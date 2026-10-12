import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ethers } from "ethers";
import { RuntimeAmountProgram, runtimeAmountFlowAdapter } from "../../adapters/runtime-amount-program.js";
import { register } from "../../adapters/registry.js";
import { compilePlan } from "../../shared/compiler/compiler.js";
import { loadBotVmRuntimeCode } from "../../shared/executor/botvm-executor.js";
import { buildEthSimulateV1ExecutionInput, validateEthSimulateV1ExecutionInput } from "../simulator/eth-simulate-v1.js";
import { HOP_DIAGNOSTIC_SLOT, directRevertedRuntimeHop, type DirectRevertEvidence } from "../simulator/direct-revert-hop.js";
import { runtimeProgramMatchesCall } from "../simulator/runtime-program-match.js";
import { ADDR } from "../../shared/constants/addresses.js";
import { buildBlockScanEthView } from "../blockscan-eth-view.js";
import { BlockScanPoolRevertAttributor, poolRevertFilterEnabled } from "../blockscan-pool-revert.js";
import { BlockScanSimRejectCache } from "../blockscan-sim-reject-cache.js";
import { scanBlockStateFromResolvedMids, type BlockScanCoreConfig, type ResolvedBlockScanQuote } from "../detector/blockscan-scanner-core.js";
import type { TokenEdge } from "../planner/token-graph.js";
import { revertedRuntimeHop, type RevertCallFrame } from "../simulator/revert-hop.js";
import type { SimulationResult } from "../simulator/botvm-simulator.js";
import type { ResolvedPlan } from "../solver/solver.js";
import { blockScanEdgeKey } from "../venues/blockscan-state-capability.js";

const addr = (n: number) => ethers.getAddress("0x" + n.toString(16).padStart(40, "0"));
const executor = addr(1), owner = addr(2), a = ADDR.WETH.toLowerCase(), b = addr(4);
const edge = (target: string, tokenIn = a, tokenOut = b): TokenEdge => ({
  target, tokenIn, tokenOut, adapterId: "univ2-swap", slotKind: "swap",
  edgeKind: "swap", leavesStandingPosition: false,
});
const edges = [edge(addr(11)), edge(addr(12), b, a)];
const abi = new ethers.Interface(["function exchange(uint256 amount,bytes32 identity)", "error Error(string)"]);
const data = abi.encodeFunctionData("exchange", [0n, ethers.ZeroHash]);
const program = (target: string) => ethers.hexlify(new RuntimeAmountProgram()
  .constant(1, 2n).math("add", 2, 0, 1).equal(0, 0)
  .call(target, data, { patches: [{ offset: 4, reg: 0 }] }).bytes());
const legs = edges.map(e => ({ tokenIn: e.tokenIn, tokenOut: e.tokenOut, program: program(e.target) }));
const plan: ResolvedPlan = {
  root: { adapterId: "runtime-amount-flow", target: executor, tokenIn: a, tokenOut: a,
    amount: 100n, params: { legs: JSON.stringify(legs), minimumReturn: 101n }, children: [] },
  flashAmount: 100n, profitToken: a, netProfit: 1n, templateName: "pool attribution",
};
const failedCall: RevertCallFrame = { type: "CALL", from: executor, to: edges[0]!.target,
  input: abi.encodeFunctionData("exchange", [100n, ethers.ZeroHash]), error: "execution reverted", output: "0x" };
const trace: RevertCallFrame = { type: "CALL", from: owner, to: executor, input: "0xaabb",
  error: "execution reverted", output: abi.encodeErrorResult("Error", ["runtime external call"]),
  calls: [failedCall] };
assert(runtimeProgramMatchesCall(legs[0]!.program, failedCall));
assert(!runtimeProgramMatchesCall(legs[0]!.program, { ...failedCall, type: "STATICCALL" }));
assert(!runtimeProgramMatchesCall(legs[0]!.program, { ...failedCall,
  input: abi.encodeFunctionData("exchange", [100n, "0x" + "11".repeat(32)]) }));
