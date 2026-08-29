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
import { candidateSubjectHash, familyCandidateKey } from "../../../packages/discovery/src/index.ts";
import { asOwnerRef } from "../../../packages/capability-contracts/src/index.ts";
import type {
  FamilySearchAmountEnvelopeV1,
  FamilySearchCurrentSourceV1,
  FamilySearchRouteLegBindingV1,
  FamilySearchSourceReadPortV1,
  FamilySearchSourceReadRequestV1,
} from "../../../packages/family-sdk/search-runtime/index.ts";
import { exactUniV3 } from "../src/exact.ts";
import { UNIV3_STANDARD_ACTION_MUTATION_CORPUS_ROOT, UNIV3_STANDARD_ACTION_MUTATION_EXECUTION_IDS, UNIV3_STANDARD_SWAP_ACTION_PORT } from "../src/action.ts";
import { UNIV3_STANDARD_FAMILY_DEFINITION_HASH } from "../src/family-definition.ts";
import { verifyUniV3IdentityStage } from "../src/identity.ts";
import { materializeUniV3 } from "../src/instance.ts";
import { UNIV3_STANDARD_FAMILY_ID } from "../src/manifest.ts";
import { deriveUniV3Routes } from "../src/routes.ts";
import { UNIV3_SEARCH_RUNTIME_ADAPTER_FACTORY } from "../src/runtime.ts";
import { getSqrtRatioAtTick } from "../src/kernel/math.ts";

const address = (digit: string) => `0x${digit.repeat(40)}`;
const h = (value: string): Hash => hashDomain("aloha/univ3-search-adapter-test/v1", value);
const word = (value: bigint) => value.toString(16).padStart(64, "0");
const words = (...values: bigint[]) => `0x${values.map(word).join("")}`;
const cutoff = Object.freeze({ chainId: "1", number: "100", hash: h("cutoff"), stateRoot: h("state") });
const pool = address("5");
const token0 = address("1");
const token1 = address("2");
const factory = "0x1f98431c8ad98523631ae4a59f267346ea31f984";
const amountIn = "1000";
const sqrtPriceX96 = getSqrtRatioAtTick(600);

function identity() {
  const result = verifyUniV3IdentityStage({
    candidate: {
      target: pool,
      instanceNominationKey: pool,
      candidateSnapshotHash: candidateSubjectHash(UNIV3_STANDARD_FAMILY_DEFINITION_HASH, pool),
      evidence: {
        kind: "log",
        cutoff,
        blockNumber: "99",
        blockHash: h("evidence-block"),
        txHash: h("evidence-tx"),
        logIndex: "0",
        target: pool,
        topic0: h("evidence-topic"),
        rawLocatorHash: h("evidence-raw"),
      },
    },
    reads: { cutoff, pool, factory, token0, token1, fee: "3000", tickSpacing: 60, reversePool: pool },
  });
  assert.equal(result.status, "verified");
  if (result.status !== "verified") throw new Error("identity fixture failed");
  return result.identity;
}

const protocolIdentity = identity();
const route = deriveUniV3Routes(protocolIdentity)[0]!;
const stateWithoutQuery = materializeUniV3({
  identity: protocolIdentity,
  read: {
    cutoff,
    pool,
    sqrtPriceX96: sqrtPriceX96.toString(),
    tick: 600,
    liquidity: "1000000000000",
    fee: "3000",
    tickSpacing: 60,
    tickBitmap: [{ word: 0, bits: "0" }],
    ticks: [],
  },
});
assert.equal(stateWithoutQuery.status, "verified");
if (stateWithoutQuery.status !== "verified") throw new Error("state fixture failed");
const localQuery = exactUniV3({ identity: protocolIdentity, state: stateWithoutQuery.state, route, amountIn });
assert.equal(localQuery.status, "verified");
if (localQuery.status !== "verified") throw new Error("quote fixture failed");
const localAmountOut = localQuery.quote.amountOut;

function routeBinding(): FamilySearchRouteLegBindingV1 {
  const memo = {
    kind: "univ3-identity-memo" as const,
    familyId: UNIV3_STANDARD_FAMILY_ID,
    familyDefinitionHash: UNIV3_STANDARD_FAMILY_DEFINITION_HASH,
    familyCandidateKey: familyCandidateKey(UNIV3_STANDARD_FAMILY_DEFINITION_HASH, pool),
    instanceNominationKey: pool,
    candidateSubjectHash: protocolIdentity.candidateSnapshotHash,
    candidateEvidenceRoot: h("candidate-evidence-root"),
    identity: protocolIdentity,
  };
  const identityMemo = decodeCanonicalJson(encodeCanonicalJson(memo)) as CanonicalJson;
  return {
    familyId: UNIV3_STANDARD_FAMILY_ID,
    familyDefinitionHash: UNIV3_STANDARD_FAMILY_DEFINITION_HASH,
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
  inputAssetRef: erc20AssetRefV1("1", token0),
  outputAssetRef: erc20AssetRefV1("1", token1),
  amountIn,
  recipient: address("8"),
});
const objectivePayload = Object.freeze({ kind: "search-objective", numeraire: amount.outputAssetRef });
const objective = Object.freeze({ objectiveRef: hashDomain("aloha/search-objective/v1", objectivePayload), payload: objectivePayload });

