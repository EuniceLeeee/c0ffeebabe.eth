import assert from "node:assert/strict";
import { test } from "node:test";
import { originalV4Leg } from "./history-evidence.js";
import type { CaptureNominationInput, CaptureNominationProvider } from "../../../adapter-family-plugin.js";
import { plugin as univ4 } from "../../../production-families/univ4.production.js";
import { plugin as feeHook } from "../../../production-families/univ4-fee-hook.production.js";
import { ERC20_SETTLEMENT_OBSERVATION as source } from "./history-erc20-observation.fixture.js";
const instance = source.descriptor.managerBinding.manager + "\u001f" + source.descriptor.poolId;
const observe = (f: any, optional = true) => originalV4Leg(instance, f.descriptor, f.receipt, f.trace, false, optional);
function calls(f: any): any[] { return [f, ...(f.calls ?? []).flatMap(calls)]; }
test("real Permit2-funded original swap binds actual payer, manager receipt, settle and take", () => {
  const actual = observe(source);
  assert.equal(actual.tokenIn, source.descriptor.poolKey.currency1);
  assert.equal(actual.tokenOut, source.descriptor.poolKey.currency0);
  assert.equal(actual.amountIn, 500798859n); assert.equal(actual.amountOut, 500729883n);
  assert.throws(() => observe(source, false), "legacy native observer has not been broadened");
});
test("delegated transfer requires success return and actual receipt, not caller identity alone", () => {
  for (const output of ["0x" + "00".repeat(32), "0x01"]) {
    const f = structuredClone(source); const payment = calls(f.trace).find(x => x.input?.startsWith("0x23b872dd"));
    payment.output = output; assert.throws(() => observe(f));
  }
  const f = structuredClone(source);
  f.receipt.logs = f.receipt.logs.filter(l => l.address.toLowerCase() !== f.descriptor.poolKey.currency1);
  assert.throws(() => observe(f));
});
test("delegated transfer outside the current sync/settle interval cannot prove funding", () => {
  const f = structuredClone(source), frames = calls(f.trace);
  const callback = frames.find(x => x.calls?.some((c: any) => c.input?.startsWith("0xa5841194")));
  const nestedPaymentIndex = callback.calls.findIndex((x: any) => x.to === "0x000000000022d473030f116ddee9f6b43ac78ba3");
  const [payment] = callback.calls.splice(nestedPaymentIndex, 1); callback.calls.unshift(payment);
  assert.throws(() => observe(f));
});

test("manager calldata nominates the same no-hook pool as its historical Swap log", () => {
  const frame = calls(source.trace).find(call => call.input?.startsWith("0xf3cd914c"));
  assert(frame);
  const swapLog = source.receipt.logs.find(log =>
    log.address === source.descriptor.managerBinding.manager && log.topics[1] === source.descriptor.poolId);
  assert(swapLog);
  const observation = {
    kind: "call" as const,
    source: { number: source.source.block, hash: swapLog.blockHash, generation: 1 },
    transactionHash: source.source.tx, target: frame.to, data: frame.input,
  };
  for (const family of [univ4, feeHook]) {
    const pattern = family.discovery.callPatterns?.find(p => p.selector === frame.input.slice(0, 10));
    assert(pattern);
    const candidate = family.discovery.decodeCandidate({ observation, matchedPatternId: pattern.id });
    if (family === feeHook) {
      assert.equal(candidate, null, "the fee-hook family excludes this no-hook call");
    } else {
      assert(candidate);
      assert("manager" in candidate && "poolId" in candidate);
      assert.equal(String(candidate.manager).toLowerCase(), source.descriptor.managerBinding.manager);
      assert.equal(candidate.poolId, swapLog.topics[1]);
    }
  }
});

test("retained PoolKey is re-bound to the manager and complete PoolId before nomination", async () => {
  const { manager } = source.descriptor.managerBinding;
  const { poolId, poolKey } = source.descriptor;
  const block = source.source.block;
  const pinned = { number: block, hash: source.receipt.logs[0]!.blockHash, generation: 12 };
  let reverseReads = 0;
  const provider: CaptureNominationProvider = {
    async getCode(address, at) {
      assert.equal(at, block);
      return address.toLowerCase() === manager ? "0x6000" : "0x";
    },
    async getStorage(_address, _slot, at) {
      assert.equal(at, block);
      return "0x" + "00".repeat(32);
    },
    async call(_tx, at) {
      assert.equal(at, block);
      reverseReads++;
      throw new Error("fixture has no PositionManager record");
    },
    async getLogs() { throw new Error("unexpected log rescan"); },
    async getTransactionReceipt() { throw new Error("unexpected receipt rescan"); },
  };
  const discovery = univ4.discovery;
  const nominate = (opaque: CaptureNominationInput["opaque"]) => discovery.nominate!.nominate({
    nominations: [{ address: manager, opaque }], provider, source: pinned,
  });
  const common = { adapter: "univ4", manager, poolId };
  const [nested] = await nominate({ ...common, poolKey });
  const [flat] = await nominate({ ...common, ...poolKey });
  assert(nested && flat);
  assert.equal(nested.source.hash, pinned.hash);
  const surface = discovery.addressSurfaces![0]!.id;
  const a = discovery.decodeCandidate({ observation: nested, matchedPatternId: surface });
  const b = discovery.decodeCandidate({ observation: flat, matchedPatternId: surface });
  assert(a && b);
  assert("poolId" in a);
  assert.equal(a.poolId, poolId);
  assert.equal(discovery.candidateKey(a), discovery.candidateKey(b));
  assert.deepEqual(await nominate({ ...common, poolKey: { ...poolKey, fee: poolKey.fee + 1 } }), []);
  assert.deepEqual(await nominate({ ...common, poolKey, manager: poolKey.currency0 }), []);
  assert.equal(reverseReads, 0);
  assert.deepEqual(await nominate(common), []);
  assert.equal(reverseReads, 1);
});
