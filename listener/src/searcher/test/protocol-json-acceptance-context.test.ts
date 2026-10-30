import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ethers } from "ethers";
import {
  acceptanceSourceFingerprint, assertAcceptanceHeader, assertAcceptanceReadOnlyRpc,
  assertAcceptanceReceipt, createAcceptanceReadOnlyRpc, validateAcceptanceContextInput,
  verifyAcceptanceBotVmArtifact,
} from "./protocol-json-acceptance-context.js";
import { getEthersCallRpcError, isRpcThrottleError } from "../rpc-throttle-guard.js";

const source = { number: 100, hash: ethers.toBeHex(1, 32) };
const executor = ethers.toBeHex(2, 20), owner = ethers.toBeHex(3, 20), txHash = ethers.toBeHex(4, 32);
const pin = { blockHash: source.hash, requireCanonical: true };
const call = [{ to: executor, from: owner, data: "0x12345678" }, pin];
const header = { number: "0x64", hash: source.hash, stateRoot: ethers.toBeHex(5, 32), mixHash: ethers.toBeHex(6, 32),
  timestamp: "0x1234", gasLimit: "0x1000000", baseFeePerGas: "0x0", miner: owner };
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const input = () => ({ readyPath: "/tmp/ready.json", rpcFile: "/tmp/rpc.json", revmBin: "/tmp/revm-sim",
  familyId: "protocol:fixture", instanceKey: "Opaque:Instance", source: { ...source }, executor, owner, transactionHash: txHash });
const control = () => ({ signal: new AbortController().signal, deadlineAtMs: Date.now() + 10_000 });
function rpcFixture(answer: (request: any) => any, maxRequests = 5) {
  const requests: any[] = [];
  const rpc = createAcceptanceReadOnlyRpc({ url: "https://archive.invalid/private-token", source, control: control(), maxRequests,
    fetch: (async (_url: any, init: any) => {
      const request = JSON.parse(init.body); requests.push(request);
      return new Response(JSON.stringify(answer(request)), { status: 200 });
    }) as typeof fetch });
  return { rpc, requests };
}

test("context input requires explicit identities and a pinned historical source", () => {
  assert.doesNotThrow(() => validateAcceptanceContextInput(input()));
  for (const change of [
    (v: any) => { v.source.hash = "latest"; }, (v: any) => { v.source.number = -1; },
    (v: any) => { v.executor = owner; }, (v: any) => { v.transactionHash = "0x1234"; },
    (v: any) => { v.readyPath = "relative.json"; }, (v: any) => { v.familyId = ""; },
    (v: any) => { v.chainId = 0; }, (v: any) => { v.timeoutMs = Infinity; }, (v: any) => { v.maxRpcRequests = 0; },
  ]) { const value = input(); change(value); assert.throws(() => validateAcceptanceContextInput(value)); }
});

test("context supports explicitly selected Swap without accepting another domain", () => {
  assert.doesNotThrow(() => validateAcceptanceContextInput({ ...input(), domain: "swap", familyId: "balancer-v1" }));
  assert.doesNotThrow(() => validateAcceptanceContextInput({ ...input(), domain: "protocol" }));
  assert.throws(() => validateAcceptanceContextInput({ ...input(), familyId: "balancer-v1" }), /domain/);
  for (const domain of ["credit", "funding", "unknown", null])
    assert.throws(() => validateAcceptanceContextInput({ ...input(), domain } as any), /domain/);
  assert.throws(() => validateAcceptanceContextInput({ ...input(), domain: "swap" }), /domain/);
});

