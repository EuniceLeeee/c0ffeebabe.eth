import assert from "node:assert/strict";
import { FunctionFragment, Interface } from "ethers";
import test from "node:test";
import { decodeSelectorAbiArguments, normalizeSelectorAbiArguments, selectorFamilyIdentity,
  selectorImmutableParameters, selectorExecutionInstanceKey, selectorExecutionRouteKey,
  selectorExecutionResourceKey, selectorAssetOfferKey, selectorAssetResourceKey } from "../venues/selector-execution-keys.js";

const target = "0x" + "ab".repeat(20), holder = "0x" + "cd".repeat(20);
const token = "0x" + "ef".repeat(20), output = "0x" + "12".repeat(20);
const pool = "0x" + "56".repeat(32);
const scope = { chainId: 1, target, poolId: pool, poolNamespace: "manager" };

test("selector families retain canonical call ABI through known four-byte collisions", () => {
  const first = selectorFamilyIdentity("burn(uint256)"), second = selectorFamilyIdentity("collate_propagate_storage(bytes16)");
  assert.equal(first.selector, second.selector, "fixture is an actual selector collision");
  assert.notEqual(first.familyId, second.familyId);
  assert.equal(first.familyId, selectorFamilyIdentity("function burn(uint amount) payable returns (bool ok)").familyId,
    "names, output format and mutability are declaration content rather than calldata shape");
  assert.throws(() => selectorFamilyIdentity("burn(uint256)", "0x00000000"), /differs from ABI/);
});

test("ABI values preserve string bytes and normalize typed nested arrays without rounding", () => {
  const signature = "execute((string,address,bytes4,int128,uint256[])[] values,bool enabled)", fn = FunctionFragment.from(signature);
  const args = [[["PoOl/A 0xAB 中文", target, "0xABcd0123", -7n, [2n ** 200n, 0n]]], true];
  const abi = new Interface([fn]), data = abi.encodeFunctionData(fn, args);
  assert.deepEqual(decodeSelectorAbiArguments(signature, data),
    [[["PoOl/A 0xAB 中文", target, "0xabcd0123", "-7", [(2n ** 200n).toString(), "0"]]], true]);
  assert.throws(() => decodeSelectorAbiArguments(signature, data + "00"), /noncanonical/);
  assert.throws(() => normalizeSelectorAbiArguments("execute(uint256)", [Number.MAX_SAFE_INTEGER + 1]), /lossless/);
  assert.throws(() => normalizeSelectorAbiArguments("execute(uint8)", [256]), /out of range/);
  assert.throws(() => normalizeSelectorAbiArguments("execute(bool)", [1]), /bool/);
});

test("same target and pool retain different selector instances but one shared physical resource", () => {
  const redeem = selectorFamilyIdentity("redeem(uint256,address,address)");
  const withdraw = selectorFamilyIdentity("withdraw(uint256,address,address)");
  const a = selectorExecutionInstanceKey({ ...scope, familyId: redeem.familyId });
  const b = selectorExecutionInstanceKey({ ...scope, familyId: withdraw.familyId });
  assert.notEqual(a, b);
  assert.equal(new Set([a, b]).size, 2);
  assert.equal(selectorExecutionResourceKey({ ...scope, familyId: redeem.familyId } as typeof scope),
    selectorExecutionResourceKey({ ...scope, familyId: withdraw.familyId } as typeof scope));
  assert.notEqual(a, selectorExecutionInstanceKey({ ...scope, target: holder, familyId: redeem.familyId }));
  assert.notEqual(a, selectorExecutionInstanceKey({ ...scope, poolId: "0x" + "57".repeat(32), familyId: redeem.familyId }));
  assert.notEqual(a, selectorExecutionInstanceKey({ ...scope, chainId: 2, familyId: redeem.familyId }));
  assert.notEqual(a, selectorExecutionInstanceKey({ ...scope, poolNamespace: "Manager", familyId: redeem.familyId }));
});

