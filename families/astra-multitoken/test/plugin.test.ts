import assert from "node:assert/strict";
import test from "node:test";
import { encodeCanonicalBytes, hashDomain, sha256Hex } from "../../../packages/canonical-codec/src/index.ts";
import { sourcePlanEvidenceRoot, sourcePlanExecutionRoot, type RecentLogEvidenceRefV1 } from "../../../packages/discovery/src/index.ts";
import type { RecentObservationReceiptV1 } from "../../../packages/observation/src/index.ts";
import { astraEffectProgram, validateAstraExchange, type Address } from "../kernel/effects.ts";
import { ASTRA_CHANGE_SELECTOR, ASTRA_CHANGE_TOPIC, ASTRA_COARSE_DEFINITION, ASTRA_CURRENT_SOURCE_EXACT, ASTRA_DEFINITION, ASTRA_EXACT_DEFINITION, ASTRA_FAMILY_DEFINITION_HASH, ASTRA_HISTORY_SOURCE_PLAN, ASTRA_IDENTITY_DEFINITION, ASTRA_MATERIALIZATION_DEFINITION, ASTRA_NOMINATION_DEFINITION, ASTRA_PROJECTION_DEFINITION, ASTRA_REHYDRATION_DEFINITION, ASTRA_RUNTIME_ADAPTER, ASTRA_SOURCE_NOMINATION_PROGRAM, ASTRA_SOURCE_PLAN, ASTRA_SOURCE_PLAN_RUNTIME, ASTRA_STAGE_IDS, ASTRA_STATE_DEFINITION, decodeAstraCandidate, nominateAstra } from "../src/public.ts";
import { compileAstraInstance } from "../src/instance.ts";
import { deriveAstraRoutes } from "../src/routes.ts";
import { buildAstraEffectSimulation, validateAstraEffectSimulationProgram } from "../src/execution.ts";
import { evaluateAstraExact } from "../src/exact.ts";
import { verifyAstraIdentity } from "../src/identity.ts";

const address = (digit: string) => `0x${digit.repeat(40)}` as Address;
const h = (value: string) => hashDomain("test/astra-family", value);
const source = Object.freeze({ chainId: "1", number: "100", hash: h("block"), stateRoot: h("state") });
const target = address("1");
const actor = address("2");
const tokenIn = address("3");
const tokenOut = address("4");
const abiWord = (value: string) => value.replace(/^0x/, "").padStart(64, "0");

function sourcePlanFixture() {
  const rawBytes = encodeCanonicalBytes({
    kind: "astra-log-evidence",
    version: 1,
    target,
    topics: [ASTRA_CHANGE_TOPIC, `0x${abiWord(tokenIn)}`, `0x${abiWord(tokenOut)}`, `0x${abiWord(actor)}`],
    dataHex: `0x${abiWord("0x7")}${abiWord("0x9")}`,
  });
  const rawHash = sha256Hex(rawBytes);
  const plan = {
    ownerRef: h("owner"),
    sourcePlanRef: h("source-plan"),
    familyDefinitionHash: ASTRA_FAMILY_DEFINITION_HASH,
    completeness: "nomination-only" as const,
    historyStartBlock: null,
  };
  const sourceEvidence = {
    kind: "source-plan-evidence" as const,
    version: 1 as const,
    plan,
    cutoff: source,
    refs: [],
    rawLocatorHashes: [rawHash],
    evidenceRoot: sourcePlanEvidenceRoot({ plan, cutoff: source, refs: [], rawLocatorHashes: [rawHash] }),
  };
  const executionBase = {
    kind: "source-plan-execution" as const,
    version: 1 as const,
    plan,
    cutoff: source,
    outcome: "positive-only" as const,
    from: "51",
    through: "100",
    previousAppliedThrough: null,
    resultPartitionRoot: h("partition"),
    opaqueResult: { kind: "astra-source-plan-result" },
    sourceEvidenceRefs: [],
    rawLocatorHashes: [rawHash],
    sourceEvidenceRoot: sourceEvidence.evidenceRoot,
  };
  const execution = { ...executionBase, executionRoot: sourcePlanExecutionRoot(executionBase) };
  const owned: RecentLogEvidenceRefV1 = {
    kind: "recent-log",
    version: 1,
    sourcePlanRef: null,
    ownerRef: null,
    blockNumber: "100",
    blockHash: source.hash,
    txHash: h("owned-tx"),
    logIndex: "0",
    address: target,
    topic: ASTRA_CHANGE_TOPIC,
    rawLocatorHash: rawHash,
  };
  const foreignHash = h("foreign-raw");
  const foreign: RecentLogEvidenceRefV1 = { ...owned, txHash: h("foreign-tx"), topic: h("foreign-topic"), rawLocatorHash: foreignHash };
  const recent: RecentObservationReceiptV1 = {
    kind: "recent-observation",
    version: 1,
    cutoff: source,
    range: { from: "51", to: "100" },
    orderedHeaders: [],
    evidence: [owned, { ...owned, txHash: h("owned-duplicate") }, foreign],
    rawLocatorHashes: [rawHash, foreignHash],
    observationRoot: h("recent"),
  };
  const locator = { kind: "raw-evidence-locator" as const, version: 1 as const, rawLocatorHash: rawHash, bytesHex: `0x${Array.from(rawBytes).map(value => value.toString(16).padStart(2, "0")).join("")}` };
  return { plan, sourceEvidence, execution, recent, rawHash, rawBytes, locator };
}