test("header and receipt checks reject reorgs, wrong transactions, failed receipts and incomplete environments", () => {
  assert.doesNotThrow(() => assertAcceptanceHeader(header, source));
  for (const change of [
    (v: any) => { v.hash = ethers.toBeHex(99, 32); }, (v: any) => { v.number = "0x65"; },
    (v: any) => { delete v.mixHash; }, (v: any) => { v.stateRoot = "0x"; },
    (v: any) => { v.timestamp = "100"; }, (v: any) => { v.miner = "unknown"; },
  ]) { const value = clone(header); change(value); assert.throws(() => assertAcceptanceHeader(value, source)); }
  const receipt = { transactionHash: txHash, blockNumber: "0x64", blockHash: source.hash, status: "0x1", logs: [] };
  assert.doesNotThrow(() => assertAcceptanceReceipt(receipt, txHash, source));
  for (const change of [
    (v: any) => { v.transactionHash = ethers.toBeHex(100, 32); }, (v: any) => { v.blockNumber = "0x63"; },
    (v: any) => { v.blockHash = ethers.toBeHex(100, 32); }, (v: any) => { v.status = "0x0"; }, (v: any) => { delete v.logs; },
  ]) { const value = clone(receipt); change(value); assert.throws(() => assertAcceptanceReceipt(value, txHash, source)); }
});

test("read transport rejects state mutation, overlays and unpinned reads before dispatch", async () => {
  const { rpc, requests } = rpcFixture(request => ({ jsonrpc: "2.0", id: request.id, result: "0x" }));
  for (const [method, params] of [
    ["eth_sendRawTransaction", ["0x"]], ["eth_sign", [owner, "0x"]], ["anvil_setCode", [executor, "0x"]],
    ["eth_call", [...call, { [executor]: { balance: "0x100" } }]],
    ["eth_call", [call[0], "latest"]],
    ["eth_call", [call[0], { ...pin, requireCanonical: false }]],
    ["eth_call", [call[0], { ...pin, blockHash: ethers.toBeHex(22, 32) }]],
    ["eth_getBlockByNumber", ["latest", false]], ["eth_getBlockByNumber", ["0x65", false]],
    ["eth_getCode", [executor, pin, {}]],
  ] as [string, unknown[]][]) await assert.rejects(rpc.request(method, params));
  assert.equal(requests.length, 0);
  assert.doesNotThrow(() => assertAcceptanceReadOnlyRpc("eth_getStorageAt", [executor, ethers.toBeHex(0, 32), pin], source));
  assert.doesNotThrow(() => assertAcceptanceReadOnlyRpc("eth_getBlockByNumber", ["0x63", false], source));
});

test("RPC responses must match request identity and budget exhaustion does not restart reads", async () => {
  const good = rpcFixture(request => ({ jsonrpc: "2.0", id: request.id, result: "0x1" }), 2);
  assert.equal(await good.rpc.request("eth_chainId", []), "0x1");
  assert.equal(await good.rpc.request("eth_call", call), "0x1");
  await assert.rejects(good.rpc.request("eth_chainId", []), /budget/);
  assert.equal(good.requests.length, 2);
  assert.equal(good.rpc.counters().revmInternalRpcReads, "not counted");
  for (const answer of [
    (request: any) => ({ jsonrpc: "2.0", id: request.id + 1, result: "0x" }),
    (request: any) => ({ jsonrpc: "1.0", id: request.id, result: "0x" }),
    (request: any) => ({ jsonrpc: "2.0", id: request.id }),
    (request: any) => ({ jsonrpc: "2.0", id: request.id, result: "0x", error: { code: 3, message: "execution reverted" } }),
  ]) {
    const bad = rpcFixture(answer);
    await assert.rejects(bad.rpc.request("eth_call", call));
    assert.equal(bad.rpc.counters().failures.length, 1);
  }
});

test("completed revert and provider quota retain the central classifier's structured evidence", async () => {
  for (const [error, throttle] of [
    [{ code: 3, message: "execution reverted", data: "0x" }, false],
    [{ code: 429, message: "Monthly capacity limit exceeded", data: "0x" }, true],
  ] as const) {
    const fixture = rpcFixture(request => ({ jsonrpc: "2.0", id: request.id, error }));
    await assert.rejects(fixture.rpc.request("eth_call", call), failure => {
      assert.equal((failure as any).code, "CALL_EXCEPTION");
      assert.deepEqual(getEthersCallRpcError(failure), error);
      assert.equal(isRpcThrottleError(failure), throttle);
      return true;
    });
    assert.equal(fixture.requests.length, 1, "context never implements its own retry");
  }
});

