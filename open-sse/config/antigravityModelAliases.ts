export const ANTIGRAVITY_PUBLIC_MODELS = Object.freeze([
  // Gemini 4 Argon tiers returned by the live model selector for Antigravity CLI 1.3.4+.
  {
    id: "gemini-4-argon-high",
    name: "Gemini 4 Argon (High)",
    contextLength: 1048576,
    maxOutputTokens: 65536,
    supportsReasoning: true,
    supportsVision: true,
    toolCalling: true,
  },
  {
    id: "gemini-4-argon-medium",
    name: "Gemini 4 Argon (Medium)",
    contextLength: 1048576,
    maxOutputTokens: 65536,
    supportsReasoning: true,
    supportsVision: true,
    toolCalling: true,
  },
  {
    id: "gemini-4-argon-low",
    name: "Gemini 4 Argon (Low)",
    contextLength: 1048576,
    maxOutputTokens: 65536,
    supportsReasoning: true,
    supportsVision: true,
    toolCalling: true,
  },
  // Gemini 3.8 Flash tiers returned by the live model selector for Antigravity CLI 1.3.4+.
  {
    id: "gemini-3.8-flash-high",
    name: "Gemini 3.8 Flash (High)",
    contextLength: 1048576,
    maxOutputTokens: 65536,
    supportsReasoning: true,
    supportsVision: true,
    toolCalling: true,
  },
  {
    id: "gemini-3.8-flash-medium",
    name: "Gemini 3.8 Flash (Medium)",
    contextLength: 1048576,
    maxOutputTokens: 65536,
    supportsReasoning: true,
    supportsVision: true,
    toolCalling: true,
  },
  {
    id: "gemini-3.8-flash-low",
    name: "Gemini 3.8 Flash (Low)",
    contextLength: 1048576,
    maxOutputTokens: 65536,
    supportsReasoning: true,
    supportsVision: true,
    toolCalling: true,
  },
  // Gemini 3.7 Flash tiers.
  {
    id: "gemini-3.7-flash-high",
    name: "Gemini 3.7 Flash (High)",
    contextLength: 1048576,
    maxOutputTokens: 65536,
    supportsReasoning: true,
    supportsVision: true,
    toolCalling: true,
  },
  {
    id: "gemini-3.7-flash-medium",
    name: "Gemini 3.7 Flash (Medium)",
    contextLength: 1048576,
    maxOutputTokens: 65536,
    supportsReasoning: true,
    supportsVision: true,
    toolCalling: true,
  },
  {
    id: "gemini-3.7-flash-low",
    name: "Gemini 3.7 Flash (Low)",
    contextLength: 1048576,
    maxOutputTokens: 65536,
    supportsReasoning: true,
    supportsVision: true,
    toolCalling: true,
  },
  // Gemini 3.6 Flash tiers returned by the live model selector for both the IDE 2.1.1
  // and CLI 1.1.x+ client identities.
  {
    id: "gemini-3.6-flash-high",
    name: "Gemini 3.6 Flash (High)",
    contextLength: 1048576,
    maxOutputTokens: 65536,
    supportsReasoning: true,
    supportsVision: true,
    toolCalling: true,
  },
  {
    id: "gemini-3.6-flash-medium",
    name: "Gemini 3.6 Flash (Medium)",
    contextLength: 1048576,
    maxOutputTokens: 65536,
    supportsReasoning: true,
    supportsVision: true,
    toolCalling: true,
  },
  {
    id: "gemini-3.6-flash-low",
    name: "Gemini 3.6 Flash (Low)",
    contextLength: 1048576,
    maxOutputTokens: 65536,
    supportsReasoning: true,
    supportsVision: true,
    toolCalling: true,
  },
  // Claude 5.5 & 4.6 (Antigravity backend).
  {
    id: "claude-opus-5-5-high",
    name: "Claude Opus 5.5 (High)",
    contextLength: 1048576,
    maxOutputTokens: 65536,
    supportsReasoning: true,
    supportsVision: true,
    toolCalling: true,
  },
  {
    id: "claude-opus-5-5-medium",
    name: "Claude Opus 5.5 (Medium)",
    contextLength: 1048576,
    maxOutputTokens: 65536,
    supportsReasoning: true,
    supportsVision: true,
    toolCalling: true,
  },
  {
    id: "claude-opus-5-5-low",
    name: "Claude Opus 5.5 (Low)",
    contextLength: 1048576,
    maxOutputTokens: 65536,
    supportsReasoning: true,
    supportsVision: true,
    toolCalling: true,
  },
  {
    id: "claude-sonnet-5-5-high",
    name: "Claude Sonnet 5.5 (High)",
    contextLength: 1048576,
    maxOutputTokens: 65536,
    supportsReasoning: true,
    supportsVision: true,
    toolCalling: true,
  },
  {
    id: "claude-sonnet-5-5-medium",
    name: "Claude Sonnet 5.5 (Medium)",
    contextLength: 1048576,
    maxOutputTokens: 65536,
    supportsReasoning: true,
    supportsVision: true,
    toolCalling: true,
  },
  {
    id: "claude-sonnet-5-5-low",
    name: "Claude Sonnet 5.5 (Low)",
    contextLength: 1048576,
    maxOutputTokens: 65536,
    supportsReasoning: true,
    supportsVision: true,
    toolCalling: true,
  },
  {
    id: "claude-opus-4-6-thinking",
    name: "Claude Opus 4.6 (Thinking)",
    contextLength: 1048576,
    maxOutputTokens: 65536,
    supportsReasoning: true,
    supportsVision: true,
    toolCalling: true,
  },
  {
    id: "claude-sonnet-4-6",
    name: "Claude Sonnet 4.6 (Thinking)",
    contextLength: 1048576,
    maxOutputTokens: 65536,
    supportsReasoning: true,
    supportsVision: true,
    toolCalling: true,
  },
  // Gemini 3.1 Pro budget tiers. Live streamGenerateContent validation uses
  // `gemini-pro-agent` for High; the separately advertised `gemini-3.1-pro-high`
  // discovery slot currently returns HTTP 400 and is intentionally not public.
  {
    id: "gemini-pro-agent",
    name: "Gemini 3.1 Pro (High)",
    contextLength: 1048576,
    maxOutputTokens: 65535,
    supportsReasoning: true,
    supportsVision: true,
    toolCalling: true,
  },
  {
    id: "gemini-3.1-pro-low",
    name: "Gemini 3.1 Pro (Low)",
    contextLength: 1048576,
    maxOutputTokens: 65535,
    supportsReasoning: true,
    supportsVision: true,
    toolCalling: true,
  },
  // Gemini 3.5 Flash tiers exposed by Antigravity's model selector. Public ids match
  // fetchAvailableModels and are forwarded upstream unchanged:
  //   High   -> gemini-3-flash-agent       (displayName: Gemini 3.5 Flash (High))
  //   Medium -> gemini-3.5-flash-low       (displayName: Gemini 3.5 Flash (Medium))
  //   Low    -> gemini-3.5-flash-extra-low (displayName: Gemini 3.5 Flash (Low))
  {
    id: "gemini-3-flash-agent",
    name: "Gemini 3.5 Flash (High)",
    contextLength: 1048576,
    maxOutputTokens: 65536,
    supportsReasoning: true,
    supportsVision: true,
    toolCalling: true,
  },
  {
    id: "gemini-3.5-flash-low",
    name: "Gemini 3.5 Flash (Medium)",
    contextLength: 1048576,
    maxOutputTokens: 65536,
    supportsReasoning: true,
    supportsVision: true,
    toolCalling: true,
  },
  {
    id: "gemini-3.5-flash-extra-low",
    name: "Gemini 3.5 Flash (Low)",
    contextLength: 1048576,
    maxOutputTokens: 65536,
    supportsReasoning: true,
    supportsVision: true,
    toolCalling: true,
  },
  {
    id: "gemini-3.1-flash-lite",
    name: "Gemini 3.1 Flash Lite",
    contextLength: 1048576,
    maxOutputTokens: 65535,
    toolCalling: true,
  },
  {
    id: "gemini-2.5-flash-thinking",
    name: "Gemini 2.5 Flash Thinking",
    contextLength: 1048576,
    maxOutputTokens: 65535,
    toolCalling: true,
  },
  {
    id: "gemini-2.5-flash",
    name: "Gemini 2.5 Flash",
    contextLength: 1048576,
    maxOutputTokens: 65535,
    toolCalling: true,
  },
  {
    id: "gemini-2.5-flash-lite",
    name: "Gemini 2.5 Flash Lite",
    contextLength: 1048576,
    maxOutputTokens: 65535,
    toolCalling: true,
  },
  {
    id: "gpt-oss-120b-medium",
    name: "GPT-OSS 120B (Medium)",
    contextLength: 131072,
    maxOutputTokens: 32768,
    supportsReasoning: true,
    toolCalling: true,
  },
]);