test("Astra call discovery preserves the observed actor separately from the target", () => {
  const candidate = decodeAstraCandidate({
    kind: "call",
    target,
    sender: actor,
    source,
    blockNumber: source.number,
    blockHash: source.hash,
    txHash: h("tx"),
    logIndex: "0",
    dataHex: `${ASTRA_CHANGE_SELECTOR}${tokenIn.slice(2).padStart(64, "0")}${tokenOut.slice(2).padStart(64, "0")}${"7".padStart(64, "0")}${"5".padStart(64, "0")}`,
  }, "astra-change-call");
  assert.ok(candidate);
  assert.equal(candidate.target, target);
  assert.equal(candidate.actor, actor);
  assert.notEqual(candidate.actor, candidate.target);
  assert.equal(ASTRA_CHANGE_TOPIC.length, 66);
  assert.equal(decodeAstraCandidate({
    kind: "call",
    target,
    sender: actor,
    source,
    blockNumber: source.number,
    blockHash: source.hash,
    txHash: h("tx-extra"),
    logIndex: "0",
    dataHex: `${ASTRA_CHANGE_SELECTOR}${tokenIn.slice(2).padStart(64, "0")}${tokenOut.slice(2).padStart(64, "0")}${"7".padStart(64, "0")}${"5".padStart(64, "0")}00`,
  }, "astra-change-call"), null);
});

test("Astra nomination uses a canonical target key and does not misclassify malformed evidence as old-window evidence", () => {
  const malformed = nominateAstra({
    target: `0x${target.slice(2).toUpperCase()}`,
    evidence: {
      kind: "call",
      target,
      sender: actor,
      source,
      blockNumber: source.number,
      blockHash: source.hash,
      txHash: h("malformed"),
      logIndex: "0",
      dataHex: `${ASTRA_CHANGE_SELECTOR}00`,
    },
  });
  assert.deepEqual(malformed, { status: "chain-proven-rejected", reasonCode: "malformed-evidence" });
  assert.throws(() => nominateAstra({
    target: address("5"),
    evidence: {
      kind: "call",
      target,
      sender: actor,
      source,
      blockNumber: source.number,
      blockHash: source.hash,
      txHash: h("wrong-target"),
      logIndex: "0",
      dataHex: `${ASTRA_CHANGE_SELECTOR}${tokenIn.slice(2).padStart(64, "0")}${tokenOut.slice(2).padStart(64, "0")}${"7".padStart(64, "0")}${"5".padStart(64, "0")}`,
    },
  }));
});