function input(readPort: FamilySearchSourceReadPortV1 = readPortFactory()) {
  return { route: routeBinding(), currentSource: { source: cutoff, assertCurrent() {} }, objective, amount, readPort };
}

function readPortFactory(options: { readonly malformed?: boolean; readonly mismatch?: boolean; readonly queryMismatch?: boolean } = {}): FamilySearchSourceReadPortV1 {
  return {
    read({ request }: { readonly request: FamilySearchSourceReadRequestV1 }) {
      if (options.malformed) return { kind: "returned" as const, requestId: request.requestId, source: request.source, dataHex: "0x01" };
      if (options.mismatch) return { kind: "returned" as const, requestId: request.requestId, source: { ...request.source, number: "101" }, dataHex: words(1n) };
      const selector = request.data.slice(0, 10);
      if (selector === "0x3850c7bd") return { kind: "returned" as const, requestId: request.requestId, source: request.source, dataHex: words(sqrtPriceX96, 600n, 0n, 0n, 0n, 0n, 1n) };
      if (selector === "0x1a686502") return { kind: "returned" as const, requestId: request.requestId, source: request.source, dataHex: words(1000000000000n) };
      if (selector === "0xddca3f43") return { kind: "returned" as const, requestId: request.requestId, source: request.source, dataHex: words(3000n) };
      if (selector === "0xd0c93a7c") return { kind: "returned" as const, requestId: request.requestId, source: request.source, dataHex: words(60n) };
      if (selector === "0x5339c296") return { kind: "returned" as const, requestId: request.requestId, source: request.source, dataHex: words(0n) };
      if (selector === "0xc6a5026a") return { kind: "returned" as const, requestId: request.requestId, source: request.source, dataHex: words(BigInt(options.queryMismatch ? BigInt(localAmountOut) + 1n : BigInt(localAmountOut)), 0n, 0n, 0n) };
      throw new Error(`unexpected UniV3 selector ${selector}`);
    },
  };
}

const adapter = UNIV3_SEARCH_RUNTIME_ADAPTER_FACTORY({
  familyDefinitionHash: UNIV3_STANDARD_FAMILY_DEFINITION_HASH,
  capabilityRefs: {},
  actionOwnerRefs: { swap: asOwnerRef(h("action-owner")) },
  composition: { resolveCapability: () => ({}), resolveActionOwner: () => ({}) },
});

