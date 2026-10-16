import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omr-ag-404-lock-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = "test-ag-404-lock-secret";

const { lockModel, isModelLocked, clearAllModelLockouts } =
  await import("../../open-sse/services/accountFallback.ts");

const CONN = "conn-ag-pro";
const COOLDOWN_MS = 120_000;

// chatCore locks a 404 with reason "model_not_found". A model the account does not
// serve (e.g. gemini-3.7-flash-low on a Pro account) must not take down the whole
// Gemini quota family on that account.
test("antigravity 404 (model_not_found) locks only the exact model, not its quota family", () => {
  clearAllModelLockouts();

  lockModel("antigravity", CONN, "gemini-3.7-flash-low", "model_not_found", COOLDOWN_MS);

  assert.equal(isModelLocked("antigravity", CONN, "gemini-3.7-flash-low"), true);
  assert.equal(isModelLocked("antigravity", CONN, "gemini-3.6-flash-low"), false);
  assert.equal(isModelLocked("antigravity", CONN, "gemini-3.8-flash-low"), false);
  assert.equal(isModelLocked("antigravity", CONN, "gemini-3.1-pro-low"), false);
});

test("antigravity 404 lock is shared by the agy alias for the same model only", () => {
  clearAllModelLockouts();

  lockModel("agy", CONN, "gemini-4-argon-low", "model_not_found", COOLDOWN_MS);

  assert.equal(isModelLocked("antigravity", CONN, "gemini-4-argon-low"), true);
  assert.equal(isModelLocked("antigravity", CONN, "gemini-4-argon-high"), false);
});

test("quota-style antigravity locks still apply to the whole family", () => {
  clearAllModelLockouts();

  lockModel("antigravity", CONN, "gemini-3.8-flash-low", "quota_exhausted", COOLDOWN_MS);

  assert.equal(isModelLocked("antigravity", CONN, "gemini-3.8-flash-high"), true);
});
