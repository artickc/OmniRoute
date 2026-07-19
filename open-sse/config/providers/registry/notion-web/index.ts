import type { RegistryEntry } from "../../shared.ts";
import {
  NOTION_WEB_FALLBACK_MODELS,
  withFriendlyNotionAliases,
} from "../../../../services/notionWebModels.ts";

// Notion AI Web (Unofficial/Experimental) — see open-sse/executors/notion-web.ts.
// Live catalog comes from cookie-auth POST /api/v3/getAvailableModels (models route).
// The registry seed below is the offline fallback when discovery fails.
// Includes food codenames (orange-mousse) + friendly slugs (gpt-5.6-sol).
export const notion_webProvider: RegistryEntry = {
  id: "notion-web",
  alias: "nw",
  format: "openai",
  executor: "notion-web",
  baseUrl: "https://app.notion.com/api/v3/runInferenceTranscript",
  authType: "apikey",
  authHeader: "cookie",
  passthroughModels: true,
  models: withFriendlyNotionAliases(NOTION_WEB_FALLBACK_MODELS).map((m) => ({
    id: m.id,
    name: m.name,
  })),
};