test("Astra declares all five stages, source plan, exact/action/runtime and family-local facts", () => {
  assert.deepEqual(Object.keys(ASTRA_STAGE_IDS), ["nomination", "identity", "materialization", "projection", "rehydration", "state", "coarse", "exact"]);
  assert.equal(ASTRA_DEFINITION.manifest.sourcePlans.length, 2);
  const recentPlan = ASTRA_DEFINITION.manifest.sourcePlans.find(plan => plan.sourcePlanId === ASTRA_SOURCE_PLAN.sourcePlanId);
  assert.ok(recentPlan);
  const { nominationProgram, ...sourcePlanDeclaration } = recentPlan;
  assert.deepEqual(sourcePlanDeclaration, {
    sourcePlanId: ASTRA_SOURCE_PLAN.sourcePlanId,
    completeness: "nomination-only",
    historyStartBlock: null,
    schemaHash: ASTRA_SOURCE_PLAN.schemaHash,
    modulePath: "families/astra-multitoken/src/source-plan-runtime.ts",
    exportName: "ASTRA_SOURCE_PLAN_RUNTIME",
  });
  assert.equal(nominationProgram.kind, "present");
  if (nominationProgram.kind !== "present") throw new Error("Astra nomination program is absent");
  assert.equal(nominationProgram.program.exportName, "ASTRA_SOURCE_NOMINATION_PROGRAM");
  assert.equal(nominationProgram.program.schemaHash, ASTRA_SOURCE_PLAN.schemaHash);
  assert.equal(nominationProgram.program.mutationCorpus.exportName, "ASTRA_NOMINATION_MUTATION_CORPUS");
  assert.equal(nominationProgram.program.independentOracle.exportName, "ASTRA_NOMINATION_INDEPENDENT_ORACLE");
  const history = ASTRA_DEFINITION.manifest.sourcePlans.find(plan => plan.sourcePlanId === ASTRA_HISTORY_SOURCE_PLAN.sourcePlanId);
  assert.ok(history);
  assert.equal(history.sourcePlanId, ASTRA_HISTORY_SOURCE_PLAN.sourcePlanId);
  assert.equal(history.completeness, "contiguous-history");
  assert.equal(history.historyStartBlock, "0");
  assert.equal(history.exportName, "ASTRA_HISTORY_SOURCE_PLAN_RUNTIME");
  assert.equal(history.nominationProgram.kind, "present");
  assert.equal(ASTRA_RUNTIME_ADAPTER.currentSourceExact, ASTRA_CURRENT_SOURCE_EXACT);
  assert.equal(ASTRA_RUNTIME_ADAPTER.actionOwnerId, "family.astra-multitoken.convert-action");
  assert.equal(typeof ASTRA_RUNTIME_ADAPTER.currentSourceExact.effectProgram, "function");
  assert.deepEqual([
    ASTRA_NOMINATION_DEFINITION,
    ASTRA_IDENTITY_DEFINITION,
    ASTRA_MATERIALIZATION_DEFINITION,
    ASTRA_PROJECTION_DEFINITION,
    ASTRA_REHYDRATION_DEFINITION,
    ASTRA_STATE_DEFINITION,
    ASTRA_COARSE_DEFINITION,
    ASTRA_EXACT_DEFINITION,
  ].map(item => item.stage), Object.keys(ASTRA_STAGE_IDS));
});

test("Astra source runtime fixes the physical window at 50 blocks and binds every returned root", async () => {
  const fixture = sourcePlanFixture();
  let physicalCalls = 0;
  const executed = await ASTRA_SOURCE_PLAN_RUNTIME.execute(
    { plan: fixture.plan, cutoff: source, previousAppliedThrough: null },
    {
      request: async () => {
        physicalCalls += 1;
        throw new Error("nomination-only Astra source must not use a physical result authority");
      },
    },
    new AbortController().signal,
  );
  assert.equal(physicalCalls, 0);
  assert.equal(executed.execution.from, "51");
  assert.equal(executed.execution.through, "100");
  assert.equal(executed.execution.outcome, "complete");
  assert.equal(executed.execution.rawLocatorHashes.length, 0);
  assert.equal(executed.sourceEvidence.rawLocatorHashes.length, 0);
  assert.notEqual(executed.execution.executionRoot, fixture.execution.executionRoot);
});

test("Astra source nomination decodes only owned matching raw evidence and deduplicates one target", async () => {
  const fixture = sourcePlanFixture();
  const sourceExecution = await ASTRA_SOURCE_PLAN_RUNTIME.execute(
    { plan: fixture.plan, cutoff: source, previousAppliedThrough: null },
    { request: async () => { throw new Error("nomination-only source has no physical request"); } },
    new AbortController().signal,
  );
  let reads = 0;
  const nominations = await ASTRA_SOURCE_NOMINATION_PROGRAM.evaluate({
    execution: sourceExecution.execution,
    sourceEvidence: sourceExecution.sourceEvidence,
    recent: fixture.recent,
    rawEvidence: {
      read: rawHash => {
        reads += 1;
        assert.equal(rawHash, fixture.rawHash);
        return new Uint8Array(fixture.rawBytes);
      },
    },
  }, new AbortController().signal);
  assert.equal(reads, 1);
  assert.equal(nominations.length, 1);
  assert.equal(nominations[0]?.familyId, "astra-multitoken");
  assert.equal(nominations[0]?.instanceNominationKey, target);
});

