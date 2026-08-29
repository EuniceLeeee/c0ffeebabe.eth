import assert from "node:assert/strict";
import test from "node:test";
import { hashDomain, sha256Hex } from "../../../packages/canonical-codec/src/index.ts";
import { encodeEvmLogObservation } from "../../../packages/observation/src/index.ts";
import {
  UNIV4_CONTRACT_EVIDENCE_TOPIC,
} from "../src/manifest.ts";
import { UNIV4_FAMILY_DEFINITION_HASH } from "../src/family-definition.ts";
import {
  UNIV4_SOURCE_NOMINATION_PROGRAM,
  UNIV4_SOURCE_PLAN_RUNTIME,
} from "../src/source-plan.ts";
import { UNIV4_POOL_MANAGER, UNIV4_QUOTER, UNIV4_STATE_VIEW, decodeUniv4InitializeLog, poolIdForKey, type Univ4PoolKey } from "../src/abi.ts";
import {
  UNIV4_CONTRACT_PATTERN,
  buildUniv4Action,
  coarseUniv4,
  compileUniv4Execution,
  decodeUniv4Candidate,
  deriveUniv4Routes,
  exactUniv4,
  materializeUniv4,
  nominateUniv4,
  verifyUniv4IdentityStage,
} from "../src/stages.ts";

const addr = (digit: string) => "0x" + digit.repeat(40);
const h = (label: string) => hashDomain("aloha/test/univ4", label);
const cutoff = { chainId: "1", number: "100", hash: h("block"), stateRoot: h("state") } as const;
const poolKey: Univ4PoolKey = Object.freeze({ currency0: addr("1"), currency1: addr("2"), fee: "3000", tickSpacing: "60", hooks: addr("0") });
/** `cast abi-encode ... | cast keccak` over the exact Solidity PoolKey tuple. */
const poolId = "0x25431634fd7de72516ccb751020a1a9188376a983ccc5f6c1152ca04a6acffad" as const;
const abiWord = (value: bigint) => BigInt.asUintN(256, value).toString(16).padStart(64, "0");
const initializeLog = Object.freeze({
  kind: "evm-log" as const,
  version: 1 as const,
  blockNumber: "100",
  blockHash: cutoff.hash,
  transactionHash: h("tx"),
  logIndex: "0",
  address: UNIV4_POOL_MANAGER.toLowerCase(),
  topics: Object.freeze([
    UNIV4_CONTRACT_EVIDENCE_TOPIC,
    poolId,
    `0x${"0".repeat(24)}${poolKey.currency0.slice(2)}` as const,
    `0x${"0".repeat(24)}${poolKey.currency1.slice(2)}` as const,
  ]),
  data: `0x${abiWord(3000n)}${abiWord(60n)}${abiWord(BigInt(poolKey.hooks))}${abiWord(1n << 96n)}${abiWord(0n)}`,
});
const initializeBytes = encodeEvmLogObservation(initializeLog);
const initializeRawLocatorHash = sha256Hex(initializeBytes);
const observation = {
  kind: "log" as const,
  target: UNIV4_POOL_MANAGER,
  blockNumber: "100",
  blockHash: cutoff.hash,
  txHash: initializeLog.transactionHash,
  logIndex: "0",
  topic: UNIV4_CONTRACT_EVIDENCE_TOPIC,
  rawLocatorHash: initializeRawLocatorHash,
  cutoff,
};

function verified() {
  const seed = decodeUniv4Candidate(observation, UNIV4_CONTRACT_PATTERN);
  assert.ok(seed);
  const nomination = nominateUniv4({ ...seed, poolId });
  assert.equal(nomination.status, "nominated");
  if (nomination.status !== "nominated") throw new Error("nomination failed");
  const identity = verifyUniv4IdentityStage({
    candidate: nomination.candidate,
    reads: {
      cutoff,
      target: UNIV4_POOL_MANAGER,
      reverseTarget: UNIV4_POOL_MANAGER,
      inputAsset: poolKey.currency0,
      outputAsset: poolKey.currency1,
      poolId,
      poolKey,
      managerBinding: { manager: UNIV4_POOL_MANAGER, stateView: UNIV4_STATE_VIEW, quoter: UNIV4_QUOTER },
    },
  });
  assert.equal(identity.status, "verified");
  if (identity.status !== "verified") throw new Error("identity failed");
  const state = materializeUniv4({
    identity: identity.identity,
    read: { cutoff, instanceKey: poolId, reserveIn: "100", reserveOut: "200" },
  });
  assert.equal(state.status, "verified");
  if (state.status !== "verified") throw new Error("materialization failed");
  const route = deriveUniv4Routes(identity.identity)[0];
  assert.ok(route);
  return { identity: identity.identity, state: state.state, route };
}

