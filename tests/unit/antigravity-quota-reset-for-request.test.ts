import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omr-ag-quota-reset-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const coreDb = await import("../../src/lib/db/core.ts");
const quotaCache = await import("../../src/domain/quotaCache.ts");

test.after(() => {
  coreDb.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

const DAY_MS = 24 * 60 * 60 * 1000;
const geminiReset = new Date(Date.now() + 4 * DAY_MS).toISOString();
const claudeReset = new Date(Date.now() + 2 * DAY_MS).toISOString();

// Shape of an Ultra account whose weekly Gemini bucket is spent while Claude still has 40%.
const ULTRA_QUOTAS = {
  "gemini-3-flash": { used: 1000, total: 1000, remainingPercentage: 0, resetAt: geminiReset },
  "gemini-4-argon-low": { used: 1000, total: 1000, remainingPercentage: 0, resetAt: geminiReset },
  gemini_weekly: { used: 1000, total: 1000, remainingPercentage: 0, resetAt: geminiReset },
  "claude-sonnet-5-5-low": {
    used: 600,
    total: 1000,
    remainingPercentage: 40,
    resetAt: claudeReset,
  },
};

test("an exhausted Gemini scope reports the Gemini bucket's reset, not a generic retry", () => {
  quotaCache.setQuotaCache("conn-ultra", "antigravity", ULTRA_QUOTAS);

  assert.equal(
    quotaCache.getQuotaResetAtForRequest("conn-ultra", "antigravity", "gemini-4-argon-low"),
    geminiReset
  );
  assert.equal(
    quotaCache.getQuotaResetAtForRequest("conn-ultra", "agy", "antigravity/gemini-3-flash"),
    geminiReset
  );
});

test("a scope with quota left falls back to the connection-wide reset", () => {
  quotaCache.setQuotaCache("conn-ultra", "antigravity", ULTRA_QUOTAS);

  // Not every window is exhausted, so there is no connection-wide reset.
  assert.equal(
    quotaCache.getQuotaResetAtForRequest("conn-ultra", "antigravity", "claude-sonnet-5-5-low"),
    null
  );
});

test("unknown connections have no reset time", () => {
  assert.equal(
    quotaCache.getQuotaResetAtForRequest("conn-missing", "antigravity", "gemini-3-flash"),
    null
  );
});
