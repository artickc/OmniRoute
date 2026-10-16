import test from "node:test";
import assert from "node:assert/strict";

import { parseJsonBodyLenient } from "../../src/sse/handlers/requestBody.ts";

test("valid JSON parses unchanged, escapes included", () => {
  const body = '{"messages":[{"role":"user","content":"a\\nb \\"q\\" \\\\ \\u00e9 \\/"}]}';
  assert.deepEqual(parseJsonBodyLenient(body), JSON.parse(body));
});

test("a stray backslash left by a text rewrite is repaired instead of failing the request", () => {
  // "\nfoo@mail.com" rewritten to "\VPPRIV_EMAILS_..." by the desktop privacy redaction
  const body = '{"messages":[{"role":"assistant","content":"list:\\VPPRIV_EMAILS_1A6E5013 done"}]}';
  assert.throws(() => JSON.parse(body));
  const parsed = parseJsonBodyLenient(body) as { messages: Array<{ content: string }> };
  assert.equal(parsed.messages[0].content, "list:VPPRIV_EMAILS_1A6E5013 done");
});

test("escaped backslashes next to a stray one are kept", () => {
  const body = '{"a":"C:\\\\dir \\X end"}';
  assert.deepEqual(parseJsonBodyLenient(body), { a: "C:\\dir X end" });
});

test("other syntax errors still throw", () => {
  assert.throws(() => parseJsonBodyLenient('{"a": "unterminated'));
  assert.throws(() => parseJsonBodyLenient("{bad json}"));
});
