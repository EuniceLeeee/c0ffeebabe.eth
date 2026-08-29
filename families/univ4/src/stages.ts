import { hashDomain, type Hash } from "../../../packages/canonical-codec/src/index.ts";
import { UNIV4_POOL_MANAGER, UNIV4_QUOTER, UNIV4_STATE_VIEW, assertPoolKey, poolIdForKey } from "./abi.ts";
import {
  UNIV4_ACTION_OWNER_ID,
  UNIV4_CONTRACT_EVIDENCE_TOPIC,
  UNIV4_FAMILY_ID,
  UNIV4_FAMILY_VERSION,
  UNIV4_MANIFEST,
  UNIV4_SOURCE_WINDOW_BLOCKS,
} from "./manifest.ts";
import { observedQuote, positiveAmount } from "./kernel/math.ts";
import {
  assertCutoff,
  canonicalAddress,
  cutoffEqual,
  familyCandidateKey,
  type Univ4ActionV1,
  type Univ4CandidateV1,
  type Univ4ExecutionIntentV1,
  type Univ4IdentityReadFactsV1,
  type Univ4IdentityV1,
  type Univ4MaterializedStateV1,
  type Univ4ObservationV1,
  type Univ4QuoteV1,
  type Univ4RouteV1,
  type Univ4StateReadFactsV1,
} from "./types.ts";

export const UNIV4_CONTRACT_PATTERN = "univ4-contract-log" as const;
export type Univ4DiscoveryPatternV1 = typeof UNIV4_CONTRACT_PATTERN;
export interface Univ4CandidateSeedV1 {
  readonly target: string;
  readonly evidence: Univ4ObservationV1;
}
export interface Univ4CandidateNominationV1 extends Univ4CandidateSeedV1 {
  readonly poolId: Hash;
}

export function decodeUniv4Candidate(
  observation: Univ4ObservationV1,
  pattern: Univ4DiscoveryPatternV1,
): Univ4CandidateSeedV1 | null {
  if (pattern !== UNIV4_CONTRACT_PATTERN
    || observation.kind !== "log"
    || observation.topic !== UNIV4_CONTRACT_EVIDENCE_TOPIC) return null;
  const target = canonicalAddress(observation.target);
  return Object.freeze({ target, evidence: Object.freeze({ ...observation, target }) });
}
export function instanceNominationKey(input: Univ4CandidateNominationV1 | Univ4CandidateV1): string {
  return canonicalHash(input.poolId, "univ4.poolId");
}
export function candidateSnapshotHash(input: Univ4ObservationV1, poolId: Hash): Hash {
  return hashDomain("aloha/univ4/candidate-snapshot/v1", {
    familyId: UNIV4_FAMILY_ID,
    target: canonicalAddress(input.target),
    cutoff: input.cutoff,
    blockNumber: input.blockNumber,
    blockHash: input.blockHash,
    txHash: input.txHash,
    logIndex: input.logIndex,
    topic: input.topic,
    rawLocatorHash: input.rawLocatorHash,
    poolId,
  });
}

export type Univ4NominationOutcomeV1 =
  | { readonly status: "nominated"; readonly candidate: Univ4CandidateV1 }
  | { readonly status: "chain-proven-rejected"; readonly reasonCode: "evidence-before-window" | "evidence-after-cutoff" };

export function nominateUniv4(input: Univ4CandidateNominationV1): Univ4NominationOutcomeV1 {
  const cutoff = assertCutoff(input.evidence.cutoff);
  const block = BigInt(input.evidence.blockNumber);
  const end = BigInt(cutoff.number);
  if (block > end) return Object.freeze({ status: "chain-proven-rejected", reasonCode: "evidence-after-cutoff" });
  if (block < end - BigInt(UNIV4_SOURCE_WINDOW_BLOCKS - 1)) return Object.freeze({ status: "chain-proven-rejected", reasonCode: "evidence-before-window" });
  const target = canonicalAddress(input.target);
  const poolId = canonicalHash(input.poolId, "univ4.poolId");
  const evidence = Object.freeze({ ...input.evidence, target, cutoff });
  const instanceKey = instanceNominationKey({ target, poolId, evidence });
  return Object.freeze({
    status: "nominated",
    candidate: Object.freeze({
      target,
      poolId,
      instanceNominationKey: instanceKey,
      candidateSnapshotHash: candidateSnapshotHash(evidence, poolId),
      evidence,
    }),
  });
}
export function candidateFamilyKey(candidate: Univ4CandidateV1): Hash {
  return familyCandidateKey(candidate.instanceNominationKey);
}

