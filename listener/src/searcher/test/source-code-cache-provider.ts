import assert from "node:assert/strict";
import { createServer } from "node:http";
import { ethers } from "ethers";
import { RebuildReadProvider } from "../rebuild-read-provider.js";
import { createSourceCodeProviders } from "../source-code-cache.js";

// A source-scoped cache must not promote ethers' number-only temporary cache
// into a long-lived entry for a different hash or generation.
const source = { number: 100, hash: "0x" + "ab".repeat(32), generation: 1 };
const address = "0x" + "ab".repeat(20);
const network = ethers.Network.from(1);
const pass = async <T>(operation: () => Promise<T>): Promise<T> => operation();
let code = "0x6001";
let reads = 0;
let failNext = false;
type Payload = { readonly id: number; readonly method: string };
const server = createServer((request, response) => {
  const chunks: Buffer[] = [];
  request.on("data", chunk => chunks.push(Buffer.from(chunk)));
  request.on("end", () => {
    const body = JSON.parse(Buffer.concat(chunks).toString()) as Payload | Payload[];
    const payloads = Array.isArray(body) ? body : [body];
    const replies = payloads.map(payload => {
      assert.equal(payload.method, "eth_getCode");
      reads++;
      if (failNext) {
        failNext = false;
        return { jsonrpc: "2.0", id: payload.id, error: { code: -32000, message: "temporary failure" } };
      }
      return { jsonrpc: "2.0", id: payload.id, result: code };
    });
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(Array.isArray(body) ? replies : replies[0]));
  });
});
await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
const listenAddress = server.address();
assert(listenAddress && typeof listenAddress !== "string");
const url = `http://127.0.0.1:${listenAddress.port}`;
const providers: RebuildReadProvider[] = [];
function scoped(cacheTimeout: number) {
  const provider = new RebuildReadProvider(pass, url, network, { staticNetwork: network, cacheTimeout });
  providers.push(provider);
  return createSourceCodeProviders({
    getCode: (target: string, block?: number) => provider.getCode(target, block),
  }, () => {});
}

try {
  // Widen the cache window for this local control without relying on 250ms.
  const unsafe = scoped(5_000);
  assert.equal(await unsafe(source).getCode(address, source.number), "0x6001");
  code = "0x6002";
  const changedHash = { ...source, hash: "0x" + "cd".repeat(32) };
  assert.equal(await unsafe(changedHash).getCode(address, source.number), "0x6001",
    "control reproduces cross-hash reuse from ethers' number-only cache");
  assert.equal(reads, 1);

  // Production probe uses cacheTimeout:-1; explicit source cache owns reuse.
  const safe = scoped(-1);
  code = "0x6001";
  assert.equal(await safe(source).getCode(address, source.number), "0x6001");
  code = "0x6002";
  assert.equal(await safe(changedHash).getCode(address, source.number), "0x6002");
  code = "0x6003";
  assert.equal(await safe({ ...changedHash, generation: 2 }).getCode(address, source.number), "0x6003");
  assert.equal(reads, 4, "hash and generation changes perform distinct physical reads");
  assert.equal(await safe(source).getCode(address, source.number), "0x6001",
    "original source retains its own code, not the latest other-source result");
  assert.equal(reads, 4);

  const newSource = { ...source, number: 101 };
  failNext = true;
  await assert.rejects(safe(newSource).getCode(address, 101));
  code = "0x6004";
  assert.equal(await safe(newSource).getCode(address, 101), "0x6004");
  assert.equal(reads, 6, "an immediate retry reaches RPC rather than ethers' rejected-promise cache");
  console.log("source-code-cache-provider PASS (underlying-cache hazard, hash/generation isolation, immediate retry)");
} finally {
  for (const provider of providers) provider.destroy();
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}
