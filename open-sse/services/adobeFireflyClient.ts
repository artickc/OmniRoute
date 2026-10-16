/**
 * Adobe Firefly (unofficial) media client.
 *
 * Talks to the same Firefly 3P async APIs that firefly.adobe.com uses (live browser
 * captures in repo `adobe/`):
 *   POST https://firefly-3p.ff.adobe.io/v2/3p-images/generate-async
 *   POST https://firefly-3p.ff.adobe.io/v2/3p-videos/generate-async
 *   POST https://firefly-3p.ff.adobe.io/v2/models/discovery
 *   GET  https://firefly.adobe.io/v1/credits/balance
 * then polls BKS job result URLs rewritten from links.result.
 *
 * Auth is an Adobe IMS access token (Bearer, client_id = clio-playground-web).
 * Callers may pass either:
 *   - a raw IMS access_token JWT (from Authorization: Bearer on Firefly), or
 *   - a browser Cookie header from firefly.adobe.com (exchanged via IMS check/v6/token
 *     with client_id clio-playground-web; Express projectx_webapp as fallback).
 *
 * x-api-key on generate/discovery MUST match the token's IMS client
 * (`clio-playground-web`). Mismatch → HTTP 401 invalid token.
 *
 * Unofficial — tokens/cookies are short-lived; Adobe may change the wire contract.
 */

import { createHash, randomBytes, randomUUID } from "node:crypto";
import { resolvePublicCred } from "../utils/publicCreds.ts";
import { sanitizeErrorMessage } from "../utils/error.ts";
import {
  ADOBE_FIREFLY_IMAGE_MODELS as DISCOVERED_IMAGE_MODELS,
  ADOBE_FIREFLY_VIDEO_MODELS as DISCOVERED_VIDEO_MODELS,
  parseAdobeModelsDiscovery,
  resolveAdobeImageModel as resolveDiscoveredImageModel,
  resolveAdobeVideoModel as resolveDiscoveredVideoModel,
  type AdobeFireflyCatalogModel as DiscoveredCatalogModel,
  type AdobeFireflyImageModelSpec as DiscoveredImageModelSpec,
  type AdobeFireflyVideoModelSpec as DiscoveredVideoModelSpec,
} from "./adobeFireflyModels.ts";

export {
  DISCOVERED_IMAGE_MODELS as ADOBE_FIREFLY_IMAGE_MODELS,
  DISCOVERED_VIDEO_MODELS as ADOBE_FIREFLY_VIDEO_MODELS,
  parseAdobeModelsDiscovery,
};

export const ADOBE_FIREFLY_IMAGE_SUBMIT_URL =
  "https://firefly-3p.ff.adobe.io/v2/3p-images/generate-async";
export const ADOBE_FIREFLY_VIDEO_SUBMIT_URL =
  "https://firefly-3p.ff.adobe.io/v2/3p-videos/generate-async";
export const ADOBE_FIREFLY_IMAGE_UPLOAD_URL = "https://firefly-3p.ff.adobe.io/v2/storage/image";
export const ADOBE_FIREFLY_MODELS_DISCOVERY_URL =
  "https://firefly-3p.ff.adobe.io/v2/models/discovery";
export const ADOBE_FIREFLY_CREDITS_BALANCE_URL = "https://firefly.adobe.io/v1/credits/balance";
export const ADOBE_FIREFLY_IMS_REFRESH_URL =
  "https://adobeid-na1.services.adobe.com/ims/check/v6/token?jslVersion=v2-v0.48.0-1-g1e322cb";
/** Scope set observed on live firefly.adobe.com IMS access tokens. */
export const ADOBE_FIREFLY_IMS_SCOPE =
  "AdobeID,firefly_api,openid,pps.read,pps.write,additional_info.projectedProductContext," +
  "additional_info.ownerOrg,uds_read,uds_write,ab.manage,read_organizations," +
  "additional_info.roles,account_cluster.read,creative_production,tk_platform," +
  "tk_platform_sync,profile";

const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36";
const DEFAULT_SEC_CH_UA = '"Not;A=Brand";v="8", "Chromium";v="150", "Google Chrome";v="150"';
const DEFAULT_POLL_INTERVAL_MS = 3000;
/**
 * Poll budget for image generate-async. Multi-ref gpt-image / nano jobs commonly
 * exceed 3 minutes (upload + colligo + render at detailLevel 5). 180s was the
 * previous default and produced widespread 504s on listing assets with screenshots.
 */
export const DEFAULT_IMAGE_TIMEOUT_MS = 300_000;
const DEFAULT_VIDEO_TIMEOUT_MS = 300_000;
/** Extra poll budget per uploaded reference blob (large screenshots + image2image). */
export const ADOBE_FIREFLY_IMAGE_TIMEOUT_PER_REF_MS = 60_000;
export const ADOBE_FIREFLY_IMAGE_TIMEOUT_MAX_MS = 600_000;
const FIREFLY_ORIGIN = "https://firefly.adobe.com";
const FIREFLY_REFERER = "https://firefly.adobe.com/";

export function adobeFireflyImageTimeoutMs(opts?: {
  timeoutMs?: number;
  refCount?: number;
}): number {
  const explicit = Number(opts?.timeoutMs);
  if (Number.isFinite(explicit) && explicit > 0) {
    return Math.min(ADOBE_FIREFLY_IMAGE_TIMEOUT_MAX_MS, Math.floor(explicit));
  }
  const refs = Math.max(0, Math.floor(Number(opts?.refCount) || 0));
  const budget = DEFAULT_IMAGE_TIMEOUT_MS + refs * ADOBE_FIREFLY_IMAGE_TIMEOUT_PER_REF_MS;
  return Math.min(ADOBE_FIREFLY_IMAGE_TIMEOUT_MAX_MS, budget);
}

const NANO_SIZE_MAP: Record<string, Record<string, { width: number; height: number }>> = {
  "1K": {
    "1:1": { width: 1024, height: 1024 },
    "16:9": { width: 1360, height: 768 },
    "9:16": { width: 768, height: 1360 },
    "4:3": { width: 1152, height: 864 },
    "3:4": { width: 864, height: 1152 },
    "1:8": { width: 384, height: 3072 },
    "1:4": { width: 512, height: 2048 },
    "4:1": { width: 2048, height: 512 },
    "8:1": { width: 3072, height: 384 },
  },
  "2K": {
    "1:1": { width: 2048, height: 2048 },
    "16:9": { width: 2752, height: 1536 },
    "9:16": { width: 1536, height: 2752 },
    "4:3": { width: 2048, height: 1536 },
    "3:4": { width: 1536, height: 2048 },
    "1:8": { width: 768, height: 6144 },
    "1:4": { width: 1024, height: 4096 },
    "4:1": { width: 4096, height: 1024 },
    "8:1": { width: 6144, height: 768 },
  },
  "4K": {
    "1:1": { width: 4096, height: 4096 },
    "16:9": { width: 5504, height: 3072 },
    "9:16": { width: 3072, height: 5504 },
    "4:3": { width: 4096, height: 3072 },
    "3:4": { width: 3072, height: 4096 },
    "1:8": { width: 1536, height: 12288 },
    "1:4": { width: 2048, height: 8192 },
    "4:1": { width: 8192, height: 2048 },
    "8:1": { width: 12288, height: 1536 },
  },
};

const GPT_SIZE_MAP: Record<string, Record<string, { width: number; height: number }>> = {
  "1K": {
    "1:1": { width: 1024, height: 1024 },
    "5:4": { width: 1120, height: 896 },
    "9:16": { width: 720, height: 1280 },
    "21:9": { width: 1456, height: 624 },
    "16:9": { width: 1280, height: 720 },
    "4:3": { width: 1152, height: 864 },
    "3:2": { width: 1248, height: 832 },
    "4:5": { width: 896, height: 1120 },
    "3:4": { width: 864, height: 1152 },
    "2:3": { width: 832, height: 1248 },
  },
  "2K": {
    "1:1": { width: 2048, height: 2048 },
    "5:4": { width: 2240, height: 1792 },
    "9:16": { width: 1440, height: 2560 },
    "21:9": { width: 3024, height: 1296 },
    "16:9": { width: 2560, height: 1440 },
    "4:3": { width: 2304, height: 1728 },
    "3:2": { width: 2496, height: 1664 },
    "4:5": { width: 1792, height: 2240 },
    "3:4": { width: 1728, height: 2304 },
    "2:3": { width: 1664, height: 2496 },
  },
  "4K": {
    "1:1": { width: 2880, height: 2880 },
    "5:4": { width: 3200, height: 2560 },
    "9:16": { width: 2160, height: 3840 },
    "21:9": { width: 3696, height: 1584 },
    "16:9": { width: 3840, height: 2160 },
    "4:3": { width: 3264, height: 2448 },
    "3:2": { width: 3504, height: 2336 },
    "4:5": { width: 2560, height: 3200 },
    "3:4": { width: 2448, height: 3264 },
    "2:3": { width: 2336, height: 3504 },
  },
};

const PIXEL_SIZE_TO_RATIO: Record<string, string> = {
  "1024x1024": "1:1",
  "1536x1536": "1:1",
  "2048x2048": "1:1",
  "1024x1792": "9:16",
  "1536x2752": "9:16",
  "1792x1024": "16:9",
  "2752x1536": "16:9",
  "2048x1536": "4:3",
  "1536x2048": "3:4",
  "1280x720": "16:9",
  "720x1280": "9:16",
  "1920x1080": "16:9",
  "1080x1920": "9:16",
};

export class AdobeFireflyError extends Error {
  status: number;
  code?: string;

  constructor(message: string, status = 502, code?: string) {
    super(message);
    this.name = "AdobeFireflyError";
    this.status = status;
    this.code = code;
  }
}

/** Public x-api-key + primary IMS client_id for firefly.adobe.com (`clio-playground-web`). */
export function adobeFireflyApiKey(): string {
  return resolvePublicCred("adobe_firefly_api_key", "ADOBE_FIREFLY_API_KEY");
}

/** Express IMS client_id fallback for cookie exchange (`projectx_webapp`). */
export function adobeFireflyExpressClientId(): string {
  return resolvePublicCred("adobe_firefly_express_client_id", "ADOBE_FIREFLY_EXPRESS_CLIENT_ID");
}

/** Public x-api-key for GET firefly.adobe.io/v1/credits/balance (`SunbreakWebUI1`). */
export function adobeFireflyBalanceApiKey(): string {
  return resolvePublicCred("adobe_firefly_balance_api_key", "ADOBE_FIREFLY_BALANCE_API_KEY");
}

