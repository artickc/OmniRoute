import { it } from "node:test";
import assert from "node:assert/strict";

// Load usage.ts before mocking fetch (open-sse/index.ts patches fetch at module evaluation).
const { getUsageForProvider } = await import("../../open-sse/services/usage.ts");

// Google's proto3 JSON omits zero-valued fields, so a spent bucket arrives with a
// resetTime but no remainingFraction. That is a reported 0%, not an unknown quota.
it("a bucket with resetTime but no remainingFraction is a reported, exhausted quota", async () => {
  const originalFetch = globalThis.fetch;
  const originalWarn = console.warn;
  const warnings: string[] = [];
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(" "));
  };
  globalThis.fetch = async () =>
    ({
      ok: true,
      json: async () => ({
        models: {
          "gemini-3-flash": { quotaInfo: { resetTime: "2026-10-20T09:17:36Z" } },
          "gemini-3.8-flash-low": { quotaInfo: { resetTime: "2026-10-20T09:17:36Z" } },
        },
      }),
    }) as Response;

  try {
    const result = await getUsageForProvider(
      {
        id: "conn-omitted-zero",
        provider: "antigravity",
        accessToken: "fake-token-omitted-zero",
        providerSpecificData: {},
        projectId: undefined,
      },
      { forceRefresh: true }
    );
    assert.ok(result && "quotas" in result, "should return quotas");
    for (const model of ["gemini-3-flash", "gemini-3.8-flash-low"]) {
      const quota = result.quotas[model];
      assert.ok(quota, `should have quota for ${model}`);
      assert.equal(quota.remainingPercentage, 0);
      assert.equal(quota.fractionReported, true);
      assert.equal(quota.resetAt, "2026-10-20T09:17:36.000Z");
    }
    assert.equal(
      warnings.some((line) => line.includes("returned no remainingFraction")),
      false,
      "an omitted zero must not be logged as an unknown quota"
    );
  } finally {
    globalThis.fetch = originalFetch;
    console.warn = originalWarn;
  }
});
