import test from "node:test";
import assert from "node:assert/strict";

const { isRetiredAntigravityModelId } =
  await import("../../open-sse/config/antigravityModelAliases.ts");
const { filterUserCallableAntigravityModels } =
  await import("../../src/app/api/providers/[id]/models/discovery/normalizers.ts");

// Verified live on 2026-10-16: the 3.5 Flash tiers still appear in :fetchAvailableModels
// but answer with a canned "Gemini 3.5 Flash is no longer available" 200, and every
// 3.6 / 3.7 Flash id answers 404. Gemini 3.8 Flash replaces them.
const RETIRED = [
  "gemini-3-flash-agent",
  "gemini-3.5-flash-low",
  "gemini-3.5-flash-extra-low",
  "gemini-3.7-flash-high",
  "gemini-3.7-flash-medium",
  "gemini-3.7-flash-low",
  "gemini-3.6-flash-high",
  "gemini-3.6-flash-medium",
  "gemini-3.6-flash-low",
];
const STILL_SERVED = ["gemini-3.8-flash-high", "gemini-3.5-flash-lite", "gemini-3-flash"];

test("only the retired tiers are flagged as retired", () => {
  for (const retired of RETIRED) {
    assert.equal(isRetiredAntigravityModelId(retired), true, retired);
  }
  for (const id of STILL_SERVED) {
    assert.equal(isRetiredAntigravityModelId(id), false, id);
  }
});

test("discovered catalogs drop retired tiers for both antigravity and agy", () => {
  const live = [...RETIRED, ...STILL_SERVED].map((id) => ({
    id,
    name: id,
  }));
  for (const provider of ["antigravity", "agy"] as const) {
    const kept = filterUserCallableAntigravityModels(live, provider).map((model) => model.id);
    assert.deepEqual(kept.sort(), [...STILL_SERVED].sort(), provider);
  }
});
