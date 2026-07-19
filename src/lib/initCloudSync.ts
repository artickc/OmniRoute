import initializeCloudSync from "@/shared/services/initializeCloudSync";
import { startBudgetResetJob } from "@/lib/jobs/budgetResetJob";
import { startModelSyncScheduler } from "@/shared/services/modelSyncScheduler";
import { isAutomatedTestProcess } from "@/shared/utils/testProcess";

// Initialize runtime background sync services once per server process.
let initialized = false;


export function shouldSkipCloudSyncInitialization(
  env: NodeJS.ProcessEnv = process.env,
  argv: string[] = process.argv
): boolean {
  if (env.NEXT_PHASE === "phase-production-build") {
    return true;
  }

  const raw = env.OMNIROUTE_DISABLE_BACKGROUND_SERVICES;
  if (raw && new Set(["1", "true", "yes", "on"]).has(raw.trim().toLowerCase())) {
    return true;
  }

  // Helper signature is (argv, env) — NOT (env, argv). A swapped call made
  // argv.some throw "e.some is not a function" and took down every request
  // via the instrumentation hook (HTTP 500 on /api/monitoring/health).
  // Prefer the helper's default argv (includes process.execArgv) when the
  // caller did not inject a custom argv list.
  const effectiveArgv =
    argv === process.argv && typeof process !== "undefined"
      ? [...process.argv, ...(process.execArgv ?? [])]
      : argv;
  return (
    isAutomatedTestProcess(effectiveArgv, env) &&
    env.OMNIROUTE_ENABLE_RUNTIME_BACKGROUND_TASKS !== "1"
  );
}

export async function ensureCloudSyncInitialized() {
  if (shouldSkipCloudSyncInitialization()) {
    return false;
  }
  if (!initialized) {
    try {
      const { initTokenHealthCheck } = await import("@/lib/tokenHealthCheck");
      initTokenHealthCheck();
      await initializeCloudSync();
      startModelSyncScheduler();
      startBudgetResetJob();
      initialized = true;
    } catch (error) {
      console.error("[ServerInit] Error initializing background sync services:", error);
    }
  }
  return initialized;
}

export default ensureCloudSyncInitialized;