test("UniV4 source execution is the fixed 50-block recent window", async () => {
  const { UNIV4_FAMILY_DEFINITION_HASH } = await import("../src/family-definition.ts");
  const plan = {
    ownerRef: h("owner"),
    sourcePlanRef: h("source-plan"),
    familyDefinitionHash: UNIV4_FAMILY_DEFINITION_HASH,
    completeness: "nomination-only" as const,
    historyStartBlock: null,
  };
  const result = await UNIV4_SOURCE_PLAN_RUNTIME.execute(
    { plan, cutoff, previousAppliedThrough: null },
    { request: async () => { throw new Error("physical source producer must not be called"); } },
    new AbortController().signal,
  );
  assert.equal(result.execution.from, String(BigInt(cutoff.number) - 49n));
  assert.equal(result.execution.through, cutoff.number);
  assert.equal(result.execution.outcome, "complete");
  assert.equal(result.execution.executionRoot, result.execution.executionRoot);
});
test("UniV4 PoolKey hashes to the independent Solidity/cast known vector", () => {
  assert.equal(poolIdForKey(poolKey), poolId);
  assert.throws(() => decodeUniv4InitializeLog({ ...initializeLog, data: initializeLog.data.slice(0, -64) }, UNIV4_CONTRACT_EVIDENCE_TOPIC), /Initialize log binding/);
  assert.throws(() => decodeUniv4InitializeLog({ ...initializeLog, topics: [initializeLog.topics[0]!, h("foreign-pool"), initializeLog.topics[2]!, initializeLog.topics[3]!] }, UNIV4_CONTRACT_EVIDENCE_TOPIC), /PoolKey reverse binding/);
});
test("UniV4 source nomination derives the required poolId from raw Initialize evidence", async () => {
  const plan = { ownerRef: h("owner"), sourcePlanRef: h("source-plan"), familyDefinitionHash: UNIV4_FAMILY_DEFINITION_HASH, completeness: "nomination-only" as const, historyStartBlock: null };
  const sealed = await UNIV4_SOURCE_PLAN_RUNTIME.execute({ plan, cutoff, previousAppliedThrough: null }, { request: async () => { throw new Error("not used"); } }, new AbortController().signal);
  const evidence = Object.freeze({ kind: "recent-log" as const, version: 1 as const, sourcePlanRef: null, ownerRef: null, blockNumber: initializeLog.blockNumber, blockHash: initializeLog.blockHash, txHash: initializeLog.transactionHash, logIndex: initializeLog.logIndex, address: initializeLog.address, topic: UNIV4_CONTRACT_EVIDENCE_TOPIC, rawLocatorHash: initializeRawLocatorHash });
  const nominations = await UNIV4_SOURCE_NOMINATION_PROGRAM.evaluate({
    execution: sealed.execution,
    sourceEvidence: sealed.sourceEvidence,
    recent: { kind: "recent-observation", version: 1, cutoff, range: { from: "51", to: "100" }, orderedHeaders: [], evidence: [evidence], rawLocatorHashes: [initializeRawLocatorHash], observationRoot: h("recent") },
    rawEvidence: { read: locator => { assert.equal(locator, initializeRawLocatorHash); return initializeBytes; } },
  }, new AbortController().signal);
  assert.equal(nominations.length, 1);
  assert.equal(nominations[0]?.instanceNominationKey, poolId);
});
test("UNIV4_SOURCE_PLAN_RUNTIME is deterministic and does not call a physical source producer", async () => {
  const { UNIV4_FAMILY_DEFINITION_HASH } = await import("../src/family-definition.ts");
  const plan = {
    ownerRef: h("owner"),
    sourcePlanRef: h("source-plan"),
    familyDefinitionHash: UNIV4_FAMILY_DEFINITION_HASH,
    completeness: "nomination-only" as const,
    historyStartBlock: null,
  };
  const result = await UNIV4_SOURCE_PLAN_RUNTIME.execute(
    { plan, cutoff, previousAppliedThrough: null },
    { request: async () => { throw new Error("physical source producer must not be called"); } },
    new AbortController().signal,
  );
  assert.equal(result.execution.plan.familyDefinitionHash, UNIV4_FAMILY_DEFINITION_HASH);
  assert.equal(result.execution.from, String(BigInt(cutoff.number) - 49n));
  assert.equal(result.execution.through, cutoff.number);
  assert.equal(result.execution.previousAppliedThrough, null);
  assert.equal(result.execution.sourceEvidenceRefs.length, 0);
  assert.equal(result.execution.rawLocatorHashes.length, 0);
  assert.equal(result.sourceEvidence.refs.length, 0);
  assert.equal(result.sourceEvidence.rawLocatorHashes.length, 0);
  const nominations = await UNIV4_SOURCE_NOMINATION_PROGRAM.evaluate({
    execution: result.execution,
    sourceEvidence: result.sourceEvidence,
    recent: {
      kind: "recent-observation",
      version: 1,
      cutoff,
      range: { from: result.execution.from, to: result.execution.through },
      orderedHeaders: [],
      evidence: [],
      rawLocatorHashes: [],
      observationRoot: h("empty-recent"),
    },
    rawEvidence: { read: () => { throw new Error("no raw read for an empty routed set"); } },
  }, new AbortController().signal);
  assert.deepEqual(nominations, []);
});
test("UniV4 nomination rejects evidence outside the fixed 50-block window and wrong pattern", () => {
  const seed = decodeUniv4Candidate(observation, UNIV4_CONTRACT_PATTERN);
  assert.ok(seed);
  assert.deepEqual(
    nominateUniv4({ ...seed, poolId, evidence: { ...seed.evidence, blockNumber: "50" } }),
    { status: "chain-proven-rejected", reasonCode: "evidence-before-window" },
  );
  assert.equal(
    decodeUniv4Candidate({ ...observation, topic: h("wrong-topic") }, UNIV4_CONTRACT_PATTERN),
    null,
  );
});