test("Astra identity derives target and routes from registry facts, not an address allowlist", () => {
  const result = verifyAstraIdentity({
    candidate: { target, actor, tokenIn, tokenOut, amountIn: 10n, minAmountOut: 1n, observedAmountOut: null, sourceKind: "observed-change-call", instanceNominationKey: target, candidateSnapshotHash: h("candidate"), source },
    reads: { target, tokens: [tokenIn, tokenOut], tokenCodeHashes: [h("in-code"), h("out-code")], weights: [50n, 50n], changesEnabled: true, totalPercents: 100n, changeFee: 1n, inLendingMode: null, activeQuote: 9n, source },
  });
  assert.equal(result.status, "verified");
  if (result.status !== "verified") return;
  const instance = compileAstraInstance(result.identity);
  const routes = deriveAstraRoutes(instance);
  assert.equal(routes.length, 2);
  assert.equal(routes[0]!.target, target);
});

test("Astra identity rejects a candidate pair outside the verified token registry", () => {
  const result = verifyAstraIdentity({
    candidate: { target, actor, tokenIn, tokenOut: address("5"), amountIn: 10n, minAmountOut: 1n, observedAmountOut: null, sourceKind: "observed-change-call", instanceNominationKey: target, candidateSnapshotHash: h("candidate-invalid-pair"), source },
    reads: { target, tokens: [tokenIn, tokenOut], tokenCodeHashes: [h("in-code"), h("out-code")], weights: [50n, 50n], changesEnabled: true, totalPercents: 100n, changeFee: 1n, inLendingMode: null, activeQuote: 9n, source },
  });
  assert.deepEqual(result, { status: "chain-proven-rejected", reasonCode: "invalid-token-registry" });
});

test("Astra identity rejects a forged instance nomination key before registry facts are trusted", () => {
  assert.throws(() => verifyAstraIdentity({
    candidate: { target, actor, tokenIn, tokenOut, amountIn: 10n, minAmountOut: 1n, observedAmountOut: null, sourceKind: "observed-change-call", instanceNominationKey: address("9"), candidateSnapshotHash: h("forged-key"), source },
    reads: { target, tokens: [tokenIn, tokenOut], tokenCodeHashes: [h("in-code"), h("out-code")], weights: [50n, 50n], changesEnabled: true, totalPercents: 100n, changeFee: 1n, inLendingMode: null, activeQuote: 9n, source },
  }));
});

test("Astra execution keeps caller mode, preCall, four observations, logs and obligations in the plugin", () => {
  const route = { routeKey: "r", instanceKey: target, target, tokenIn, tokenOut, pairIndex: 0, bindingFingerprint: h("binding") };
  const program = buildAstraEffectSimulation({ route, amountIn: 7n, minAmountOut: 5n });
  assert.deepEqual(validateAstraEffectSimulationProgram(program, { route, amountIn: 7n, minAmountOut: 5n }), program);
  assert.equal(program.caller.executionMode, "impersonated-call-frame");
  assert.equal(program.preCalls.length, 1);
  assert.equal(program.preCalls[0]!.to, tokenIn);
  assert.equal(program.preCalls[0]!.caller.executionMode, "impersonated-call-frame");
  assert.equal(program.observeTokenBalances.length, 4);
  assert.deepEqual(program.observeTokenBalances, [
    { token: tokenIn, account: { kind: "observed-sender" } },
    { token: tokenIn, account: target },
    { token: tokenOut, account: { kind: "observed-sender" } },
    { token: tokenOut, account: target },
  ]);
  assert.equal(program.observeLogs, true);
  assert.ok(program.obligations.includes("token-delta"));
  assert.equal(program.data.slice(0, 10), ASTRA_CHANGE_SELECTOR);
  const deltas = [{ token: tokenIn, account: actor, delta: -7n }, { token: tokenIn, account: target, delta: 7n }, { token: tokenOut, account: actor, delta: 9n }, { token: tokenOut, account: target, delta: -9n }];
  assert.equal(validateAstraExchange({ tokenDeltas: deltas, caller: actor, target, tokenIn, tokenOut, amountIn: 7n, amountOut: 9n }), 9n);
  assert.deepEqual(astraEffectProgram({ caller: actor, target, tokenIn, tokenOut }).observeTokenBalances.length, 4);
});