export const ANTIGRAVITY_MODEL_ALIASES = Object.freeze({
  // gemini-3.1-pro-low is not aliased: the upstream accepts it verbatim.
  "gemini-3-pro-image-preview": "gemini-3-pro-image",
  // Legacy Claude display ids → current upstream ids. NOTE: an earlier comment here
  // assumed Claude was removed from Antigravity 2.0 and would 404; discussion #3184
  // disproved that — the Antigravity OAuth backend still serves claude-opus-4-6-thinking
  // and claude-sonnet-4-6 (now listed in ANTIGRAVITY_PUBLIC_MODELS above). These aliases
  // remap the old gemini-claude-* ids to the live upstream ids.
  "gemini-claude-sonnet-4-5": "claude-sonnet-4-6",
  "gemini-claude-sonnet-4-5-thinking": "claude-sonnet-4-6",
  "gemini-claude-opus-4-5-thinking": "claude-opus-4-6-thinking",
});

const ANTIGRAVITY_RETIRED_MODEL_IDS = new Set<string>([
  "gemini-3-flash-agent",
  "gemini-3.5-flash-low",
  "gemini-3.5-flash-extra-low",
  "gemini-3.7-flash-high",
  "gemini-3.7-flash-medium",
  "gemini-3.7-flash-low",
  "gemini-3.6-flash-high",
  "gemini-3.6-flash-medium",
  "gemini-3.6-flash-low",
]);

