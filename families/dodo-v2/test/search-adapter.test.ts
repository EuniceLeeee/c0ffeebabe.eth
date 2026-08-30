import assert from "node:assert/strict";
import test from "node:test";
import {
  decodeCanonicalJson,
  encodeCanonicalJson,
  hashDomain,
  type CanonicalJson,
  type Hash,
} from "../../../packages/canonical-codec/src/index.ts";
import { erc20AssetRefV1, nativeAssetRefV1 } from "../../../packages/asset-ref/src/index.ts";
import { familyCandidateKey } from "../../../packages/discovery/src/index.ts";
import { asOwnerRef } from "../../../packages/capability-contracts/src/index.ts";
import { decodePackedCallProgram, encodePackedCallProgram } from "../../../packages/execution-program/src/index.ts";
import type {
  FamilySearchAmountEnvelopeV1,
  FamilySearchCurrentSourceV1,
  FamilySearchRouteLegBindingV1,
  FamilySearchSourceReadPortV1,
  FamilySearchSourceReadRequestV1,
} from "../../../packages/family-sdk/search-runtime/index.ts";
import { DODO_V2_FAMILY_AUTHORING_HASH } from "../src/family-definition.ts";
import { DODO_V2_ACTION_MUTATION_CORPUS_ROOT, DODO_V2_ACTION_MUTATION_EXECUTION_IDS, DODO_V2_SWAP_ACTION_PORT } from "../src/action.ts";
import { exactDodoV2 } from "../src/exact.ts";
import { verifyDodoIdentityStage } from "../src/identity.ts";
import { materializeDodoV2, resealDodoState } from "../src/instance.ts";
import { DODO_V2_FACTORIES, DODO_V2_FAMILY_ID, DODO_V2_QUOTE_ACTOR } from "../src/manifest.ts";
import { deriveDodoRoutes } from "../src/routes.ts";
import { DODO_SEARCH_RUNTIME_ADAPTER_FACTORY } from "../src/runtime.ts";
import { DODO_DECIMAL_ONE, type DodoPmmState } from "../src/kernel/math.ts";

const address = (digit: string) => `0x${digit.repeat(40)}`;
const h = (value: string): Hash => hashDomain("aloha/dodo-search-adapter-test/v1", value);
const word = (value: bigint) => value.toString(16).padStart(64, "0");
const words = (...values: bigint[]) => `0x${values.map(word).join("")}`;
const cutoff = Object.freeze({ chainId: "1", number: "100", hash: h("cutoff"), stateRoot: h("state") });
const pool = address("5");
const baseToken = address("1");
const quoteToken = address("2");
const amountIn = "10";
const pmm: DodoPmmState = Object.freeze({ i: 2n * DODO_DECIMAL_ONE, K: 0n, B: 1_000n, Q: 2_000n, B0: 1_000n, Q0: 2_000n, R: 0 });
const lpFeeRate = (DODO_DECIMAL_ONE / 10n).toString();

function identity() {
  const result = verifyDodoIdentityStage({
    candidate: {
      target: pool,
      instanceNominationKey: pool,
      candidateSnapshotHash: h("candidate"),
      evidence: {
        kind: "call",
        cutoff,
        blockNumber: "99",
        blockHash: h("evidence-block"),
        txHash: h("evidence-tx"),
        logIndex: "0",
        target: pool,
        rawLocatorHash: h("evidence-raw"),
      },
    },
    reads: {
      cutoff,
      pool,
      factory: DODO_V2_FACTORIES[0]!.address,
      registry: DODO_V2_FACTORIES[0]!.address,
      registryPool: pool,
      baseToken,
      quoteToken,
      quoteActor: DODO_V2_QUOTE_ACTOR,
      pmm,
      lpFeeRate,
      mtFeeRate: "0",
    },
  });
  assert.equal(result.status, "verified");
  if (result.status !== "verified") throw new Error("identity fixture failed");
  return result.identity;
}