export type Univ4IdentityOutcomeV1 =
  | { readonly status: "verified"; readonly identity: Univ4IdentityV1 }
  | { readonly status: "chain-proven-rejected"; readonly reasonCode: "reverse-identity-mismatch" | "asset-pair-invalid" };

export function verifyUniv4IdentityStage(input: {
  readonly candidate: Univ4CandidateV1;
  readonly reads: Univ4IdentityReadFactsV1;
}): Univ4IdentityOutcomeV1 {
  const reads = {
    ...input.reads,
    cutoff: assertCutoff(input.reads.cutoff),
    target: canonicalAddress(input.reads.target),
    reverseTarget: canonicalAddress(input.reads.reverseTarget),
    inputAsset: canonicalAddress(input.reads.inputAsset),
    outputAsset: canonicalAddress(input.reads.outputAsset),
  };
  if (!cutoffEqual(reads.cutoff, input.candidate.evidence.cutoff)) throw new TypeError("univ4 identity cutoff mismatch");
  if (reads.target !== canonicalAddress(input.candidate.target) || reads.reverseTarget !== reads.target) {
    return Object.freeze({ status: "chain-proven-rejected", reasonCode: "reverse-identity-mismatch" });
  }
  if (reads.inputAsset === reads.outputAsset) {
    return Object.freeze({ status: "chain-proven-rejected", reasonCode: "asset-pair-invalid" });
  }
  const poolKey = assertPoolKey(reads.poolKey, "univ4.poolKey");
  const poolId = canonicalHash(reads.poolId, "univ4.poolId");
  const manager = canonicalAddress(reads.managerBinding.manager);
  const stateView = canonicalAddress(reads.managerBinding.stateView);
  const quoter = canonicalAddress(reads.managerBinding.quoter);
  if (
    poolIdForKey(poolKey) !== poolId
    || manager !== canonicalAddress(UNIV4_POOL_MANAGER)
    || stateView !== canonicalAddress(UNIV4_STATE_VIEW)
    || quoter !== canonicalAddress(UNIV4_QUOTER)
    || reads.target !== manager
    || (reads.inputAsset !== poolKey.currency0 && reads.inputAsset !== poolKey.currency1)
    || (reads.outputAsset !== poolKey.currency0 && reads.outputAsset !== poolKey.currency1)
    || reads.inputAsset === reads.outputAsset
    || input.candidate.poolId !== poolId
    || input.candidate.instanceNominationKey !== poolId
    || input.candidate.candidateSnapshotHash !== candidateSnapshotHash(input.candidate.evidence, poolId)
  ) return Object.freeze({ status: "chain-proven-rejected", reasonCode: "reverse-identity-mismatch" });
  const facts = Object.freeze({
    target: reads.target,
    inputAsset: reads.inputAsset,
    outputAsset: reads.outputAsset,
    poolId,
    poolKey,
    managerBinding: Object.freeze({ manager, stateView, quoter }),
  });
  const factsHash = hashDomain("aloha/univ4/identity-facts/v1", facts);
  return Object.freeze({
    status: "verified",
    identity: Object.freeze({
      cutoff: reads.cutoff,
      candidateSnapshotHash: input.candidate.candidateSnapshotHash,
      instanceKey: poolId,
      factsHash,
      facts,
    }),
  });
}
export function identityDescriptorHash(identity: Univ4IdentityV1): Hash {
  return hashDomain("aloha/univ4/instance-descriptor/v1", {
    familyId: UNIV4_FAMILY_ID,
    version: UNIV4_FAMILY_VERSION,
    instanceKey: identity.instanceKey,
    factsHash: identity.factsHash,
  });
}

