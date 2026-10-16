import assert from "node:assert/strict";
import http from "node:http";
import { RebuildReadProvider } from "../rebuild-read-provider.js";
import { createProbeWiring } from "../universe-rebuild-production.js";

/** Loopback production-wiring regression, not historical/Family acceptance. */
export async function assertProbeReadPhysicalTimeout(): Promise<void> {
  const target = "0x1111111111111111111111111111111111111111";
  let streamed = 0, physicallyClosed = 0;
  const providers = new Set<RebuildReadProvider>();
  const prototype = RebuildReadProvider.prototype;
  const descriptor = Object.getOwnPropertyDescriptor(prototype, "_getConnection");
  const originalConnection = prototype._getConnection;
  const oldRevm = process.env.SEARCHER_REVM_SIM_BIN;
  let guard: NodeJS.Timeout | undefined;
  let resolveClosed!: () => void;
  const closed = new Promise<void>(resolve => { resolveClosed = resolve; });
  const server = http.createServer((request, response) => {
    let body = "";
    request.on("data", chunk => { body += String(chunk); });
    request.on("end", () => {
      const decoded = JSON.parse(body);
      const batch = Array.isArray(decoded) ? decoded : [decoded];
      if (batch.some((item: { method: string }) => item.method === "eth_getCode")) {
        streamed++;
        response.writeHead(200, { "content-type": "application/json" });
        response.write("[");
        // An idle timeout cannot fire while bytes continue to arrive.
        const timer = setInterval(() => response.write(" "), 20);
        response.on("close", () => { clearInterval(timer); physicallyClosed++; resolveClosed(); });
        return;
      }
      const result = batch.map((item: { id: number; method: string }) => ({
        jsonrpc: "2.0", id: item.id,
        result: item.method === "eth_chainId" ? "0x1" : "0x" + "00".repeat(32),
      }));
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(Array.isArray(decoded) ? result : result[0]));
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address !== null && typeof address !== "string");
  // The production option stays 60000. Only this instance's existing
  // FetchRequest cap is shortened; sendBounded uses min(connection, option).
  prototype._getConnection = function (this: RebuildReadProvider) {
    providers.add(this);
    const connection = originalConnection.call(this);
    connection.timeout = 250;
    return connection;
  };
  delete process.env.SEARCHER_REVM_SIM_BIN;
  try {
    const wiring = createProbeWiring({ rpcUrl: `http://127.0.0.1:${address.port}`,
      familyIds: ["univ2-standard"] });
    const started = performance.now();
    const attempt = wiring.attestFamilyInstanceOnce({
      candidate: { familyId: "univ2-standard", adapter: "univ2", address: target, pool: target },
      cutoff: { number: 123, hash: "0x" + "12".repeat(32), generation: 123 },
    });
    // A baseline failure is bounded and closes every owned socket in finally.
    // Production receives no Promise.race or new timeout implementation.
    const watchdog = new Promise<never>((_resolve, reject) => {
      guard = setTimeout(() => reject(new Error("probe wiring did not cancel physical streaming HTTP")), 2000);
    });
    const outcome = await Promise.race([attempt, watchdog]);
    assert.equal(streamed, 1, "exercise the production probe's real get-code HTTP");
    assert.equal(outcome.status, "retryable");
    if (outcome.status !== "retryable") throw new Error("expected timeout result");
    assert.equal(outcome.failureCode, "deadline");
    // Observe actual socket close before any forced cleanup by this fixture.
    await Promise.race([closed, watchdog]);
    assert.equal(physicallyClosed, 1, "deadline must close the physical response before test cleanup");
    assert(performance.now() - started < 1500, "no 60-second sleep or idle-timeout substitute");
  } finally {
    if (guard !== undefined) clearTimeout(guard);
    if (descriptor === undefined) delete (prototype as unknown as Record<string, unknown>)._getConnection;
    else Object.defineProperty(prototype, "_getConnection", descriptor);
    if (oldRevm === undefined) delete process.env.SEARCHER_REVM_SIM_BIN;
    else process.env.SEARCHER_REVM_SIM_BIN = oldRevm;
    for (const provider of providers) provider.destroy();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}