test("cancelled or expired work cannot dispatch or convert a late response into evidence", async () => {
  const abort = new AbortController(); let sends = 0;
  const rpc = createAcceptanceReadOnlyRpc({ url: "https://archive.invalid", source,
    control: { signal: abort.signal, deadlineAtMs: Date.now() + 10_000 }, maxRequests: 3,
    fetch: (async (_url: any, init: any) => {
      sends++; const request = JSON.parse(init.body); abort.abort(new Error("cancelled during response"));
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: "0x1" }));
    }) as typeof fetch });
  await assert.rejects(rpc.request("eth_chainId", [], { deadlineAtMs: Date.now() - 1 }), /deadline/);
  assert.equal(sends, 0);
  await assert.rejects(rpc.request("eth_chainId", []), /cancelled/);
  await assert.rejects(rpc.request("eth_chainId", []), /cancelled/);
  assert.equal(sends, 1);
});

test("endpoint and source snapshots cannot drift and diagnostic errors redact endpoints", async () => {
  const settings = { url: "https://archive.invalid/private-token", source: { ...source }, control: control(), maxRequests: 3,
    fetch: (async (url: any) => { throw new Error(`transport ${String(url)} failed`); }) as typeof fetch };
  const rpc = createAcceptanceReadOnlyRpc(settings);
  settings.url = "https://other.invalid"; settings.source.hash = ethers.toBeHex(77, 32);
  await assert.rejects(rpc.request("eth_call", [{ ...call[0] as object }, { ...pin, blockHash: settings.source.hash }]), /source pin/);
  await assert.rejects(rpc.request("eth_call", call), error => { assert(!String(error).includes("private-token")); return true; });
  assert(!JSON.stringify(rpc.counters()).includes("private-token"));
});

test("executor artifact validation binds Solidity content and rejects escaped or stale sources", () => {
  const root = mkdtempSync(join(tmpdir(), "protocol-context-artifact-"));
  try {
    mkdirSync(join(root, "src")); const sourceBytes = Buffer.from("contract BotVM {}");
    writeFileSync(join(root, "src/BotVM.sol"), sourceBytes);
    const metadata: any = { settings: { compilationTarget: { "src/BotVM.sol": "BotVM" } },
      sources: { "src/BotVM.sol": { keccak256: ethers.keccak256(sourceBytes) } } };
    const artifact = () => Buffer.from(JSON.stringify({ metadata: JSON.stringify(metadata) }));
    const pins = verifyAcceptanceBotVmArtifact(root, artifact());
    assert.equal(pins.length, 1); assert.match(pins[0]!.sha256, /^[0-9a-f]{64}$/);
    writeFileSync(join(root, "src/BotVM.sol"), "contract Stale {}");
    assert.throws(() => verifyAcceptanceBotVmArtifact(root, artifact()), /stale/);
    delete metadata.sources["src/BotVM.sol"];
    metadata.sources["../outside.sol"] = { keccak256: ethers.ZeroHash };
    assert.throws(() => verifyAcceptanceBotVmArtifact(root, artifact()));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("source fingerprint includes dirty runtime files while keeping fixture/test data separate", () => {
  const root = mkdtempSync(join(tmpdir(), "protocol-context-source-"));
  try {
    mkdirSync(join(root, "listener/src/test"), { recursive: true });
    writeFileSync(join(root, "listener/src/runtime.ts"), "export const value = 1;");
    writeFileSync(join(root, "listener/src/test/fixture.ts"), "fixture one");
    const first = acceptanceSourceFingerprint(root);
    writeFileSync(join(root, "listener/src/test/fixture.ts"), "fixture two");
    assert.equal(acceptanceSourceFingerprint(root), first);
    writeFileSync(join(root, "listener/src/runtime.ts"), "export const value = 2;");
    assert.notEqual(acceptanceSourceFingerprint(root), first);
    symlinkSync(join(root, "listener/src/runtime.ts"), join(root, "listener/src/linked.ts"));
    assert.throws(() => acceptanceSourceFingerprint(root), /symlink/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
