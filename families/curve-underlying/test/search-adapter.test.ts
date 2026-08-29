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
import type {
  FamilySearchAmountEnvelopeV1,
  FamilySearchCurrentSourceV1,
  FamilySearchRouteLegBindingV1,
  FamilySearchSourceReadPortV1,
  FamilySearchSourceReadRequestV1,
} from "../../../packages/family-sdk/search-runtime/index.ts";
import { asOwnerRef } from "../../../packages/capability-contracts/src/index.ts";
import { CURVE_UNDERLYING_FAMILY_AUTHORING_HASH } from "../src/family-definition.ts";
import { CURVE_UNDERLYING_ACTION_MUTATION_CORPUS_ROOT, CURVE_UNDERLYING_ACTION_MUTATION_EXECUTION_IDS, CURVE_UNDERLYING_SWAP_ACTION_PORT } from "../src/action.ts";
import { exactCurveUnderlying } from "../src/exact.ts";
import { verifyCurveUnderlyingIdentityStage } from "../src/identity.ts";
import { materializeCurveUnderlying, resealCurveState } from "../src/instance.ts";
import { CURVE_METAREGISTRY, CURVE_UNDERLYING_FAMILY_ID } from "../src/manifest.ts";
import { deriveCurveUnderlyingRoutes } from "../src/routes.ts";
import { CURVE_SEARCH_RUNTIME_ADAPTER_FACTORY } from "../src/runtime.ts";

const address = (digit: string) => `0x${digit.repeat(40)}`;
const h = (value: string): Hash => hashDomain("aloha/curve-search-adapter-test/v1", value);
const word = (value: bigint) => value.toString(16).padStart(64, "0");
const words = (...values: bigint[]) => `0x${values.map(word).join("")}`;
const cutoff = Object.freeze({ chainId: "1", number: "100", hash: h("cutoff"), stateRoot: h("state") });
const pool = address("5");
const token0 = address("1");
const token1 = address("2");
const amountIn = "1000000000000000000";

function identity() {
  const result = verifyCurveUnderlyingIdentityStage({
    candidate: {
      target: pool,
      instanceNominationKey: pool,
      candidateSnapshotHash: candidateSubjectHash(CURVE_UNDERLYING_FAMILY_AUTHORING_HASH, pool),
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
      metaRegistry: CURVE_METAREGISTRY,
      registryPool: pool,
      poolHasCode: true,
      handlers: [address("6")],
      underlyingCoins: [token0, token1],
      underlyingDecimals: [18, 18],
      verifiedDirections: [{ i: 0, j: 1, amountIn: "100", amountOut: "99" }],
    },
  });
  assert.equal(result.status, "verified");
  if (result.status !== "verified") throw new Error("identity fixture failed");
  return result.identity;
}

const protocolIdentity = identity();
const route = deriveCurveUnderlyingRoutes(protocolIdentity).find(value => value.i === 0 && value.j === 1)!;
const stateWithoutQuery = materializeCurveUnderlying({
  identity: protocolIdentity,
  read: {
    cutoff,
    pool,
    variant: "plain",
    A: "1000",
    fee: "30",
    balances: ["100000000000000000000", "100000000000000000000"],
    rates: ["1000000000000000000", "1000000000000000000"],
  },
});
assert.equal(stateWithoutQuery.status, "verified");
if (stateWithoutQuery.status !== "verified") throw new Error("state fixture failed");
assert.equal(resealCurveState(stateWithoutQuery.state), stateWithoutQuery.state.stateHash);
const localQuery = exactCurveUnderlying({ identity: protocolIdentity, state: stateWithoutQuery.state, route, amountIn });
assert.equal(localQuery.status, "verified");
if (localQuery.status !== "verified") throw new Error("quote fixture failed");
const localAmountOut = localQuery.quote.amountOut;

