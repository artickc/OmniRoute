import { test } from "node:test";
import assert from "node:assert/strict";

import { AntigravityExecutor } from "../../open-sse/executors/antigravity.ts";
import { buildAntigravityUpstreamError } from "../../open-sse/executors/antigravityUpstreamError.ts";
import { resetUserProjectHeaderDenied } from "../../open-sse/executors/antigravity/executeAttempt.ts";
import {
  classifyProviderError,
  PROVIDER_ERROR_TYPES,
} from "../../open-sse/services/errorClassifier.ts";
import {
  clearAntigravityVersionCaches,
  seedAntigravityIdeVersionCache,
  seedAntigravityCliVersionCache,
} from "../../open-sse/services/antigravityVersion.ts";

const googleError = (status: string, reason: string, message: string) =>
  JSON.stringify({
    error: {
      code: 403,
      message,
      status,
      details: [
        { "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason, domain: "googleapis.com" },
      ],
    },
  });

test.afterEach(() => {
  clearAntigravityVersionCaches();
  resetUserProjectHeaderDenied();
});

test("a 403 VALIDATION_REQUIRED keeps Google's reason so routing sees an unusable account", () => {
  const body = buildAntigravityUpstreamError(
    403,
    "",
    googleError("PERMISSION_DENIED", "VALIDATION_REQUIRED", "Verify your account to continue.")
  );
  assert.equal(
    body.error.message,
    "Antigravity upstream error (403): VALIDATION_REQUIRED: Verify your account to continue."
  );
  assert.equal(
    classifyProviderError(403, body.error.message, "antigravity"),
    PROVIDER_ERROR_TYPES.ACCOUNT_DEACTIVATED
  );
});

test("a bare or non-JSON 403 still reads as a recoverable project-route error", () => {
  const bare = buildAntigravityUpstreamError(403, "Forbidden", "<html>nope</html>");
  assert.equal(bare.error.message, "Antigravity upstream error (403): Forbidden");
  assert.equal(
    classifyProviderError(403, bare.error.message, "antigravity"),
    PROVIDER_ERROR_TYPES.PROJECT_ROUTE_ERROR
  );
});

test("a project that rejects x-goog-user-project is sent without it from then on", async () => {
  const executor = new AntigravityExecutor();
  const originalFetch = globalThis.fetch;
  seedAntigravityIdeVersionCache("2026.04.17-test");
  seedAntigravityCliVersionCache("2026.04.17-test");

  const sentProjectHeaders: Array<string | null> = [];
  globalThis.fetch = async (_url: unknown, init?: RequestInit) => {
    const headers = (init?.headers || {}) as Record<string, string>;
    const project = headers["x-goog-user-project"] ?? null;
    sentProjectHeaders.push(project);
    if (project) {
      return new Response(
        googleError(
          "PERMISSION_DENIED",
          "USER_PROJECT_DENIED",
          "Caller does not have required permission to use project aicode-consumers."
        ),
        { status: 403, headers: { "Content-Type": "application/json" } }
      );
    }
    return new Response('data: {"response":{"candidates":[]}}\n\n', {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    });
  };

  const run = () =>
    executor.execute({
      model: "antigravity/gemini-3.8-flash-low",
      body: { request: { contents: [{ role: "user", parts: [{ text: "hi" }] }] } },
      stream: true,
      credentials: { accessToken: "token", projectId: "aicode-consumers" },
      log: { debug() {}, info() {}, warn() {} },
    });

  try {
    const first = await run();
    assert.equal(first.response.status, 200);
    assert.deepEqual(sentProjectHeaders, ["aicode-consumers", null]);

    sentProjectHeaders.length = 0;
    const second = await run();
    assert.equal(second.response.status, 200);
    assert.deepEqual(sentProjectHeaders, [null], "the denied header must not be sent again");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