const protocolIdentity = identity();
const route = deriveDodoRoutes(protocolIdentity)[0]!;
const identityMemoIdentity = {
  ...protocolIdentity,
  facts: {
    ...protocolIdentity.facts,
    pmm: {
      ...protocolIdentity.facts.pmm,
      i: protocolIdentity.facts.pmm.i.toString(),
      K: protocolIdentity.facts.pmm.K.toString(),
      B: protocolIdentity.facts.pmm.B.toString(),
      Q: protocolIdentity.facts.pmm.Q.toString(),
      B0: protocolIdentity.facts.pmm.B0.toString(),
      Q0: protocolIdentity.facts.pmm.Q0.toString(),
    },
  },
};
const transactionOrigin = address("7");
const executorAddress = address("8");
const execution = Object.freeze({ transactionOrigin, executorAddress });
const stateWithoutQuery = materializeDodoV2({ identity: protocolIdentity, read: { cutoff, pool, quoteActor: transactionOrigin, pmm, lpFeeRate, mtFeeRate: "0" } });
assert.equal(stateWithoutQuery.status, "verified");
if (stateWithoutQuery.status !== "verified") throw new Error("state fixture failed");
assert.equal(resealDodoState(stateWithoutQuery.state), stateWithoutQuery.state.stateHash);
const localQuery = exactDodoV2({ identity: protocolIdentity, state: stateWithoutQuery.state, route, amountIn });
assert.equal(localQuery.status, "verified");
if (localQuery.status !== "verified") throw new Error("quote fixture failed");
const localAmountOut = localQuery.quote.amountOut;

function routeBinding(): FamilySearchRouteLegBindingV1 {
  const memo = {
    kind: "dodo-v2-identity-memo" as const,
    familyId: DODO_V2_FAMILY_ID,
    familyDefinitionHash: DODO_V2_FAMILY_AUTHORING_HASH,
    familyCandidateKey: familyCandidateKey(DODO_V2_FAMILY_AUTHORING_HASH, pool),
    instanceNominationKey: pool,
    candidateSnapshotHash: protocolIdentity.candidateSnapshotHash,
    identity: identityMemoIdentity,
  };
  const identityMemo = decodeCanonicalJson(encodeCanonicalJson(memo)) as CanonicalJson;
  return {
    familyId: DODO_V2_FAMILY_ID,
    familyDefinitionHash: DODO_V2_FAMILY_AUTHORING_HASH,
    instanceKey: pool,
    identityMemo,
    identityMemoHash: hashDomain("aloha/identity-memo/v1", identityMemo),
    instancePublicationHash: h("publication"),
    staticProjectionMemoHash: h("static-memo"),
    requestedArtifactDependencyRoot: h("dependencies"),
    staticProjectionHash: h("static-projection"),
    projectionHash: h("projection"),
    authoritySessionHash: h("authority"),
  };
}

const amount: FamilySearchAmountEnvelopeV1 = Object.freeze({
  inputAssetRef: erc20AssetRefV1("1", baseToken),
  outputAssetRef: erc20AssetRefV1("1", quoteToken),
  amountIn,
  recipient: executorAddress,
});
const objectivePayload = Object.freeze({ kind: "search-objective", numeraire: amount.outputAssetRef });
const objective = Object.freeze({ objectiveRef: hashDomain("aloha/search-objective/v1", objectivePayload), payload: objectivePayload });

function input(readPort: FamilySearchSourceReadPortV1 = readPortFactory()) {
  return { route: routeBinding(), currentSource: { source: cutoff, assertCurrent() {} }, objective, amount, execution, readPort };
}