test("UniV3 adapter consumes raw pool and Quoter V2 ABI and seals coarse to exact to action", async () => {
  const result = await adapter.run(input());
  assert.equal(result.kind, "verified");
  if (result.kind !== "verified") return;
  assert.equal(result.artifact.state.kind, "state");
  assert.equal(result.artifact.coarse.status, "rankable");
  assert.equal(result.artifact.exact.status, "verified");
  assert.equal(result.artifact.action.status, "ready");
  assert.equal(result.artifact.action.exactEvaluationHash, result.artifact.exact.evaluationHash);
  const payload = result.artifact.action.payload as unknown as Record<string, unknown>;
  const verified = UNIV3_STANDARD_SWAP_ACTION_PORT.decode(payload);
  assert.equal(UNIV3_STANDARD_SWAP_ACTION_PORT.verifyObligations(payload).subjectRoot, result.artifact.action.obligationRoot);
  const reject = (mutation: Record<string, unknown>) => assert.throws(() => UNIV3_STANDARD_SWAP_ACTION_PORT.decode(mutation));
  const mutationCorpus = [
    { id: "metadata-splice", value: { ...payload, actionImplementationHash: h("implementation-splice") } },
    { id: "state-facts-root-splice", value: { ...payload, stateFactsRoot: h("facts-splice") } },
    { id: "input-amount-splice", value: { ...payload, inputs: [{ ...verified.inputs[0]!, amount: "2" }] } },
    { id: "input-asset-splice", value: { ...payload, inputs: [{ ...verified.inputs[0]!, assetRef: h("foreign-input-asset") }] } },
    { id: "output-amount-splice", value: { ...payload, outputs: [{ ...verified.outputs[0]!, amount: (BigInt(verified.outputs[0]!.amount) + 1n).toString() }] } },
    { id: "output-asset-splice", value: { ...payload, outputs: [{ ...verified.outputs[0]!, assetRef: h("foreign-output-asset") }] } },
    { id: "quote-splice", value: { ...payload, quote: { ...verified.quote, amountIn: (BigInt(verified.quote.amountIn) + 1n).toString() } } },
    { id: "raw-action-splice", value: { ...payload, rawAction: { ...verified.rawAction, actionHash: h("raw-action-splice") } } },
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
  ] as const;
  assert.deepEqual(mutationCorpus.map(mutation => mutation.id), UNIV3_STANDARD_ACTION_MUTATION_EXECUTION_IDS);
  assert.equal(UNIV3_STANDARD_ACTION_MUTATION_CORPUS_ROOT, hashDomain("aloha/univ3-standard/action-verifier-mutations/v1", { executionIds: UNIV3_STANDARD_ACTION_MUTATION_EXECUTION_IDS }));
  for (const mutation of mutationCorpus) reject(mutation.value);
  reject({ ...payload, route: { ...verified.route, inputToken: address("9") } });
  reject({ ...payload, rawAction: { ...verified.rawAction, target: address("9") } });
  reject({ ...payload, zeroForOne: !verified.zeroForOne });
  const foreignInputs = [{ ...verified.inputs[0]!, assetRef: h("joint-foreign-input") }];
  const foreignProof = hashDomain("aloha/univ3-standard/action-obligation-postcondition/v1", { rawActionHash: verified.rawAction.actionHash, routeBindingHash: verified.route.routeBindingHash, exactEvaluationHash: verified.exactEvaluationHash, obligationRoot: verified.obligationRoot, inputs: foreignInputs, outputs: verified.outputs, stateFactsRoot: verified.stateFactsRoot, zeroForOne: verified.zeroForOne });
  const foreignPayload = { ...verified, inputs: foreignInputs, obligationProofRoot: foreignProof };
  const { actionHash: ignoredForeign, ...foreignBody } = foreignPayload;
  void ignoredForeign;
  reject({ ...foreignBody, actionHash: hashDomain("aloha/univ3-standard/search-action/v1", foreignBody) });
  const cutoffRawBody = { ...verified.rawAction, cutoff: { ...verified.rawAction.cutoff, number: "101" } };
  const { actionHash: ignoredCutoffRaw, ...cutoffRawWithoutHash } = cutoffRawBody;
  void ignoredCutoffRaw;
  const cutoffRaw = { ...cutoffRawWithoutHash, actionHash: hashDomain("aloha/univ3-standard/action/v1", cutoffRawWithoutHash) };
  const cutoffProof = hashDomain("aloha/univ3-standard/action-obligation-postcondition/v1", { rawActionHash: cutoffRaw.actionHash, routeBindingHash: verified.route.routeBindingHash, exactEvaluationHash: verified.exactEvaluationHash, obligationRoot: verified.obligationRoot, inputs: verified.inputs, outputs: verified.outputs, stateFactsRoot: verified.stateFactsRoot, zeroForOne: verified.zeroForOne });
  const cutoffPayload = { ...verified, rawAction: cutoffRaw, obligationProofRoot: cutoffProof };
  const { actionHash: ignoredCutoffFinal, ...cutoffBody } = cutoffPayload;
  void ignoredCutoffFinal;
  reject({ ...cutoffBody, actionHash: hashDomain("aloha/univ3-standard/search-action/v1", cutoffBody) });
  reject({ ...payload, obligationRoot: h("obligation-splice") });
  reject({ ...payload, obligationProofRoot: h("proof-splice") });
  reject({ ...payload, exactEvaluationHash: h("evaluation-splice") });
  reject({ ...payload, rawAction: { ...verified.rawAction, actionHash: h("raw-action-splice") } });
  reject({ ...payload, actionHash: h("action-splice") });
});

test("UniV3 adapter fails closed on malformed, stale, Quoter-mismatched, and forged lineage inputs", async () => {
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
  const mutatedAmount = adapter.evaluateExact({ ...input(), amount: { ...amount, amountIn: "1001" }, state: state.artifact, coarse: coarse.artifact });
  assert.equal(mutatedAmount.kind, "invalidProgram");
  const mutatedRoute = adapter.projectCoarse({ ...input(), route: { ...routeBinding(), projectionHash: h("mutated") }, state: state.artifact });
  assert.equal(mutatedRoute.kind, "invalidProgram");
  const forgedAction = adapter.buildAction({ ...input(), exact: { ...exact.artifact, evaluationHash: h("forged") } });
  assert.equal(forgedAction.kind, "invalidProgram");
});
