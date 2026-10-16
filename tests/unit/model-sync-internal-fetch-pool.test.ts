import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { buildConnector, fetch as undiciFetch, type Dispatcher } from "undici";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-model-sync-pool-"));
process.env.DATA_DIR = TEST_DATA_DIR;

// The server loads open-sse (and with it the proxyFetch patch) before it starts the
// model sync scheduler, so the internal self-fetch runs against the patched
// globalThis.fetch. Load it the same way here.
await import("../../open-sse/utils/proxyFetch.ts");
const { getDefaultDispatcherConnectionLimit } =
  await import("../../open-sse/utils/proxyDispatcher.ts");
const scheduler = await import("../../src/shared/services/modelSyncScheduler.ts");

const PROBE_PATH = "/api/providers/__readiness_probe__/models";

test.after(() => {
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

/**
 * A loopback server that reproduces the boot-time shape: every sync-models POST
 * stays open until the readiness probe GET arrives, the same way the route waits on
 * ensureLoopbackServerReady before answering.
 */
async function startGateServer(
  createServer: (handler: http.RequestListener) => http.Server | https.Server
) {
  let releaseHolders!: () => void;
  const released = new Promise<void>((resolve) => {
    releaseHolders = resolve;
  });
  let heldCount = 0;
  const heldWaiters: Array<{ count: number; resolve: () => void }> = [];

  const server = createServer((req, res) => {
    if (req.url?.startsWith(PROBE_PATH)) {
      releaseHolders();
      res.writeHead(404, { "content-type": "application/json" });
      res.end("{}");
      return;
    }
    heldCount++;
    for (const waiter of heldWaiters.filter((w) => heldCount >= w.count)) {
      heldWaiters.splice(heldWaiters.indexOf(waiter), 1);
      waiter.resolve();
    }
    void released.then(() => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ syncedModels: 0 }));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    port,
    waitForHeld(count: number) {
      if (heldCount >= count) return Promise.resolve();
      return new Promise<void>((resolve) => heldWaiters.push({ count, resolve }));
    },
    async close() {
      releaseHolders();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} did not finish within ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

test("internal http self-fetch is not starved when every egress socket is held by a request waiting on it", async () => {
  const gate = await startGateServer((handler) => http.createServer(handler));
  const previous = {
    DASHBOARD_PORT: process.env.DASHBOARD_PORT,
    OMNIROUTE_BASE_PATH: process.env.OMNIROUTE_BASE_PATH,
    OMNIROUTE_INTERNAL_SCHEME: process.env.OMNIROUTE_INTERNAL_SCHEME,
  };
  process.env.DASHBOARD_PORT = String(gate.port);
  delete process.env.OMNIROUTE_BASE_PATH;
  delete process.env.OMNIROUTE_INTERNAL_SCHEME;

  try {
    const baseUrl = scheduler.getModelSyncInternalBaseUrl();
    assert.equal(baseUrl, `http://127.0.0.1:${gate.port}`);

    // One held request per socket of the capped direct-egress pool: the scheduler
    // fires one sync-models POST per connection, and each one blocks until the
    // probe below is answered.
    const holderCount = getDefaultDispatcherConnectionLimit();
    const holders = Array.from({ length: holderCount }, (_, i) =>
      scheduler.fetchModelSyncInternal(`${baseUrl}/api/providers/conn-${i}/sync-models`, {
        method: "POST",
      })
    );
    await withTimeout(gate.waitForHeld(holderCount), 5_000, "holder requests reaching the server");

    // The later request every holder is waiting on. With a shared, capped pool it
    // queues behind the holders and times out, which is the boot-time deadlock.
    const probe = await scheduler.fetchModelSyncInternal(`${baseUrl}${PROBE_PATH}`, {
      redirect: "error",
      signal: AbortSignal.timeout(2_000),
    });
    assert.equal(probe.status, 404);
    await probe.arrayBuffer();

    const responses = await withTimeout(Promise.all(holders), 5_000, "held requests");
    assert.equal(responses.length, holderCount);
    for (const response of responses) {
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { syncedModels: 0 });
    }
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await gate.close();
  }
});

test("pinned TLS loopback dispatcher has no connection cap", async () => {
  const { default: selfsigned } = await import("selfsigned");
  const pems = await selfsigned.generate([{ name: "commonName", value: "localhost" }], {
    keySize: 2048,
    algorithm: "sha256",
    extensions: [{ name: "subjectAltName", altNames: [{ type: 2, value: "localhost" }] }],
  });
  const gate = await startGateServer((handler) =>
    https.createServer({ key: pems.private, cert: pems.cert }, handler)
  );
  // Same factory and pinned connector the https internal fetch uses; only the CA is
  // added so the test can trust its self-signed certificate.
  const dispatcher: Dispatcher = scheduler.createModelSyncLoopbackDispatcher(
    scheduler.createPinnedModelSyncTlsConnector(
      buildConnector({ servername: "localhost", ca: pems.cert })
    )
  );
  const fetchWithDispatcher = undiciFetch as unknown as (
    input: string,
    init: RequestInit & { dispatcher: Dispatcher }
  ) => Promise<Response>;

  try {
    // More held requests than the old 8-connection TLS agent allowed.
    const holderCount = 12;
    const origin = `https://localhost:${gate.port}`;
    const holders = Array.from({ length: holderCount }, (_, i) =>
      fetchWithDispatcher(`${origin}/api/providers/conn-${i}/sync-models`, {
        method: "POST",
        dispatcher,
      })
    );
    await withTimeout(gate.waitForHeld(holderCount), 5_000, "holder requests reaching the server");

    const probe = await fetchWithDispatcher(`${origin}${PROBE_PATH}`, {
      dispatcher,
      signal: AbortSignal.timeout(2_000),
    });
    assert.equal(probe.status, 404);
    await probe.arrayBuffer();

    const responses = await withTimeout(Promise.all(holders), 5_000, "held requests");
    for (const response of responses) {
      assert.equal(response.status, 200);
      await response.arrayBuffer();
    }
  } finally {
    await gate.close();
    await dispatcher.close();
  }
});
