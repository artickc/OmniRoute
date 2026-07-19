/**
 * "Am I running under an automated test runner?" — one answer, one place.
 *
 * Eleven subsystems each carried their own copy of this check, and every copy decided it with
 * `process.argv.some((arg) => arg.includes("test"))`. That substring test is wrong in a way that is
 * easy to miss and expensive to hit: `'latest'.includes('test') === true`. Any argv carrying a
 * `latest` segment — a release symlink (`/opt/app/latest/server.js`), an npm/npx cache path, a
 * `--model=latest` flag — silently flipped the process into "test mode", and the subsystems gated on
 * it turned themselves off without a word. The worst of them is `src/lib/db/backup.ts`:
 * `isSqliteAutoBackupDisabled()` returns true, so SQLite auto-backup simply never runs. Same class of
 * silent disable for migrations, cloud sync, the health checks and quota recovery.
 *
 * Matching rules:
 *  - env first (`NODE_ENV=test`, `VITEST`) — unchanged behaviour.
 *  - argv: `test`/`tests` only as a WHOLE token delimited by a path separator, dot or dash — so
 *    `--test`, `tests/unit/x.test.ts` and `src/x.test.ts` match, while `latest`, `protest`,
 *    `contest` and `attestation` do not.
 *  - argv: known runner binaries (vitest/jest/mocha/ava/tap), which have no delimiter before "test".
 *
 * argv and env are parameters rather than globals so the behaviour is testable: under a test runner
 * the globals always say "test", which is exactly why the substring bug could never be caught.
 */

/** `test`/`tests` as a whole token: `--test`, `/tests/`, `.test.ts` — but never `latest`/`protest`. */
const TEST_TOKEN_RE = /(^|[\\/.-])tests?([\\/.-]|$)/i;

/** Runner binaries: no delimiter precedes "test" in "vitest", so they need their own rule. */
const TEST_RUNNER_RE = /(^|[\\/])(vitest|jest|mocha|ava|tap)(\.[cm]?js)?$/i;

export function isAutomatedTestProcess(
  // execArgv too: `node --test x.js` puts `--test` in execArgv, not argv (modelLockoutSettings was the
  // only copy that remembered to look there — now every caller gets it).
  argv: readonly string[] = typeof process !== "undefined" ? [...process.argv, ...(process.execArgv ?? [])] : [],
  env: NodeJS.ProcessEnv = typeof process !== "undefined" ? process.env : ({} as NodeJS.ProcessEnv)
): boolean {
  // Recover from the common (env, argv) swap left behind when local helpers
  // that took (env, argv) were replaced by this shared (argv, env) helper.
  // Without this, a single bad call site crashes instrumentation and every
  // HTTP request returns 500 ("e.some is not a function").
  if (argv != null && typeof argv === "object" && !Array.isArray(argv)) {
    const maybeEnv = argv as unknown as NodeJS.ProcessEnv;
    const maybeArgv = Array.isArray(env) ? (env as unknown as readonly string[]) : [];
    return isAutomatedTestProcess(maybeArgv, maybeEnv);
  }

  const safeEnv =
    env != null && typeof env === "object" && !Array.isArray(env)
      ? env
      : ({} as NodeJS.ProcessEnv);

  if (safeEnv.NODE_ENV === "test") return true;
  if (safeEnv.VITEST !== undefined) return true;

  // Defensive: tolerate a non-array argv instead of throwing — this check
  // gates production behavior (auto-backup, migrations, cloud sync…), so it
  // must never crash the process it's protecting.
  if (!Array.isArray(argv)) return false;
  return argv.some(
    (arg) => typeof arg === "string" && (TEST_TOKEN_RE.test(arg) || TEST_RUNNER_RE.test(arg))
  );
}

/** Next.js production build phase — several call sites pair this with the test check. */
export function isBuildProcess(env: NodeJS.ProcessEnv = process.env): boolean {
  return typeof process !== "undefined" && env.NEXT_PHASE === "phase-production-build";
}