function readPortFactory(options: { readonly malformed?: boolean; readonly mismatch?: boolean; readonly queryMismatch?: boolean; readonly observedRequests?: FamilySearchSourceReadRequestV1[] } = {}): FamilySearchSourceReadPortV1 {
  return {
    read({ request }: { readonly request: FamilySearchSourceReadRequestV1 }) {
      options.observedRequests?.push(request);
      if (options.malformed) return { kind: "returned" as const, requestId: request.requestId, source: request.source, dataHex: "0x01" };
      if (options.mismatch) return { kind: "returned" as const, requestId: request.requestId, source: { ...request.source, number: "101" }, dataHex: words(1n, 0n) };
      const selector = request.data.slice(0, 10);
      if (selector === "0xfd1ed7e9") return { kind: "returned" as const, requestId: request.requestId, source: request.source, dataHex: words(pmm.i, pmm.K, pmm.B, pmm.Q, pmm.B0, pmm.Q0, BigInt(pmm.R)) };
      if (selector === "0x44096609") return { kind: "returned" as const, requestId: request.requestId, source: request.source, dataHex: words(BigInt(lpFeeRate), 0n) };
      if (selector === "0x79a04876" || selector === "0x66410a21") return { kind: "returned" as const, requestId: request.requestId, source: request.source, dataHex: words(BigInt(options.queryMismatch ? BigInt(localAmountOut) + 1n : BigInt(localAmountOut))) };
      throw new Error(`unexpected DODO selector ${selector}`);
    },
  };
}

const adapter = DODO_SEARCH_RUNTIME_ADAPTER_FACTORY({
  familyDefinitionHash: DODO_V2_FAMILY_AUTHORING_HASH,
  capabilityRefs: {},
  actionOwnerRefs: { swap: asOwnerRef(h("action-owner")) },
  composition: { resolveCapability: () => ({}), resolveActionOwner: () => DODO_V2_SWAP_ACTION_PORT },
});

test("DODO adapter rejects a shape-compatible but non-generated action owner", () => {
  assert.throws(() => DODO_SEARCH_RUNTIME_ADAPTER_FACTORY({
    familyDefinitionHash: DODO_V2_FAMILY_AUTHORING_HASH,
    capabilityRefs: {},
    actionOwnerRefs: { swap: asOwnerRef(h("action-owner")) },
    composition: { resolveCapability: () => ({}), resolveActionOwner: () => ({ ...DODO_V2_SWAP_ACTION_PORT }) },
  }), /action owner identity mismatch/);
});