export type Univ4MaterializationOutcomeV1 =
  | { readonly status: "verified"; readonly state: Univ4MaterializedStateV1 }
  | { readonly status: "chain-proven-rejected"; readonly reasonCode: "instance-mismatch" | "state-invalid" };

export function materializeUniv4(input: {
  readonly identity: Univ4IdentityV1;
  readonly read: Univ4StateReadFactsV1;
}): Univ4MaterializationOutcomeV1 {
  const read = {
    ...input.read,
    cutoff: assertCutoff(input.read.cutoff),
    instanceKey: canonicalInstanceKey(input.read.instanceKey),
  };
  if (!cutoffEqual(read.cutoff, input.identity.cutoff)) throw new TypeError("univ4 materialization cutoff mismatch");
  if (read.instanceKey !== input.identity.instanceKey) return Object.freeze({ status: "chain-proven-rejected", reasonCode: "instance-mismatch" });
  try {
    positiveAmount(read.reserveIn, "reserveIn");
    positiveAmount(read.reserveOut, "reserveOut");
  } catch {
    return Object.freeze({ status: "chain-proven-rejected", reasonCode: "state-invalid" });
  }
  const stateHash = hashDomain("aloha/univ4/materialized-state/v1", {
    identityFactsHash: input.identity.factsHash,
    reserveIn: read.reserveIn,
    reserveOut: read.reserveOut,
  });
  return Object.freeze({
    status: "verified",
    state: Object.freeze({ ...read, identityFactsHash: input.identity.factsHash, stateHash }),
  });
}
export function resealUniv4State(state: Univ4MaterializedStateV1): Hash {
  return hashDomain("aloha/univ4/materialized-state/v1", {
    identityFactsHash: state.identityFactsHash,
    reserveIn: state.reserveIn,
    reserveOut: state.reserveOut,
  });
}

export function deriveUniv4Routes(identity: Univ4IdentityV1): readonly Univ4RouteV1[] {
  const route = {
    instanceKey: identity.instanceKey,
    inputAsset: identity.facts.inputAsset,
    outputAsset: identity.facts.outputAsset,
  };
  return Object.freeze([Object.freeze({
    ...route,
    routeBindingHash: hashDomain("aloha/univ4/route-binding/v1", route),
  })]);
}
export function assertUniv4Route(route: Univ4RouteV1, identity: Univ4IdentityV1): void {
  const expected = hashDomain("aloha/univ4/route-binding/v1", {
    instanceKey: route.instanceKey,
    inputAsset: route.inputAsset,
    outputAsset: route.outputAsset,
  });
  if (
    route.instanceKey !== identity.instanceKey
    || route.inputAsset !== identity.facts.inputAsset
    || route.outputAsset !== identity.facts.outputAsset
    || route.routeBindingHash !== expected
  ) throw new TypeError("univ4 route identity mismatch");
}

export type Univ4CoarseOutcomeV1 =
  | { readonly status: "rankable"; readonly quote: Univ4QuoteV1 }
  | { readonly status: "unavailable"; readonly reasonCode: "invalid-observation" | "route-mismatch" };

export function coarseUniv4(input: {
  readonly identity: Univ4IdentityV1;
  readonly route: Univ4RouteV1;
  readonly amountIn: string;
  readonly observedAmountOut: string;
}): Univ4CoarseOutcomeV1 {
  try {
    assertUniv4Route(input.route, input.identity);
    const observed = observedQuote(input.amountIn, input.observedAmountOut);
    const payload = {
      cutoff: input.identity.cutoff,
      routeBindingHash: input.route.routeBindingHash,
      amountIn: observed.amountIn,
      observedAmountOut: observed.observedAmountOut,
    };
    return Object.freeze({
      status: "rankable",
      quote: Object.freeze({ ...payload, quoteHash: hashDomain("aloha/univ4/quote/v1", payload) }),
    });
  } catch (error) {
    return Object.freeze({
      status: "unavailable",
      reasonCode: error instanceof TypeError && error.message.includes("route") ? "route-mismatch" : "invalid-observation",
    });
  }
}
export const exactUniv4 = coarseUniv4;