assert(!runtimeProgramMatchesCall(legs[0]!.program.slice(0, -2), failedCall));
assert.equal(revertedRuntimeHop(plan, edges, trace, executor), 0);
for (const variant of [
  { ...trace, error: undefined },
  { ...trace, output: abi.encodeErrorResult("Error", ["runtime minimum output"]) },
  { ...trace, calls: [{ ...failedCall, error: "out of gas" }] },
  { ...trace, calls: [failedCall, { ...failedCall, error: undefined }] },
  { ...trace, calls: [{ ...failedCall, from: owner }] },
]) assert.equal(revertedRuntimeHop(plan, edges, variant, executor), null);
assert.equal(revertedRuntimeHop({ ...plan, root: { ...plan.root, params: {
  ...plan.root.params, legs: JSON.stringify([legs[0], legs[0]]),
} } }, [edges[0]!, edges[0]!], trace, executor), null, "ambiguous repeated call cannot poison a pool");
assert.equal(revertedRuntimeHop(plan, [edge(addr(13)), edges[1]!], trace, executor), null,
  "a Family-emitted support call cannot be relabelled as another pool");

const source = { number: 100, hash: "0x" + "aa".repeat(32), generation: 1 };
register(runtimeAmountFlowAdapter);
const executionInput = buildEthSimulateV1ExecutionInput({ source, owner, executor,
  header: { number: 100, hash: source.hash, parentHash: ethers.ZeroHash,
    timestamp: 1800000000, baseFeePerGas: 1n, gasUsed: 30000000n, gasLimit: 60000000n, transactionHashes: [] },
  profitToken: a, scriptHex: ethers.hexlify(compilePlan(plan.root, executor)),
  executorRuntimeCode: loadBotVmRuntimeCode(owner), diagnosticKey: "0x" + "34".repeat(32),
});
assert.equal(executionInput.schemaVersion, 4);
assert.deepEqual(validateEthSimulateV1ExecutionInput(JSON.parse(JSON.stringify(executionInput))), executionInput);
const withWrongStorage = JSON.parse(JSON.stringify(executionInput));
withWrongStorage.simulateParams[0].blockStateCalls[0].stateOverrides[executor].stateDiff[HOP_DIAGNOSTIC_SLOT] = ethers.ZeroHash;
assert.throws(() => validateEthSimulateV1ExecutionInput(withWrongStorage));
const diagnosticAbi = new ethers.Interface([
  "error RuntimeHopFailed(uint256 hop,address target,bytes32 flowHash,bytes reason,bytes32 proof)",
]);
const directEvidence = (hop: number, reason = "0x", target = edges[hop]!.target): DirectRevertEvidence => {
  const flowHash = ethers.keccak256(compilePlan(plan.root, executor).slice(4));
  const proof = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(
    ["bytes32", "uint256", "address", "bytes32", "bytes32"],
    [executionInput.diagnosticKey, hop, target, flowHash, ethers.keccak256(reason)],
  ));
  return { executionInput, gasUsed: "123456", returnData: diagnosticAbi.encodeErrorResult("RuntimeHopFailed",
    [hop, target, flowHash, reason, proof]) };
};
const evidence = directEvidence(0);
assert.equal(directRevertedRuntimeHop(plan, edges, evidence)?.hopIndex, 0);
assert.equal(directRevertedRuntimeHop({ ...plan, flashAmount: 99n }, edges, evidence), null);
assert.equal(directRevertedRuntimeHop(plan, edges, { ...evidence,
  returnData: evidence.returnData.slice(0, -2) + "aa" }), null, "foreign errors cannot forge the envelope");
assert.equal(directRevertedRuntimeHop(plan, edges, { ...evidence,
  errorData: "0xdeadbeef" }), null, "conflicting original response bytes are unresolved");
assert.equal(directRevertedRuntimeHop(plan, edges, { ...evidence,
  executionInput: { ...executionInput, diagnosticKey: "0x" + "56".repeat(32) } }), null, "another trial cannot replay the proof");