test("DODO adapter consumes raw PMM/query ABI and seals coarse to exact to action", async () => {
  const observedRequests: FamilySearchSourceReadRequestV1[] = [];
  const result = await adapter.run(input(readPortFactory({ observedRequests })));
  assert.equal(result.kind, "verified");
  if (result.kind !== "verified") return;
  assert.equal(result.artifact.state.kind, "state");
  assert.equal(result.artifact.coarse.status, "rankable");
  assert.equal(result.artifact.exact.status, "verified");
  assert.equal(result.artifact.action.status, "ready");
  assert.equal(result.artifact.action.exactEvaluationHash, result.artifact.exact.evaluationHash);
  const actorWord = transactionOrigin.slice(2).padStart(64, "0");
  const actorSensitive = observedRequests.filter(request => request.data.startsWith("0x44096609") || request.data.startsWith("0x79a04876") || request.data.startsWith("0x66410a21"));
  assert.equal(actorSensitive.length, 2);
  assert.ok(actorSensitive.every(request => request.data.slice(10, 74) === actorWord));
  assert.ok(actorSensitive.every(request => !request.data.includes(executorAddress.slice(2).padStart(64, "0"), 10)));
  const payload = result.artifact.action.payload as unknown as Record<string, unknown>;
  const verified = DODO_V2_SWAP_ACTION_PORT.decode(payload);
  assert.equal(result.artifact.action.opaqueBytes, verified.opaqueBytes);
  assert.deepEqual(result.artifact.action.effectTransport, verified.effectTransport);
  const calls = decodePackedCallProgram(verified.opaqueBytes, "dodo test action program");
  assert.equal(calls.length, 2);
  assert.equal(calls[0]!.target, verified.route.inputToken);
  assert.equal(calls[0]!.calldata, `0xa9059cbb${"0".repeat(24)}${pool.slice(2)}${BigInt(verified.quote.amountIn).toString(16).padStart(64, "0")}`);
  assert.equal(calls[1]!.target, pool);
  assert.equal(calls[1]!.calldata, verified.rawAction.calldata);
  assert.deepEqual(verified.effectTransport.observeTokenBalances, [
    { token: baseToken, account: amount.recipient },
    { token: quoteToken, account: amount.recipient },
    { token: baseToken, account: pool },
    { token: quoteToken, account: pool },
  ]);
  assert.equal(DODO_V2_SWAP_ACTION_PORT.verifyObligations(payload).subjectRoot, result.artifact.action.obligationRoot);
  const reject = (mutation: Record<string, unknown>) => assert.throws(() => DODO_V2_SWAP_ACTION_PORT.decode(mutation));
  const proofRoot = (value: typeof verified) => hashDomain("aloha/dodo-v2/action-obligation-postcondition/v1", { rawActionHash: value.rawAction.actionHash, routeBindingHash: value.route.routeBindingHash, recipient: value.recipient, opaqueBytes: value.opaqueBytes, effectTransport: value.effectTransport, exactEvaluationHash: value.exactEvaluationHash, obligationRoot: value.obligationRoot, inputs: value.inputs, outputs: value.outputs, stateFactsRoot: value.stateFactsRoot, sellBase: value.sellBase });
  const reroot = (value: typeof verified): Record<string, unknown> => { const withProof = { ...value, obligationProofRoot: proofRoot(value) }; const { actionHash: ignored, ...body } = withProof; void ignored; return { ...body, actionHash: hashDomain("aloha/dodo-v2/search-action/v1", body) }; };
  const rerootedAmountOut = (BigInt(verified.quote.amountOut) + 1n).toString();
  const rerootedQuoteBody = { ...verified.quote, amountOut: rerootedAmountOut };
  const { quoteHash: ignoredRerootedQuote, ...rerootedQuoteWithoutHash } = rerootedQuoteBody;
  void ignoredRerootedQuote;
  const rerootedQuote = { ...rerootedQuoteWithoutHash, quoteHash: hashDomain("aloha/dodo-v2/quote/v1", rerootedQuoteWithoutHash) };
  const rerootedRawBody = { ...verified.rawAction, exactQuoteHash: rerootedQuote.quoteHash };
  const { actionHash: ignoredRerootedRaw, ...rerootedRawWithoutHash } = rerootedRawBody;
  void ignoredRerootedRaw;
  const rerootedRaw = { ...rerootedRawWithoutHash, actionHash: hashDomain("aloha/dodo-v2/action/v1", rerootedRawWithoutHash) };
  const rerootedOutputs = [{ ...verified.outputs[0]!, amount: rerootedAmountOut }];
  const rerootedEvaluation = hashDomain("aloha/dodo-v2/search-exact-evaluation/v1", { quoteHash: rerootedQuote.quoteHash, stateHash: rerootedQuote.stateHash });
  const rerootedObligation = hashDomain("aloha/dodo-v2/search-obligation/v1", { evaluationHash: rerootedEvaluation, routeBindingHash: verified.searchRouteBindingHash });
  const rerootedPayload = { ...verified, quote: rerootedQuote, rawAction: rerootedRaw, outputs: rerootedOutputs, exactEvaluationHash: rerootedEvaluation, obligationRoot: rerootedObligation };
  const changedTransferTarget = encodePackedCallProgram([{ ...calls[0]!, target: address("9") as `0x${string}` }, calls[1]!]);
  const changedTransferAmount = encodePackedCallProgram([{ ...calls[0]!, calldata: `${calls[0]!.calldata.slice(0, -64)}${(BigInt(verified.quote.amountIn) + 1n).toString(16).padStart(64, "0")}` as `0x${string}` }, calls[1]!]);
  const reversedCalls = encodePackedCallProgram([calls[1]!, calls[0]!]);
  const changedTransport = { ...verified.effectTransport, caller: { ...verified.effectTransport.caller, executionMode: "impersonated-call-frame" as const } };
  const changedObservations = { ...verified.effectTransport, observeTokenBalances: verified.effectTransport.observeTokenBalances.slice(0, -1) };
  const mutationCorpus = [
    { id: "metadata-splice", value: { ...payload, actionImplementationHash: h("implementation-splice") } },
    { id: "state-facts-root-splice", value: { ...payload, stateFactsRoot: h("facts-splice") } },
    { id: "input-amount-splice", value: { ...payload, inputs: [{ ...verified.inputs[0]!, amount: "2" }] } },
    { id: "input-asset-splice", value: { ...payload, inputs: [{ ...verified.inputs[0]!, assetRef: h("foreign-input-asset") }] } },
    { id: "output-amount-splice", value: { ...payload, outputs: [{ ...verified.outputs[0]!, amount: rerootedAmountOut }] } },
    { id: "output-asset-splice", value: { ...payload, outputs: [{ ...verified.outputs[0]!, assetRef: h("foreign-output-asset") }] } },
    { id: "quote-splice", value: { ...payload, quote: { ...verified.quote, amountIn: (BigInt(verified.quote.amountIn) + 1n).toString() } } },
    { id: "raw-action-splice", value: { ...payload, rawAction: { ...verified.rawAction, actionHash: h("raw-action-splice") } } },
    { id: "opaque-program-splice", value: { ...payload, opaqueBytes: "0x01" } },
    { id: "opaque-program-noncanonical", value: { ...payload, opaqueBytes: verified.opaqueBytes.toUpperCase().replace("0X", "0x") } },
    { id: "transfer-target-splice", value: { ...payload, opaqueBytes: changedTransferTarget } },
    { id: "transfer-amount-splice", value: { ...payload, opaqueBytes: changedTransferAmount } },
    { id: "call-order-splice", value: { ...payload, opaqueBytes: reversedCalls } },
    { id: "effect-transport-splice", value: { ...payload, effectTransport: changedTransport } },
    { id: "effect-observation-splice", value: { ...payload, effectTransport: changedObservations } },
    { id: "evaluation-splice", value: { ...payload, exactEvaluationHash: h("evaluation-splice") } },
    { id: "obligation-root-splice", value: { ...payload, obligationRoot: h("obligation-splice") } },
    { id: "obligation-proof-splice", value: { ...payload, obligationProofRoot: h("proof-splice") } },
    { id: "final-action-splice", value: { ...payload, actionHash: h("action-splice") } },
    { id: "top-level-field-injection", value: { ...payload, unexpected: true } },
    { id: "quote-field-injection", value: { ...payload, quote: { ...verified.quote, unexpected: true } } },
    { id: "route-field-injection", value: { ...payload, route: { ...verified.route, unexpected: true } } },
    { id: "raw-action-field-injection", value: { ...payload, rawAction: { ...verified.rawAction, unexpected: true } } },
    { id: "quote-cutoff-field-injection", value: { ...payload, quote: { ...verified.quote, cutoff: { ...verified.quote.cutoff, unexpected: true } } } },
    { id: "raw-cutoff-field-injection", value: { ...payload, rawAction: { ...verified.rawAction, cutoff: { ...verified.rawAction.cutoff, unexpected: true } } } },
    { id: "fee-arithmetic-reroot", value: reroot(rerootedPayload) },
  ] as const;
  assert.deepEqual(mutationCorpus.map(mutation => mutation.id), DODO_V2_ACTION_MUTATION_EXECUTION_IDS);
  assert.equal(DODO_V2_ACTION_MUTATION_CORPUS_ROOT, hashDomain("aloha/dodo-v2/action-verifier-mutations/v1", { executionIds: DODO_V2_ACTION_MUTATION_EXECUTION_IDS }));
  for (const mutation of mutationCorpus) reject(mutation.value);
  reject(reroot({ ...verified, opaqueBytes: changedTransferTarget }));
  reject(reroot({ ...verified, opaqueBytes: changedTransferAmount }));
  reject(reroot({ ...verified, opaqueBytes: reversedCalls }));
  reject(reroot({ ...verified, effectTransport: changedTransport }));
  reject(reroot({ ...verified, effectTransport: changedObservations }));
  reject({ ...payload, route: { ...verified.route, inputToken: address("9") } });
  reject({ ...payload, rawAction: { ...verified.rawAction, target: address("9") } });
  reject({ ...payload, sellBase: !verified.sellBase });
  const foreignInputs = [{ ...verified.inputs[0]!, assetRef: h("joint-foreign-input") }];
  const foreignProof = proofRoot({ ...verified, inputs: foreignInputs });
  const foreignPayload = { ...verified, inputs: foreignInputs, obligationProofRoot: foreignProof };
  const { actionHash: ignoredForeign, ...foreignBody } = foreignPayload;
  void ignoredForeign;
  reject({ ...foreignBody, actionHash: hashDomain("aloha/dodo-v2/search-action/v1", foreignBody) });
  const cutoffRawBody = { ...verified.rawAction, cutoff: { ...verified.rawAction.cutoff, number: "101" } };
  const { actionHash: ignoredCutoffRaw, ...cutoffRawWithoutHash } = cutoffRawBody;
  void ignoredCutoffRaw;
  const cutoffRaw = { ...cutoffRawWithoutHash, actionHash: hashDomain("aloha/dodo-v2/action/v1", cutoffRawWithoutHash) };
  const cutoffProof = proofRoot({ ...verified, rawAction: cutoffRaw });
  const cutoffPayload = { ...verified, rawAction: cutoffRaw, obligationProofRoot: cutoffProof };
  const { actionHash: ignoredCutoffFinal, ...cutoffBody } = cutoffPayload;
  void ignoredCutoffFinal;
  reject({ ...cutoffBody, actionHash: hashDomain("aloha/dodo-v2/search-action/v1", cutoffBody) });
  reject({ ...payload, obligationRoot: h("obligation-splice") });
  reject({ ...payload, obligationProofRoot: h("proof-splice") });
  reject({ ...payload, exactEvaluationHash: h("evaluation-splice") });
  reject({ ...payload, rawAction: { ...verified.rawAction, actionHash: h("raw-action-splice") } });
  reject({ ...payload, actionHash: h("action-splice") });
});

