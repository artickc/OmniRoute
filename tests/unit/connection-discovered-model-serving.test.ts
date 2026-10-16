import test from "node:test";
import assert from "node:assert/strict";

const { createDiscoveredModelServingCheck } =
  await import("../../src/domain/connectionModelRules.ts");

// Live :fetchAvailableModels catalogs of an Ultra and a Pro Antigravity account.
const DISCOVERED = {
  ultra: ["gemini-3-flash", "gemini-4-argon-low", "gemini-4-argon-high", "claude-sonnet-5-5-low"],
  pro: ["gemini-3-flash", "gemini-4-argon-disabled", "claude-sonnet-4-6"],
};

test("a model only one account serves is routed only to that account", () => {
  const canServe = createDiscoveredModelServingCheck("gemini-4-argon-low", DISCOVERED);
  assert.equal(canServe("ultra"), true);
  assert.equal(canServe("pro"), false);
});

test("models served by several accounts stay eligible on all of them", () => {
  const canServe = createDiscoveredModelServingCheck("gemini-3-flash", DISCOVERED);
  assert.equal(canServe("ultra"), true);
  assert.equal(canServe("pro"), true);
});

test("provider-prefixed request ids match bare catalog ids", () => {
  const canServe = createDiscoveredModelServingCheck("antigravity/claude-sonnet-4-6", DISCOVERED);
  assert.equal(canServe("pro"), true);
  assert.equal(canServe("ultra"), false);
});

test("connections without a discovered catalog are never excluded", () => {
  const canServe = createDiscoveredModelServingCheck("gemini-4-argon-low", {
    ...DISCOVERED,
    fresh: [],
  });
  assert.equal(canServe("fresh"), true);
  assert.equal(canServe("never-synced"), true);
});

test("a model no catalog lists fails open for every connection", () => {
  const canServe = createDiscoveredModelServingCheck("gemini-9-flash", DISCOVERED);
  assert.equal(canServe("ultra"), true);
  assert.equal(canServe("pro"), true);
});

test("missing model or catalogs fail open", () => {
  assert.equal(createDiscoveredModelServingCheck(null, DISCOVERED)("pro"), true);
  assert.equal(createDiscoveredModelServingCheck("gemini-3-flash", {})("pro"), true);
});