test("Astra exact effect scope rejects a missing or duplicate segment", () => {
  const deltas = [
    { token: tokenIn, account: actor, delta: -7n },
    { token: tokenIn, account: target, delta: 7n },
    { token: tokenOut, account: actor, delta: 9n },
    { token: tokenOut, account: target, delta: -9n },
  ];
  assert.throws(() => validateAstraExchange({ tokenDeltas: deltas.slice(0, 3), caller: actor, target, tokenIn, tokenOut, amountIn: 7n, amountOut: 9n }));
  assert.throws(() => validateAstraExchange({ tokenDeltas: [...deltas.slice(0, 3), { token: tokenOut, account: actor, delta: 0n }], caller: actor, target, tokenIn, tokenOut, amountIn: 7n, amountOut: 9n }));
});

test("Astra effect declaration rejects clone mutations, missing scope and transport-dropped fields", () => {
  const route = { routeKey: "r-strict", instanceKey: target, target, tokenIn, tokenOut, pairIndex: 0, bindingFingerprint: h("binding-strict") };
  const program = buildAstraEffectSimulation({ route, amountIn: 7n, minAmountOut: 5n });
  assert.throws(() => validateAstraEffectSimulationProgram({ ...program, caller: { ...program.caller, executionMode: "top-level" } }, { route, amountIn: 7n, minAmountOut: 5n }));
  assert.throws(() => validateAstraEffectSimulationProgram({ ...program, preCalls: [] }, { route, amountIn: 7n, minAmountOut: 5n }));
  assert.throws(() => validateAstraEffectSimulationProgram({ ...program, observeTokenBalances: program.observeTokenBalances.slice(0, 3) }, { route, amountIn: 7n, minAmountOut: 5n }));
  assert.throws(() => validateAstraEffectSimulationProgram({ ...program, observeLogs: undefined }, { route, amountIn: 7n, minAmountOut: 5n }));
  assert.throws(() => validateAstraEffectSimulationProgram({ ...program, unexpected: true }, { route, amountIn: 7n, minAmountOut: 5n }));
});

test("Astra exact verification binds deltas to the observed caller and real Change topic", () => {
  const identityOutcome = verifyAstraIdentity({
    candidate: { target, actor, tokenIn, tokenOut, amountIn: 7n, minAmountOut: 1n, observedAmountOut: null, sourceKind: "observed-change-call", instanceNominationKey: target, candidateSnapshotHash: h("candidate-exact"), source },
    reads: { target, tokens: [tokenIn, tokenOut], tokenCodeHashes: [h("in-code"), h("out-code")], weights: [50n, 50n], changesEnabled: true, totalPercents: 100n, changeFee: 1n, inLendingMode: null, activeQuote: 9n, source },
  });
  assert.equal(identityOutcome.status, "verified");
  if (identityOutcome.status !== "verified") return;
  const instance = compileAstraInstance(identityOutcome.identity);
  const route = deriveAstraRoutes(instance)[0]!;
  const exact = evaluateAstraExact({
    identity: identityOutcome.identity,
    route,
    source,
    amountIn: 7n,
    minAmountOut: 1n,
    observation: {
      caller: actor,
      program: buildAstraEffectSimulation({ route, amountIn: 7n, minAmountOut: 1n }),
      tokenDeltas: [{ token: tokenIn, account: actor, delta: -7n }, { token: tokenIn, account: target, delta: 7n }, { token: tokenOut, account: actor, delta: 9n }, { token: tokenOut, account: target, delta: -9n }],
      logs: [{ address: target, topic0: ASTRA_CHANGE_TOPIC }],
    },
  });
  assert.equal(exact.amountOut, 9n);
  assert.throws(() => evaluateAstraExact({
    identity: identityOutcome.identity,
    route,
    source,
    amountIn: 7n,
    minAmountOut: 1n,
    observation: {
      caller: address("9"),
      program: buildAstraEffectSimulation({ route, amountIn: 7n, minAmountOut: 1n }),
      tokenDeltas: [{ token: tokenIn, account: actor, delta: -7n }, { token: tokenIn, account: target, delta: 7n }, { token: tokenOut, account: actor, delta: 9n }, { token: tokenOut, account: target, delta: -9n }],
      logs: [{ address: target, topic0: ASTRA_CHANGE_TOPIC }],
    },
  }));
  assert.throws(() => evaluateAstraExact({
    identity: identityOutcome.identity,
    route,
    source,
    amountIn: 7n,
    minAmountOut: 1n,
    observation: { caller: actor, tokenDeltas: [], logs: [] } as never,
  }));
});