/**
 * Retired tiers the live :fetchAvailableModels catalog still lists but the backend no
 * longer serves (verified 2026-10-16: the 3.5 Flash tiers reply "Gemini 3.5 Flash is no
 * longer available", every 3.6 / 3.7 Flash id answers 404; Gemini 3.8 Flash replaces
 * them). They are left out of the per-account discovered catalogs that drive model
 * lists and routing; requests are not rewritten to another model.
 */
export function isRetiredAntigravityModelId(modelId: string): boolean {
  return ANTIGRAVITY_RETIRED_MODEL_IDS.has(modelId);
}

type AntigravityModelAliasMap = Record<string, string>;

/**
 * Per-request upstream-id fallback chains for callable Gemini 3.1 Pro tiers.
 * Each chain starts with its own key and every candidate is listed at most once.
 */
export const ANTIGRAVITY_PRO_FALLBACK_CHAINS: Readonly<Record<string, readonly string[]>> =
  Object.freeze({
    "gemini-3.1-pro-low": Object.freeze(["gemini-3.1-pro-low", "gemini-3-pro-low"]),
  });

/**
 * Return the ordered upstream-id fallback chain for `modelId` (the requested id first), or
 * `[]` when the model has no chain (flash, claude, plain pro, etc.). Pure — safe to unit test
 * and to call on every request (returns `[]` cheaply off the happy path's hot models).
 */
export function getAntigravityModelFallbacks(modelId: string): readonly string[] {
  if (!modelId) return [];
  return ANTIGRAVITY_PRO_FALLBACK_CHAINS[modelId] ?? [];
}

export const ANTIGRAVITY_REVERSE_MODEL_ALIASES: AntigravityModelAliasMap = Object.freeze({
  "gemini-3-pro-image": "gemini-3-pro-image-preview",
});

const CLIENT_VISIBLE_MODEL_NAMES = Object.freeze(
  ANTIGRAVITY_PUBLIC_MODELS.reduce<Record<string, string>>((acc, model) => {
    acc[model.id] = model.name;
    return acc;
  }, {})
);

const PUBLIC_MODEL_IDS = new Set(ANTIGRAVITY_PUBLIC_MODELS.map((model) => model.id));
const UPSTREAM_PUBLIC_MODEL_IDS = new Set(
  ANTIGRAVITY_PUBLIC_MODELS.map((model) => resolveAntigravityModelId(model.id))
);

export function resolveAntigravityModelId(modelId: string): string {
  if (!modelId) return modelId;
  return (ANTIGRAVITY_MODEL_ALIASES as AntigravityModelAliasMap)[modelId] || modelId;
}

export function toClientAntigravityModelId(modelId: string): string {
  if (!modelId) return modelId;
  return ANTIGRAVITY_REVERSE_MODEL_ALIASES[modelId] || modelId;
}

// Retired/hidden upstream preview buckets that must be dropped from client-facing usage.
const ANTIGRAVITY_DROPPED_QUOTA_BUCKETS = new Set<string>([
  "gemini-3.5-flash-preview",
  "gemini-3-flash-preview",
]);

/**
 * Keep Antigravity quota buckets in the upstream model-id namespace used by the public
 * catalog, or return `null` when a retired preview bucket should be hidden from clients.
 */
export function toClientAntigravityQuotaModelId(modelId: string): string | null {
  if (!modelId) return null;
  if (ANTIGRAVITY_DROPPED_QUOTA_BUCKETS.has(modelId)) return null;
  return toClientAntigravityModelId(modelId);
}

export function getClientVisibleAntigravityModelName(
  modelId: string,
  fallbackName?: string
): string {
  return CLIENT_VISIBLE_MODEL_NAMES[modelId] || fallbackName || modelId;
}

/**
 * Ids the live `:fetchAvailableModels` catalog returns that are not chat models:
 * plan placeholders such as `gemini-4-argon-disabled` (shown greyed out in the
 * picker for plans without access) and image-generation-only models.
 */
export function isNonChatAntigravityCatalogId(modelId: string): boolean {
  return modelId.endsWith("-disabled") || /-image(-|$)/.test(modelId);
}

export function isUserCallableAntigravityModelId(modelId: string): boolean {
  if (!modelId) return false;
  return (
    !isNonChatAntigravityCatalogId(modelId) &&
    !modelId.startsWith("chat_") &&
    !modelId.startsWith("tab_") &&
    !modelId.endsWith("_weekly") &&
    !ANTIGRAVITY_DROPPED_QUOTA_BUCKETS.has(modelId)
  );
}