test("only declared immutable ABI resources affect durable instances", () => {
  const signature = "exchange((string,uint256) resource,uint256 amount,address receiver,uint256 deadline)", family = selectorFamilyIdentity(signature);
  const before = [["Pool/A", 17n], 10n, target, 100n], after = [["Pool/A", 17n], 999n, holder, 9999n];
  const a = selectorImmutableParameters(signature, before, [[0, 1], [0, 0]]);
  const b = selectorImmutableParameters(signature, after, [[0, 0], [0, 1], [0, 0]]);
  assert.deepEqual(a, b, "observation amounts, receiver, deadlines and declaration ordering do not split the resource");
  const instance = selectorExecutionInstanceKey({ ...scope, familyId: family.familyId, immutableParameters: a });
  assert.equal(instance, selectorExecutionInstanceKey({ ...scope, familyId: family.familyId, immutableParameters: b,
    source: { number: 99, hash: "different source" }, transactionHash: "different tx", executor: holder } as Parameters<typeof selectorExecutionInstanceKey>[0]));
  const changed = selectorImmutableParameters(signature, [["pool/a", 17n], 10n, target, 100n], [[0, 0], [0, 1]]);
  assert.notEqual(instance, selectorExecutionInstanceKey({ ...scope, familyId: family.familyId, immutableParameters: changed }));
  assert.throws(() => selectorImmutableParameters(signature, before, [[0, 9]]), /unavailable/);
});

test("route identity retains direction, token address and tokenId within the execution instance", () => {
  const instance = selectorExecutionInstanceKey({ ...scope, familyId: selectorFamilyIdentity("swap(uint256)").familyId });
  const route = { tokenIn: { address: token, id: "0x2a" }, tokenOut: { address: token, id: "43" }, direction: "forward" };
  const key = selectorExecutionRouteKey(instance, route);
  assert.equal(key, selectorExecutionRouteKey(instance, { ...route, tokenIn: { address: token, id: "42" } }));
  const others = [
    { ...route, tokenIn: route.tokenOut, tokenOut: route.tokenIn },
    { ...route, tokenOut: { address: output, id: "43" } },
    { ...route, tokenOut: { address: token, id: "44" } },
    { ...route, direction: "reverse" },
  ];
  for (const other of others) assert.notEqual(key, selectorExecutionRouteKey(instance, other));
});

test("funding offers retain entry and provider identity while a common holder shares capacity", () => {
  const familyA = selectorFamilyIdentity("flashLoan(address,uint256,bytes)").familyId;
  const familyB = selectorFamilyIdentity("flashLoan(address,address,uint256,bytes,uint16)").familyId;
  const a = selectorExecutionInstanceKey({ ...scope, familyId: familyA });
  const b = selectorExecutionInstanceKey({ ...scope, familyId: familyB });
  const c = selectorExecutionInstanceKey({ ...scope, target: output, familyId: familyA });
  const asset = { address: token };
  assert.equal(new Set([a, b, c].map(key => selectorAssetOfferKey(key, asset))).size, 3);
  const shared = { ...scope, target: holder };
  const capacities = [{familyId:familyA,provider:target},{familyId:familyB,provider:target},{familyId:familyA,provider:output}]
    .map(entry => selectorAssetResourceKey({ ...shared, ...entry } as typeof shared, asset));
  assert.equal(new Set(capacities).size, 1, "different entries sharing the same holder/asset must not duplicate capacity identity");
  assert.notEqual(selectorAssetResourceKey(shared, asset), selectorAssetResourceKey(shared, { address: output }));
  assert.notEqual(selectorAssetResourceKey(shared, { address: token, id: "1" }), selectorAssetResourceKey(shared, { address: token, id: "2" }));
});

test("opaque resource strings remain case sensitive even when they resemble hex", () => {
  const familyId = selectorFamilyIdentity("redeem(uint256)").familyId;
  const a = selectorExecutionInstanceKey({ ...scope, poolId: "0xAB", familyId });
  const b = selectorExecutionInstanceKey({ ...scope, poolId: "0xab", familyId });
  assert.notEqual(a, b, "string resources must not be reinterpreted as bytes");
  assert.notEqual(selectorExecutionResourceKey({ ...scope, poolId: " Pool/A " }),
    selectorExecutionResourceKey({ ...scope, poolId: "Pool/A" }), "ABI string resource bytes are never trimmed");
  const bytes = normalizeSelectorAbiArguments("redeem(bytes1)", ["0xAB"]);
  assert.equal(selectorExecutionInstanceKey({ ...scope, poolId: bytes[0] as string, familyId }), b);
  assert.throws(() => selectorExecutionResourceKey({ chainId: 1, target, poolNamespace: "x" }), /without pool id/);
});