export function buildUniv4Action(input: {
  readonly identity: Univ4IdentityV1;
  readonly quote: Univ4QuoteV1;
  readonly calldata: string;
}): Univ4ActionV1 {
  if (!/^0x(?:[0-9a-fA-F]{2})*$/.test(input.calldata)) throw new TypeError("univ4 calldata must be even-length hex bytes");
  if (!cutoffEqual(input.identity.cutoff, input.quote.cutoff)) throw new TypeError("univ4 action cutoff mismatch");
  const expectedRouteBindingHash = hashDomain("aloha/univ4/route-binding/v1", {
    instanceKey: input.identity.instanceKey,
    inputAsset: input.identity.facts.inputAsset,
    outputAsset: input.identity.facts.outputAsset,
  });
  if (input.quote.routeBindingHash !== expectedRouteBindingHash) throw new TypeError("univ4 action route binding mismatch");
  const payload = {
    cutoff: input.identity.cutoff,
    target: canonicalAddress(input.identity.facts.managerBinding.manager),
    calldata: input.calldata.toLowerCase(),
    exactQuoteHash: input.quote.quoteHash,
  };
  return Object.freeze({ ...payload, actionHash: hashDomain("aloha/univ4/action/v1", payload) });
}
export const UNIV4_ACTION_PORT = Object.freeze({
  actionOwnerId: UNIV4_ACTION_OWNER_ID,
  actionKind: "swap",
  build: buildUniv4Action,
});

export function compileUniv4Execution(input: {
  readonly identity: Univ4IdentityV1;
  readonly action: Univ4ActionV1;
}): Univ4ExecutionIntentV1 {
  if (
    input.action.target !== canonicalAddress(input.identity.facts.managerBinding.manager)
    || !cutoffEqual(input.action.cutoff, input.identity.cutoff)
  ) throw new TypeError("univ4 execution binding mismatch");
  return Object.freeze({
    kind: "univ4-execution-intent",
    cutoff: input.action.cutoff,
    target: input.action.target,
    calldata: input.action.calldata,
    actionHash: input.action.actionHash,
    exactQuoteHash: input.action.exactQuoteHash,
  });
}

function canonicalHash(value: unknown, path: string): Hash {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(value)) throw new TypeError(`${path} must be bytes32`);
  return value.toLowerCase() as Hash;
}
function canonicalInstanceKey(value: string): string {
  return canonicalHash(value, "univ4.instanceKey");
}
export function captureUniv4Evidence(input: {
  readonly observation: Univ4ObservationV1;
  readonly pattern: Univ4DiscoveryPatternV1;
}): Univ4CandidateSeedV1 | null {
  return decodeUniv4Candidate(input.observation, input.pattern);
}

export const UNIV4_RUNTIME = Object.freeze({
  manifest: UNIV4_MANIFEST,
  discover: decodeUniv4Candidate,
  capture: captureUniv4Evidence,
  nominate: nominateUniv4,
  identity: verifyUniv4IdentityStage,
  materialize: materializeUniv4,
  routes: deriveUniv4Routes,
  coarse: coarseUniv4,
  exact: exactUniv4,
  execute: compileUniv4Execution,
});
export const UNIV4_NOMINATION_RUNTIME = Object.freeze({ stage: "nomination", run: nominateUniv4 });
export const UNIV4_IDENTITY_RUNTIME = Object.freeze({ stage: "identity", run: verifyUniv4IdentityStage });
export const UNIV4_MATERIALIZATION_RUNTIME = Object.freeze({ stage: "materialization", run: materializeUniv4 });
export const UNIV4_PROJECTION_RUNTIME = Object.freeze({ stage: "projection", run: deriveUniv4Routes });
export const UNIV4_REHYDRATION_RUNTIME = Object.freeze({ stage: "rehydration", run: deriveUniv4Routes });
