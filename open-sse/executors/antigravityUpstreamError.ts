/**
 * Build a sanitized OpenAI-style error body for a non-ok Antigravity/agy upstream
 * response (#3229).
 *
 * The non-streaming executor path previously fed 4xx/5xx responses into the SSE
 * collector, which produced a synthetic `{"object":"chat.completion","content":""}`
 * success envelope — masking the real error. Route non-ok responses through
 * `buildErrorBody` instead so the client sees a proper error (hard rule #12).
 *
 * The message carries Google's ErrorInfo reason and first message line (printable
 * text only) because account routing classifies on the message alone: without it a
 * 403 "VALIDATION_REQUIRED: Verify your account to continue." looked like a transient
 * project-routing glitch and the unusable account was retried on every request.
 */
import { buildErrorBody } from "../utils/error.ts";

const UPSTREAM_DETAIL_MAX = 200;

function printableLine(value: unknown): string {
  if (typeof value !== "string") return "";
  const line = value
    .split("\n")[0]
    .replace(/[^\x20-\x7E]/g, "")
    .trim();
  return line.length > UPSTREAM_DETAIL_MAX ? `${line.slice(0, UPSTREAM_DETAIL_MAX)}...` : line;
}

export function describeAntigravityUpstreamError(upstreamDetails: unknown): string {
  const error =
    upstreamDetails && typeof upstreamDetails === "object"
      ? (upstreamDetails as { error?: unknown }).error
      : null;
  if (!error || typeof error !== "object") return "";
  const { message, details } = error as { message?: unknown; details?: unknown };
  const errorInfo = Array.isArray(details)
    ? details.find(
        (d) =>
          d &&
          typeof d === "object" &&
          String((d as { "@type"?: unknown })["@type"] || "").endsWith("google.rpc.ErrorInfo")
      )
    : null;
  const reason = printableLine((errorInfo as { reason?: unknown } | null)?.reason);
  const text = printableLine(message);
  return [reason, text].filter(Boolean).join(": ");
}

export function buildAntigravityUpstreamError(status: number, statusText: string, rawBody: string) {
  let upstreamDetails: unknown;
  try {
    upstreamDetails = JSON.parse(rawBody);
  } catch {
    // upstream body is not JSON (e.g. HTML error page) — omit structured details
  }
  const detail = describeAntigravityUpstreamError(upstreamDetails) || statusText;
  const suffix = detail ? `: ${detail}` : "";
  return buildErrorBody(status, `Antigravity upstream error (${status})${suffix}`, upstreamDetails);
}
