// Adobe Firefly (unofficial) image-generation handler.
// Family: adobe-firefly-image | Provider: adobe-firefly
//
// Credentials: IMS access_token (JWT, client_id clio-playground-web) or full
// Cookie header from firefly.adobe.com. Cookie → IMS check/v6/token with
// client_id clio-playground-web (Express projectx_webapp fallback).
//
// Reference images (Media page / OpenAI edit aliases):
//   1) POST raw bytes → firefly-3p /v2/storage/image → { images:[{ id }] }
//   2) generate-async with referenceBlobs:[{ id, usage:"general"|"subject" }]
// See web_providers/adobe_atach_images.txt for live captures.

import { sanitizeErrorMessage } from "../../../utils/error.ts";
import { saveImageErrorResult, saveImageSuccessResult } from "../../imageGeneration.ts";
import {
  AdobeFireflyError,
  adobeFireflyGenerateImage,
  adobeFireflyImageTimeoutMs,
  resolveAdobeSourceImageReferences,
  resolveAdobeImageModel,
  resolveAdobeModelWithDiscovery,
} from "../../../services/adobeFireflyClient.ts";
import { getAdobeReferenceUploadLimit } from "../../../services/adobeFireflyModels.ts";
import { ensureAdobeFireflySession } from "../../../services/adobeFireflySession.ts";
import { isAdobeFireflyUpscaleModel } from "../../../services/adobeFireflyUpscale.ts";
import { handleAdobeFireflyImageUpscale } from "../../imageUpscale/adobeFirefly.ts";

export async function handleAdobeFireflyImageGeneration({
  model,
  provider,
  body,
  credentials,
  log,
  fetchImpl = fetch,
}: {
  model: string;
  provider: string;
  providerConfig?: { baseUrl?: string };
  body: {
    prompt?: unknown;
    size?: unknown;
    aspect_ratio?: unknown;
    aspectRatio?: unknown;
    quality?: unknown;
    seed?: unknown;
    negative_prompt?: unknown;
    timeout_ms?: unknown;
    image?: unknown;
    image_url?: unknown;
    image_urls?: unknown;
    images?: unknown;
    [key: string]: unknown;
  };
  credentials: {
    apiKey?: string;
    accessToken?: string;
    connectionId?: string;
    providerSpecificData?: {
      cookie?: unknown;
      access_token?: unknown;
      accessToken?: unknown;
      browserSessionKey?: unknown;
    } | null;
  };
  log?: { info?: (...args: unknown[]) => void; error?: (...args: unknown[]) => void };
  fetchImpl?: typeof fetch;
}) {
  const startTime = Date.now();
  const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";

  // Preserve the pre-discovery upscale execution route without advertising it as a
  // generative model. Upscale has its own registry and request schema.
  if (isAdobeFireflyUpscaleModel(model)) {
    return handleAdobeFireflyImageUpscale({
      model,
      provider,
      body: body as Record<string, unknown>,
      credentials,
      log,
      fetchImpl,
    });
  }

  if (!prompt) {
    return saveImageErrorResult({
      provider,
      model,
      status: 400,
      startTime,
      error: "Prompt is required for Adobe Firefly image generation",
    });
  }

  try {
    // Unknown model ids: only worth a session (Chrome mint / warm) when live discovery may know
    // them — resolved after ensure via resolveAdobeModelWithDiscovery.
    let modelKnown = true;
    try {
      resolveAdobeImageModel(model);
    } catch {
      modelKnown = false;
    }
    const session = await ensureAdobeFireflySession({ credentials, fetchImpl, log });
    const accessToken = session.accessToken;
    if (!modelKnown) {
      await resolveAdobeModelWithDiscovery("image", model, accessToken, fetchImpl);
    }
    const sessionCookie = session.cookie || undefined;
    const arpSessionId = session.arpSessionId;
    const seed =
      typeof body.seed === "number"
        ? body.seed
        : typeof body.seed === "string" && body.seed.trim()
          ? Number(body.seed)
          : undefined;

    const { spec } = resolveAdobeImageModel(model);
    const maxReferences = getAdobeReferenceUploadLimit(spec, "image");
    const references = await resolveAdobeSourceImageReferences({
      accessToken,
      body,
      max: maxReferences,
      sessionCookie,
      arpSessionId,
      prompt,
      fetchImpl,
      log,
    });

    const explicitTimeout =
      typeof body.timeout_ms === "number"
        ? body.timeout_ms
        : typeof body.timeout_ms === "string" && body.timeout_ms.trim()
          ? Number(body.timeout_ms)
          : undefined;
    const timeoutMs = adobeFireflyImageTimeoutMs({
      timeoutMs: explicitTimeout,
      refCount: references.length,
    });

    log?.info?.(
      "IMAGE",
      `${provider}/${model} (adobe-firefly) | prompt: "${prompt.slice(0, 60)}${prompt.length > 60 ? "..." : ""}"` +
        (references.length ? ` | refs: ${references.length}/${maxReferences}` : "") +
        ` | session=${session.source}` +
        ` | pollTimeoutMs=${timeoutMs}`
    );

    const result = await adobeFireflyGenerateImage({
      accessToken,
      prompt,
      model,
      size: body.size,
      aspectRatio: body.aspect_ratio ?? body.aspectRatio ?? body.size,
      quality: body.quality,
      seed: Number.isFinite(seed as number) ? (seed as number) : undefined,
      negativePrompt: typeof body.negative_prompt === "string" ? body.negative_prompt : undefined,
      references: references.length ? references : undefined,
      sessionCookie,
      arpSessionId,
      sessionFingerprint: session.fingerprint,
      sessionBrowserKey: session.browserSessionKey,
      timeoutMs,
      fetchImpl,
      log,
    });

    return saveImageSuccessResult({
      provider,
      model,
      startTime,
      images: [{ url: result.url }],
    });
  } catch (err) {
    if (err instanceof AdobeFireflyError) {
      log?.error?.("IMAGE", `${provider} adobe-firefly error ${err.status}: ${err.message}`);
      return saveImageErrorResult({
        provider,
        model,
        status: err.status,
        startTime,
        error: err.message,
      });
    }
    const errorText = sanitizeErrorMessage(err instanceof Error ? err.message : String(err));
    log?.error?.("IMAGE", `${provider} adobe-firefly exception: ${errorText}`);
    return saveImageErrorResult({
      provider,
      model,
      status: 500,
      startTime,
      error: errorText,
    });
  }
}
