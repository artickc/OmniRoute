/**
 * Adobe Firefly browser login.
 *
 * Firefly needs an Adobe IMS access_token JWT (Bearer) issued for
 * client_id `clio-playground-web`. That JWT is NEVER present in
 * cookies/localStorage — the SPA only holds it in memory and attaches it
 * as `Authorization: Bearer <jwt>` on XHRs to firefly-3p.ff.adobe.io.
 *
 * So unlike conol-web (cookie-only), we open a Playwright browser at
 * firefly.adobe.com, then intercept outgoing requests to firefly-3p and
 * grab the Bearer JWT + sherlockToken cookie once the user is signed in.
 *
 * Mirrors the shape of conolBrowserLogin.ts so the /login route can call
 * it the same way.
 */
import { sanitizeErrorMessage } from "../utils/error.ts";

const FIREFLY_HOME_URL = "https://firefly.adobe.com/";
const FIREFLY_3P_HOST_SUFFIX = "firefly-3p.ff.adobe.io";
const ADOBE_BEARER_REGEX = /^Bearer\s+(eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)/i;

const DEFAULT_LOGIN_TIMEOUT_MS = 300_000;
const MIN_LOGIN_TIMEOUT_MS = 15_000;
const MAX_LOGIN_TIMEOUT_MS = 600_000;
const POLL_INTERVAL_MS = 1_000;

export interface AdobeFireflyBrowserLoginResult {
  success: boolean;
  credentials?: { accessToken?: string; cookie?: string };
  error?: string;
}

type BrowserLauncher = Pick<typeof import("playwright"), "chromium">;

function clampTimeout(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_LOGIN_TIMEOUT_MS;
  return Math.max(MIN_LOGIN_TIMEOUT_MS, Math.min(MAX_LOGIN_TIMEOUT_MS, Math.trunc(value)));
}

/**
 * Try several browser launch strategies (configured path, Chrome, Edge, default)
 * so the visible sign-in window appears even on minimal installs. Mirrors
 * conolBrowserLogin.launchConolLoginBrowser.
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
      return await playwright.chromium.launch(options);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error("No compatible browser is available for Adobe Firefly sign-in");
}

/**
 * Build a single cookie header from the relevant Firefly cookies. We only need
 * sherlockToken (used as x-arp-session-id); the rest of the page cookies are
 * not useful for the 3P API (wrong origin) and are dropped by the executor.
 */
function buildCookieHeader(
  cookies: Array<{ name: string; value: string; domain?: string }>
): string {
  const wanted = ["sherlockToken", "forterToken", "aux_sid", "ff_session_guid"];
  const parts: string[] = [];
  for (const wantedName of wanted) {
    const c = cookies.find(
      (candidate) =>
        candidate.name === wantedName && candidate.value && !/[\r\n;]/.test(candidate.value)
    );
    if (c) parts.push(`${wantedName}=${c.value}`);
  }
  return parts.join("; ");
}

export async function startAdobeFireflyBrowserLogin(
  requestedTimeout?: unknown
): Promise<AdobeFireflyBrowserLoginResult> {
  const timeout = clampTimeout(requestedTimeout);

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
        const m = authHeader.match(ADOBE_BEARER_REGEX);
        if (m?.[1]) capturedAccessToken = m[1];
      } catch {
        // Headers can throw on navigations; ignore.
      }
    };

    // Attach interception to every page (including future popups).
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
        const cookie = buildCookieHeader(
          await context.cookies(["https://firefly.adobe.com", "https://.adobe.com"])
        );
        return {
          success: true,
          credentials: {
            accessToken: capturedAccessToken,
            ...(cookie ? { cookie } : {}),
          },
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
