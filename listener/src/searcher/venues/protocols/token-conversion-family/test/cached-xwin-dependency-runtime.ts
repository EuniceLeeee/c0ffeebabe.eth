import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { id } from "ethers";
import { assertXwinChainlinkAggregatorRuntime, assertXwinChainlinkFeedRuntime, assertXwinFiatImplementationRuntime, assertXwinRouterRuntime, assertXwinTokenRuntime, proveXwinDependencyProxy, XWIN_FIAT_ADMIN_SLOT, XWIN_FIAT_IMPLEMENTATION_SLOT } from "../xwin-dependency-runtime.js";

const cacheFile = process.env.XWIN_DEPENDENCY_RUNTIME_EVIDENCE;
const N_HASH = "0x7d657e10588fe0327698837441079dc5568813e20a53057ae806a28ab210dead";
const FACTORY = "0x1f98431c8ad98523631ae4a59f267346ea31f984";

function archivedCode(): Map<string, string> {
  const codes = new Map<string, string>();
  for (const line of readFileSync(cacheFile!, "utf8").split("\n").filter(Boolean)) {
    const row = JSON.parse(line);
    const requests = Array.isArray(row.request) ? row.request : [row.request];
    const responses = Array.isArray(row.response) ? row.response : [row.response];
    for (const request of requests) {
      if (request?.method !== "eth_getCode" || request.params[1]?.blockHash?.toLowerCase() !== N_HASH ||
          request.params[1]?.requireCanonical !== true) continue;
      const response = responses.find((item: { id: unknown }) => item?.id === request.id);
      if (!response || response.error || typeof response.result !== "string") continue;
      const address = request.params[0].toLowerCase();
      if (codes.has(address)) assert.equal(codes.get(address), response.result, "same-source runtime conflict");
      codes.set(address, response.result);
    }
  }
  return codes;
}

test("xWin dependency bindings reject missing and counterfeit runtimes", () => {
  for (const code of ["0x", "0x0", "0x00", "0x60006000f3"]) {
    assert.throws(() => assertXwinRouterRuntime(code, FACTORY));
    assert.throws(() => assertXwinChainlinkFeedRuntime(code));
    assert.throws(() => assertXwinChainlinkAggregatorRuntime(code));
    assert.throws(() => assertXwinTokenRuntime(code));
    assert.throws(() => assertXwinFiatImplementationRuntime(code));
    assert.throws(() => proveXwinDependencyProxy(code));
  }
});

test("xWin swap/oracle proxy has storage admin, unlike fund immutable-admin proxy", { skip: !cacheFile }, () => {
  const codes = archivedCode();
  const swap = codes.get("0x4d146413c0dd1794019f9adee8d28304d0afee05")!;
  const oracle = codes.get("0xc0c01a95595a9b494e812d6cd95c3768ae82e64a")!;
  assert.equal(swap, oracle);
  const proof = proveXwinDependencyProxy(swap);
  assert.equal(proof.kind, "eip1967-storage-admin");
  assert.equal(proof.adminSlot, `0x${(BigInt(id("eip1967.proxy.admin")) - 1n).toString(16)}`);
  assert.equal(proof.implementationSlot, `0x${(BigInt(id("eip1967.proxy.implementation")) - 1n).toString(16)}`);
  assert.ok(swap.toLowerCase().includes(proof.adminSlot.slice(2)));
  assert.ok(swap.toLowerCase().includes(proof.implementationSlot.slice(2)));
  assert.throws(() => proveXwinDependencyProxy(codes.get("0x49edcc5aab2e349c1f71c27c98fe9c65b01745b1")!));
});

test("xWin dependency proxy runtime equals archived verified-source publication", {
  skip: !cacheFile || !process.env.TOKEN_CONVERSION_EVIDENCE,
}, () => {
  const html = readFileSync(join(process.env.TOKEN_CONVERSION_EVIDENCE!, "contracts", "0x4d146413c0dd1794019f9adee8d28304d0afee05.html"), "utf8");
  const published = html.slice(html.indexOf("Deployed Bytecode</h6>")).match(/<div>(0x[\da-fA-F]+)<\/div>/)?.[1];
  assert.ok(published);
  const swap = archivedCode().get("0x4d146413c0dd1794019f9adee8d28304d0afee05")!;
  assert.equal(published.toLowerCase(), swap.toLowerCase());
  const proof = proveXwinDependencyProxy(swap);
  assert.ok(html.includes(`bytes32 internal constant _ADMIN_SLOT = ${proof.adminSlot}`));
  assert.ok(html.includes("return StorageSlot.getAddressSlot(_ADMIN_SLOT).value;"));
});

