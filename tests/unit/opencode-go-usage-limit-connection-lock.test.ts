// OpenCode Go answers an exhausted account quota with a 429 "Go usage limit exceeded"
// (Retry-After ~2 days). It is account-wide: every model on the connection fails.
// Treating it as a plain rate limit locked one model for ~10s, so combos walked every
// opencode-go model in turn and burned their whole attempt budget ("Maximum combo
// retry limit reached"). It must cool the whole connection instead.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-opencode-go-usage-limit-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const core = await import("../../src/lib/db/core.ts");
const providersDb = await import("../../src/lib/db/providers.ts");
const auth = await import("../../src/sse/services/auth.ts");
const { isSubscriptionQuotaText } = await import("../../open-sse/services/quotaTextCooldowns.ts");

async function resetStorage() {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
}

test.after(() => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

test("'Go usage limit exceeded' is recognised as an exhausted subscription quota", () => {
  assert.equal(isSubscriptionQuotaText("[429]: go usage limit exceeded", "opencode-go"), true);
  assert.equal(isSubscriptionQuotaText("usage limit exceeded for this plan", "opencode-go"), true);
  assert.equal(isSubscriptionQuotaText("too many requests, slow down", "opencode-go"), false);
});

test("an opencode-go usage-limit 429 cools the whole connection, not one model", async () => {
  await resetStorage();

  const conn = await providersDb.createProviderConnection({
    provider: "opencode-go",
    authType: "apikey",
    apiKey: "sk-opencode-go-usage-limit",
    isActive: true,
    testStatus: "active",
  });
  const connectionId = (conn as { id: string }).id;

  const result = await auth.markAccountUnavailable(
    connectionId,
    429,
    "[429]: Go usage limit exceeded",
    "opencode-go",
    "glm-5.2"
  );
  const after = await providersDb.getProviderConnectionById(connectionId);

  assert.equal(result.shouldFallback, true);
  assert.ok(
    result.cooldownMs >= 30 * 60 * 1000,
    `expected a long connection cooldown, got ${result.cooldownMs}ms`
  );
  assert.ok(after.rateLimitedUntil, "the connection itself must be cooled down");
  assert.ok(new Date(after.rateLimitedUntil).getTime() - Date.now() >= 30 * 60 * 1000);

  const sibling = (await auth.getProviderCredentials("opencode-go", null, null, "kimi-k3-max")) as {
    allRateLimited?: boolean;
    connectionId?: string;
  } | null;
  assert.ok(
    !sibling || sibling.allRateLimited === true || !sibling.connectionId,
    "a sibling model on the same exhausted connection must not be selectable"
  );
});
