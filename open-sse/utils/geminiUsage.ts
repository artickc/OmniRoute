/**
 * Map Gemini / Cloud Code `usageMetadata` to an OpenAI `usage` object.
 *
 * Mirrors the streaming translator (translator/response/gemini-to-openai.ts):
 * thinking tokens are output tokens, so `completion_tokens` is
 * `candidatesTokenCount + thoughtsTokenCount` and the thinking share is reported
 * as `completion_tokens_details.reasoning_tokens`. Non-streaming collectors used
 * to report `candidatesTokenCount` alone, under-counting thinking models.
 */
export function geminiUsageMetadataToOpenAIUsage(
  usageMetadata: unknown
): Record<string, unknown> | null {
  if (!usageMetadata || typeof usageMetadata !== "object" || Array.isArray(usageMetadata)) {
    return null;
  }
  const um = usageMetadata as Record<string, unknown>;
  const count = (value: unknown) => (typeof value === "number" && value > 0 ? value : 0);

  const promptTokens = count(um.promptTokenCount);
  const thoughtsTokens = count(um.thoughtsTokenCount);
  const totalTokens = count(um.totalTokenCount);
  const cachedTokens = count(um.cachedContentTokenCount);
  let candidatesTokens = count(um.candidatesTokenCount);
  if (candidatesTokens === 0 && totalTokens > 0) {
    candidatesTokens = Math.max(0, totalTokens - promptTokens - thoughtsTokens);
  }

  const usage: Record<string, unknown> = {
    prompt_tokens: promptTokens,
    completion_tokens: candidatesTokens + thoughtsTokens,
    total_tokens: totalTokens || promptTokens + candidatesTokens + thoughtsTokens,
  };
  if (cachedTokens > 0) usage.prompt_tokens_details = { cached_tokens: cachedTokens };
  if (thoughtsTokens > 0) usage.completion_tokens_details = { reasoning_tokens: thoughtsTokens };
  return usage;
}