let traceCalls = 0;
const sim: SimulationResult = { success: false, netProfit: 0n, grossProfit: 0n, gasUsed: 0n,
  profitToken: a, calldata: executionInput.calldata,
  failure: { kind: "revert", code: "TRANSACTION_REVERTED", cause: new Error("fixture") },
  revertEvidence: evidence,
  traceRevert: async () => { traceCalls++; throw new Error("must not add a trace request"); },
};
const root = mkdtempSync(join(tmpdir(), "pool-revert-test-"));
const control = () => ({ signal: new AbortController().signal, deadlineAtMs: Date.now() + 3000 });
const request = () => ({ source, edges, p: 100n, trials: [{ plan, sim }], ...control() });
try {
  const cache = new BlockScanSimRejectCache();
  const writer = new BlockScanPoolRevertAttributor(cache, root);
  const path = await writer.record(request());
  assert(path);
  const saved = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(saved.trials[0].attribution.callTarget, edges[0]!.target.toLowerCase());
  assert.equal(saved.trials[0].returnData, evidence.returnData);
  assert.equal(saved.policy, "p-revert-failed-hop-any-cause");
  assert.equal(saved.trials[0].executionInput.source.hash, source.hash);
  assert(cache.hasPool(edges[0]!));
  assert(!cache.hasPool(edges[1]!), "the shared tail pool remains eligible");
  assert.equal(cache.hasPool(edge(edges[0]!.target, b, a)), true);
  assert.equal(new BlockScanSimRejectCache().hasPool(edges[0]!), false);
  cache.clear();
  assert(!cache.hasPool(edges[0]!));
  for (const variant of [
    { ...sim, revertEvidence: undefined },
    { ...sim, revertEvidence: { ...evidence, returnData: "0x" } },
    { ...sim, revertEvidence: { ...evidence, executionInput: { ...executionInput,
      source: { ...source, hash: "0x" + "bb".repeat(32) } } } },
    { ...sim, revertEvidence: { ...evidence, returnData: abi.encodeErrorResult("Error", ["min profit"]) } },
    { ...sim, failure: { kind: "rpc", code: 429, cause: new Error("rate limit") } },
    { ...sim, success: true },
  ]) {
    assert.equal(await writer.record({ ...request(), trials: [{ plan, sim: variant }] }), null);
    assert(!cache.hasPool(edges[0]!));
  }
  assert.equal(await writer.record({ ...request(), p: 99n }), null, "only P is eligible");
  assert.equal(await writer.record({ ...request(), signal: AbortSignal.abort() }), null);
  assert.equal(await writer.record({ ...request(), deadlineAtMs: 0 }), null);
  assert.equal(await writer.record({ ...request(), trials: [{ plan, sim }, { plan, sim: { ...sim,
    revertEvidence: directEvidence(1),
  } }] }), null, "different P-trial attribution stays unresolved");
  const unwritable = new BlockScanPoolRevertAttributor(cache, join(path, "not-a-directory"));
  assert.equal(await unwritable.record(request()), null);
  assert(!cache.hasPool(edges[0]!), "unsaved evidence must never create pool policy");
  // Policy deliberately does not classify reasons. A hop-specific executor
  // floor or token/support call is eligible, but no other hop inherits it.
  for (const reason of ["runtime minimum output", "token transfer failed", "unsupported error"]) {
    assert(await writer.record({ ...request(), trials: [{ plan, sim: { ...sim,
      revertEvidence: directEvidence(1, abi.encodeErrorResult("Error", [reason]), b),
    } }] }));
    assert(cache.hasPool(edges[1]!));
    assert(!cache.hasPool(edges[0]!));
    cache.clear();
  }
  assert.equal(traceCalls, 0);
  const shared = { ...edges[0]!, instanceKey: "logical-instance-1" };
  assert(cache.recordPool(shared, sim, { amount: 100n, p: 100n }));
  assert(!cache.hasPool({ ...shared, instanceKey: "logical-instance-2" }));
  const id1 = { ...edges[0]!, poolId: "0x" + "11".repeat(32) };
  assert(cache.recordPool(id1, sim, { amount: 100n, p: 100n }));
  assert(!cache.hasPool({ ...id1, poolId: "0x" + "22".repeat(32) }));
} finally { rmSync(root, { recursive: true, force: true }); }
for (const value of [undefined, "0"]) assert.equal(poolRevertFilterEnabled(value), false);
assert.equal(poolRevertFilterEnabled("1"), true);
assert.throws(() => poolRevertFilterEnabled("true"));

// A toxic pool changes the K=1 anchor. Filtering must rebuild from full effective
// mids before pairing/ranking; deleting its resulting routes afterwards differs.
const allEdges = [11, 12, 13].flatMap(n => [edge(addr(n)), edge(addr(n), b, a)]);
const mids = new Map<string, ResolvedBlockScanQuote>(allEdges.map((e, i) => [blockScanEdgeKey(e), {
  kind: "v2", pool: e.target, edges: [e],
  mid: [1000, 0.001, 1, 1.1, 1, 1][i]!, feeBps: 0, depthProxy: 0,
  quoteAmountIn: 1000n, quoteAmountOut: [1000000n, 1n, 1000n, 1100n, 1000n, 1000n][i]!,
}]));
const cfg: BlockScanCoreConfig = { maxHops: 3, minSpreadBps: 0, maxCandidates: 1,
  budgetMs: 10000, ethSignalPairsPerToken: 1, pricedTokens: new Map([[a, { maxBorrow: 10n ** 18n }]]) };
