import type { RegistryEntry } from "../../shared.ts";
import { CONOL_FALLBACK_MODELS } from "../../../../services/conolModels.ts";

// conol.ai — unofficial reverse-engineered browser-session chat.
// Auth: browser Cookie header (__Secure-better-auth.session_token).
// Chat: POST /api/sessions to mint a session, then cumulative NDJSON history
// deltas from GET /api/sessions/{id}/messages?logDeltas=1.
// Model/effort are NOT accepted on session creation — they are pinned
// out-of-band via POST /api/sessions/{id}/model (see conolSessionModel.ts).
export const conolWebProvider: RegistryEntry = {
  id: "conol-web",
  alias: "cnl",
  format: "openai",
  executor: "conol-web",
  baseUrl: "https://conol.ai/api/sessions",
  authType: "apikey",
  authHeader: "cookie",
  passthroughModels: true,
  models: CONOL_FALLBACK_MODELS,
};