/** Decode IMS JWT payload (no signature verification — client-side claim read only). */
export function decodeAdobeJwtPayload(token: string): Record<string, unknown> | null {
  try {
    // Do not call extractAdobeCredentialToken here (would recurse via guest checks).
    let raw = String(token || "")
      .trim()
      .replace(/^bearer\s+/i, "")
      .trim();
    // If a blob was passed, take the first JWT-shaped segment.
    const m = raw.match(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/);
    if (m) raw = m[0];
    const part = raw.split(".")[1];
    if (!part) return null;
    const json = Buffer.from(part.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    const obj = JSON.parse(json);
    return obj && typeof obj === "object" ? (obj as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** AdobeID subject for x-account-id on balance / account_cluster calls. */
export function extractAdobeAccountIdFromToken(token: string): string {
  const payload = decodeAdobeJwtPayload(token);
  if (!payload) return "";
  const candidates = [payload.user_id, payload.aa_id, payload.sub, payload.id];
  for (const c of candidates) {
    if (typeof c === "string" && c.includes("@")) return c.trim();
  }
  for (const c of candidates) {
    if (typeof c === "string" && c.trim()) return c.trim();
  }
  return "";
}

export function looksLikeAdobeJwt(value: string): boolean {
  const raw = value.trim();
  if (!raw) return false;
  // Avoid treating cookie blobs that happen to have two dots as JWT.
  if (raw.includes(";") || (raw.includes("=") && !raw.startsWith("eyJ"))) return false;
  // Allow a single space after optional Bearer prefix (stripped earlier).
  if (/\s/.test(raw) && !/^bearer\s+/i.test(raw)) return false;
  const token = raw.replace(/^bearer\s+/i, "").trim();
  const parts = token.split(".");
  if (parts.length !== 3) return false;
  // Adobe IMS access tokens are sizable; reject tiny accidental 3-segment strings.
  if (token.length < 80) return false;
  return parts.every((p) => p.length > 0 && /^[A-Za-z0-9_-]+$/.test(p));
}

/**
 * True when IMS issued a guest token (no signed-in AdobeID).
 * Live repro: firefly.adobe.com page cookies alone → account_type=guest → generate 401 /
 * balance 403 ErrMismatchOauthToken.
 */
export function isAdobeGuestAccessToken(token: string): boolean {
  const payload = decodeAdobeJwtPayload(token);
  if (!payload) return false;
  const userId = typeof payload.user_id === "string" ? payload.user_id : "";
  const aaId = typeof payload.aa_id === "string" ? payload.aa_id : "";
  const type = typeof payload.type === "string" ? payload.type.toLowerCase() : "";
  // Authenticated Firefly tokens always carry an @AdobeID (or similar) subject.
  if (userId.includes("@AdobeID") || aaId.includes("@AdobeID")) return false;
  if (userId.includes("@GuestID") || aaId.includes("@GuestID")) return true;
  if (type === "guest" || type.includes("guest")) return true;
  // Guest tokens from ims/check often omit type/user_id entirely.
  if (!userId && !aaId) return true;
  return false;
}

export function isAdobeUserAccessToken(token: string): boolean {
  return looksLikeAdobeJwt(token) && !isAdobeGuestAccessToken(token);
}

/**
 * Pull an IMS JWT out of free-form paste: raw JWT, Bearer …, access_token=…,
 * IMS sessionStorage JSON (`tokenValue`), multi-line Network/HAR dumps.
 * Prefer the longest user (non-guest) eyJ… JWT found.
 */
export function extractAdobeCredentialToken(raw: string): string {
  const value = String(raw || "").trim();
  if (!value) return "";

  if (/^bearer\s+/i.test(value)) {
    const bare =
      value
        .replace(/^bearer\s+/i, "")
        .trim()
        .split(/\s+/)[0] || "";
    if (looksLikeAdobeJwt(bare)) return bare;
  }

  // access_token=... in cookie-ish or form paste
  const accessMatch = value.match(/(?:^|[;\s&])access_token=([^;\s&]+)/i);
  if (accessMatch?.[1]) {
    const t = decodeURIComponent(accessMatch[1].trim());
    if (looksLikeAdobeJwt(t)) return t;
  }

  // IMS sessionStorage / localStorage JSON: "tokenValue":"eyJ..."
  const tokenValueMatch = value.match(/"tokenValue"\s*:\s*"(eyJ[^"]+)"/i);
  if (tokenValueMatch?.[1] && looksLikeAdobeJwt(tokenValueMatch[1])) {
    return tokenValueMatch[1];
  }

  // Authorization: Bearer eyJ...
  const authMatch = value.match(
    /Authorization\s*:\s*Bearer\s+([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)/i
  );
  if (authMatch?.[1] && looksLikeAdobeJwt(authMatch[1])) return authMatch[1];

  // Any eyJ… JWT in the blob (HAR / multi-line). Prefer user AdobeID tokens.
  const jwtMatches = value.match(
    /eyJ[A-Za-z0-9_-]{1,4096}\.[A-Za-z0-9_-]{1,4096}\.[A-Za-z0-9_-]{1,4096}/g
  );
  if (jwtMatches && jwtMatches.length > 0) {
    const sorted = [...jwtMatches].sort((a, b) => b.length - a.length);
    const user = sorted.find((t) => looksLikeAdobeJwt(t) && isAdobeUserAccessToken(t));
    if (user) return user;
    const best = sorted[0];
    if (looksLikeAdobeJwt(best)) return best;
  }

  // Pure JWT
  if (looksLikeAdobeJwt(value)) return value.replace(/^bearer\s+/i, "").trim();

  // Cookie / other blob unchanged for IMS exchange
  return value;
}

/**
 * True when the paste still looks like a Cookie header (not a bare JWT).
 * Used to attach Cookie + sherlockToken → x-arp-session-id on generate.
 */
export function looksLikeAdobeCookieBlob(value: string): boolean {
  const raw = String(value || "").trim();
  if (!raw || looksLikeAdobeJwt(raw)) return false;
  if (raw.includes(";") && raw.includes("=")) return true;
  if (/(?:^|[;\s])(?:aux_sid|ff_session|sherlockToken|forterToken|arkose)=/i.test(raw)) {
    return true;
  }
  return false;
}

/**
 * Strip JWTs / Authorization lines from a mixed paste so only Cookie pairs remain.
 * Undici Headers.append rejects multi-line Cookie values (throws Headers.append: "eyJ…").
 */
export function extractAdobeCookieHeader(raw: string): string {
  const value = String(raw || "").trim();
  if (!value) return "";
  if (looksLikeAdobeJwt(value)) return "";

  // Drop pure JWT lines and Authorization: Bearer lines
  const cleaned = value
    .split(/[\r\n]+/)
    .map((line) => line.trim())
    .filter((line) => {
      if (!line) return false;
      if (/^authorization\s*:/i.test(line)) return false;
      if (/^bearer\s+/i.test(line)) return false;
      if (looksLikeAdobeJwt(line)) return false;
      // Drop standalone eyJ… segments
      if (/^eyJ[A-Za-z0-9_-]{1,4096}\.[A-Za-z0-9_-]{1,4096}\.[A-Za-z0-9_-]{1,4096}$/.test(line))
        return false;
      return true;
    })
    .join("; ");

  // Also strip inline eyJ JWT tokens that may sit inside a cookie string
  const noJwt = cleaned
    .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "")
    .replace(/;\s*;/g, ";")
    .replace(/^;\s*|\s*;$/g, "")
    .trim();

  if (!noJwt || !looksLikeAdobeCookieBlob(noJwt)) return "";
  // Final safety: Cookie header must be single-line
  return noJwt.replace(/[\r\n]+/g, "; ").trim();
}

const GUEST_COOKIE_HELP =
  "Firefly page cookies alone only mint a GUEST IMS token (no AdobeID) — generate returns 401 and Limits 403. " +
  "Fix: open firefly.adobe.com signed-in → F12 → Network → click a request to firefly-3p.ff.adobe.io " +
  "(generate-async or models/discovery) → Request Headers → Authorization → copy the token AFTER 'Bearer ' " +
  "(starts with eyJ…). Paste that JWT as the credential. " +
  "Cookie-only works only if you also export IMS session cookies from adobelogin.com / adobeid-na1 " +
  "(Cookie-Editor → export all Adobe domains); firefly.adobe.com cookies by themselves are not enough.";

export function normalizeAdobeAspectRatio(sizeOrRatio: unknown, fallback = "1:1"): string {
  if (typeof sizeOrRatio !== "string" || !sizeOrRatio.trim()) return fallback;
  let raw = sizeOrRatio.trim().replace(/_/g, ":");
  if (raw.toLowerCase() === "auto") return fallback;

  if (/^\d+:\d+$/.test(raw)) return raw;

  // Short ratio forms like 16x9 / 9x16
  const short = raw.match(/^(\d+)x(\d+)$/i);
  if (short) {
    const a = Number(short[1]);
    const b = Number(short[2]);
    if (a > 0 && b > 0 && a < 100 && b < 100) return `${a}:${b}`;
  }

  const lower = raw.toLowerCase();
  if (PIXEL_SIZE_TO_RATIO[lower]) return PIXEL_SIZE_TO_RATIO[lower];

  // Generic WxH pixel sizes → closest common ratio
  const pixel = lower.match(/^(\d+)x(\d+)$/);
  if (pixel) {
    const w = Number(pixel[1]);
    const h = Number(pixel[2]);
    if (w > 0 && h > 0) {
      if (Math.abs(w - h) / Math.max(w, h) < 0.08) return "1:1";
      if (w > h * 1.5) return "16:9";
      if (h > w * 1.5) return "9:16";
      if (w > h) return "4:3";
      return "3:4";
    }
  }

  return fallback;
}

export function normalizeAdobeOutputResolution(
  quality: unknown,
  size: unknown
): "1K" | "2K" | "4K" {
  const q = String(quality ?? "")
    .trim()
    .toLowerCase();
  if (q === "4k" || q === "ultra" || q === "high") return "4K";
  if (q === "2k" || q === "hd" || q === "standard" || q === "medium") return "2K";
  if (q === "1k" || q === "low") return "1K";

  const s = String(size ?? "").toLowerCase();
  if (s.includes("4k") || /4096|5504|3840/.test(s)) return "4K";
  if (s.includes("1k") || /1024x1024|768x1360|1360x768/.test(s)) return "1K";
  return "2K";
}

export function resolveAdobeImageModel(
  model: string
): ReturnType<typeof resolveDiscoveredImageModel> {
  try {
    return resolveDiscoveredImageModel(model);
  } catch (error) {
    throw new AdobeFireflyError(
      error instanceof Error ? error.message : "Unknown Adobe Firefly image model",
      400,
      "unknown_model"
    );
  }
}

export function resolveAdobeVideoModel(
  model: string
): ReturnType<typeof resolveDiscoveredVideoModel> {
  try {
    return resolveDiscoveredVideoModel(model);
  } catch (error) {
    throw new AdobeFireflyError(
      error instanceof Error ? error.message : "Unknown Adobe Firefly video model",
      400,
      "unknown_model"
    );
  }
}

function gptDetailLevel(quality: unknown): number {
  const q = String(quality ?? "high")
    .trim()
    .toLowerCase();
  if (q === "low" || q === "1k" || q === "1") return 1;
  if (q === "medium" || q === "2k" || q === "standard" || q === "hd" || q === "3") return 3;
  // high / 4k / ultra / auto / empty / unknown → max detail
  return 5;
}

export interface AdobeFireflyReferenceBlob {
  id: string;
  mediaType?: string;
  usage?: string;
  order?: number;
}

function defaultAdobeReferenceUsage(
  model: DiscoveredCatalogModel,
  mediaType: string
): string | null {
  const supported = model.capabilities.referenceInputs
    .filter((capability) => capability.mediaType === mediaType)
    .map((capability) => capability.usageType);
  const priority =
    model.modality === "video"
      ? ["frame", "element", "style", "subject", "source", "general"]
      : ["source", "general", "style", "element", "subject"];
  return priority.find((usage) => supported.includes(usage)) || supported[0] || null;
}

/** Validate roles/counts against the resolved discovery schema and produce wire blobs. */
export function normalizeAdobeReferenceBlobs(
  model: DiscoveredCatalogModel,
  references: AdobeFireflyReferenceBlob[] = [],
  fallbackImageIds: string[] = []
): Array<Record<string, unknown>> {
  const requested = references.length
    ? references
    : fallbackImageIds.map((id) => ({ id, mediaType: "image" }));
  const capabilities = model.capabilities.referenceInputs;
  const totalLimit = model.capabilities.maxReferenceItems;
  if (totalLimit !== null && requested.length > totalLimit) {
    throw new AdobeFireflyError(
      `${model.name} accepts at most ${totalLimit} total reference item(s)`,
      400,
      "invalid_reference_count"
    );
  }

  const counts = new Map<string, number>();
  const normalized = requested.map((reference) => {
    const id = String(reference.id || "").trim();
    if (!id) {
      throw new AdobeFireflyError(
        "Adobe Firefly reference id is required",
        400,
        "invalid_reference"
      );
    }
    const mediaType = String(reference.mediaType || "image")
      .trim()
      .toLowerCase();
    const usage =
      String(reference.usage || "")
        .trim()
        .toLowerCase() || defaultAdobeReferenceUsage(model, mediaType);
    const capability = capabilities.find(
      (candidate) => candidate.mediaType === mediaType && candidate.usageType === usage
    );
    if (!usage || !capability) {
      const allowed = capabilities
        .filter((candidate) => candidate.mediaType === mediaType)
        .map((candidate) => candidate.usageType)
        .join(", ");
      throw new AdobeFireflyError(
        `${model.name} does not support ${mediaType} references with usage '${usage || "unspecified"}'` +
          (allowed ? ` (allowed: ${allowed})` : ""),
        400,
        "invalid_reference_usage"
      );
    }
    const key = `${mediaType}:${usage}`;
    const count = (counts.get(key) || 0) + 1;
    counts.set(key, count);
    if (capability.maxItems !== null && count > capability.maxItems) {
      throw new AdobeFireflyError(
        `${model.name} accepts at most ${capability.maxItems} ${usage} ${mediaType} reference(s)`,
        400,
        "invalid_reference_count"
      );
    }
    return {
      id,
      usage,
      ...(usage === "frame" ? { order: reference.order ?? count } : {}),
    };
  });

  for (const capability of capabilities) {
    if (capability.minItems <= 0) continue;
    const key = `${capability.mediaType}:${capability.usageType}`;
    const count = counts.get(key) || 0;
    if (count < capability.minItems) {
      throw new AdobeFireflyError(
        `${model.name} requires at least ${capability.minItems} ${capability.usageType} ${capability.mediaType} reference(s)`,
        400,
        "missing_required_reference"
      );
    }
  }
  return normalized;
}

/**
 * Snap a requested ratio/size to the model's discovered size enum (when it has one).
 * Adobe validates enumerated sizes strictly (live: gpt-image-1.5 → 400 "Invalid image size:
 * 2304x1728. Supported sizes are: ['1024x1024', '1536x1024', '1024x1536', 'auto']").
 * Picks the closest aspect ratio, then the pixel count closest to the requested tier.
 */
export function snapAdobeImageSize(
  supportedSizes: readonly string[],
  ratio: string,
  target: { width: number; height: number }
): { width: number; height: number } | null {
  const parsed = supportedSizes
    .map((value) => String(value).match(/^(\d+)x(\d+)$/i))
    .filter((m): m is RegExpMatchArray => Boolean(m))
    .map((m) => ({ width: Number(m[1]), height: Number(m[2]) }))
    .filter((s) => s.width > 0 && s.height > 0);
  if (parsed.length === 0) return null;
  const exact = parsed.find((s) => s.width === target.width && s.height === target.height);
  if (exact) return exact;
  const [rw, rh] = String(ratio || "1:1")
    .split(":")
    .map(Number);
  const wanted = rw > 0 && rh > 0 ? rw / rh : target.width / Math.max(1, target.height);
  const targetArea = target.width * target.height;
  const score = (s: { width: number; height: number }) =>
    Math.abs(Math.log(s.width / s.height / wanted)) * 100 +
    Math.abs(Math.log((s.width * s.height) / Math.max(1, targetArea)));
  return [...parsed].sort((a, b) => score(a) - score(b))[0] || null;
}

export function buildAdobeImagePayload(opts: {
  prompt: string;
  aspectRatio: string;
  outputResolution: "1K" | "2K" | "4K";
  modelSpec: DiscoveredImageModelSpec;
  quality?: unknown;
  seed?: number;
  sourceImageIds?: string[];
  references?: AdobeFireflyReferenceBlob[];
  negativePrompt?: string;
}): Record<string, unknown> {
  const ratio = opts.aspectRatio === "auto" ? "1:1" : opts.aspectRatio || "1:1";
  const seeds = [typeof opts.seed === "number" ? opts.seed : Math.floor(Date.now() % 999999)];
  const negative = String(opts.negativePrompt || "").trim();
  const referenceBlobs = normalizeAdobeReferenceBlobs(
    opts.modelSpec,
    opts.references,
    opts.sourceImageIds
  );
  const genSettings: Record<string, unknown> = {};
  if (negative) {
    genSettings.avoidKeywords = negative
      .replace(/;/g, ",")
      .split(",")
      .map((w) => w.trim())
      .filter(Boolean);
  }

  if (opts.modelSpec.family === "gpt-image") {
    // Firefly GPT Image historically used modelSpecificPayload.size:"auto" only.
    // That ignored Screenshot Quality 4K and often returned ~1–2K (e.g. 1672×941).
    // When we know the tier, request the explicit GPT_SIZE_MAP pixel size; fall back to
    // "auto" only when the map has no entry. detailLevel still carries quality.
    const gptMap = GPT_SIZE_MAP[opts.outputResolution] || GPT_SIZE_MAP["2K"];
    const mapped = gptMap[ratio] || gptMap["1:1"];
    // Fixed-size models (gpt-image-1.5 / gpt-4o-image) only accept their enum.
    const gptPixel =
      snapAdobeImageSize(opts.modelSpec.capabilities.supportedSizes, ratio, mapped) || mapped;
    const gptSizeToken =
      gptPixel && gptPixel.width > 0 && gptPixel.height > 0
        ? `${gptPixel.width}x${gptPixel.height}`
        : "auto";
    const payload: Record<string, unknown> = {
      n: 1,
      seeds,
      output: { storeInputs: true },
      prompt: opts.prompt,
      referenceBlobs: [] as Array<Record<string, unknown>>,
      modelSpecificPayload: { size: gptSizeToken },
      modelId: opts.modelSpec.upstreamModelId,
      modelVersion: opts.modelSpec.upstreamModelVersion,
      generationMetadata: {
        module: "text2image",
        submodule: "ff-image-generate",
      },
      generationSettings: {
        detailLevel: gptDetailLevel(opts.quality),
        ...genSettings,
      },
    };
    if (referenceBlobs.length) {
      // gpt-image subject references (mask path uses separate mask blob when present).
      payload.generationMetadata = { module: "image2image", submodule: "ff-image-generate" };
      payload.referenceBlobs = referenceBlobs;
      payload.modelSpecificPayload = { size: gptSizeToken };
    }
    return payload;
  }

  // Gemini Flash + generic (Flux / Seedream / Runway image): same 3P image shape.
  // Live capture (web_providers/adobe_atach_images.txt): referenceBlobs with usage "general"
  // keep module "text2image" (not image2image) for nano multi-ref composition.
  const sizeMap = NANO_SIZE_MAP[opts.outputResolution] || NANO_SIZE_MAP["2K"];
  const mappedPixel = sizeMap[ratio] || sizeMap["1:1"];
  const pixel =
    snapAdobeImageSize(opts.modelSpec.capabilities.supportedSizes, ratio, mappedPixel) ||
    mappedPixel;
  const payload: Record<string, unknown> = {
    modelId: opts.modelSpec.upstreamModelId,
    modelVersion: opts.modelSpec.upstreamModelVersion,
    n: 1,
    prompt: opts.prompt,
    size: pixel,
    seeds,
    groundSearch: false,
    // Live firefly.adobe.com capture (2026-09-29) sends caiClaimVersion 2 and no skipCai.
    caiClaimVersion: 2,
    output: { storeInputs: true },
    generationMetadata: {
      module: "text2image",
      submodule: "ff-image-generate",
    },
    // Live SPA capture (2026-09-29, nano-banana-3 1:1) carries only `parameters`; earlier
    // working captures sent aspectRatio for non-square ratios — keep it only there.
    modelSpecificPayload:
      opts.modelSpec.family === "gemini" && ratio === "1:1"
        ? { parameters: { addWatermark: false } }
        : { parameters: { addWatermark: false }, aspectRatio: ratio },
    referenceBlobs: [] as Array<Record<string, unknown>>,
  };
  if (Object.keys(genSettings).length) payload.generationSettings = genSettings;

  if (referenceBlobs.length) {
    payload.referenceBlobs = referenceBlobs;
    // Flux / Seedream / Runway image historically used image2image; Gemini keeps text2image.
    if (opts.modelSpec.family === "generic") {
      payload.generationMetadata = {
        module: "image2image",
        submodule: "ff-image-generate",
      };
    }
  }
  return payload;
}

function videoSize(aspectRatio: string, resolution: string): { width: number; height: number } {
  const res = String(resolution || "720p").toLowerCase();
  const short = res.includes("1080") ? 1080 : res.includes("480") ? 480 : 720;
  const ratio = aspectRatio === "9:16" ? "9:16" : aspectRatio === "1:1" ? "1:1" : "16:9";
  if (ratio === "1:1") return { width: short, height: short };
  if (ratio === "9:16") return { width: Math.round((short * 9) / 16), height: short };
  return { width: Math.round((short * 16) / 9), height: short };
}

function parseSize(value: string): { width: number; height: number } | null {
  const match = String(value || "").match(/^(\d+)[x:](\d+)$/i);
  if (!match) return null;
  const width = Number(match[1]);
  const height = Number(match[2]);
  return width > 0 && height > 0 ? { width, height } : null;
}

function selectAdobeVideoSize(
  model: DiscoveredVideoModelSpec,
  aspectRatio: string,
  resolution: string
): { width: number; height: number } {
  const supported = model.capabilities.supportedSizes.map(parseSize).filter(Boolean) as Array<{
    width: number;
    height: number;
  }>;
  const requestedExact = parseSize(aspectRatio);
  if (requestedExact) {
    const exact = supported.find(
      (size) => size.width === requestedExact.width && size.height === requestedExact.height
    );
    if (exact) return exact;
  }
  if (supported.length === 0) return videoSize(aspectRatio, resolution);

  const [ratioWidth, ratioHeight] = String(aspectRatio || "16:9")
    .split(":")
    .map(Number);
  const targetRatio = ratioWidth > 0 && ratioHeight > 0 ? ratioWidth / ratioHeight : 16 / 9;
  const targetLongEdge = String(resolution).includes("1080") ? 1920 : 1280;
  return [...supported].sort((left, right) => {
    const leftScore =
      Math.abs(left.width / left.height - targetRatio) * 10_000 +
      Math.abs(Math.max(left.width, left.height) - targetLongEdge);
    const rightScore =
      Math.abs(right.width / right.height - targetRatio) * 10_000 +
      Math.abs(Math.max(right.width, right.height) - targetLongEdge);
    return leftScore - rightScore;
  })[0];
}

function validateAdobeDuration(model: DiscoveredVideoModelSpec, requested: number): number {
  const capabilities = model.capabilities;
  const duration = Math.floor(Number.isFinite(requested) ? requested : model.defaultDuration);
  if (
    capabilities.supportedDurations.length > 0 &&
    !capabilities.supportedDurations.includes(duration)
  ) {
    throw new AdobeFireflyError(
      `${model.name} supports duration(s): ${capabilities.supportedDurations.join(", ")} seconds`,
      400,
      "invalid_duration"
    );
  }
  if (
    (capabilities.durationMin !== null && duration < capabilities.durationMin) ||
    (capabilities.durationMax !== null && duration > capabilities.durationMax)
  ) {
    throw new AdobeFireflyError(
      `${model.name} duration must be between ${capabilities.durationMin ?? "?"} and ${capabilities.durationMax ?? "?"} seconds`,
      400,
      "invalid_duration"
    );
  }
  return duration;
}

export function buildAdobeVideoPayload(opts: {
  prompt: string;
  aspectRatio: string;
  duration: number;
  modelSpec: DiscoveredVideoModelSpec;
  resolution?: string;
  seed?: number;
  sourceImageIds?: string[];
  references?: AdobeFireflyReferenceBlob[];
  negativePrompt?: string;
  generateAudio?: boolean;
}): Record<string, unknown> {
  const model = opts.modelSpec;
  const properties = new Set(model.capabilities.schemaProperties);
  const aspect = opts.aspectRatio === "auto" ? "16:9" : opts.aspectRatio || "16:9";
  if (
    model.capabilities.supportedAspectRatios.length > 0 &&
    !model.capabilities.supportedAspectRatios.includes(aspect)
  ) {
    throw new AdobeFireflyError(
      `${model.name} supports aspect ratio(s): ${model.capabilities.supportedAspectRatios.join(", ")}`,
      400,
      "invalid_aspect_ratio"
    );
  }
  const duration = validateAdobeDuration(model, opts.duration);
  const referenceBlobs = normalizeAdobeReferenceBlobs(model, opts.references, opts.sourceImageIds);
  const seed = typeof opts.seed === "number" ? opts.seed : Math.floor(Date.now() % 999999);
  const resolution = opts.resolution || model.defaultResolution;
  const payload: Record<string, unknown> = {
    modelId: model.upstreamModelId,
    modelVersion: model.upstreamModelVersion,
    prompt: opts.prompt,
    generationMetadata: {
      module: referenceBlobs.some((reference) => reference.usage === "frame")
        ? "image2video"
        : "text2video",
    },
  };

  if (properties.has("n")) payload.n = 1;
  if (properties.has("seeds")) payload.seeds = [seed];
  if (properties.has("output")) payload.output = { storeInputs: true };
  if (properties.has("size")) payload.size = selectAdobeVideoSize(model, aspect, resolution);
  if (properties.has("duration")) payload.duration = duration;
  if (properties.has("generationSettings")) payload.generationSettings = { aspectRatio: aspect };
  if (properties.has("generateAudio")) payload.generateAudio = opts.generateAudio !== false;
  if (properties.has("modelSpecificPayload")) payload.modelSpecificPayload = {};
  if (properties.has("referenceBlobs")) payload.referenceBlobs = referenceBlobs;
  const negativePrompt = String(opts.negativePrompt || "").trim();
  if (negativePrompt && properties.has("negativePrompt")) payload.negativePrompt = negativePrompt;
  return payload;
}

/** UA of the Chrome that minted the current Sherlock ARP (submit client hints align to it). */
let submitUserAgent = "";

export function setAdobeFireflySubmitUserAgent(userAgent: string): void {
  const ua = String(userAgent || "").trim();
  if (/^Mozilla\/5\.0 .*Chrome\/\d+/.test(ua) && !/[\r\n]/.test(ua)) submitUserAgent = ua;
}

function currentUserAgent(): string {
  return submitUserAgent || DEFAULT_USER_AGENT;
}

function currentSecChUa(): string {
  const major = currentUserAgent().match(/Chrome\/(\d+)/)?.[1];
  if (!submitUserAgent || !major) return DEFAULT_SEC_CH_UA;
  const brand = /Edg\//.test(submitUserAgent) ? "Microsoft Edge" : "Google Chrome";
  return `"Chromium";v="${major}", "Not-A.Brand";v="24", "${brand}";v="${major}"`;
}

function browserHeaders(): Record<string, string> {
  return {
    "user-agent": currentUserAgent(),
    origin: FIREFLY_ORIGIN,
    referer: FIREFLY_REFERER,
    "accept-language": "en-US,en;q=0.9",
    "sec-ch-ua": currentSecChUa(),
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"Windows"',
    "sec-fetch-site": "cross-site",
    "sec-fetch-mode": "cors",
    "sec-fetch-dest": "empty",
  };
}

/** Random 64-char hex fallback when token/prompt are missing for deterministic nonce. */
export function generateAdobeNonce(): string {
  const bytes = new Uint8Array(32);
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Deterministic x-nonce used by working open-source Firefly clients
 * (adobe2api / GPT2Image-Pro / image2api):
 *   sha256(`${user_id}-${prompt.slice(0, 256)}`)
 *
 * Random nonces (browser-looking) still get colligo 408 on many accounts when
 * the request is not from the SPA. Deterministic nonce is what unblocks generate.
 */
export function buildAdobeSubmitNonce(accessToken: string, prompt: string): string {
  const userId = extractAdobeAccountIdFromToken(accessToken);
  const promptPrefix = String(prompt || "").slice(0, 256);
  if (!userId || !promptPrefix) return "";
  return createHash("sha256").update(`${userId}-${promptPrefix}`, "utf8").digest("hex");
}

/**
 * Live firefly.adobe.com Arkose public key (web_providers/adobe_atach_images.txt, 2026-07).
 * Browser x-arp-session-id is base64(JSON({sid, ark, ftr})) — synthetic sessions without a
 * real Arkose blob often get colligo HTTP 408 "system under load". Prefer pasted sherlockToken.
 */
export const ADOBE_FIREFLY_ARKOSE_PUBLIC_KEY = "BBCC314C-4937-4CCD-B0A3-FDF0F0F7603C";
/** Live ftr magic (replaces older adobe2api `dUAL43-mnts-ants-d4_31ck__tt`). */
export const ADOBE_FIREFLY_FTR_MAGIC = "__UDF43-m4_31ck";

/**
 * True when a string looks like a Firefly ARP session (base64 JSON with sid).
 */
export function isValidAdobeArpSessionId(value: string): boolean {
  const t = String(value || "").trim();
  if (t.length < 4) return false;
  // Never treat Cookie name=value pairs (e.g. aux_sid=…, forter=…) as ARP.
  // Live ARP is base64(JSON) or a bare opaque token — not "key=value".
  if (/^[A-Za-z_][A-Za-z0-9_.%-]*=/.test(t) && !t.startsWith("eyJ")) return false;
  try {
    const padded = t + "=".repeat((4 - (t.length % 4)) % 4);
    const json = Buffer.from(padded.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString(
      "utf8"
    );
    // Reject binary garbage that "decodes" but isn't JSON (corrupted sherlock paste).
    if (/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(json)) return false;
    const obj = JSON.parse(json) as {
      sid?: unknown;
      ftr?: unknown;
      ark?: unknown;
    };
    return typeof obj.sid === "string" && obj.sid.length > 0;
  } catch {
    // Opaque short sherlockToken values (tests / non-JSON) when non-empty.
    // No mid-string "=" (cookie pair leftovers); padding "=" at end is OK.
    if (/=.+/.test(t.replace(/=+$/, ""))) return false;
    return !looksLikeAdobeJwt(t) && /^[A-Za-z0-9+/_=-]+$/.test(t);
  }
}

/**
 * Synthesize x-arp-session-id when no browser sherlockToken is available.
 * Shape matches live successful generate (adobe/image_generate.txt):
 *   base64(JSON({sid, ark, bfp, ftr, fpjs}))
 * ALWAYS send this header on generate-async / storage upload.
 * Prefer real sherlockToken / cookie rebuild (forter+arkose+sid) when available.
 */
export function buildAdobeArpSessionId(region = "eu-west-1"): string {
  const nowMs = Date.now();
  const sid = randomUUID();
  const randHex = randomBytes(16).toString("hex");
  // Live ftr: {32hex}_{ms}__UDF43-m4_31ck_{b64}=-N-v2_tt
  const mid = randomBytes(12).toString("base64url");
  const n = 1000 + Math.floor(Math.random() * 9000);
  const ftr = `${randHex}_${nowMs}${ADOBE_FIREFLY_FTR_MAGIC}_${mid}=-${n}-v2_tt`;
  // Arkose session-shaped string (public pk from firefly SPA). Without a real
  // Arkose solve this may still 408; real sherlockToken is the stable path.
  const arkSession = `${randomBytes(8).toString("hex")}.${Math.random().toFixed(10).slice(2)}`;
  const ark =
    `${arkSession}|r=${region}|meta=3|metabgclr=transparent|metaiconclr=%23757575|` +
    `guitextcolor=%23000000|pk=${ADOBE_FIREFLY_ARKOSE_PUBLIC_KEY}|at=40|sup=1|rid=13|ag=101|` +
    `cdn_url=https%3A%2F%2Farks-client.adobe.com%2Fcdn%2Ffc|` +
    `surl=https%3A%2F%2Farks-client.adobe.com|` +
    `smurl=https%3A%2F%2Farks-client.adobe.com%2Fcdn%2Ffc%2Fassets%2Fstyle-manager`;
  // Successful browser ARP also carries Browser Fingerprint + FingerprintJS payload.
  const bfp = randomUUID();
  const fpjs = JSON.stringify({
    requestId: `${nowMs}.${randomBytes(3).toString("base64url")}`,
    visitorId: randomBytes(12).toString("base64url"),
  });
  const raw = JSON.stringify({ sid, ark, bfp, ftr, fpjs });
  return Buffer.from(raw, "utf-8").toString("base64");
}

/**
 * Pull sherlockToken / x-arp-session-id from Cookie header, HAR paste, or multi-line credential.
 * Browser generate sends Cookie.sherlockToken (or the request header) as x-arp-session-id.
 * Live value is base64({sid, ark, ftr}) — includes Arkose session data.
 *
 * Also handles PasswordBox mangling (JWT + ARP joined by a single space) and full fetch()
 * copy/paste from DevTools (web_providers/adobe_atach_images.txt).
 */
export function extractAdobeArpSessionId(cookieOrBlob: string): string {
  const raw = String(cookieOrBlob || "");
  if (!raw.trim()) return "";

  const candidates: string[] = [];
  const push = (v: string | undefined | null) => {
    if (!v) return;
    let t = v
      .trim()
      .replace(/^["']|["']$/g, "")
      .trim();
    try {
      // Cookie values are often URI-encoded
      if (/%[0-9A-Fa-f]{2}/.test(t)) t = decodeURIComponent(t);
    } catch {
      /* keep raw */
    }
    if (t) candidates.push(t);
  };

  // Cookie: sherlockToken=...
  const m = raw.match(/(?:^|[;\s\n\r])sherlockToken=([^;\s\n\r]+)/i);
  if (m?.[1]) push(m[1]);

  // Cookie or form: x-arp-session-id=...
  const m2 = raw.match(/(?:^|[;\s\n\r])x-arp-session-id=([^;\s\n\r]+)/i);
  if (m2?.[1]) push(m2[1]);

  // HAR / Network / fetch() headers: "x-arp-session-id": "eyJ..." or x-arp-session-id: eyJ...
  const m3 = raw.match(/["']?x-arp-session-id["']?\s*[:=]\s*["']?([A-Za-z0-9+/=_-]{40,})["']?/i);
  if (m3?.[1]) push(m3[1]);

  // HAR: "sherlockToken": "eyJ..."
  const m4 = raw.match(/["']?sherlockToken["']?\s*[:=]\s*["']?([A-Za-z0-9+/=_-]{40,})["']?/i);
  if (m4?.[1]) push(m4[1]);

  // Bare base64 ARP blob on its own line (line 2 of two-line paste)
  for (const line of raw.split(/[\r\n]+/)) {
    const t = line.trim().replace(/^["']|["']$/g, "");
    // Skip pure JWT lines
    if (looksLikeAdobeJwt(t)) continue;
    if (t.length >= 40 && isValidAdobeArpSessionId(t)) push(t);
  }

  // JWT + ARP joined by whitespace (single-line PasswordBox paste collapses \n → space)
  // Split on whitespace only — NOT on "=" — so we never treat "aux_sid=…" as a token.
  const withoutJwt = raw.replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, " ");
  for (const token of withoutJwt.split(/[\s,;"']+/)) {
    let t = token.trim();
    // If this chunk is name=value from a Cookie header, only keep the value when
    // the name is sherlockToken / x-arp-session-id; skip aux_sid, forter, etc.
    const eq = t.indexOf("=");
    if (eq > 0 && eq < 40 && /^[A-Za-z0-9_.%-]+$/.test(t.slice(0, eq))) {
      const name = t.slice(0, eq).toLowerCase();
      if (name === "sherlocktoken" || name === "x-arp-session-id") {
        t = t.slice(eq + 1).trim();
      } else {
        continue;
      }
    }
    if (t.length >= 40 && isValidAdobeArpSessionId(t)) push(t);
  }

  // Prefer ARP that decodes to JSON with sid+ark (real browser session over opaque short tokens)
  const ranked = candidates
    .map((c) => c.replace(/^["']|["']$/g, "").trim())
    .filter((v) => isValidAdobeArpSessionId(v));
  ranked.sort((a, b) => scoreAdobeArpCandidate(b) - scoreAdobeArpCandidate(a));
  return ranked[0] || "";
}

/** Higher = more like a live firefly-3p x-arp-session-id (sid+ark+ftr[+bfp+fpjs] base64). */
function scoreAdobeArpCandidate(value: string): number {
  let score = value.length;
  try {
    const padded = value + "=".repeat((4 - (value.length % 4)) % 4);
    const json = Buffer.from(padded.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString(
      "utf8"
    );
    const obj = JSON.parse(json) as {
      sid?: unknown;
      ark?: unknown;
      ftr?: unknown;
      bfp?: unknown;
      fpjs?: unknown;
    };
    if (typeof obj.sid === "string" && obj.sid) score += 1000;
    if (typeof obj.ark === "string" && obj.ark.length > 20) score += 500;
    if (typeof obj.ftr === "string" && obj.ftr.includes(ADOBE_FIREFLY_FTR_MAGIC)) score += 200;
    if (typeof obj.ark === "string" && obj.ark.includes(ADOBE_FIREFLY_ARKOSE_PUBLIC_KEY))
      score += 100;
    // Live successful generates (adobe/image_generate.txt) include browser fingerprint fields.
    if (typeof obj.bfp === "string" && obj.bfp.length >= 8) score += 150;
    if (typeof obj.fpjs === "string" && obj.fpjs.length > 10) score += 150;
  } catch {
    /* opaque sherlockToken */
  }
  return score;
}

/**
 * True when the credential blob already contains a browser ARP / sherlockToken
 * OR enough cookie pieces to rebuild one (ff_session_guid + arkose + forterToken).
 * Synthetic-only ARP is a fallback — real cookie pieces are required for stable generate.
 */
export function hasBrowserAdobeArpSession(sessionCookieOrBlob?: string): boolean {
  const blob = String(sessionCookieOrBlob || "");
  if (extractAdobeArpSessionId(blob)) return true;
  // Rebuild path counts as browser ARP (same pieces the SPA uses for sherlockToken).
  const sid = blob.match(/(?:^|[;\s])ff_session_guid=([^;\s]+)/i)?.[1];
  const ark = blob.match(/(?:^|[;\s])arkose=([^;\s]+)/i)?.[1];
  const ftr =
    blob.match(/(?:^|[;\s])forterToken=([^;\s]+)/i)?.[1] ||
    blob.match(/(?:^|[;\s])forter=([^;\s]+)/i)?.[1];
  return Boolean(sid && ark && ftr && !/^[a-f0-9]{32},\d+$/i.test(ftr));
}

/**
 * Resolve ARP for a Firefly request.
 * Prefer cookie rebuild (ff_session_guid + arkose + forterToken [+bfp/fpjs]) over a
 * frozen sherlockToken paste — Forter advances while the pasted ARP goes stale.
 * Fall back to sherlockToken / x-arp-session-id extract, then synthetic rich ARP.
 * Mint once per generate/upload chain and reuse (browser uses the same ARP for upload+submit);
 * on 408 the submit loop rotates ARP separately.
 */
export function resolveAdobeArpSessionId(sessionCookieOrBlob?: string): string {
  const blob = String(sessionCookieOrBlob || "");
  // Lazy require of rebuild helper to avoid circular import at module load.
  // Inline minimal rebuild here (sid+ark+ftr) so resolve stays self-contained.
  const getCookie = (name: string): string => {
    const m = blob.match(new RegExp(`(?:^|[;\\s\\n\\r])${name}=([^;\\s\\n\\r]+)`, "i"));
    if (!m?.[1]) return "";
    let v = m[1].trim();
    try {
      if (/%[0-9A-Fa-f]{2}/.test(v)) v = decodeURIComponent(v);
    } catch {
      /* keep */
    }
    return v;
  };
  const sid = getCookie("ff_session_guid");
  const ark = getCookie("arkose");
  let ftr = getCookie("forterToken") || getCookie("forter");
  try {
    if (/%[0-9A-Fa-f]{2}/.test(ftr)) ftr = decodeURIComponent(ftr);
  } catch {
    /* keep */
  }
  if (ftr.endsWith("v2") && !ftr.endsWith("v2_tt")) ftr = `${ftr}_tt`;
  // Skip localStorage-style "id,timestamp" forter values
  if (/^[a-f0-9]{32},\d+$/i.test(ftr)) ftr = "";
  if (sid && ark && ftr) {
    const bfp = getCookie("bfp");
    let fpjs = getCookie("fpjs");
    try {
      if (fpjs && /%[0-9A-Fa-f]{2}/.test(fpjs)) fpjs = decodeURIComponent(fpjs);
    } catch {
      /* keep */
    }
    const obj: Record<string, string> = { sid, ark, ftr };
    if (bfp) obj.bfp = bfp;
    if (fpjs) obj.fpjs = fpjs;
    return Buffer.from(JSON.stringify(obj), "utf-8").toString("base64");
  }
  const extracted = extractAdobeArpSessionId(blob);
  if (extracted) return extracted;
  return buildAdobeArpSessionId();
}

export function buildAdobeSubmitHeaders(
  accessToken: string,
  extras?: {
    arpSessionId?: string;
    nonce?: string;
    cookie?: string;
    /** Required for deterministic x-nonce (sha256 user_id+prompt). */
    prompt?: string;
  }
): Record<string, string> {
  // Live capture (web_providers/adobe_atach_images.txt) + working clients:
  // Authorization + x-api-key + x-nonce + ALWAYS x-arp-session-id (sid+ark+ftr).
  // Do NOT attach firefly.adobe.com page Cookie to firefly-3p (wrong origin).
  // Prefer real sherlockToken from cookie blob; synthetic ARP is fallback only.
  const cookieBlob = String(extras?.cookie || "").trim();
  const deterministic =
    extras?.nonce ||
    (extras?.prompt ? buildAdobeSubmitNonce(accessToken, extras.prompt) : "") ||
    generateAdobeNonce();
  // Explicit arpSessionId wins (caller may pass synthetic short test ids or real browser ARP).
  const explicitArp = extras?.arpSessionId ? String(extras.arpSessionId).trim() : "";
  const arp = explicitArp || extractAdobeArpSessionId(cookieBlob) || buildAdobeArpSessionId();
  const headers: Record<string, string> = {
    ...browserHeaders(),
    Authorization: `Bearer ${accessToken}`,
    // Must be clio-playground-web — same client_id that minted the IMS token.
    "x-api-key": adobeFireflyApiKey(),
    "content-type": "application/json",
    accept: "*/*",
    // Live SPA capture (2026-09-29) sends no cache-control/pragma on generate-async.
    priority: "u=1, i",
    "x-nonce": deterministic,
    "x-arp-session-id": arp,
  };
  return headers;
}

/** Max reference image size for Firefly storage upload (20 MiB). */
export const ADOBE_FIREFLY_MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

/**
 * Headers for POST /v2/storage/image (raw image body).
 * Live capture (web_providers/adobe_atach_images.txt): Bearer + x-api-key + x-arp + x-nonce
 * + content-type image/png|jpeg (not application/json).
 */
export function buildAdobeUploadHeaders(
  accessToken: string,
  contentType: string,
  extras?: {
    arpSessionId?: string;
    nonce?: string;
    cookie?: string;
    prompt?: string;
  }
): Record<string, string> {
  const base = buildAdobeSubmitHeaders(accessToken, {
    arpSessionId: extras?.arpSessionId,
    nonce: extras?.nonce,
    cookie: extras?.cookie,
    prompt: extras?.prompt || "upload",
  });
  const ct =
    String(contentType || "image/png")
      .trim()
      .toLowerCase() || "image/png";
  return {
    ...base,
    "content-type": ct.startsWith("image/") ? ct : "image/png",
  };
}

/**
 * Collect reference image sources from an OpenAI-style / Media-page image|video body.
 * Supports: image_url, image, images[], image_urls[], input_image(s), reference_images,
 * provider_options.*, and prompt_image fields used by the WinUI Media page.
 */
export function extractAdobeSourceImageSources(body: unknown, max = 4): string[] {
  if (!body || typeof body !== "object") return [];
  const b = body as Record<string, unknown>;
  const po =
    b.provider_options &&
    typeof b.provider_options === "object" &&
    !Array.isArray(b.provider_options)
      ? (b.provider_options as Record<string, unknown>)
      : {};

  const out: string[] = [];
  const seen = new Set<string>();
  const push = (v: unknown) => {
    if (out.length >= max) return;
    if (typeof v === "string") {
      const t = v.trim();
      if (!t || seen.has(t)) return;
      // Skip empty / clearly non-image
      if (t === "null" || t === "undefined") return;
      seen.add(t);
      out.push(t);
      return;
    }
    if (Array.isArray(v)) {
      for (const item of v) {
        if (out.length >= max) break;
        push(item);
      }
      return;
    }
    if (v && typeof v === "object") {
      const o = v as Record<string, unknown>;
      if (typeof o.url === "string") push(o.url);
      else if (typeof o.image_url === "string") push(o.image_url);
      else if (o.image_url && typeof o.image_url === "object") {
        const inner = (o.image_url as Record<string, unknown>).url;
        if (typeof inner === "string") push(inner);
      } else if (typeof o.b64_json === "string") {
        push(`data:image/png;base64,${o.b64_json}`);
      } else if (typeof o.base64 === "string") {
        push(`data:image/png;base64,${o.base64}`);
      }
    }
  };

  // Order matches MediaViewModel / OpenAI edit aliases (primary single fields first).
  const keys = [
    "image_url",
    "imageUrl",
    "input_image",
    "source_image",
    "promptImage",
    "prompt_image",
    "image",
    "images",
    "image_urls",
    "imageUrls",
    "input_images",
    "reference_images",
    "referenceImages",
    "reference_image",
  ];
  for (const k of keys) {
    push(b[k]);
    push(po[k]);
  }

  // OpenAI chat-style content parts (rare on /v1/images but harmless).
  if (Array.isArray(b.messages)) {
    for (const msg of b.messages) {
      if (!msg || typeof msg !== "object") continue;
      const content = (msg as Record<string, unknown>).content;
      if (!Array.isArray(content)) continue;
      for (const part of content) {
        if (!part || typeof part !== "object") continue;
        const p = part as Record<string, unknown>;
        if (p.type === "image_url" || p.type === "image") {
          push(p.image_url ?? p.image ?? p.url);
        }
      }
    }
  }

  return out.slice(0, max);
}

export interface AdobeFireflySourceImageReference {
  source: string;
  usage?: string;
  order?: number;
}

/** Structured extension used when a caller needs style/element/frame semantics. */
export function extractAdobeSourceImageReferences(
  body: unknown,
  max = 4
): AdobeFireflySourceImageReference[] {
  const record = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const explicit = record.adobe_reference_inputs ?? record.adobeReferenceInputs;
  if (Array.isArray(explicit)) {
    const references: AdobeFireflySourceImageReference[] = [];
    for (const value of explicit) {
      if (references.length >= max) break;
      if (!value || typeof value !== "object") continue;
      const item = value as Record<string, unknown>;
      const mediaType = String(item.media_type ?? item.mediaType ?? "image").toLowerCase();
      if (mediaType !== "image") continue;
      const source =
        typeof item.source === "string"
          ? item.source
          : typeof item.url === "string"
            ? item.url
            : typeof item.image_url === "string"
              ? item.image_url
              : "";
      if (!source.trim()) continue;
      const usage = String(item.usage ?? item.usage_type ?? item.usageType ?? "").trim();
      const orderValue = Number(item.order);
      references.push({
        source: source.trim(),
        ...(usage ? { usage } : {}),
        ...(Number.isInteger(orderValue) && orderValue > 0 ? { order: orderValue } : {}),
      });
    }
    return references;
  }
  return extractAdobeSourceImageSources(body, max).map((source) => ({ source }));
}

export function parseAdobeImageSourceBytes(source: string): {
  buffer: Buffer;
  contentType: string;
} {
  const trimmed = String(source || "").trim();
  if (!trimmed) {
    throw new AdobeFireflyError("Empty image reference", 400, "bad_image");
  }

  const dataUri = /^data:([^;,]+)?(?:;charset=[^;,]+)?(;base64)?,([\s\S]+)$/i.exec(trimmed);
  if (dataUri) {
    const mime = (dataUri[1] || "image/png").trim().toLowerCase() || "image/png";
    const isB64 = Boolean(dataUri[2]);
    const payload = dataUri[3] || "";
    if (!isB64) {
      throw new AdobeFireflyError(
        "Image data URL must be base64-encoded (data:image/...;base64,...)",
        400,
        "bad_image"
      );
    }
    const buffer = Buffer.from(payload.replace(/\s/g, ""), "base64");
    if (!buffer.length) {
      throw new AdobeFireflyError("Image data URL decoded to empty bytes", 400, "bad_image");
    }
    if (buffer.length > ADOBE_FIREFLY_MAX_UPLOAD_BYTES) {
      throw new AdobeFireflyError(
        `Image reference too large (${buffer.length} bytes; max ${ADOBE_FIREFLY_MAX_UPLOAD_BYTES})`,
        400,
        "bad_image"
      );
    }
    return {
      buffer,
      contentType: mime.startsWith("image/") ? mime : "image/png",
    };
  }

  // Raw base64 without data: prefix
  if (
    !/^https?:\/\//i.test(trimmed) &&
    /^[A-Za-z0-9+/=\s]+$/.test(trimmed) &&
    trimmed.length > 64
  ) {
    const buffer = Buffer.from(trimmed.replace(/\s/g, ""), "base64");
    if (buffer.length > 0 && buffer.length <= ADOBE_FIREFLY_MAX_UPLOAD_BYTES) {
      return { buffer, contentType: "image/png" };
    }
  }

  throw new AdobeFireflyError(
    "Unsupported image reference (need data:image/...;base64,... or raw base64). " +
      "HTTP(S) URLs are resolved by the caller before upload.",
    400,
    "bad_image"
  );
}

/**
 * Parse Firefly storage upload response: {"images":[{"id":"uuid"}]}.
 */
export function parseAdobeStorageUploadResponse(body: unknown): string {
  if (!body || typeof body !== "object") return "";
  const images = (body as Record<string, unknown>).images;
  if (Array.isArray(images) && images.length > 0) {
    const first = images[0];
    if (first && typeof first === "object") {
      const id = (first as Record<string, unknown>).id;
      if (typeof id === "string" && id.trim()) return id.trim();
    }
  }
  const id = (body as Record<string, unknown>).id;
  if (typeof id === "string" && id.trim()) return id.trim();
  return "";
}

/**
 * Upload one image to Firefly storage → blob id for referenceBlobs.
 * Wire: POST https://firefly-3p.ff.adobe.io/v2/storage/image (raw bytes).
 */
export async function uploadAdobeFireflyImage(opts: {
  accessToken: string;
  bytes: Buffer | Uint8Array;
  contentType?: string;
  sessionCookie?: string;
  /** Reuse the same ARP as generate-async (browser does). */
  arpSessionId?: string;
  /** Used for deterministic x-nonce (optional). */
  prompt?: string;
  fetchImpl?: typeof fetch;
  log?: {
    info?: (...args: unknown[]) => void;
    error?: (...args: unknown[]) => void;
  };
}): Promise<string> {
  const fetchImpl = opts.fetchImpl || fetch;
  const buffer = Buffer.isBuffer(opts.bytes) ? opts.bytes : Buffer.from(opts.bytes);
  if (!buffer.length) {
    throw new AdobeFireflyError("Cannot upload empty image", 400, "bad_image");
  }
  if (buffer.length > ADOBE_FIREFLY_MAX_UPLOAD_BYTES) {
    throw new AdobeFireflyError(
      `Image reference too large (${buffer.length} bytes; max ${ADOBE_FIREFLY_MAX_UPLOAD_BYTES})`,
      400,
      "bad_image"
    );
  }

  const sessionCookie = String(opts.sessionCookie || "").trim();
  const cookieHeader = extractAdobeCookieHeader(sessionCookie);
  // One ARP for the whole chain — do not mint a new synthetic id per upload.
  const arpSessionId =
    (opts.arpSessionId && String(opts.arpSessionId).trim()) ||
    resolveAdobeArpSessionId(cookieHeader || sessionCookie);
  const contentType =
    (opts.contentType && opts.contentType.trim()) ||
    (buffer[0] === 0xff && buffer[1] === 0xd8
      ? "image/jpeg"
      : buffer[0] === 0x89 && buffer[1] === 0x50
        ? "image/png"
        : "image/png");

  const resp = await fetchImpl(ADOBE_FIREFLY_IMAGE_UPLOAD_URL, {
    method: "POST",
    headers: buildAdobeUploadHeaders(opts.accessToken, contentType, {
      arpSessionId,
      cookie: cookieHeader || undefined,
      prompt: opts.prompt || "upload",
    }),
    body: Uint8Array.from(buffer),
  });

  const text = await resp.text().catch(() => "");
  if (resp.status === 401 || resp.status === 403) {
    throw new AdobeFireflyError(
      "Adobe Firefly image upload unauthorized — paste a fresh IMS JWT",
      401,
      "auth"
    );
  }
  if (!resp.ok) {
    throw new AdobeFireflyError(
      `Adobe Firefly image upload failed (${resp.status}): ${sanitizeErrorMessage(text.slice(0, 300))}`,
      resp.status >= 400 && resp.status < 500 ? resp.status : 502,
      "upload"
    );
  }

  let json: unknown = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    throw new AdobeFireflyError("Adobe Firefly image upload returned non-JSON body", 502, "upload");
  }
  const id = parseAdobeStorageUploadResponse(json);
  if (!id) {
    throw new AdobeFireflyError(
      "Adobe Firefly image upload succeeded but no images[].id was returned",
      502,
      "upload"
    );
  }
  opts.log?.info?.("ADOBE-FIREFLY", `uploaded reference image id=${id} (${buffer.length} bytes)`);
  return id;
}

/**
 * Resolve Media/OpenAI body image fields → Firefly storage blob ids.
 * - data: URLs / raw base64 → upload
 * - http(s) URLs → fetch then upload
 * - already looks like a UUID blob id → use as-is (advanced)
 */
export async function resolveAdobeSourceImageIds(opts: {
  accessToken: string;
  body: unknown;
  max?: number;
  sessionCookie?: string;
  /** Shared ARP for upload+generate (required for stable Firefly 3P). */
  arpSessionId?: string;
  prompt?: string;
  fetchImpl?: typeof fetch;
  log?: {
    info?: (...args: unknown[]) => void;
    error?: (...args: unknown[]) => void;
  };
}): Promise<string[]> {
  const max = Math.max(1, Math.min(32, opts.max ?? 4));
  const sources = extractAdobeSourceImageSources(opts.body, max);
  if (!sources.length) return [];

  const fetchImpl = opts.fetchImpl || fetch;
  const ids: string[] = [];
  // One ARP for all uploads in this request (browser reuses the same header).
  const arpSessionId =
    (opts.arpSessionId && String(opts.arpSessionId).trim()) ||
    resolveAdobeArpSessionId(opts.sessionCookie);

  for (const src of sources) {
    // Already a Firefly storage id (uuid)
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(src)) {
      ids.push(src);
      continue;
    }

    let buffer: Buffer;
    let contentType = "image/png";

    if (/^https?:\/\//i.test(src)) {
      const r = await fetchImpl(src, {
        method: "GET",
        headers: { accept: "image/*,*/*" },
      });
      if (!r.ok) {
        throw new AdobeFireflyError(
          `Failed to download reference image (${r.status}): ${src.slice(0, 120)}`,
          400,
          "bad_image"
        );
      }
      const ab = await r.arrayBuffer();
      buffer = Buffer.from(ab);
      const ct = r.headers.get("content-type") || "";
      if (ct.toLowerCase().startsWith("image/")) {
        contentType = ct.split(";")[0]!.trim();
      }
    } else {
      const parsed = parseAdobeImageSourceBytes(src);
      buffer = parsed.buffer;
      contentType = parsed.contentType;
    }

    const id = await uploadAdobeFireflyImage({
      accessToken: opts.accessToken,
      bytes: buffer,
      contentType,
      sessionCookie: opts.sessionCookie,
      arpSessionId,
      prompt: opts.prompt,
      fetchImpl,
      log: opts.log,
    });
    ids.push(id);
  }

  return ids;
}

export async function resolveAdobeSourceImageReferences(opts: {
  accessToken: string;
  body: unknown;
  max?: number;
  sessionCookie?: string;
  prompt?: string;
  fetchImpl?: typeof fetch;
  log?: { info?: (...args: unknown[]) => void; error?: (...args: unknown[]) => void };
}): Promise<AdobeFireflyReferenceBlob[]> {
  const max = Math.max(1, Math.min(32, opts.max ?? 4));
  const references = extractAdobeSourceImageReferences(opts.body, max);
  if (references.length === 0) return [];
  const ids = await resolveAdobeSourceImageIds({
    ...opts,
    max,
    body: { images: references.map((reference) => reference.source) },
  });
  return ids.map((id, index) => ({
    id,
    mediaType: "image",
    ...(references[index]?.usage ? { usage: references[index].usage } : {}),
    ...(references[index]?.order ? { order: references[index].order } : {}),
  }));
}

/** Transient Adobe 3P overload / rate / edge errors worth retrying. */
export function isAdobeTransientSubmitError(status: number, bodyText: string): boolean {
  if (status === 408 || status === 429 || status === 502 || status === 503 || status === 504) {
    return true;
  }
  const t = (bodyText || "").toLowerCase();
  return (
    t.includes("timeout_error") ||
    t.includes("system under load") ||
    t.includes("try again") ||
    t.includes("temporarily") ||
    t.includes("overloaded")
  );
}

export function buildAdobePollHeaders(accessToken: string): Record<string, string> {
  // Live adobe/status_check.txt: Bearer + accept only (no x-api-key, no Cookie).
  return {
    Authorization: `Bearer ${accessToken}`,
    accept: "*/*",
    "cache-control": "no-cache",
    pragma: "no-cache",
    "user-agent": DEFAULT_USER_AGENT,
    referer: FIREFLY_REFERER,
  };
}

export function buildAdobeBalanceHeaders(accessToken: string): Record<string, string> {
  const accountId = extractAdobeAccountIdFromToken(accessToken);
  const headers: Record<string, string> = {
    ...browserHeaders(),
    Authorization: `Bearer ${accessToken}`,
    accept: "application/json",
    "content-type": "application/json",
    "x-api-key": adobeFireflyBalanceApiKey(),
  };
  if (accountId) headers["x-account-id"] = accountId;
  return headers;
}

export function buildAdobeDiscoveryHeaders(accessToken: string): Record<string, string> {
  return {
    ...browserHeaders(),
    Authorization: `Bearer ${accessToken}`,
    "x-api-key": adobeFireflyApiKey(),
    "content-type": "application/json",
    // Missing Accept → HTTP 406 "Unsupported Accept Type or not allowed".
    accept: "*/*",
  };
}

/** User-facing message when Adobe colligo returns 408 "system under load". */
export function formatAdobeSystemUnderLoadError(
  kind: "image" | "video",
  attempts: number,
  opts?: { hadBrowserArp?: boolean }
): string {
  const hadArp = opts?.hadBrowserArp === true;
  if (!hadArp) {
    return (
      `Adobe Firefly ${kind} generation failed (HTTP 408 "system under load", after ${attempts} attempt` +
      `${attempts === 1 ? "" : "s"}). Your credential is missing a browser x-arp-session-id / sherlockToken ` +
      `(JWT alone almost always 408s even when credits/Limits work). Re-open the Adobe Firefly account and paste ` +
      `TWO lines from a SUCCESSFUL firefly-3p.ff.adobe.io generate-async request (F12 → Network): ` +
      `(1) Authorization token AFTER "Bearer " (eyJ… JWT), (2) the raw x-arp-session-id header value ` +
      `OR Cookie containing sherlockToken. Use the multi-line credential box so both lines are kept.`
    );
  }
  return (
    `Adobe Firefly ${kind} generation failed (HTTP 408 "system under load", after ${attempts} attempt` +
    `${attempts === 1 ? "" : "s"}). JWT was accepted for balance/discovery but colligo rejected the risk session ` +
    `(Forter/Arkose stale or rate-limited). The app spaces submits, sticks to the last working x-arp-session-id, ` +
    `and on 408 auto-warms Forter/ARP via off-screen Chrome CDP (true headless is rejected by colligo — set ADOBE_FIREFLY_CHROME_HEADLESS=1 only for debug). ` +
    `Paste the full firefly.adobe.com Cookie once with the JWT so recovery can run. If it still fails after that, ` +
    `open firefly.adobe.com, generate one image in-browser, then paste a FRESH multi-line credential (JWT + Cookie) once.`
  );
}

export function extractAdobeResultLink(
  headers: Headers | Record<string, string | null | undefined>,
  body: unknown
): string {
  const get = (name: string): string => {
    if (typeof (headers as Headers).get === "function") {
      return String((headers as Headers).get(name) || "").trim();
    }
    const rec = headers as Record<string, string | null | undefined>;
    const key = Object.keys(rec).find((k) => k.toLowerCase() === name.toLowerCase());
    return String((key ? rec[key] : "") || "").trim();
  };

  const override = get("x-override-status-link");
  if (override) return override;

  const data = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const links =
    data.links && typeof data.links === "object" ? (data.links as Record<string, unknown>) : {};
  const result = links.result;
  if (typeof result === "string" && result) return result;
  if (result && typeof result === "object") {
    const href = (result as Record<string, unknown>).href;
    if (typeof href === "string" && href) return href;
  }
  if (typeof data.statusUrl === "string" && data.statusUrl) return data.statusUrl;
  if (typeof data.resultUrl === "string" && data.resultUrl) return data.resultUrl;
  return "";
}

/**
 * Rewrite Firefly EPO result links to the BKS poll endpoint used by the SPA.
 *
 * Live capture (adobe/status_check.txt):
 *   links.result = https://firefly-epo855232.adobe.io/jobs/result/{jobId}
 *   poll URL     = https://bks-epo8552.adobe.io/v2/jobs/result/{jobId}?host=firefly-epo855232.adobe.io
 *
 * BKS host uses the first 4 digits of the EPO id when the id is longer (855232 → 8552).
 */
export function normalizeAdobePollUrl(rawUrl: string): string {
  const url = String(rawUrl || "").trim();
  if (!url) return url;
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    if (!host.startsWith("firefly-epo")) return url;

    const path = parsed.pathname || "";
    const isJobPath =
      path.includes("/jobs/result/") || path.includes("/v2/status") || path.includes("/status/");
    if (!isJobPath) return url;

    const jobId = path.split("/").filter(Boolean).pop() || "";
    if (!jobId || jobId === "status" || jobId === "result") return url;

    const epoId = host.slice("firefly-epo".length).split(".")[0] || "";
    // 855232 → 8552 (browser BKS host); short ids kept as-is.
    const bksId = epoId.length > 4 ? epoId.slice(0, 4) : epoId;
    return `https://bks-epo${bksId}.adobe.io/v2/jobs/result/${jobId}?host=${host}`;
  } catch {
    return url;
  }
}

export function extractAdobeMediaUrl(latest: unknown, kind: "image" | "video"): string | null {
  const body = latest && typeof latest === "object" ? (latest as Record<string, unknown>) : {};
  const outputs = Array.isArray(body.outputs) ? body.outputs : [];
  if (outputs.length > 0) {
    const first =
      outputs[0] && typeof outputs[0] === "object" ? (outputs[0] as Record<string, unknown>) : {};
    const media =
      kind === "image"
        ? first.image && typeof first.image === "object"
          ? (first.image as Record<string, unknown>)
          : null
        : first.video && typeof first.video === "object"
          ? (first.video as Record<string, unknown>)
          : null;
    const url = media && typeof media.presignedUrl === "string" ? media.presignedUrl : null;
    if (url) return url;
  }

  // Fallback recursive search for a presigned URL.
  const found = findPresignedUrl(
    latest,
    kind === "image" ? [".png", ".jpg", ".jpeg", ".webp"] : [".mp4", ".webm"]
  );
  return found;
}

function findPresignedUrl(obj: unknown, exts: string[]): string | null {
  if (!obj) return null;
  if (typeof obj === "string") {
    const s = obj.trim();
    if (
      /^https?:\/\//i.test(s) &&
      (exts.some((e) => s.toLowerCase().includes(e)) ||
        s.includes("presigned") ||
        s.includes("X-Amz"))
    ) {
      return s;
    }
    return null;
  }
  if (Array.isArray(obj)) {
    for (const item of obj) {
      const found = findPresignedUrl(item, exts);
      if (found) return found;
    }
    return null;
  }
  if (typeof obj === "object") {
    const rec = obj as Record<string, unknown>;
    if (typeof rec.presignedUrl === "string" && rec.presignedUrl) return rec.presignedUrl;
    for (const value of Object.values(rec)) {
      const found = findPresignedUrl(value, exts);
      if (found) return found;
    }
  }
  return null;
}

export function isAdobeJobInProgress(status: string): boolean {
  const s = String(status || "").toUpperCase();
  return (
    !s ||
    s === "IN_PROGRESS" ||
    s === "PENDING" ||
    s === "RUNNING" ||
    s === "QUEUED" ||
    s === "PROCESSING" ||
    s === "SUBMITTED"
  );
}

export function isAdobeJobFailed(status: string): boolean {
  const s = String(status || "").toUpperCase();
  return s === "FAILED" || s === "CANCELLED" || s === "ERROR" || s === "CANCELED";
}

type ImsTokenResponse = {
  access_token?: string;
  account_type?: string;
  guestId?: string;
  token_type?: string;
  error?: string;
  error_description?: string;
};

async function imsCheckToken(opts: {
  cookie: string;
  clientId: string;
  guestAllowed: boolean;
  fetchImpl: typeof fetch;
}): Promise<
  { ok: true; token: string; data: ImsTokenResponse } | { ok: false; status: number; error: string }
> {
  const form = new URLSearchParams({
    client_id: opts.clientId,
    scope: ADOBE_FIREFLY_IMS_SCOPE,
    guest_allowed: opts.guestAllowed ? "true" : "false",
  });

  const resp = await opts.fetchImpl(ADOBE_FIREFLY_IMS_REFRESH_URL, {
    method: "POST",
    headers: {
      Accept: "*/*",
      "Accept-Language": "en-US,en;q=0.9",
      "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
      Cookie: opts.cookie,
      Origin: FIREFLY_ORIGIN,
      Referer: FIREFLY_REFERER,
      "User-Agent": DEFAULT_USER_AGENT,
    },
    body: form.toString(),
  });

  const text = await resp.text().catch(() => "");
  let data: ImsTokenResponse | null = null;
  try {
    data = JSON.parse(text) as ImsTokenResponse;
  } catch {
    data = null;
  }

  if (!resp.ok) {
    return {
      ok: false,
      status: resp.status,
      error: sanitizeErrorMessage(
        data?.error_description || data?.error || text.slice(0, 200) || `HTTP ${resp.status}`
      ),
    };
  }

  const token = String(data?.access_token || "").trim();
  if (!token) {
    return {
      ok: false,
      status: 401,
      error: sanitizeErrorMessage(
        data?.error_description || data?.error || "IMS response missing access_token"
      ),
    };
  }
  return { ok: true, token, data: data || {} };
}

/**
 * Exchange a browser Cookie header for an Adobe IMS **user** access_token.
 *
 * Live repro (user firefly.adobe.com Cookie export):
 * - guest_allowed=true → account_type=guest (no AdobeID) → generate 401 / balance 403
 * - guest_allowed=false → "All session cookies are empty" (IMS cookies live on adobelogin.com)
 *
 * Reliable path: paste Authorization Bearer JWT from a live firefly-3p request.
 */
export async function exchangeAdobeCookieForAccessToken(
  cookieHeader: string,
  fetchImpl: typeof fetch = fetch
): Promise<string> {
  const cookie = String(cookieHeader || "").trim();
  if (!cookie) {
    throw new AdobeFireflyError("Adobe Firefly cookie is empty", 401, "missing_cookie");
  }

  // HAR / mixed paste that already contains a user JWT
  const embedded = extractAdobeCredentialToken(cookie);
  if (embedded !== cookie && looksLikeAdobeJwt(embedded)) {
    if (isAdobeGuestAccessToken(embedded)) {
      throw new AdobeFireflyError(GUEST_COOKIE_HELP, 401, "guest_token");
    }
    return embedded;
  }

  const clientIds = [adobeFireflyApiKey(), adobeFireflyExpressClientId()].filter(
    (id, i, arr) => id && arr.indexOf(id) === i
  );

  let sawEmptySession = false;
  let lastError = "";
  let lastStatus = 502;
  let guestTokenSeen = false;

  for (const clientId of clientIds) {
    // 1) Authenticated session only (needs IMS cookies from adobelogin.com)
    const authed = await imsCheckToken({
      cookie,
      clientId,
      guestAllowed: false,
      fetchImpl,
    });
    if (authed.ok) {
      if (
        isAdobeGuestAccessToken(authed.token) ||
        authed.data.account_type === "guest" ||
        authed.data.guestId
      ) {
        guestTokenSeen = true;
      } else {
        return authed.token;
      }
    } else {
      lastStatus = authed.status;
      lastError = authed.error;
      if (/session cookies are empty/i.test(authed.error)) sawEmptySession = true;
    }

    // 2) Guest path — never accept guest tokens for Firefly media/limits
    const guest = await imsCheckToken({
      cookie,
      clientId,
      guestAllowed: true,
      fetchImpl,
    });
    if (guest.ok) {
      if (
        guest.data.account_type === "guest" ||
        guest.data.guestId ||
        isAdobeGuestAccessToken(guest.token)
      ) {
        guestTokenSeen = true;
        lastError = "IMS returned a guest token (no AdobeID session)";
        lastStatus = 401;
        continue;
      }
      return guest.token;
    }
    lastStatus = guest.status;
    lastError = guest.error;
    if (/session cookies are empty/i.test(guest.error)) sawEmptySession = true;
  }

  if (guestTokenSeen || sawEmptySession) {
    throw new AdobeFireflyError(GUEST_COOKIE_HELP, 401, "guest_token");
  }

  throw new AdobeFireflyError(
    `Adobe IMS token exchange failed (${lastStatus}): ${lastError || "no access_token"}. ${GUEST_COOKIE_HELP}`,
    lastStatus === 401 || lastStatus === 403 ? 401 : 502,
    "ims_refresh_failed"
  );
}

/**
 * Resolve credentials into a usable **user** IMS access token (rejects guest tokens).
 */
export async function resolveAdobeAccessToken(
  credentials:
    | {
        apiKey?: string;
        accessToken?: string;
        providerSpecificData?: {
          cookie?: unknown;
          access_token?: unknown;
          accessToken?: unknown;
        } | null;
      }
    | null
    | undefined,
  fetchImpl: typeof fetch = fetch
): Promise<string> {
  const psd = credentials?.providerSpecificData;
  const candidates: string[] = [];
  const push = (v: unknown) => {
    if (typeof v === "string" && v.trim()) candidates.push(v.trim());
  };
  push(credentials?.apiKey);
  push(credentials?.accessToken);
  push(psd?.access_token);
  push(psd?.accessToken);
  push(psd?.cookie);

  if (candidates.length === 0) {
    throw new AdobeFireflyError(
      "Adobe Firefly credentials missing. " + GUEST_COOKIE_HELP,
      401,
      "missing_credentials"
    );
  }

  for (const c of candidates) {
    const extracted = extractAdobeCredentialToken(c);
    if (looksLikeAdobeJwt(extracted) && isAdobeUserAccessToken(extracted)) {
      return extracted;
    }
  }

  for (const c of candidates) {
    const extracted = extractAdobeCredentialToken(c);
    if (looksLikeAdobeJwt(extracted) && isAdobeGuestAccessToken(extracted)) {
      throw new AdobeFireflyError(GUEST_COOKIE_HELP, 401, "guest_token");
    }
  }

  const cookieBlob =
    candidates.find(
      (c) =>
        c.includes(";") ||
        c.toLowerCase().includes("aux_sid") ||
        c.toLowerCase().includes("ff_session")
    ) || candidates[0];

  const token = await exchangeAdobeCookieForAccessToken(cookieBlob, fetchImpl);
  if (isAdobeGuestAccessToken(token)) {
    throw new AdobeFireflyError(GUEST_COOKIE_HELP, 401, "guest_token");
  }
  return token;
}

// ── Credits balance (Limits) ────────────────────────────────────────────────

export interface AdobeFireflyCreditsBalance {
  total: number;
  used: number;
  remaining: number;
  availableUntil: string | null;
  freeTotal: number;
  freeUsed: number;
  freeRemaining: number;
  planTotal: number;
  planUsed: number;
  planRemaining: number;
  raw?: unknown;
}

function readQuotaBlock(block: unknown): {
  total: number;
  used: number;
  available: number;
} {
  if (!block || typeof block !== "object") return { total: 0, used: 0, available: 0 };
  const q =
    (block as Record<string, unknown>).quota &&
    typeof (block as Record<string, unknown>).quota === "object"
      ? ((block as Record<string, unknown>).quota as Record<string, unknown>)
      : (block as Record<string, unknown>);
  const total = Number(q.total ?? 0);
  const used = Number(q.used ?? 0);
  const available = Number(q.available ?? Math.max(0, total - used));
  return {
    total: Number.isFinite(total) ? total : 0,
    used: Number.isFinite(used) ? used : 0,
    available: Number.isFinite(available) ? available : 0,
  };
}

/**
 * Parse GET /v1/credits/balance JSON (adobe/balance.txt Response).
 * total.quota = aggregate; credits.firefly_* = free + plan buckets.
 */
export function parseAdobeCreditsBalance(body: unknown): AdobeFireflyCreditsBalance {
  const root = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const totalBlock = readQuotaBlock(root.total);
  const credits =
    root.credits && typeof root.credits === "object"
      ? (root.credits as Record<string, unknown>)
      : {};
  const free = readQuotaBlock(credits.firefly_free_credit);
  const plan = readQuotaBlock(credits.firefly_plan_credit);

  // Prefer top-level total; fall back to free+plan sum when total missing.
  let total = totalBlock.total;
  let used = totalBlock.used;
  let remaining = totalBlock.available;
  if (total <= 0 && (free.total > 0 || plan.total > 0)) {
    total = free.total + plan.total;
    used = free.used + plan.used;
    remaining = free.available + plan.available;
  }
  if (remaining <= 0 && total > 0) remaining = Math.max(0, total - used);

  const availableUntil =
    root.total &&
    typeof root.total === "object" &&
    typeof (root.total as Record<string, unknown>).availableUntil === "string"
      ? String((root.total as Record<string, unknown>).availableUntil)
      : null;

  return {
    total,
    used,
    remaining,
    availableUntil,
    freeTotal: free.total,
    freeUsed: free.used,
    freeRemaining: free.available,
    planTotal: plan.total,
    planUsed: plan.used,
    planRemaining: plan.available,
    raw: body,
  };
}

export async function fetchAdobeCreditsBalance(
  accessToken: string,
  fetchImpl: typeof fetch = fetch
): Promise<AdobeFireflyCreditsBalance> {
  const resp = await fetchImpl(ADOBE_FIREFLY_CREDITS_BALANCE_URL, {
    method: "GET",
    headers: buildAdobeBalanceHeaders(accessToken),
  });
  if (resp.status === 401 || resp.status === 403) {
    throw new AdobeFireflyError("Adobe Firefly balance: token invalid or expired", 401, "auth");
  }
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new AdobeFireflyError(
      `Adobe Firefly balance failed (${resp.status}): ${sanitizeErrorMessage(text.slice(0, 200))}`,
      502
    );
  }
  const data = await resp.json().catch(() => ({}));
  return parseAdobeCreditsBalance(data);
}

// ── Models discovery ────────────────────────────────────────────────────────

export async function discoverAdobeFireflyModels(
  accessToken: string,
  fetchImpl: typeof fetch = fetch
) {
  const resp = await fetchImpl(ADOBE_FIREFLY_MODELS_DISCOVERY_URL, {
    method: "POST",
    headers: buildAdobeDiscoveryHeaders(accessToken),
    body: JSON.stringify({ filters: { resolveSchema: true } }),
  });
  if (resp.status === 401 || resp.status === 403) {
    throw new AdobeFireflyError(
      "Adobe Firefly model discovery: token invalid or expired",
      401,
      "auth"
    );
  }
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new AdobeFireflyError(
      `Adobe Firefly model discovery failed (${resp.status}): ${sanitizeErrorMessage(text.slice(0, 200))}`,
      502
    );
  }
  const data = await resp.json().catch(() => ({}));
  return parseAdobeModelsDiscovery(data);
}

let lastOnDemandDiscoveryAt = 0;

/**
 * Resolve a model id; when it is unknown to the snapshot/registry, run ONE live discovery with
 * the session token (throttled to once per minute), register the results and retry.
 */
export async function resolveAdobeModelWithDiscovery(
  kind: "image" | "video",
  model: string,
  accessToken: string,
  fetchImpl: typeof fetch = fetch
): Promise<void> {
  const resolve = () =>
    kind === "image" ? resolveAdobeImageModel(model) : resolveAdobeVideoModel(model);
  try {
    resolve();
    return;
  } catch (err) {
    if (!accessToken || Date.now() - lastOnDemandDiscoveryAt < 60_000) throw err;
  }
  lastOnDemandDiscoveryAt = Date.now();
  try {
    const { mapDiscoveredToCatalog, registerAdobeFireflyDiscoveredModels } =
      await import("./adobeFireflyModels.ts");
    registerAdobeFireflyDiscoveredModels(
      mapDiscoveredToCatalog(await discoverAdobeFireflyModels(accessToken, fetchImpl))
    );
  } catch {
    /* fall through to the unknown-model error */
  }
  resolve();
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export async function pollAdobeJob(opts: {
  pollUrl: string;
  accessToken: string;
  kind: "image" | "video";
  timeoutMs: number;
  pollIntervalMs?: number;
  /** Optional session cookie so a mid-poll 401 can renew JWT once via CDP. */
  sessionCookie?: string;
  sessionFingerprint?: string;
  fetchImpl?: typeof fetch;
  log?: {
    info?: (...args: unknown[]) => void;
    error?: (...args: unknown[]) => void;
  };
}): Promise<{ mediaUrl: string; latest: unknown }> {
  const fetchImpl = opts.fetchImpl || fetch;
  const deadline = Date.now() + opts.timeoutMs;
  const interval =
    opts.pollIntervalMs && opts.pollIntervalMs > 0 ? opts.pollIntervalMs : DEFAULT_POLL_INTERVAL_MS;
  let attempt = 0;
  let latest: unknown = {};
  let accessToken = opts.accessToken;
  let authRefreshAttempted = false;

  while (Date.now() < deadline) {
    attempt += 1;
    const pollResp = await fetchImpl(opts.pollUrl, {
      method: "GET",
      headers: buildAdobePollHeaders(accessToken),
    });

    if (pollResp.status === 401 || pollResp.status === 403) {
      const accessError = pollResp.headers.get("x-access-error") || "";
      if (accessError === "taste_exhausted") {
        throw new AdobeFireflyError(
          "Adobe Firefly quota exhausted for this account",
          429,
          "quota_exhausted"
        );
      }
      // One CDP JWT renewal mid-poll (long jobs can outlive a near-expiry IMS token).
      if (!authRefreshAttempted && opts.sessionCookie) {
        authRefreshAttempted = true;
        try {
          const {
            rotateAdobeFireflySessionOnError,
            fingerprintAdobeCredential,
            estimateAdobeTokenExpiry,
          } = await import("./adobeFireflySession.ts");
          const fp =
            String(opts.sessionFingerprint || "").trim() ||
            fingerprintAdobeCredential(
              [accessToken, opts.sessionCookie].filter(Boolean).join("\n")
            );
          const refreshed = await rotateAdobeFireflySessionOnError(
            {
              accessToken,
              cookie: opts.sessionCookie,
              arpSessionId: "",
              tokenExpiresAt: estimateAdobeTokenExpiry(accessToken),
              updatedAt: Date.now(),
              fingerprint: fp,
              source: "rebuild",
            },
            { attempt: 3, authFailure: true, tryBrowser: true, log: opts.log }
          );
          if (refreshed?.accessToken && isAdobeUserAccessToken(refreshed.accessToken)) {
            accessToken = refreshed.accessToken;
            opts.log?.info?.(
              "ADOBE-FIREFLY",
              `poll auth ${pollResp.status}; retrying once with renewed JWT`
            );
            continue;
          }
        } catch {
          /* fall through to auth error */
        }
      }
      throw new AdobeFireflyError("Adobe Firefly token invalid or expired", 401, "auth");
    }

    if (!pollResp.ok) {
      const text = await pollResp.text().catch(() => "");
      if (
        pollResp.status === 408 ||
        pollResp.status === 429 ||
        pollResp.status === 451 ||
        pollResp.status >= 500 ||
        isAdobeTransientSubmitError(pollResp.status, text)
      ) {
        opts.log?.info?.("ADOBE-FIREFLY", `poll temporary ${pollResp.status}, attempt #${attempt}`);
        await sleep(interval);
        continue;
      }
      throw new AdobeFireflyError(
        `Adobe Firefly poll failed (${pollResp.status}): ${sanitizeErrorMessage(text.slice(0, 300))}`,
        502
      );
    }

    latest = await pollResp.json().catch(() => ({}));
    const statusHeader = String(pollResp.headers.get("x-task-status") || "").toUpperCase();
    const statusVal = String(
      (latest && typeof latest === "object" ? (latest as Record<string, unknown>).status : "") ||
        statusHeader ||
        ""
    ).toUpperCase();

    const mediaUrl = extractAdobeMediaUrl(latest, opts.kind);
    if (mediaUrl) {
      return { mediaUrl, latest };
    }

    if (isAdobeJobFailed(statusVal)) {
      throw new AdobeFireflyError(
        `Adobe Firefly ${opts.kind} job failed: ${sanitizeErrorMessage(JSON.stringify(latest).slice(0, 300))}`,
        502,
        "job_failed"
      );
    }

    opts.log?.info?.(
      "ADOBE-FIREFLY",
      `${opts.kind} pending #${attempt} status=${statusVal || "unknown"}`
    );
    await sleep(interval);
  }

  throw new AdobeFireflyError(`Adobe Firefly ${opts.kind} generation timed out`, 504, "timeout");
}

// Colligo often returns instant 408 with x-colligo-timeout:0.0 under load OR when
// generate-async is hammered in a batch. Space submits (gate) + reuse sticky ARP;
// do NOT thrash synthetic rebuilds on every retry (identical forter → no-op).
// More attempts: 1–2 reuse sticky ARP when forter is fresh; stale forter / attempt 3+ → off-screen Chrome warm.
// 3, not 5: each rejected submit counts against the account — live, a burst of rejected 408
// submits was followed by Adobe revoking the IMS session (401013 "Oauth token is not valid").
const SUBMIT_MAX_ATTEMPTS = 3;
/** Base backoff after 408; combined with withAdobeFireflySubmitGate (~12s min gap). */
function submitBaseDelayMs(): number {
  if (
    process.env.ADOBE_FIREFLY_SUBMIT_BASE_DELAY_MS != null &&
    process.env.ADOBE_FIREFLY_SUBMIT_BASE_DELAY_MS !== ""
  ) {
    return Math.max(0, Number(process.env.ADOBE_FIREFLY_SUBMIT_BASE_DELAY_MS) || 0);
  }
  if (process.env.NODE_ENV === "test" || process.env.VITEST || process.env.NODE_TEST_CONTEXT)
    return 20;
  return 8000;
}

/** Short, secret-free summary of an Adobe 401/403 body (e.g. `401013 Oauth token is not valid`). */
export function summarizeAdobeAuthBody(bodyText: string): string {
  const text = String(bodyText || "").trim();
  if (!text) return "";
  try {
    const obj = JSON.parse(text) as Record<string, unknown>;
    const code = obj.error_code ?? obj.code ?? obj.title ?? "";
    const msg = obj.message ?? obj.error_description ?? obj.error ?? "";
    return sanitizeErrorMessage(
      `${code ? `${code} ` : ""}${String(msg || "")}`.trim().slice(0, 160)
    );
  } catch {
    return sanitizeErrorMessage(text.replace(/\s+/g, " ").slice(0, 160));
  }
}

/** True when an Adobe 401/403 is about credits/entitlement rather than an invalid token. */
export function isAdobeQuotaDenial(accessError: string, bodyText: string): boolean {
  if (accessError === "taste_exhausted") return true;
  return /taste_exhausted|quota|insufficient|credit|exhausted|entitle/i.test(
    String(bodyText || "")
  );
}

/** User-facing message for a token Adobe rejected even after one renewal attempt. */
export function formatAdobeAuthRejectedMessage(status: number, detail: string): string {
  return (
    `Adobe Firefly rejected the sign-in token (HTTP ${status}${detail ? `: ${detail}` : ""}). ` +
    "The Adobe session was signed out or expired and automatic renewal did not produce a new " +
    "token. Open Providers → Adobe Firefly → Add Account (OAuth) → Sign in with browser (or paste " +
    "a fresh JWT + Cookie). Requests with this token now fail immediately for a few minutes " +
    "instead of queueing."
  );
}

/** Sherlock SDK ARP = base64 JSON with exactly the browser fields sid/ftr/ark/bfp (no fpjs). */
function looksLikeSherlockMintedArp(value: string): boolean {
  try {
    const raw = String(value || "").trim();
    const obj = JSON.parse(
      Buffer.from(raw + "=".repeat((4 - (raw.length % 4)) % 4), "base64").toString("utf8")
    ) as Record<string, unknown>;
    // Sherlock emits keys in this exact order; cookie rebuilds use sid,ark,ftr[,bfp,fpjs].
    return (
      Object.keys(obj).join(",") === "sid,ftr,ark,bfp" &&
      ["sid", "ftr", "ark", "bfp"].every((k) => typeof obj[k] === "string" && obj[k])
    );
  } catch {
    return false;
  }
}

interface AdobeSubmitState {
  accessToken: string;
  cookie: string;
  arpSessionId: string;
  fingerprint: string;
  browserSessionKey: string;
}

/**
 * 401/403 on generate-async. Returns normally ONLY when a renewed, different token was applied
 * (caller retries); otherwise throws. Quota/entitlement denials never trigger renewal, and a
 * token that stays rejected trips the per-account auth breaker so queued requests fail fast.
 */
async function handleAdobeSubmitAuthFailure(opts: {
  kind: "image" | "video";
  response: Response;
  attempt: number;
  state: AdobeSubmitState;
  applyRenewed: (session: { accessToken: string; cookie: string; arpSessionId: string }) => void;
  alreadyRenewed: boolean;
  markRenewed: () => void;
  log?: { info?: (...args: unknown[]) => void; error?: (...args: unknown[]) => void };
}): Promise<void> {
  const session = await import("./adobeFireflySession.ts");
  session.noteAdobeFireflySubmitFailure();
  const status = opts.response.status;
  const accessError = opts.response.headers.get("x-access-error") || "";
  const bodyText = await opts.response.text().catch(() => "");
  const detail = summarizeAdobeAuthBody(bodyText);
  if (isAdobeQuotaDenial(accessError, bodyText)) {
    throw new AdobeFireflyError(
      `Adobe Firefly quota exhausted for this account${detail ? ` (${detail})` : ""}`,
      429,
      "quota_exhausted"
    );
  }
  opts.log?.info?.(
    "ADOBE-FIREFLY",
    `${opts.kind} submit auth ${status}${detail ? ` (${detail})` : ""}; attempt ${opts.attempt}`
  );
  const { state } = opts;
  if (!opts.alreadyRenewed && opts.attempt < SUBMIT_MAX_ATTEMPTS) {
    opts.markRenewed();
    const refreshed = await session
      .rotateAdobeFireflySessionOnError(
        {
          accessToken: state.accessToken,
          cookie: state.cookie,
          arpSessionId: state.arpSessionId,
          tokenExpiresAt: session.estimateAdobeTokenExpiry(state.accessToken),
          updatedAt: Date.now(),
          fingerprint: state.fingerprint,
          browserSessionKey: state.browserSessionKey,
          source: "rebuild",
        },
        { attempt: opts.attempt, authFailure: true, tryBrowser: true, log: opts.log }
      )
      .catch(() => null);
    // Only a DIFFERENT token can fix "Oauth token is not valid" — resubmitting the same one
    // just burns another gated submit.
    if (
      refreshed?.accessToken &&
      isAdobeUserAccessToken(refreshed.accessToken) &&
      refreshed.accessToken !== state.accessToken
    ) {
      opts.applyRenewed({
        accessToken: refreshed.accessToken,
        cookie: refreshed.cookie,
        arpSessionId: refreshed.arpSessionId,
      });
      opts.log?.info?.("ADOBE-FIREFLY", `${opts.kind} submit: retrying once with renewed token`);
      return;
    }
  }
  const message = formatAdobeAuthRejectedMessage(status, detail);
  session.markAdobeFireflyAuthDead(state.fingerprint, state.accessToken, message);
  throw new AdobeFireflyError(message, 401, "auth_rejected");
}

/** Throw immediately when another request already proved this token dead. */
async function assertAdobeTokenNotDead(fingerprint: string, accessToken: string): Promise<void> {
  const { getAdobeFireflyAuthDeadMessage } = await import("./adobeFireflySession.ts");
  const message = getAdobeFireflyAuthDeadMessage(fingerprint, accessToken);
  if (message) throw new AdobeFireflyError(message, 401, "auth_rejected");
}

export async function adobeFireflyGenerateImage(opts: {
  accessToken: string;
  prompt: string;
  model: string;
  size?: unknown;
  aspectRatio?: unknown;
  quality?: unknown;
  seed?: number;
  sourceImageIds?: string[];
  references?: AdobeFireflyReferenceBlob[];
  negativePrompt?: string;
  /** Optional Cookie blob — used only to lift sherlockToken → x-arp-session-id */
  sessionCookie?: string;
  /** Shared ARP (sid+ark+ftr). Reuse with uploads; do not mint per retry. */
  arpSessionId?: string;
  /** Session cache key from ensureAdobeFireflySession — sticky ARP across batch jobs. */
  sessionFingerprint?: string;
  /** Chrome profile key (provider connection id) for CDP warm/login isolation. */
  sessionBrowserKey?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  log?: {
    info?: (...args: unknown[]) => void;
    error?: (...args: unknown[]) => void;
  };
}): Promise<{ url: string; b64_json?: string; latest: unknown }> {
  const fetchImpl = opts.fetchImpl || fetch;
  const { spec } = resolveAdobeImageModel(opts.model);
  const aspectRatio = normalizeAdobeAspectRatio(opts.aspectRatio ?? opts.size, "1:1");
  const outputResolution = normalizeAdobeOutputResolution(opts.quality, opts.size);
  const payload = buildAdobeImagePayload({
    prompt: opts.prompt,
    aspectRatio,
    outputResolution,
    modelSpec: spec,
    quality: opts.quality,
    seed: opts.seed,
    sourceImageIds: opts.sourceImageIds,
    references: opts.references,
    negativePrompt: opts.negativePrompt,
  });

  const sessionCookie = String(opts.sessionCookie || "").trim();
  let activeCookie = extractAdobeCookieHeader(sessionCookie) || sessionCookie;
  // Prefer real browser sherlockToken / cookie rebuild (forter+arkose). Only the raw
  // credential paste counts as "browser ARP" — never the pure synthetic fallback.
  const hadBrowserArp = hasBrowserAdobeArpSession(activeCookie);
  let arpSessionId =
    (opts.arpSessionId && String(opts.arpSessionId).trim()) ||
    resolveAdobeArpSessionId(activeCookie);
  let submitData: unknown = {};
  let submitHeaders: Headers | Record<string, string | null | undefined> = new Headers();
  let lastSubmitError = "";
  let sawSystemUnderLoad = false;
  let accessToken = opts.accessToken;
  let authRefreshAttempted = false;

  const {
    withAdobeFireflySubmitGate,
    markAdobeFireflyArpSuccess,
    noteAdobeFireflySubmitFailure,
    rotateAdobeFireflySessionOnError,
    resolveAdobeArpSessionIdSmart,
    fingerprintAdobeCredential,
    estimateAdobeTokenExpiry,
  } = await import("./adobeFireflySession.ts");

  // Stable sticky key — do NOT include arpSessionId (it changes and would break sticky).
  const fingerprint =
    String(opts.sessionFingerprint || "").trim() ||
    fingerprintAdobeCredential([accessToken, activeCookie].filter(Boolean).join("\n"));
  const browserSessionKey = String(opts.sessionBrowserKey || "").trim() || fingerprint;

  // Gate ONLY the actual generate-async HTTP call (min gap). CDP warm / backoff run
  // outside so interactive browser login and other Firefly submits are not blocked for minutes.
  let submitOk = false;
  const submitState = (): AdobeSubmitState => ({
    accessToken,
    cookie: activeCookie,
    arpSessionId,
    fingerprint,
    browserSessionKey,
  });
  for (let attempt = 1; attempt <= SUBMIT_MAX_ATTEMPTS; attempt++) {
    await assertAdobeTokenNotDead(fingerprint, accessToken);
    const submitResp = await withAdobeFireflySubmitGate(async () => {
      // Re-check inside the gate: another queued request may have proved the token dead.
      await assertAdobeTokenNotDead(fingerprint, accessToken);
      return fetchImpl(ADOBE_FIREFLY_IMAGE_SUBMIT_URL, {
        method: "POST",
        headers: buildAdobeSubmitHeaders(accessToken, {
          arpSessionId,
          prompt: opts.prompt,
          cookie: activeCookie || undefined,
        }),
        body: JSON.stringify(payload),
      });
    });

    if (submitResp.status === 401 || submitResp.status === 403) {
      await handleAdobeSubmitAuthFailure({
        kind: "image",
        response: submitResp,
        attempt,
        state: submitState(),
        applyRenewed: (s) => {
          accessToken = s.accessToken;
          activeCookie = s.cookie || activeCookie;
          arpSessionId = s.arpSessionId || arpSessionId;
        },
        alreadyRenewed: authRefreshAttempted,
        markRenewed: () => {
          authRefreshAttempted = true;
        },
        log: opts.log,
      });
      continue;
    }

    if (!submitResp.ok) {
      const text = await submitResp.text().catch(() => "");
      if (isAdobeTransientSubmitError(submitResp.status, text)) {
        sawSystemUnderLoad = true;
      }
      lastSubmitError = `Adobe Firefly image submit failed (${submitResp.status}): ${sanitizeErrorMessage(text.slice(0, 300))}`;
      if (isAdobeTransientSubmitError(submitResp.status, text) && attempt < SUBMIT_MAX_ATTEMPTS) {
        const { getAdobeForterAgeMs: forterAgeMsFn, extractAdobeForterTimestampMs: forterTsFn } =
          await import("./adobeFireflySession.ts");
        // Only treat as known-stale when the cookie embeds a parseable forter timestamp.
        // Missing timestamp (tests / synthetic ARP) must keep the full retry ladder.
        const forterTs = forterTsFn(activeCookie || "");
        const forterAgeBefore = forterAgeMsFn(activeCookie || "");
        const forterKnownStale =
          forterTs > 0 && Number.isFinite(forterAgeBefore) && forterAgeBefore > 4 * 60_000;
        // Stale risk session: at most 2 attempts (warm once + one retry). Avoid ~600s thrash.
        // Cookie-forter staleness only matters for cookie-derived ARPs; a Sherlock-minted ARP
        // is independent of the cookie and gets re-minted by the recovery below instead.
        if (forterKnownStale && attempt >= 2 && !looksLikeSherlockMintedArp(arpSessionId)) {
          noteAdobeFireflySubmitFailure();
          throw new AdobeFireflyError(
            formatAdobeSystemUnderLoadError("image", attempt, { hadBrowserArp }) +
              " Risk session looks expired — open Providers → Adobe Firefly → Sign in with browser once.",
            408,
            "system_under_load"
          );
        }
        const arpBeforeRecovery = arpSessionId;
        try {
          // Always run recovery: it mints a Sherlock ARP even for JWT-only credentials.
          if (activeCookie || process.env.ADOBE_FIREFLY_BROWSER_REFRESH !== "0") {
            const rotated = await rotateAdobeFireflySessionOnError(
              {
                accessToken,
                cookie: activeCookie,
                arpSessionId,
                tokenExpiresAt: estimateAdobeTokenExpiry(accessToken),
                updatedAt: Date.now(),
                fingerprint,
                browserSessionKey,
                source: "rebuild",
              },
              {
                // Stale forter warms immediately; fresh forter quiet-reuses on 1–2 then warms.
                attempt,
                tryBrowser: process.env.ADOBE_FIREFLY_BROWSER_REFRESH !== "0",
                log: opts.log,
              }
            );
            accessToken = rotated.accessToken || accessToken;
            activeCookie = rotated.cookie || activeCookie;
            arpSessionId = rotated.arpSessionId;
          } else {
            arpSessionId = resolveAdobeArpSessionIdSmart(sessionCookie, {
              rotate: true,
            });
          }
        } catch {
          // Keep prior ARP — synthetic thrash rarely recovers colligo 408.
        }
        const base = submitBaseDelayMs();
        // A freshly minted ARP must be used promptly (live: minted tokens submitted within
        // seconds → 200; the same flow after a 16–65s backoff → 408). The submit gate still
        // enforces the minimum spacing.
        const freshMint =
          arpSessionId !== arpBeforeRecovery && looksLikeSherlockMintedArp(arpSessionId);
        const delay = freshMint
          ? 0
          : base <= 50
            ? base
            : Math.min(90_000, base * Math.pow(2, attempt - 1)) + Math.floor(Math.random() * 1500);
        opts.log?.info?.(
          "ADOBE-FIREFLY",
          `image submit transient ${submitResp.status}, retry ${attempt}/${SUBMIT_MAX_ATTEMPTS} in ${delay}ms (recovery attempt=${attempt})`
        );
        await sleep(delay);
        continue;
      }
      noteAdobeFireflySubmitFailure();
      if (sawSystemUnderLoad && isAdobeTransientSubmitError(submitResp.status, text)) {
        throw new AdobeFireflyError(
          formatAdobeSystemUnderLoadError("image", attempt, {
            hadBrowserArp,
          }),
          408,
          "system_under_load"
        );
      }
      throw new AdobeFireflyError(
        lastSubmitError,
        submitResp.status >= 400 && submitResp.status < 500 ? submitResp.status : 502
      );
    }

    submitData = await submitResp.json().catch(() => ({}));
    submitHeaders = submitResp.headers;
    // Sticky: remember ARP that colligo accepted so the next batch image reuses it.
    markAdobeFireflyArpSuccess(fingerprint, arpSessionId);
    submitOk = true;
    break;
  }
  if (!submitOk && !lastSubmitError) {
    throw new AdobeFireflyError(
      formatAdobeSystemUnderLoadError("image", SUBMIT_MAX_ATTEMPTS, { hadBrowserArp }),
      408,
      "system_under_load"
    );
  }

  let pollUrl = extractAdobeResultLink(submitHeaders, submitData);
  if (!pollUrl) {
    if (sawSystemUnderLoad) {
      throw new AdobeFireflyError(
        formatAdobeSystemUnderLoadError("image", SUBMIT_MAX_ATTEMPTS, {
          hadBrowserArp,
        }),
        408,
        "system_under_load"
      );
    }
    throw new AdobeFireflyError(
      lastSubmitError || "Adobe Firefly image submit succeeded but no poll URL was returned",
      502
    );
  }
  pollUrl = normalizeAdobePollUrl(pollUrl);

  const pollTimeoutMs = adobeFireflyImageTimeoutMs({
    timeoutMs: opts.timeoutMs,
    refCount: opts.sourceImageIds?.length ?? 0,
  });
  const { mediaUrl, latest } = await pollAdobeJob({
    pollUrl,
    accessToken,
    kind: "image",
    timeoutMs: pollTimeoutMs,
    sessionCookie: activeCookie || sessionCookie || undefined,
    sessionFingerprint: fingerprint,
    fetchImpl,
    log: opts.log,
  });

  return { url: mediaUrl, latest };
}

export async function adobeFireflyGenerateVideo(opts: {
  accessToken: string;
  prompt: string;
  model: string;
  size?: unknown;
  aspectRatio?: unknown;
  duration?: unknown;
  quality?: unknown;
  resolution?: unknown;
  seed?: number;
  sourceImageIds?: string[];
  references?: AdobeFireflyReferenceBlob[];
  negativePrompt?: string;
  generateAudio?: boolean;
  sessionCookie?: string;
  /** Shared ARP (sid+ark+ftr). Reuse with frame uploads. */
  arpSessionId?: string;
  /** Session cache key from ensureAdobeFireflySession — sticky ARP across batch jobs. */
  sessionFingerprint?: string;
  /** Chrome profile key (provider connection id) for CDP warm/login isolation. */
  sessionBrowserKey?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  log?: {
    info?: (...args: unknown[]) => void;
    error?: (...args: unknown[]) => void;
  };
}): Promise<{
  url: string;
  b64_json?: string;
  format: string;
  latest: unknown;
}> {
  const fetchImpl = opts.fetchImpl || fetch;
  const { spec } = resolveAdobeVideoModel(opts.model);
  const aspectRatio = normalizeAdobeAspectRatio(opts.aspectRatio ?? opts.size, "16:9");
  const duration =
    typeof opts.duration === "number"
      ? opts.duration
      : typeof opts.duration === "string" && opts.duration.trim()
        ? Number(opts.duration)
        : spec.defaultDuration;
  const resolution =
    typeof opts.resolution === "string" && opts.resolution.trim()
      ? opts.resolution
      : typeof opts.quality === "string" && /p$/i.test(opts.quality)
        ? opts.quality
        : spec.defaultResolution;

  const payload = buildAdobeVideoPayload({
    prompt: opts.prompt,
    aspectRatio,
    duration: Number.isFinite(duration) ? Number(duration) : spec.defaultDuration,
    modelSpec: spec,
    resolution,
    seed: opts.seed,
    sourceImageIds: opts.sourceImageIds,
    references: opts.references,
    negativePrompt: opts.negativePrompt,
    generateAudio: opts.generateAudio,
  });

  const sessionCookie = String(opts.sessionCookie || "").trim();
  let activeCookie = extractAdobeCookieHeader(sessionCookie) || sessionCookie;
  const hadBrowserArp = hasBrowserAdobeArpSession(activeCookie);
  let arpSessionId =
    (opts.arpSessionId && String(opts.arpSessionId).trim()) ||
    resolveAdobeArpSessionId(activeCookie);
  let submitData: unknown = {};
  let submitHeaders: Headers | Record<string, string | null | undefined> = new Headers();
  let lastSubmitError = "";
  let sawSystemUnderLoad = false;
  let accessToken = opts.accessToken;
  let authRefreshAttempted = false;

  const {
    withAdobeFireflySubmitGate,
    markAdobeFireflyArpSuccess,
    noteAdobeFireflySubmitFailure,
    rotateAdobeFireflySessionOnError,
    resolveAdobeArpSessionIdSmart,
    fingerprintAdobeCredential,
    estimateAdobeTokenExpiry,
  } = await import("./adobeFireflySession.ts");

  const fingerprint =
    String(opts.sessionFingerprint || "").trim() ||
    fingerprintAdobeCredential([accessToken, activeCookie].filter(Boolean).join("\n"));
  const browserSessionKey = String(opts.sessionBrowserKey || "").trim() || fingerprint;

  let videoSubmitOk = false;
  const submitState = (): AdobeSubmitState => ({
    accessToken,
    cookie: activeCookie,
    arpSessionId,
    fingerprint,
    browserSessionKey,
  });
  for (let attempt = 1; attempt <= SUBMIT_MAX_ATTEMPTS; attempt++) {
    await assertAdobeTokenNotDead(fingerprint, accessToken);
    const submitResp = await withAdobeFireflySubmitGate(async () => {
      await assertAdobeTokenNotDead(fingerprint, accessToken);
      return fetchImpl(ADOBE_FIREFLY_VIDEO_SUBMIT_URL, {
        method: "POST",
        headers: buildAdobeSubmitHeaders(accessToken, {
          arpSessionId,
          prompt: opts.prompt,
          cookie: activeCookie || undefined,
        }),
        body: JSON.stringify(payload),
      });
    });

    if (submitResp.status === 401 || submitResp.status === 403) {
      await handleAdobeSubmitAuthFailure({
        kind: "video",
        response: submitResp,
        attempt,
        state: submitState(),
        applyRenewed: (s) => {
          accessToken = s.accessToken;
          activeCookie = s.cookie || activeCookie;
          arpSessionId = s.arpSessionId || arpSessionId;
        },
        alreadyRenewed: authRefreshAttempted,
        markRenewed: () => {
          authRefreshAttempted = true;
        },
        log: opts.log,
      });
      continue;
    }

    if (!submitResp.ok) {
      const text = await submitResp.text().catch(() => "");
      if (isAdobeTransientSubmitError(submitResp.status, text)) {
        sawSystemUnderLoad = true;
      }
      lastSubmitError = `Adobe Firefly video submit failed (${submitResp.status}): ${sanitizeErrorMessage(text.slice(0, 300))}`;
      if (isAdobeTransientSubmitError(submitResp.status, text) && attempt < SUBMIT_MAX_ATTEMPTS) {
        const { getAdobeForterAgeMs: forterAgeMsFn, extractAdobeForterTimestampMs: forterTsFn } =
          await import("./adobeFireflySession.ts");
        const forterTs = forterTsFn(activeCookie || "");
        const forterAgeBefore = forterAgeMsFn(activeCookie || "");
        const forterKnownStale =
          forterTs > 0 && Number.isFinite(forterAgeBefore) && forterAgeBefore > 4 * 60_000;
        // Cookie-forter staleness only matters for cookie-derived ARPs; a Sherlock-minted ARP
        // is independent of the cookie and gets re-minted by the recovery below instead.
        if (forterKnownStale && attempt >= 2 && !looksLikeSherlockMintedArp(arpSessionId)) {
          noteAdobeFireflySubmitFailure();
          throw new AdobeFireflyError(
            formatAdobeSystemUnderLoadError("video", attempt, { hadBrowserArp }) +
              " Risk session looks expired — open Providers → Adobe Firefly → Sign in with browser once.",
            408,
            "system_under_load"
          );
        }
        const arpBeforeRecovery = arpSessionId;
        try {
          // Always run recovery: it mints a Sherlock ARP even for JWT-only credentials.
          if (activeCookie || process.env.ADOBE_FIREFLY_BROWSER_REFRESH !== "0") {
            const rotated = await rotateAdobeFireflySessionOnError(
              {
                accessToken,
                cookie: activeCookie,
                arpSessionId,
                tokenExpiresAt: estimateAdobeTokenExpiry(accessToken),
                updatedAt: Date.now(),
                fingerprint,
                browserSessionKey,
                source: "rebuild",
              },
              {
                attempt,
                tryBrowser: process.env.ADOBE_FIREFLY_BROWSER_REFRESH !== "0",
                log: opts.log,
              }
            );
            accessToken = rotated.accessToken || accessToken;
            activeCookie = rotated.cookie || activeCookie;
            arpSessionId = rotated.arpSessionId;
          } else {
            arpSessionId = resolveAdobeArpSessionIdSmart(sessionCookie, {
              rotate: true,
            });
          }
        } catch {
          /* keep prior ARP */
        }
        const base = submitBaseDelayMs();
        // A freshly minted ARP must be used promptly (live: minted tokens submitted within
        // seconds → 200; the same flow after a 16–65s backoff → 408). The submit gate still
        // enforces the minimum spacing.
        const freshMint =
          arpSessionId !== arpBeforeRecovery && looksLikeSherlockMintedArp(arpSessionId);
        const delay = freshMint
          ? 0
          : base <= 50
            ? base
            : Math.min(90_000, base * Math.pow(2, attempt - 1)) + Math.floor(Math.random() * 1500);
        opts.log?.info?.(
          "ADOBE-FIREFLY",
          `video submit transient ${submitResp.status}, retry ${attempt}/${SUBMIT_MAX_ATTEMPTS} in ${delay}ms (recovery attempt=${attempt})`
        );
        await sleep(delay);
        continue;
      }
      noteAdobeFireflySubmitFailure();
      if (sawSystemUnderLoad && isAdobeTransientSubmitError(submitResp.status, text)) {
        throw new AdobeFireflyError(
          formatAdobeSystemUnderLoadError("video", attempt, {
            hadBrowserArp,
          }),
          408,
          "system_under_load"
        );
      }
      throw new AdobeFireflyError(
        lastSubmitError,
        submitResp.status >= 400 && submitResp.status < 500 ? submitResp.status : 502
      );
    }

    submitData = await submitResp.json().catch(() => ({}));
    submitHeaders = submitResp.headers;
    markAdobeFireflyArpSuccess(fingerprint, arpSessionId);
    videoSubmitOk = true;
    break;
  }
  if (!videoSubmitOk && !lastSubmitError) {
    throw new AdobeFireflyError(
      formatAdobeSystemUnderLoadError("video", SUBMIT_MAX_ATTEMPTS, { hadBrowserArp }),
      408,
      "system_under_load"
    );
  }

  let pollUrl = extractAdobeResultLink(submitHeaders, submitData);
  if (!pollUrl) {
    if (sawSystemUnderLoad) {
      throw new AdobeFireflyError(
        formatAdobeSystemUnderLoadError("video", SUBMIT_MAX_ATTEMPTS, {
          hadBrowserArp,
        }),
        408,
        "system_under_load"
      );
    }
    throw new AdobeFireflyError(
      lastSubmitError || "Adobe Firefly video submit succeeded but no poll URL was returned",
      502
    );
  }
  pollUrl = normalizeAdobePollUrl(pollUrl);

  const { mediaUrl, latest } = await pollAdobeJob({
    pollUrl,
    accessToken,
    kind: "video",
    timeoutMs: opts.timeoutMs && opts.timeoutMs > 0 ? opts.timeoutMs : DEFAULT_VIDEO_TIMEOUT_MS,
    sessionCookie: activeCookie || sessionCookie || undefined,
    sessionFingerprint: fingerprint,
    fetchImpl,
    log: opts.log,
  });

  return { url: mediaUrl, format: "mp4", latest };
}
