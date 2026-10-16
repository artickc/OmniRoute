import { SAFE_OUTBOUND_FETCH_PRESETS, safeOutboundFetch } from "@/shared/network/safeOutboundFetch";
import { getProviderOutboundGuard } from "@/shared/network/outboundUrlGuardPolicy";
import {
  TWINMIND_FALLBACK_MODELS,
  discoverTwinmindModels,
  type TwinmindCatalogModel,
} from "@omniroute/open-sse/services/twinmindModels.ts";
import { ensureTwinmindAccessToken } from "@omniroute/open-sse/services/twinmindAuth.ts";
import { sanitizeErrorMessage } from "@omniroute/open-sse/utils/error";

interface DiscoveryWarnings {
  cacheWarning?: string;
  localWarning?: string;
}

interface TwinmindDiscoveryRouteOptions {
  provider: string;
  connectionId: string;
  apiKey: unknown;
  accessToken: unknown;
  refreshToken: unknown;
  providerSpecificData: unknown;
  proxy: unknown;
  maybeReturnCachedDiscovery: () => Response | null;
  maybeReturnAutoFetchDisabled: () => Response | null;
  buildDiscoveryFallbackResponse: (warnings: DiscoveryWarnings) => Response | null;
  buildResponse: (payload: Record<string, unknown>) => Response;
  buildApiDiscoveryResponse: (models: TwinmindCatalogModel[]) => Promise<Response>;
  onCredentialsRefreshed?: (patch: Record<string, unknown>) => Promise<void> | void;
}

export async function maybeHandleTwinmindModelDiscovery(
  options: TwinmindDiscoveryRouteOptions
): Promise<Response | null> {
  if (options.provider !== "twinmind" && options.provider !== "tm") return null;

  const cachedResponse = options.maybeReturnCachedDiscovery();
  if (cachedResponse) return cachedResponse;

  const autoFetchDisabledResponse = options.maybeReturnAutoFetchDisabled();
  if (autoFetchDisabledResponse) return autoFetchDisabledResponse;

  const seedModels = TWINMIND_FALLBACK_MODELS.map((model) => ({
    id: model.id,
    name: model.name,
  }));

  const ensured = await ensureTwinmindAccessToken({
    apiKey: typeof options.apiKey === "string" ? options.apiKey : "",
    accessToken: typeof options.accessToken === "string" ? options.accessToken : "",
    refreshToken: typeof options.refreshToken === "string" ? options.refreshToken : "",
    providerSpecificData:
      options.providerSpecificData && typeof options.providerSpecificData === "object"
        ? (options.providerSpecificData as Record<string, unknown>)
        : {},
    onCredentialsRefreshed: options.onCredentialsRefreshed,
  });

  if (!ensured.token) {
    const fallback = options.buildDiscoveryFallbackResponse({
      cacheWarning: "No Twinmind token configured — using cached catalog",
      localWarning: "No Twinmind token configured — using local catalog",
    });
    if (fallback) return fallback;
    return options.buildResponse({
      provider: options.provider,
      connectionId: options.connectionId,
      models: seedModels,
      source: "local_catalog",
      intentional: true,
      warning: "No Twinmind Bearer or refresh token — using seed model list",
    });
  }

  try {
    const models = await discoverTwinmindModels({
      token: ensured.token,
      fetchImpl: (url, init) =>
        safeOutboundFetch(url, {
          ...SAFE_OUTBOUND_FETCH_PRESETS.modelsDiscovery,
          guard: getProviderOutboundGuard(),
          proxyConfig: options.proxy,
          ...init,
        }),
    });
    return options.buildApiDiscoveryResponse(models);
  } catch (error) {
    console.log("Error fetching models from twinmind", {
      error: sanitizeErrorMessage(error instanceof Error ? error.message : error),
    });
    const fallback = options.buildDiscoveryFallbackResponse({
      cacheWarning: "Twinmind model discovery failed — using cached catalog",
      localWarning: "Twinmind model discovery failed — using seed catalog",
    });
    if (fallback) return fallback;
    return options.buildResponse({
      provider: options.provider,
      connectionId: options.connectionId,
      models: seedModels,
      source: "local_catalog",
      intentional: true,
      warning: "API unavailable — using seed Twinmind model list",
    });
  }
}