function routeBinding(): FamilySearchRouteLegBindingV1 {
  const memo = {
    kind: "curve-underlying-identity-memo" as const,
    familyId: CURVE_UNDERLYING_FAMILY_ID,
    familyDefinitionHash: CURVE_UNDERLYING_FAMILY_AUTHORING_HASH,
    familyCandidateKey: familyCandidateKey(CURVE_UNDERLYING_FAMILY_AUTHORING_HASH, pool),
    instanceNominationKey: pool,
    candidateSubjectHash: protocolIdentity.candidateSnapshotHash,
    candidateEvidenceRoot: h("candidate-evidence-root"),
    identity: protocolIdentity,
  };
  const identityMemo = decodeCanonicalJson(encodeCanonicalJson(memo)) as CanonicalJson;
  return {
    familyId: CURVE_UNDERLYING_FAMILY_ID,
    familyDefinitionHash: CURVE_UNDERLYING_FAMILY_AUTHORING_HASH,
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

function input(readPort: FamilySearchSourceReadPortV1 = readPortFactory()): {
  readonly route: FamilySearchRouteLegBindingV1;
  readonly currentSource: FamilySearchCurrentSourceV1;
  readonly objective: typeof objective;
  readonly amount: FamilySearchAmountEnvelopeV1;
  readonly readPort: FamilySearchSourceReadPortV1;
} {
  return { route: routeBinding(), currentSource: { source: cutoff, assertCurrent() {} }, objective, amount, readPort };
}

function readPortFactory(options: { readonly malformed?: boolean; readonly mismatch?: boolean } = {}): FamilySearchSourceReadPortV1 {
  return {
    read({ request }: { readonly request: FamilySearchSourceReadRequestV1 }) {
      if (options.malformed) return { kind: "returned" as const, requestId: request.requestId, source: request.source, dataHex: "0x01" };
      if (options.mismatch) return { kind: "returned" as const, requestId: request.requestId, source: { ...request.source, number: "101" }, dataHex: words(1000n) };
      const selector = request.data.slice(0, 10);
      if (selector === "0xf446c1d0") return { kind: "returned" as const, requestId: request.requestId, source: request.source, dataHex: words(1000n) };
      if (selector === "0xddca3f43") return { kind: "returned" as const, requestId: request.requestId, source: request.source, dataHex: words(30n) };
      if (selector === "0x59f4f351") return { kind: "returned" as const, requestId: request.requestId, source: request.source, dataHex: words(100000000000000000000n, 100000000000000000000n, 0n, 0n, 0n, 0n, 0n, 0n) };
      if (selector === "0x4cb088f1") return { kind: "returned" as const, requestId: request.requestId, source: request.source, dataHex: words(18n, 18n, 0n, 0n, 0n, 0n, 0n, 0n) };
      if (selector === "0x8edfdd5f" || selector === "0xfd0684b1") return { kind: "unavailable" as const, requestId: request.requestId, source: request.source, reasonCode: "method-missing" };
      if (selector === "0x85f11d1e") return { kind: "returned" as const, requestId: request.requestId, source: request.source, dataHex: words(BigInt(localAmountOut)) };
      throw new Error(`unexpected Curve selector ${selector}`);
    },
  };
}

const adapter = CURVE_SEARCH_RUNTIME_ADAPTER_FACTORY({
  familyDefinitionHash: CURVE_UNDERLYING_FAMILY_AUTHORING_HASH,
  capabilityRefs: {},
  actionOwnerRefs: { swap: asOwnerRef(h("action-owner")) },
  composition: { resolveCapability: () => ({}), resolveActionOwner: () => ({}) },
});

test("Curve adapter consumes raw ABI reads and seals coarse to exact to action", async () => {
  const result = await adapter.run(input());
  assert.equal(result.kind, "verified");
  if (result.kind !== "verified") return;
  assert.equal(result.artifact.state.kind, "state");
  assert.equal(result.artifact.coarse.status, "rankable");
  assert.equal(result.artifact.exact.status, "verified");
  assert.equal(result.artifact.action.status, "ready");
  assert.equal(result.artifact.action.exactEvaluationHash, result.artifact.exact.evaluationHash);
  const payload = result.artifact.action.payload as unknown as Record<string, unknown>;
  const verified = CURVE_UNDERLYING_SWAP_ACTION_PORT.decode(payload);
  assert.equal(verified.actionHash, result.artifact.action.actionHash);
  assert.equal(CURVE_UNDERLYING_SWAP_ACTION_PORT.verifyObligations(payload).subjectRoot, result.artifact.action.obligationRoot);
  const reject = (mutation: Record<string, unknown>) => assert.throws(() => CURVE_UNDERLYING_SWAP_ACTION_PORT.decode(mutation));
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
  assert.deepEqual(mutationCorpus.map(mutation => mutation.id), CURVE_UNDERLYING_ACTION_MUTATION_EXECUTION_IDS);
  assert.equal(CURVE_UNDERLYING_ACTION_MUTATION_CORPUS_ROOT, hashDomain("aloha/curve-underlying/action-verifier-mutations/v1", { executionIds: CURVE_UNDERLYING_ACTION_MUTATION_EXECUTION_IDS }));
  for (const mutation of mutationCorpus) reject(mutation.value);
  const cutoffRawBody = { ...verified.rawAction, cutoff: { ...verified.rawAction.cutoff, number: "101" } };
  const { actionHash: ignoredCutoffRaw, ...cutoffRawWithoutHash } = cutoffRawBody;
  void ignoredCutoffRaw;
  const cutoffRaw = { ...cutoffRawWithoutHash, actionHash: hashDomain("aloha/curve-underlying/action/v1", cutoffRawWithoutHash) };
  const cutoffProof = hashDomain("aloha/curve-underlying/action-obligation-postcondition/v1", { rawActionHash: cutoffRaw.actionHash, exactEvaluationHash: verified.exactEvaluationHash, obligationRoot: verified.obligationRoot, inputs: verified.inputs, outputs: verified.outputs, stateFactsRoot: verified.stateFactsRoot, routeBindingHash: verified.route.routeBindingHash });
  const cutoffPayload = { ...verified, rawAction: cutoffRaw, obligationProofRoot: cutoffProof };
  const { actionHash: ignoredCutoffFinal, ...cutoffBody } = cutoffPayload;
  void ignoredCutoffFinal;
  reject({ ...cutoffBody, actionHash: hashDomain("aloha/curve-underlying/search-action/v1", cutoffBody) });
});

test("Curve adapter fails closed on malformed, stale, and mismatched exact ABI responses", async () => {
  const malformed = await adapter.run(input(readPortFactory({ malformed: true })));
  assert.equal(malformed.kind, "invalidProgram");
  if (malformed.kind === "invalidProgram") assert.equal(malformed.stage, "state");
  const stale = await adapter.run(input(readPortFactory({ mismatch: true })));
  assert.equal(stale.kind, "invalidProgram");

  const state = await adapter.readState(input());
  assert.equal(state.kind, "verified");
  if (state.kind !== "verified") return;
  const coarse = adapter.projectCoarse({ ...input(), state: state.artifact });
  assert.equal(coarse.kind, "verified");
  if (coarse.kind !== "verified") return;
  const exact = adapter.evaluateExact({ ...input(), state: state.artifact, coarse: coarse.artifact });
  assert.equal(exact.kind, "verified");
  if (exact.kind !== "verified") return;
  const mutatedAmount = adapter.evaluateExact({ ...input(), amount: { ...amount, amountIn: "2" }, state: state.artifact, coarse: coarse.artifact });
  assert.equal(mutatedAmount.kind, "invalidProgram");
  const mutatedRoute = adapter.projectCoarse({ ...input(), route: { ...routeBinding(), projectionHash: h("mutated") }, state: state.artifact });
  assert.equal(mutatedRoute.kind, "invalidProgram");
  const forgedExact = adapter.buildAction({ ...input(), exact: { ...exact.artifact, evaluationHash: h("forged") } });
  assert.equal(forgedExact.kind, "invalidProgram");
});
