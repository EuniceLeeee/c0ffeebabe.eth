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
import {
  familySearchAmountHash,
  type FamilySearchAmountEnvelopeV1,
  type FamilySearchCurrentSourceV1,
  type FamilySearchRouteLegBindingV1,
  type FamilySearchSourceReadPortV1,
  type FamilySearchSourceReadRequestV1,
} from "../../../packages/family-sdk/search-runtime/index.ts";
import { candidateSubjectHash, familyCandidateKey } from "../../../packages/discovery/src/index.ts";
import { asFamilyId, type StageCapabilityRefV1, type ActionOwnerRef } from "../../../packages/family-sdk/runtime-refs/index.ts";
import { asCapabilityVersion, asOwnerRef, asSchemaRef } from "../../../packages/capability-contracts/src/index.ts";
import {
  createUniV2SearchAdapterFromComposition,
  nominateUniV2,
  UNIV2_STANDARD_FAMILY_DEFINITION_HASH,
  UNIV2_STANDARD_FAMILY_ID,
  UNIV2_STANDARD_SEARCH_ADAPTER,
  UNIV2_SYNC_EVENT_TOPIC0,
  verifyUniV2IdentityStage,
} from "../src/public.ts";
import { UNIV2_STANDARD_REQUESTED_ARTIFACT_DEPENDENCY_ROOT } from "../src/family-definition.ts";
import {
  UNIV2_STANDARD_COARSE_CAPABILITY_ID,
  UNIV2_STANDARD_COARSE_INTERPRETER_HASH,
  UNIV2_STANDARD_COARSE_SCHEMA_HASH,
  UNIV2_STANDARD_EXACT_CAPABILITY_ID,
  UNIV2_STANDARD_EXACT_INTERPRETER_HASH,
  UNIV2_STANDARD_EXACT_SCHEMA_HASH,
  UNIV2_STANDARD_STATE_CAPABILITY_ID,
  UNIV2_STANDARD_STATE_INTERPRETER_HASH,
  UNIV2_STANDARD_STATE_SCHEMA_HASH,
} from "../src/capabilities/metadata.ts";
import { UNIV2_STANDARD_COARSE_PORT } from "../src/capabilities/coarse.ts";
import { UNIV2_STANDARD_EXACT_PORT } from "../src/capabilities/exact.ts";
import { UNIV2_STANDARD_STATE_PORT } from "../src/capabilities/state.ts";
import { UNIV2_STANDARD_SWAP_ACTION_PORT } from "../src/capabilities/action.ts";

const hash = (value: string): Hash => hashDomain("aloha/univ2-standard/search-adapter-test/v1", value);
const address = (digit: string) => `0x${digit.repeat(40)}`;
const word = (value: bigint) => value.toString(16).padStart(64, "0");
const addressWord = (value: string) => `0x${"0".repeat(24)}${value.slice(2)}`;
const reserves = (reserve0: bigint, reserve1: bigint, timestamp: bigint) => `0x${word(reserve0)}${word(reserve1)}${word(timestamp)}`;

const cutoff = Object.freeze({
  chainId: "1",
  number: "100",
  hash: hash("cutoff-hash"),
  stateRoot: hash("cutoff-state"),
});
const pool = address("1");
const token0 = address("2");
const token1 = address("3");
const factory = address("f");
const recipient = address("4");

function identity() {
  const nominated = nominateUniV2({
    pool,
    evidence: {
      cutoff,
      blockNumber: "99",
      blockHash: hash("evidence-block"),
      txHash: hash("evidence-tx"),
      logIndex: "0",
      emitter: pool,
      topic0: UNIV2_SYNC_EVENT_TOPIC0,
      rawLocatorHash: hash("evidence-locator"),
    },
  });
  assert.equal(nominated.status, "nominated");
  const verified = verifyUniV2IdentityStage({
    nomination: {
      ...nominated.candidate,
      candidateSnapshotHash: candidateSubjectHash(UNIV2_STANDARD_FAMILY_DEFINITION_HASH, pool),
    },
    reads: {
      cutoff,
      pool,
      token0ReturnHex: addressWord(token0),
      token1ReturnHex: addressWord(token1),
      factoryReturnHex: addressWord(factory),
      forwardPairReturnHex: addressWord(pool),
      reversePairReturnHex: addressWord(pool),
    },
  });
  assert.equal(verified.status, "verified");
  return verified.identity;
}

