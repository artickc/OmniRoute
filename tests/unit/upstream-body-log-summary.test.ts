import test from "node:test";
import assert from "node:assert/strict";

const { summarizeUpstreamBodyForLog } = await import("../../open-sse/utils/error.ts");

// Google's generic frontend 404, as returned by *.googleapis.com for an unknown RPC path.
const GOOGLE_404_HTML = `<!DOCTYPE html>
<html lang=en>
  <meta charset=utf-8>
  <meta name=viewport content="initial-scale=1, minimum-scale=1, width=device-width">
  <title>Error 404 (Not Found)!!1</title>
  <style>
    *{margin:0;padding:0}html,code{font:15px/22px arial,sans-serif}
  </style>
  <p><b>404.</b> <ins>That’s an error.</ins>
`;

test("HTML error pages collapse to a single line with their title", () => {
  const summary = summarizeUpstreamBodyForLog(GOOGLE_404_HTML);
  assert.equal(summary, "HTML page: Error 404 (Not Found)!!1");
  assert.equal(summary.includes("\n"), false);
});

test("non-HTML bodies are collapsed to one line and truncated", () => {
  const body = `{"error": {\n  "code": 403,\n  "message": "${"x".repeat(500)}"\n}}`;
  const summary = summarizeUpstreamBodyForLog(body, 80);
  assert.equal(summary.includes("\n"), false);
  assert.ok(summary.length <= 81, `expected <= 81 chars, got ${summary.length}`);
  assert.ok(summary.startsWith('{"error": { "code": 403'));
});

test("credentials in bodies are redacted", () => {
  const summary = summarizeUpstreamBodyForLog('{"access_token": "ya29.secret-value"}');
  assert.equal(summary.includes("ya29.secret-value"), false);
});

test("empty or non-string bodies are reported as empty", () => {
  assert.equal(summarizeUpstreamBodyForLog(""), "(empty body)");
  assert.equal(summarizeUpstreamBodyForLog(undefined), "(empty body)");
});