test("xWin archived canonical-source router/feed/aggregator runtimes bind independently", { skip: !cacheFile }, () => {
  const codes = archivedCode();
  const code = (address: string) => { const result = codes.get(address); assert.ok(result, `missing archived code: ${address}`); return result; };
  const router = code("0xe592427a0aece92de3edee1f18e0157c05861564");
  assert.equal(assertXwinRouterRuntime(router, FACTORY), "0xbb90113d2f9a5e9b7feb15a1d1fff06c1ee1575b3f9b1181778ffd0cf633e7ea");
  assert.throws(() => assertXwinRouterRuntime(router, "0x0000000000000000000000000000000000000001"));
  for (const address of ["0x5f4ec3df9cbd43714fe2740f5e3616155c5b8419", "0xf4030086522a5beea4988f8ca5b36dbc97bee88c", "0x8fffffd4afb6115b954bd326cbe7b4ba576818f6"])
    assertXwinChainlinkFeedRuntime(code(address));
  for (const address of ["0x4a3411ac2948b33c69666b35cc6d055b27ea84f1", "0x7d4e742018fb52e48b08be73d041c18b21de6fb5", "0xc9e1a09622afdb659913fefe800feae5dbbfe9d7"])
    assertXwinChainlinkAggregatorRuntime(code(address));
  assert.throws(() => assertXwinChainlinkFeedRuntime(router));
  assert.throws(() => assertXwinChainlinkAggregatorRuntime(code("0x5f4ec3df9cbd43714fe2740f5e3616155c5b8419")));
  assert.throws(() => assertXwinRouterRuntime(`${router.slice(0, -2)}00`, FACTORY));
});

test("xWin local token compatibility pins proxy AND dynamically resolved implementation", { skip: !cacheFile }, () => {
  const codes = archivedCode();
  const usdc = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
  assert.equal(assertXwinTokenRuntime(codes.get("0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2")!), "weth9");
  assert.equal(assertXwinTokenRuntime(codes.get("0x2260fac5e5542a773aa44fbcfedf7c193bc2c599")!), "wbtc");
  assert.equal(XWIN_FIAT_IMPLEMENTATION_SLOT, id("org.zeppelinos.proxy.implementation"));
  assert.equal(XWIN_FIAT_ADMIN_SLOT, id("org.zeppelinos.proxy.admin"));
  assert.equal(assertXwinTokenRuntime(codes.get(usdc)!), "fiat-token-proxy");
  let implementation: string | undefined;
  for (const line of readFileSync(cacheFile!, "utf8").split("\n").filter(Boolean)) {
    const row = JSON.parse(line);
    const requests = Array.isArray(row.request) ? row.request : [row.request];
    const responses = Array.isArray(row.response) ? row.response : [row.response];
    for (const request of requests) {
      if (request?.method !== "eth_getStorageAt" || request.params[0].toLowerCase() !== usdc ||
          request.params[1].toLowerCase() !== XWIN_FIAT_IMPLEMENTATION_SLOT || request.params[2]?.blockHash?.toLowerCase() !== N_HASH) continue;
      const response = responses.find((item: { id: unknown }) => item?.id === request.id);
      assert.ok(response && !response.error);
      assert.match(response.result, /^0x0{24}[0-9a-fA-F]{40}$/);
      implementation = `0x${response.result.slice(-40)}`.toLowerCase();
    }
  }
  assert.ok(implementation, "missing source-pinned Fiat implementation word");
  assert.equal(assertXwinFiatImplementationRuntime(codes.get(implementation)!), "0xcdfb7d322961af3acae7a8f7ee8b69c205b36f576cc5b077f170c7eb8ecbe3ea");
  assert.throws(() => assertXwinFiatImplementationRuntime(codes.get(usdc)!));
  assert.throws(() => assertXwinTokenRuntime(codes.get(implementation)!));
});
