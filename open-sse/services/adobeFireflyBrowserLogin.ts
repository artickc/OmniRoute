/**
 * Adobe Firefly browser login.
 *
 * Firefly needs an Adobe IMS access_token JWT (Bearer) issued for
 * client_id `clio-playground-web`. That JWT is NEVER present in
 * cookies/localStorage тАФ the SPA only holds it in memory and attaches it
 * as `Authorization: Bearer <jwt>` on XHRs to firefly-3p.ff.adobe.io.
 *
 * Open a Playwright browser at firefly.adobe.com, intercept outgoing
 * firefly-3p requests, and capture the Bearer JWT + useful session cookies
 * once the user is signed in.
 */
import { sanitizeErrorMessage } from "../utils/error.ts";

const FIREFLY_HOME_URL = "https://firefly.adobe.com/";
const FIREFLY_3P_HOST_SUFFIX = "firefly-3p.ff.adobe.io";
// Bounded quantifiers (Hard Rule: avoid ReDoS on adversarial Authorization headers).
const ADOBE_BEARER_REGEX =
  /^Bearer\s+(eyJ[A-Za-z0-9_-]{1,4096}\.[A-Za-z0-9_-]{1,4096}\.[A-Za-z0-9_-]{1,4096})/i;

const DEFAULT_LOGIN_TIMEOUT_MS = 300_000;
const MIN_LOGIN_TIMEOUT_MS = 15_000;
const MAX_LOGIN_TIMEOUT_MS = 600_000;
const POLL_INTERVAL_MS = 1_000;

export interface AdobeFireflyBrowserLoginResult {
  success: boolean;
  credentials?: { accessToken?: string; cookie?: string };
  /** Best-effort Adobe account label (email or user id) decoded from the JWT. */
  account?: string;
  error?: string;
}

type BrowserLauncher = Pick<typeof import("playwright"), "chromium">;

export function clampAdobeFireflyLoginTimeout(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_LOGIN_TIMEOUT_MS;
  return Math.max(MIN_LOGIN_TIMEOUT_MS, Math.min(MAX_LOGIN_TIMEOUT_MS, Math.trunc(value)));
}

/**
 * Extract an IMS JWT from an Authorization header value.
 * Exported for unit tests.
 */
export function extractAdobeBearerTokenFromAuthorization(authHeader: string): string {
  const m = String(authHeader || "").match(ADOBE_BEARER_REGEX);
  return m?.[1] || "";
}

/**
 * Build a single cookie header from the relevant Firefly cookies. We only need
 * sherlockToken (used as x-arp-session-id); a few companions help session rebuild.
 * Exported for unit tests.
 */
export function buildAdobeFireflyCookieHeader(
  cookies: Array<{ name: string; value: string; domain?: string }>
): string {
  const wanted = ["sherlockToken", "forterToken", "aux_sid", "ff_session_guid"];
  const parts: string[] = [];
  for (const wantedName of wanted) {
    const c = cookies.find(
      (candidate) =>
        candidate.name === wantedName &&
        typeof candidate.value === "string" &&
        candidate.value.length > 0 &&
        !/[\r\n;]/.test(candidate.value)
    );
    if (c) parts.push(`${wantedName}=${c.value}`);
  }
  return parts.join("; ");
}

/**
 * Best-effort account label from an IMS JWT payload (no signature verify).
 * Exported for unit tests.
 */
export function accountLabelFromAdobeJwt(token: string): string {
  try {
    const part = String(token || "").split(".")[1];
    if (!part) return "";
    const json = Buffer.from(part.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    const obj = JSON.parse(json) as Record<string, unknown>;
    for (const key of ["email", "preferred_username", "user_id", "sub"]) {
      const v = obj[key];
      if (typeof v === "string" && v.trim()) return v.trim();
    }
  } catch {
    // ignore decode failures
  }
  return "";
}

/**
 * Try several browser launch strategies (configured path, Chrome, Edge, default)
 * so the visible sign-in window appears even on minimal installs.
 */
export async function launchAdobeFireflyLoginBrowser(
  playwright: BrowserLauncher
): Promise<import("playwright").Browser> {
  const configuredPath = process.env.OMNIROUTE_LOGIN_BROWSER_PATH?.trim();
  const attempts: Array<Record<string, unknown>> = [
    ...(configuredPath ? [{ headless: false, executablePath: configuredPath }] : []),
    { headless: false, channel: "chrome" },
    { headless: false, channel: "msedge" },
    { headless: false },
  ];

  let lastError: unknown;
  for (const options of attempts) {
    try {
      // Playwright always uses an ephemeral profile unless userDataDir is set,
      // so each sign-in is a fresh SSO session (matches freshSession:true callers).
      return await playwright.chromium.launch(options);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error("No compatible browser is available for Adobe Firefly sign-in");
}

export async function startAdobeFireflyBrowserLogin(
  requestedTimeout?: unknown
): Promise<AdobeFireflyBrowserLoginResult> {
  const timeout = clampAdobeFireflyLoginTimeout(requestedTimeout);

  let playwright: typeof import("playwright");
  try {
    playwright = await import("playwright");
  } catch {
    return {
      success: false,
      error:
        "Browser sign-in is unavailable (Playwright not installed). " +
        "Paste the IMS Bearer JWT from firefly-3p.ff.adobe.io instead.",
    };
  }

  let browser: import("playwright").Browser | null = null;
  try {
    browser = await launchAdobeFireflyLoginBrowser(playwright);
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      locale: "en-US",
    });

    let capturedAccessToken = "";
    const onPageRequest = (request: {
      url: () => string;
      headers: () => Record<string, string>;
    }) => {
      if (capturedAccessToken) return;
      try {
        const url = request.url();
        if (!url.includes(FIREFLY_3P_HOST_SUFFIX)) return;
        const authHeader = request.headers()["authorization"] || "";
        const token = extractAdobeBearerTokenFromAuthorization(authHeader);
        if (token) capturedAccessToken = token;
      } catch {
        // Headers can throw on navigations; ignore.
      }
    };

    // Attach interception to every page (including OAuth popups).
    context.on("page", (page) => {
      page.on("request", onPageRequest);
    });
    const page = await context.newPage();
    page.on("request", onPageRequest);

    await page.goto(FIREFLY_HOME_URL, {
      waitUntil: "domcontentloaded",
      timeout: Math.min(timeout, 60_000),
    });

    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (capturedAccessToken) {
        // Do NOT pass invalid URLs like "https://.adobe.com" тАФ Playwright rejects them
        // and would turn a successful capture into a failure.
        let cookies: Array<{ name: string; value: string; domain?: string }> = [];
        try {
          cookies = await context.cookies();
        } catch {
          cookies = [];
        }
        const cookie = buildAdobeFireflyCookieHeader(cookies);
        const account = accountLabelFromAdobeJwt(capturedAccessToken);
        return {
          success: true,
          credentials: {
            accessToken: capturedAccessToken,
            ...(cookie ? { cookie } : {}),
          },
          ...(account ? { account } : {}),
        };
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }

    return {
      success: false,
      error:
        "Adobe Firefly sign-in timed out. Complete sign-in at firefly.adobe.com and trigger an action " +
        "(open Generate) so the browser sends the Firefly request, then try again.",
    };
  } catch (error) {
    return {
      success: false,
      error: sanitizeErrorMessage(error instanceof Error ? error.message : error),
    };
  } finally {
    if (browser) {
      try {
        await browser.close();
      } catch {
        // The user may close the login window before extraction completes.
      }
    }
  }
}