function routeBinding(): FamilySearchRouteLegBindingV1 {
  const protocolIdentity = identity();
  const memo = {
    kind: "univ2-identity-memo" as const,
    familyId: UNIV2_STANDARD_FAMILY_ID,
    familyDefinitionHash: UNIV2_STANDARD_FAMILY_DEFINITION_HASH,
    familyCandidateKey: familyCandidateKey(UNIV2_STANDARD_FAMILY_DEFINITION_HASH, pool),
    instanceNominationKey: pool,
    candidateSubjectHash: candidateSubjectHash(UNIV2_STANDARD_FAMILY_DEFINITION_HASH, pool),
    candidateEvidenceRoot: hash("candidate-evidence-root"),
    identity: protocolIdentity,
  };
  return {
    familyId: UNIV2_STANDARD_FAMILY_ID,
    familyDefinitionHash: UNIV2_STANDARD_FAMILY_DEFINITION_HASH,
    instanceKey: pool,
    identityMemo: decodeCanonicalJson(encodeCanonicalJson(memo)) as CanonicalJson,
    identityMemoHash: hashDomain("aloha/identity-memo/v1", memo),
    instancePublicationHash: hash("publication"),
    staticProjectionMemoHash: hash("static-projection-memo"),
    requestedArtifactDependencyRoot: UNIV2_STANDARD_REQUESTED_ARTIFACT_DEPENDENCY_ROOT,
    staticProjectionHash: hash("static-projection"),
    projectionHash: hash("projection"),
    authoritySessionHash: hash("authority-session"),
  };
}

const amount: FamilySearchAmountEnvelopeV1 = Object.freeze({
  inputAssetRef: erc20AssetRefV1("1", token0),
  outputAssetRef: erc20AssetRefV1("1", token1),
  amountIn: "100000",
  recipient,
});
const objectivePayload = Object.freeze({ kind: "search-objective", numeraire: amount.outputAssetRef });
const objective = Object.freeze({
  objectiveRef: hashDomain("aloha/search-objective/v1", objectivePayload),
  payload: objectivePayload,
});

function sourceSession(): FamilySearchCurrentSourceV1 {
  return {
    source: cutoff,
    assertCurrent() {},
  };
}

function readPortFactory(mutate: boolean): FamilySearchSourceReadPortV1 {
  return {
    read({ request }: { readonly request: FamilySearchSourceReadRequestV1 }) {
      return {
        kind: "returned" as const,
        requestId: request.requestId,
        source: mutate ? { ...request.source, number: "101" } : request.source,
        dataHex: reserves(1_000_000n, 2_000_000n, 42n),
      };
    },
  };
}

function input(readPort: FamilySearchSourceReadPortV1 = readPortFactory(false)) {
  return {
    route: routeBinding(),
    currentSource: sourceSession(),
    objective,
    amount,
    readPort,
  };
}

test("single UniV2 handle binding runs state to coarse to exact to action through generic envelopes", async () => {
  const result = await UNIV2_STANDARD_SEARCH_ADAPTER.run(input());
  assert.equal(result.kind, "verified");
  if (result.kind !== "verified") return;
  assert.equal(result.artifact.state.kind, "state");
  assert.equal(result.artifact.coarse.status, "rankable");
  assert.equal(result.artifact.exact.status, "verified");
  assert.equal(result.artifact.action.status, "ready");
  assert.equal(result.artifact.action.exactEvaluationHash, result.artifact.exact.evaluationHash);
  assert.equal((result.artifact.action.payload as { readonly kind: string }).kind, "univ2-standard.swap-action");
  assert.equal(result.artifact.coarse.amountHash, familySearchAmountHash(amount));
});

