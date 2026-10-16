import test from "node:test";
import assert from "node:assert/strict";

const { isUserCallableAntigravityModelId } =
  await import("../../open-sse/config/antigravityModelAliases.ts");
const { isUserCallableAgyModelId } = await import("../../open-sse/config/agyModels.ts");

// A Pro account's live :fetchAvailableModels lists "gemini-4-argon-disabled": a picker
// placeholder for a model the plan cannot use. It is not a callable chat model.
test("plan-disabled placeholders are not callable chat models", () => {
  assert.equal(isUserCallableAntigravityModelId("gemini-4-argon-disabled"), false);
  assert.equal(isUserCallableAgyModelId("gemini-4-argon-disabled"), false);
});

test("image-generation models stay out of the chat catalog", () => {
  assert.equal(isUserCallableAntigravityModelId("gemini-3.1-flash-image"), false);
  assert.equal(isUserCallableAgyModelId("gemini-3.1-flash-image"), false);
});

test("live chat models discovered upstream remain callable", () => {
  for (const id of ["gemini-4-argon-low", "claude-sonnet-5-5-low", "gemini-3.8-flash-tiered"]) {
    assert.equal(isUserCallableAntigravityModelId(id), true, id);
    assert.equal(isUserCallableAgyModelId(id), true, id);
  }
});