test("UniV4 reverse identity binds the instance before route and state", () => {
  const seed = decodeUniv4Candidate(observation, UNIV4_CONTRACT_PATTERN);
  assert.ok(seed);
  const nomination = nominateUniv4({ ...seed, poolId });
  assert.equal(nomination.status, "nominated");
  if (nomination.status !== "nominated") throw new Error("nomination failed");
  const rejected = verifyUniv4IdentityStage({
    candidate: nomination.candidate,
    reads: {
      cutoff,
      target: UNIV4_POOL_MANAGER,
      reverseTarget: addr("6"),
      inputAsset: poolKey.currency0,
      outputAsset: poolKey.currency1,
      poolId,
      poolKey,
      managerBinding: { manager: UNIV4_POOL_MANAGER, stateView: UNIV4_STATE_VIEW, quoter: UNIV4_QUOTER },
    },
  });
  assert.deepEqual(rejected, { status: "chain-proven-rejected", reasonCode: "reverse-identity-mismatch" });
});

test("UniV4 carries identity → materialization → route → exact → action → execution lineage", () => {
  const facts = verified();
  const coarse = coarseUniv4({
    identity: facts.identity,
    route: facts.route,
    amountIn: "10",
    observedAmountOut: "20",
  });
  assert.equal(coarse.status, "rankable");
  if (coarse.status !== "rankable") throw new Error("coarse failed");
  const exact = exactUniv4({
    identity: facts.identity,
    route: facts.route,
    amountIn: "10",
    observedAmountOut: "20",
  });
  assert.equal(exact.status, "rankable");
  if (exact.status !== "rankable") throw new Error("exact failed");
  const action = buildUniv4Action({
    identity: facts.identity,
    quote: exact.quote,
    calldata: "0x1234",
  });
  assert.throws(
    () => buildUniv4Action({
      identity: facts.identity,
      quote: { ...exact.quote, routeBindingHash: h("foreign-route") },
      calldata: "0x1234",
    }),
    /route binding/,
  );
  const intent = compileUniv4Execution({ identity: facts.identity, action });
  assert.equal(intent.actionHash, action.actionHash);
  assert.equal(intent.target, UNIV4_POOL_MANAGER.toLowerCase());
});