test("physical source absence remains unavailable and source/hash mutations are fail-closed", async () => {
  const unavailable = await UNIV2_STANDARD_SEARCH_ADAPTER.run({
    ...input(),
    readPort: {
      read({ request }) {
        return { kind: "unavailable" as const, requestId: request.requestId, source: request.source, reasonCode: "rpc-timeout" };
      },
    },
  });
  assert.equal(unavailable.kind, "unavailable");
  if (unavailable.kind === "unavailable") assert.equal(unavailable.stage, "state");

  const staleSource = await UNIV2_STANDARD_SEARCH_ADAPTER.run({ ...input(), readPort: readPortFactory(true) });
  assert.equal(staleSource.kind, "invalidProgram");

  const state = await UNIV2_STANDARD_SEARCH_ADAPTER.readState(input());
  assert.equal(state.kind, "verified");
  if (state.kind !== "verified") return;
  const coarse = UNIV2_STANDARD_SEARCH_ADAPTER.projectCoarse({ ...input(), state: { ...state.artifact, artifactHash: hash("forged-state") } });
  assert.equal(coarse.kind, "invalidProgram");

  const validCoarse = UNIV2_STANDARD_SEARCH_ADAPTER.projectCoarse({ ...input(), state: state.artifact });
  assert.equal(validCoarse.kind, "verified");
  if (validCoarse.kind !== "verified") return;
  const exact = UNIV2_STANDARD_SEARCH_ADAPTER.evaluateExact({ ...input(), state: state.artifact, coarse: { ...validCoarse.artifact, projectionHash: hash("forged-projection") } });
  assert.equal(exact.kind, "invalidProgram");

  const validExact = UNIV2_STANDARD_SEARCH_ADAPTER.evaluateExact({ ...input(), state: state.artifact, coarse: validCoarse.artifact });
  assert.equal(validExact.kind, "verified");
  if (validExact.kind !== "verified") return;
  const action = UNIV2_STANDARD_SEARCH_ADAPTER.buildAction({ ...input(), exact: { ...validExact.artifact, evaluationHash: hash("forged-evaluation") } });
  assert.equal(action.kind, "invalidProgram");
});

test("caller amount callback bytes cannot authorize a UniV2 flash callback", async () => {
  const result = await UNIV2_STANDARD_SEARCH_ADAPTER.run({
    ...input(),
    amount: { ...amount, callbackDataHex: "0x1234" } as never,
  });
  assert.equal(result.kind, "invalidProgram");
  if (result.kind === "invalidProgram") {
    assert.equal(result.stage, "state");
    assert.match(result.code, /unknown-field|callback|amount/i);
  }
});

test("adapter resolves the release's real ports through generated-composition shape", async () => {
  const ref = (capabilityId: typeof UNIV2_STANDARD_STATE_CAPABILITY_ID | typeof UNIV2_STANDARD_COARSE_CAPABILITY_ID | typeof UNIV2_STANDARD_EXACT_CAPABILITY_ID, schemaHash: Hash, interpreterHash: Hash): StageCapabilityRefV1 => ({
    familyId: asFamilyId(UNIV2_STANDARD_FAMILY_ID),
    familyDefinitionHash: UNIV2_STANDARD_FAMILY_DEFINITION_HASH,
    stage: "capability" as const,
    capabilityId,
    version: asCapabilityVersion("1.0.0"),
    schemaHash: asSchemaRef(schemaHash),
    interpreterHash,
    ownerRef: asOwnerRef(hash(`${capabilityId}-owner`)),
  });
  const refs = {
    state: ref(UNIV2_STANDARD_STATE_CAPABILITY_ID, UNIV2_STANDARD_STATE_SCHEMA_HASH, UNIV2_STANDARD_STATE_INTERPRETER_HASH),
    coarse: ref(UNIV2_STANDARD_COARSE_CAPABILITY_ID, UNIV2_STANDARD_COARSE_SCHEMA_HASH, UNIV2_STANDARD_COARSE_INTERPRETER_HASH),
    exact: ref(UNIV2_STANDARD_EXACT_CAPABILITY_ID, UNIV2_STANDARD_EXACT_SCHEMA_HASH, UNIV2_STANDARD_EXACT_INTERPRETER_HASH),
  };
  const composition = {
    resolveCapability(_familyDefinitionHash: Hash, capabilityRef: StageCapabilityRefV1) {
      if (capabilityRef.capabilityId === refs.state.capabilityId) return UNIV2_STANDARD_STATE_PORT;
      if (capabilityRef.capabilityId === refs.coarse.capabilityId) return UNIV2_STANDARD_COARSE_PORT;
      return UNIV2_STANDARD_EXACT_PORT;
    },
    resolveActionOwner() {
      return UNIV2_STANDARD_SWAP_ACTION_PORT;
    },
  };
  const adapter = createUniV2SearchAdapterFromComposition({
    composition,
    capabilityRefs: refs,
    actionOwnerRefs: {
      swap: asOwnerRef(hash("generated-action-owner")) as ActionOwnerRef,
    },
  });
  const result = await adapter.run(input());
  assert.equal(result.kind, "verified");
});