test("DODO adapter fails closed on malformed, stale, query-mismatched, and forged lineage inputs", async () => {
  const malformed = await adapter.run(input(readPortFactory({ malformed: true })));
  assert.equal(malformed.kind, "invalidProgram");
  if (malformed.kind === "invalidProgram") assert.equal(malformed.stage, "state");
  const stale = await adapter.run(input(readPortFactory({ mismatch: true })));
  assert.equal(stale.kind, "invalidProgram");
  const queryMismatch = await adapter.run(input(readPortFactory({ queryMismatch: true })));
  assert.equal(queryMismatch.kind, "invalidProgram");
  if (queryMismatch.kind === "invalidProgram") assert.equal(queryMismatch.stage, "exact");

  const state = await adapter.readState(input());
  assert.equal(state.kind, "verified");
  if (state.kind !== "verified") return;
  const coarse = adapter.projectCoarse({ ...input(), state: state.artifact });
  assert.equal(coarse.kind, "verified");
  if (coarse.kind !== "verified") return;
  const exact = adapter.evaluateExact({ ...input(), state: state.artifact, coarse: coarse.artifact });
  assert.equal(exact.kind, "verified");
  if (exact.kind !== "verified") return;
  const mutatedAmount = adapter.evaluateExact({ ...input(), amount: { ...amount, amountIn: "11" }, state: state.artifact, coarse: coarse.artifact });
  assert.equal(mutatedAmount.kind, "invalidProgram");
  const swappedActors = adapter.evaluateExact({ ...input(), execution: { transactionOrigin: executorAddress, executorAddress: transactionOrigin }, state: state.artifact, coarse: coarse.artifact });
  assert.equal(swappedActors.kind, "invalidProgram");
  const mutatedRoute = adapter.projectCoarse({ ...input(), route: { ...routeBinding(), projectionHash: h("mutated") }, state: state.artifact });
  assert.equal(mutatedRoute.kind, "invalidProgram");
  const forgedAction = adapter.buildAction({ ...input(), exact: { ...exact.artifact, evaluationHash: h("forged") } });
  assert.equal(forgedAction.kind, "invalidProgram");
});
