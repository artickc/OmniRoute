export const TWINMIND_CHAT_URL = "https://api2.twinmind.com/api/v3/chat";
export const TWINMIND_MODELS_URLS = [
  "https://api.twinmind.com/api/v3/chat/models",
  "https://app.twinmind.com/api/v3/chat/models",
] as const;

export const TWINMIND_FALLBACK_MODELS = [
  { id: "auto", name: "Auto" },
  { id: "gemini-3.1-pro-thinking", name: "Gemini 3.1 Pro Thinking" },
  { id: "gemini-3.8-flash-thinking", name: "Gemini 3.8 Flash Thinking" },
  { id: "gemini-3.7-flash", name: "Gemini 3.7 Flash" },
  { id: "gemini-3.6-flash", name: "Gemini 3.6 Flash" },
  { id: "gpt-5.6-sol-thinking", name: "GPT-5.6 Sol Thinking" },
  { id: "gpt-5.5-thinking", name: "GPT-5.5 Thinking" },
  { id: "gpt-5.6-terra", name: "GPT-5.6 Terra" },
  { id: "gpt-5.6-luna", name: "GPT-5.6 Luna" },
  { id: "claude-opus-5-thinking", name: "Claude Opus 5 Thinking" },
  { id: "claude-opus-4-7-thinking", name: "Claude Opus 4.7 Thinking" },
  { id: "claude-sonnet-5", name: "Claude Sonnet 5" },
  { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6" },
] as const;

export type TwinmindCatalogModel = { id: string; name: string };

export function flattenTwinmindModelsCatalog(json: unknown): TwinmindCatalogModel[] {
  const root = json && typeof json === "object" && !Array.isArray(json) ? (json as Record<string, unknown>) : {};
  const seen = new Set<string>();
  const models: TwinmindCatalogModel[] = [];

  const add = (id: string, name?: string) => {
    const trimmed = id.trim();
    if (!trimmed || seen.has(trimmed)) return;
    seen.add(trimmed);
    models.push({ id: trimmed, name: (name || trimmed).trim() || trimmed });
  };

  add("auto", "Auto");

  const providers = Array.isArray(root.providers) ? root.providers : [];
  for (const provider of providers) {
    if (!provider || typeof provider !== "object" || Array.isArray(provider)) continue;
    const group = provider as Record<string, unknown>;
    const nested = Array.isArray(group.models) ? group.models : [];
    for (const model of nested) {
      if (!model || typeof model !== "object" || Array.isArray(model)) continue;
      const rec = model as Record<string, unknown>;
      const id = typeof rec.name === "string" ? rec.name : typeof rec.id === "string" ? rec.id : "";
      const display = typeof rec.display_name === "string" ? rec.display_name : undefined;
      if (id) add(id, display);
    }
  }

  const defaultModel = root.default_model;
  if (defaultModel && typeof defaultModel === "object" && !Array.isArray(defaultModel)) {
    const rec = defaultModel as Record<string, unknown>;
    const id = typeof rec.name === "string" ? rec.name : "";
    const display = typeof rec.display_name === "string" ? rec.display_name : undefined;
    if (id) add(id, display);
  }

  return models;
}

export async function discoverTwinmindModels(options: {
  token: string;
  fetchImpl?: typeof fetch;
}): Promise<TwinmindCatalogModel[]> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const headers: Record<string, string> = {};
  if (options.token) headers.authorization = `Bearer ${options.token}`;

  for (const url of TWINMIND_MODELS_URLS) {
    try {
      const response = await fetchImpl(url, { method: "GET", headers });
      if (!response.ok) continue;
      const json = await response.json();
      const models = flattenTwinmindModelsCatalog(json);
      if (models.length > 1) return models;
    } catch {
      // Try the next host (api.twinmind.com vs app.twinmind.com).
    }
  }

  return TWINMIND_FALLBACK_MODELS.map((model) => ({ id: model.id, name: model.name }));
}
