import { wildcardMatch } from "@omniroute/open-sse/services/wildcardRouter.ts";

type JsonRecord = Record<string, unknown>;

interface ConnectionLike {
  providerSpecificData?: unknown;
}

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : {};
}

function normalizePattern(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (!normalized || normalized === "**") return null;
  return normalized;
}

function toPatternList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map(normalizePattern).filter((pattern): pattern is string => Boolean(pattern));
  }
  if (typeof value === "string") {
    return value
      .split(",")
      .map(normalizePattern)
      .filter((pattern): pattern is string => Boolean(pattern));
  }
  return [];
}

function uniquePatterns(patterns: string[]): string[] {
  return Array.from(new Set(patterns));
}

function getModelMatchCandidates(modelId: string): string[] {
  const normalized = modelId.trim();
  if (!normalized) return [];

  const withoutExtendedContext = normalized.endsWith("[1m]") ? normalized.slice(0, -4) : normalized;
  const lastSlashIndex = withoutExtendedContext.lastIndexOf("/");
  const rawModel =
    lastSlashIndex >= 0 ? withoutExtendedContext.slice(lastSlashIndex + 1) : withoutExtendedContext;

  return Array.from(new Set([normalized, withoutExtendedContext, rawModel].filter(Boolean)));
}

export function normalizeExcludedModelPatterns(value: unknown): string[] {
  return uniquePatterns(toPatternList(value));
}

export function getConnectionExcludedModels(providerSpecificData: unknown): string[] {
  const data = asRecord(providerSpecificData);
  return normalizeExcludedModelPatterns(data.excludedModels ?? data.excluded_models);
}

export function isModelExcludedByConnection(
  modelId: unknown,
  providerSpecificData: unknown
): boolean {
  if (typeof modelId !== "string" || modelId.trim().length === 0) return false;

  const candidates = getModelMatchCandidates(modelId);
  const excludedModels = getConnectionExcludedModels(providerSpecificData);
  if (candidates.length === 0 || excludedModels.length === 0) return false;

  return excludedModels.some((pattern) =>
    candidates.some((candidate) => wildcardMatch(candidate, pattern))
  );
}

function toBareModelId(modelId: string): string {
  const trimmed = modelId.trim();
  const slash = trimmed.lastIndexOf("/");
  return (slash >= 0 ? trimmed.slice(slash + 1) : trimmed).toLowerCase();
}

/**
 * Build a check telling whether a connection can serve `modelId`, using the model
 * catalogs discovered per connection from the upstream (e.g. Antigravity
 * `:fetchAvailableModels`). Accounts on different plans expose different models, so
 * a request must not land on an account whose live catalog lacks the model — that
 * only produces an upstream 404.
 *
 * Fail-open by design: a connection without a discovered catalog is always allowed,
 * and when no catalog lists the model at all (new model, stale sync) every connection
 * is allowed, so a missing sync can never block routing.
 */
export function createDiscoveredModelServingCheck(
  modelId: unknown,
  discoveredByConnection: Record<string, readonly string[] | null | undefined>
): (connectionId: string) => boolean {
  if (typeof modelId !== "string" || !modelId.trim()) return () => true;
  const requested = new Set(getModelMatchCandidates(modelId).map(toBareModelId));

  const catalogs = new Map<string, Set<string>>();
  let servedAnywhere = false;
  for (const [connectionId, ids] of Object.entries(discoveredByConnection || {})) {
    if (!Array.isArray(ids) || ids.length === 0) continue;
    const catalog = new Set(
      ids.filter((id): id is string => typeof id === "string").map(toBareModelId)
    );
    catalogs.set(connectionId, catalog);
    if (!servedAnywhere && [...requested].some((candidate) => catalog.has(candidate))) {
      servedAnywhere = true;
    }
  }
  if (!servedAnywhere) return () => true;

  return (connectionId: string) => {
    const catalog = catalogs.get(connectionId);
    if (!catalog) return true;
    return [...requested].some((candidate) => catalog.has(candidate));
  };
}

export function hasEligibleConnectionForModel(
  connections: ConnectionLike[] | null | undefined,
  modelId: unknown
): boolean {
  if (!Array.isArray(connections) || connections.length === 0) return false;

  return connections.some(
    (connection) => !isModelExcludedByConnection(modelId, connection?.providerSpecificData)
  );
}
