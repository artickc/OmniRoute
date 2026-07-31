/**
 * Pure-function tests for Adobe Firefly browser login helpers.
 * (No Playwright launch — that path is integration-only.)
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  accountLabelFromAdobeJwt,
  buildAdobeFireflyCookieHeader,
  clampAdobeFireflyLoginTimeout,
  extractAdobeBearerTokenFromAuthorization,
} from "../../open-sse/services/adobeFireflyBrowserLogin.ts";

test("clampAdobeFireflyLoginTimeout defaults and clamps", () => {
  assert.equal(clampAdobeFireflyLoginTimeout(undefined), 300_000);
  assert.equal(clampAdobeFireflyLoginTimeout("nope"), 300_000);
  assert.equal(clampAdobeFireflyLoginTimeout(1000), 15_000);
  assert.equal(clampAdobeFireflyLoginTimeout(999_999), 600_000);
  assert.equal(clampAdobeFireflyLoginTimeout(120_000), 120_000);
});

test("extractAdobeBearerTokenFromAuthorization pulls eyJ JWT", () => {
  const jwt =
    "eyJhbGciOiJIUzI1NiJ9." +
    Buffer.from(JSON.stringify({ email: "user@example.com", sub: "abc" })).toString("base64url") +
    ".sig";
  assert.equal(extractAdobeBearerTokenFromAuthorization(`Bearer ${jwt}`), jwt);
  assert.equal(extractAdobeBearerTokenFromAuthorization(""), "");
  assert.equal(extractAdobeBearerTokenFromAuthorization("Basic abc"), "");
});

test("buildAdobeFireflyCookieHeader keeps only wanted pairs", () => {
  const header = buildAdobeFireflyCookieHeader([
    { name: "unrelated", value: "x" },
    { name: "sherlockToken", value: "s1" },
    { name: "forterToken", value: "f1" },
    { name: "bad", value: "a;b" },
    { name: "ff_session_guid", value: "g1" },
  ]);
  assert.equal(header, "sherlockToken=s1; forterToken=f1; ff_session_guid=g1");
  assert.equal(buildAdobeFireflyCookieHeader([]), "");
});

test("accountLabelFromAdobeJwt prefers email", () => {
  const payload = Buffer.from(
    JSON.stringify({ email: "a@b.com", preferred_username: "x", sub: "id1" })
  ).toString("base64url");
  const jwt = `eyJhbGciOiJIUzI1NiJ9.${payload}.sig`;
  assert.equal(accountLabelFromAdobeJwt(jwt), "a@b.com");
  assert.equal(accountLabelFromAdobeJwt("not-a-jwt"), "");
});