const view = buildBlockScanEthView(allEdges, mids, 1, false);
const snapshot = () => JSON.stringify([...mids], (_key, value) => typeof value === "bigint" ? value.toString() : value);
const before = snapshot();
const base = { sourceBlock: 100, swapTouched: null, cfg, mids };
const off = scanBlockStateFromResolvedMids({ ...base, edges: allEdges, ethView: view });
assert(off.opportunities.some(o => o.seedEdges.some(e => e.target === addr(11))));
const on = scanBlockStateFromResolvedMids({ ...base, edges: allEdges, ethView: view,
  poolRevertExcludedEdge: e => e.target === addr(11) });
const expected = scanBlockStateFromResolvedMids({ ...base, edges: allEdges.filter(e => e.target !== addr(11)) });
assert(on.opportunities.length > 0);
assert.deepEqual(on.opportunities, expected.opportunities);
assert(on.opportunities.every(o => o.seedEdges.every(e => e.target !== addr(11))));
assert.equal(snapshot(), before, "the published effective table stays complete");
console.log("blockscan-pool-revert PASS (original-sim proof, any reason, no trace, P-only, persistence, run lifetime, pre-pair filtering)");

const fixtureDirectory = process.env.MEV_POOL_REVERT_FIXTURES;
if (fixtureDirectory) {
  const cache = new BlockScanSimRejectCache();
  const writer = new BlockScanPoolRevertAttributor(cache, join(fixtureDirectory, "verified-attribution"));
  let attributed = 0;
  let batTail: TokenEdge | undefined;
  for (const id of [1, 689, 4000, 6300, 6871]) {
    const fixture = JSON.parse(readFileSync(join(fixtureDirectory, `fixture-${id}.json`), "utf8"),
      (_key, value) => value?.$type === "bigint" ? BigInt(value.value) : value) as {
      expectedHop: number | null; expectedTarget: string | null; edges: TokenEdge[]; trace: RevertCallFrame;
      input: { plan: ResolvedPlan; originalResult: SimulationResult;
        source: typeof source; executionInput: typeof executionInput & { simulateParams: [
          { blockStateCalls: Array<{ calls: unknown[]; stateOverrides: unknown; blockOverrides: unknown }> }, unknown
        ] }; params: [unknown, unknown, { stateOverrides: unknown; blockOverrides: unknown }] };
    };
    const saved = fixture.input;
    const block = saved.executionInput.simulateParams[0].blockStateCalls[0]!;
    assert.deepEqual(saved.params[0], block.calls[1]);
    assert.deepEqual(saved.params[1], saved.executionInput.simulateParams[1]);
    assert.deepEqual(saved.params[2].stateOverrides, block.stateOverrides);
    assert.deepEqual(saved.params[2].blockOverrides, block.blockOverrides);
    const p = 2_000_000_000_000_000n;
    if (!saved.originalResult.success) assert.equal(saved.plan.flashAmount, p);
    if (id === 6871) batTail = fixture.edges.find(e => e.target.toLowerCase() === "0xae614a7a56cb79c04df2aeba6f5dab80a39ca78e");
    assert.equal(fixture.trace.input?.toLowerCase(), saved.executionInput.calldata.toLowerCase());
    const hop = revertedRuntimeHop(saved.plan, fixture.edges, fixture.trace, saved.executionInput.executor);
    assert.equal(hop, fixture.expectedHop, `saved production trial ${id}`);
    if (hop !== null) assert.equal(fixture.edges[hop]!.target.toLowerCase(), fixture.expectedTarget);
    // Historical trace decoding remains an offline diagnostic, never new-live policy.
    if (hop !== null) attributed++;
    console.log(JSON.stringify({ trial: id, historicalHopIndex: hop }));
  }
  assert.equal(attributed, 2);
  assert(batTail);
  assert(!cache.hasPool(batTail),
    "BAT tail must not inherit the AMPL failures");
  console.log("saved production traces PASS: two AMPL hops, two executor guards, BAT success control");
}
