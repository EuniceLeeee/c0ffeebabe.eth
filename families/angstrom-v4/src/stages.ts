import { hashDomain, type Hash } from "../../../packages/canonical-codec/src/index.ts";
import { ANGSTROM_MAINNET_HOOK, ANGSTROM_V4_POOL_MANAGER, ANGSTROM_V4_QUOTER, ANGSTROM_V4_STATE_VIEW, assertPoolKey, poolIdForKey } from "./abi.ts";
import {
  ANGSTROM_V4_ACTION_OWNER_ID,
  ANGSTROM_V4_CONTRACT_EVIDENCE_TOPIC,
  ANGSTROM_V4_FAMILY_ID,
  ANGSTROM_V4_FAMILY_VERSION,
  ANGSTROM_V4_MANIFEST,
  ANGSTROM_V4_SOURCE_WINDOW_BLOCKS,
} from "./manifest.ts";
import { observedQuote, positiveAmount } from "./kernel/math.ts";
import {
  assertCutoff,
  canonicalAddress,
  cutoffEqual,
  familyCandidateKey,
  type AngstromV4ActionV1,
  type AngstromV4CandidateV1,
  type AngstromV4ExecutionIntentV1,
  type AngstromV4IdentityReadFactsV1,
  type AngstromV4IdentityV1,
  type AngstromV4MaterializedStateV1,
  type AngstromV4ObservationV1,
  type AngstromV4QuoteV1,
  type AngstromV4RouteV1,
  type AngstromV4StateReadFactsV1,
} from "./types.ts";

export const ANGSTROM_V4_CONTRACT_PATTERN = "angstrom-v4-contract-log" as const;
export type AngstromV4DiscoveryPatternV1 = typeof ANGSTROM_V4_CONTRACT_PATTERN;
export interface AngstromV4CandidateSeedV1 {
  readonly target: string;
  readonly evidence: AngstromV4ObservationV1;
}
export interface AngstromV4CandidateNominationV1 extends AngstromV4CandidateSeedV1 {
  readonly poolId: Hash;
}

export function decodeAngstromV4Candidate(
  observation: AngstromV4ObservationV1,
  pattern: AngstromV4DiscoveryPatternV1,
): AngstromV4CandidateSeedV1 | null {
  if (pattern !== ANGSTROM_V4_CONTRACT_PATTERN
    || observation.kind !== "log"
    || observation.topic !== ANGSTROM_V4_CONTRACT_EVIDENCE_TOPIC) return null;
  const target = canonicalAddress(observation.target);
  return Object.freeze({ target, evidence: Object.freeze({ ...observation, target }) });
}
export function instanceNominationKey(input: AngstromV4CandidateNominationV1 | AngstromV4CandidateV1): string {
  return canonicalHash(input.poolId, "angstrom-v4.poolId");
}
export function candidateSnapshotHash(input: AngstromV4ObservationV1, poolId: Hash): Hash {
  return hashDomain("aloha/angstrom-v4/candidate-snapshot/v1", {
    familyId: ANGSTROM_V4_FAMILY_ID,
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

export type AngstromV4NominationOutcomeV1 =
  | { readonly status: "nominated"; readonly candidate: AngstromV4CandidateV1 }
  | { readonly status: "chain-proven-rejected"; readonly reasonCode: "evidence-before-window" | "evidence-after-cutoff" };

export function nominateAngstromV4(input: AngstromV4CandidateNominationV1): AngstromV4NominationOutcomeV1 {
  const cutoff = assertCutoff(input.evidence.cutoff);
  const block = BigInt(input.evidence.blockNumber);
  const end = BigInt(cutoff.number);
  if (block > end) return Object.freeze({ status: "chain-proven-rejected", reasonCode: "evidence-after-cutoff" });
  if (block < end - BigInt(ANGSTROM_V4_SOURCE_WINDOW_BLOCKS - 1)) return Object.freeze({ status: "chain-proven-rejected", reasonCode: "evidence-before-window" });
  const target = canonicalAddress(input.target);
  const poolId = canonicalHash(input.poolId, "angstrom-v4.poolId");
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
export function candidateFamilyKey(candidate: AngstromV4CandidateV1): Hash {
  return familyCandidateKey(candidate.instanceNominationKey);
}

export type AngstromV4IdentityOutcomeV1 =
  | { readonly status: "verified"; readonly identity: AngstromV4IdentityV1 }
  | { readonly status: "chain-proven-rejected"; readonly reasonCode: "reverse-identity-mismatch" | "asset-pair-invalid" };

export function verifyAngstromV4IdentityStage(input: {
  readonly candidate: AngstromV4CandidateV1;
  readonly reads: AngstromV4IdentityReadFactsV1;
}): AngstromV4IdentityOutcomeV1 {
  const reads = {
    ...input.reads,
    cutoff: assertCutoff(input.reads.cutoff),
    target: canonicalAddress(input.reads.target),
    reverseTarget: canonicalAddress(input.reads.reverseTarget),
    inputAsset: canonicalAddress(input.reads.inputAsset),
    outputAsset: canonicalAddress(input.reads.outputAsset),
  };
  if (!cutoffEqual(reads.cutoff, input.candidate.evidence.cutoff)) throw new TypeError("angstrom-v4 identity cutoff mismatch");
  if (reads.target !== canonicalAddress(input.candidate.target) || reads.reverseTarget !== reads.target) {
    return Object.freeze({ status: "chain-proven-rejected", reasonCode: "reverse-identity-mismatch" });
  }
  if (reads.inputAsset === reads.outputAsset) {
    return Object.freeze({ status: "chain-proven-rejected", reasonCode: "asset-pair-invalid" });
  }
  const poolKey = assertPoolKey(reads.poolKey, "angstrom-v4.poolKey");
  const poolId = canonicalHash(reads.poolId, "angstrom-v4.poolId");
  const manager = canonicalAddress(reads.managerBinding.manager);
  const stateView = canonicalAddress(reads.managerBinding.stateView);
  const quoter = canonicalAddress(reads.managerBinding.quoter);
  if (
    poolIdForKey(poolKey) !== poolId
    || poolKey.hooks !== canonicalAddress(ANGSTROM_MAINNET_HOOK)
    || manager !== canonicalAddress(ANGSTROM_V4_POOL_MANAGER)
    || stateView !== canonicalAddress(ANGSTROM_V4_STATE_VIEW)
    || quoter !== canonicalAddress(ANGSTROM_V4_QUOTER)
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
  const factsHash = hashDomain("aloha/angstrom-v4/identity-facts/v1", facts);
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
export function identityDescriptorHash(identity: AngstromV4IdentityV1): Hash {
  return hashDomain("aloha/angstrom-v4/instance-descriptor/v1", {
    familyId: ANGSTROM_V4_FAMILY_ID,
    version: ANGSTROM_V4_FAMILY_VERSION,
    instanceKey: identity.instanceKey,
    factsHash: identity.factsHash,
  });
}

export type AngstromV4MaterializationOutcomeV1 =
  | { readonly status: "verified"; readonly state: AngstromV4MaterializedStateV1 }
  | { readonly status: "chain-proven-rejected"; readonly reasonCode: "instance-mismatch" | "state-invalid" };

export function materializeAngstromV4(input: {
  readonly identity: AngstromV4IdentityV1;
  readonly read: AngstromV4StateReadFactsV1;
}): AngstromV4MaterializationOutcomeV1 {
  const read = {
    ...input.read,
    cutoff: assertCutoff(input.read.cutoff),
    instanceKey: canonicalInstanceKey(input.read.instanceKey),
  };
  if (!cutoffEqual(read.cutoff, input.identity.cutoff)) throw new TypeError("angstrom-v4 materialization cutoff mismatch");
  if (read.instanceKey !== input.identity.instanceKey) return Object.freeze({ status: "chain-proven-rejected", reasonCode: "instance-mismatch" });
  try {
    positiveAmount(read.reserveIn, "reserveIn");
    positiveAmount(read.reserveOut, "reserveOut");
  } catch {
    return Object.freeze({ status: "chain-proven-rejected", reasonCode: "state-invalid" });
  }
  const stateHash = hashDomain("aloha/angstrom-v4/materialized-state/v1", {
    identityFactsHash: input.identity.factsHash,
    reserveIn: read.reserveIn,
    reserveOut: read.reserveOut,
  });
  return Object.freeze({
    status: "verified",
    state: Object.freeze({ ...read, identityFactsHash: input.identity.factsHash, stateHash }),
  });
}
export function resealAngstromV4State(state: AngstromV4MaterializedStateV1): Hash {
  return hashDomain("aloha/angstrom-v4/materialized-state/v1", {
    identityFactsHash: state.identityFactsHash,
    reserveIn: state.reserveIn,
    reserveOut: state.reserveOut,
  });
}

export function deriveAngstromV4Routes(identity: AngstromV4IdentityV1): readonly AngstromV4RouteV1[] {
  const route = {
    instanceKey: identity.instanceKey,
    inputAsset: identity.facts.inputAsset,
    outputAsset: identity.facts.outputAsset,
  };
  return Object.freeze([Object.freeze({
    ...route,
    routeBindingHash: hashDomain("aloha/angstrom-v4/route-binding/v1", route),
  })]);
}
export function assertAngstromV4Route(route: AngstromV4RouteV1, identity: AngstromV4IdentityV1): void {
  const expected = hashDomain("aloha/angstrom-v4/route-binding/v1", {
    instanceKey: route.instanceKey,
    inputAsset: route.inputAsset,
    outputAsset: route.outputAsset,
  });
  if (
    route.instanceKey !== identity.instanceKey
    || route.inputAsset !== identity.facts.inputAsset
    || route.outputAsset !== identity.facts.outputAsset
    || route.routeBindingHash !== expected
  ) throw new TypeError("angstrom-v4 route identity mismatch");
}

export type AngstromV4CoarseOutcomeV1 =
  | { readonly status: "rankable"; readonly quote: AngstromV4QuoteV1 }
  | { readonly status: "unavailable"; readonly reasonCode: "invalid-observation" | "route-mismatch" };

export function coarseAngstromV4(input: {
  readonly identity: AngstromV4IdentityV1;
  readonly route: AngstromV4RouteV1;
  readonly amountIn: string;
  readonly observedAmountOut: string;
}): AngstromV4CoarseOutcomeV1 {
  try {
    assertAngstromV4Route(input.route, input.identity);
    const observed = observedQuote(input.amountIn, input.observedAmountOut);
    const payload = {
      cutoff: input.identity.cutoff,
      routeBindingHash: input.route.routeBindingHash,
      amountIn: observed.amountIn,
      observedAmountOut: observed.observedAmountOut,
    };
    return Object.freeze({
      status: "rankable",
      quote: Object.freeze({ ...payload, quoteHash: hashDomain("aloha/angstrom-v4/quote/v1", payload) }),
    });
  } catch (error) {
    return Object.freeze({
      status: "unavailable",
      reasonCode: error instanceof TypeError && error.message.includes("route") ? "route-mismatch" : "invalid-observation",
    });
  }
}
export const exactAngstromV4 = coarseAngstromV4;

export function buildAngstromV4Action(input: {
  readonly identity: AngstromV4IdentityV1;
  readonly quote: AngstromV4QuoteV1;
  readonly calldata: string;
}): AngstromV4ActionV1 {
  if (!/^0x(?:[0-9a-fA-F]{2})*$/.test(input.calldata)) throw new TypeError("angstrom-v4 calldata must be even-length hex bytes");
  if (!cutoffEqual(input.identity.cutoff, input.quote.cutoff)) throw new TypeError("angstrom-v4 action cutoff mismatch");
  const expectedRouteBindingHash = hashDomain("aloha/angstrom-v4/route-binding/v1", {
    instanceKey: input.identity.instanceKey,
    inputAsset: input.identity.facts.inputAsset,
    outputAsset: input.identity.facts.outputAsset,
  });
  if (input.quote.routeBindingHash !== expectedRouteBindingHash) throw new TypeError("angstrom-v4 action route binding mismatch");
  const payload = {
    cutoff: input.identity.cutoff,
    target: canonicalAddress(input.identity.facts.managerBinding.manager),
    calldata: input.calldata.toLowerCase(),
    exactQuoteHash: input.quote.quoteHash,
  };
  return Object.freeze({ ...payload, actionHash: hashDomain("aloha/angstrom-v4/action/v1", payload) });
}
export const ANGSTROM_V4_ACTION_PORT = Object.freeze({
  actionOwnerId: ANGSTROM_V4_ACTION_OWNER_ID,
  actionKind: "swap",
  build: buildAngstromV4Action,
});

export function compileAngstromV4Execution(input: {
  readonly identity: AngstromV4IdentityV1;
  readonly action: AngstromV4ActionV1;
}): AngstromV4ExecutionIntentV1 {
  if (
    input.action.target !== canonicalAddress(input.identity.facts.managerBinding.manager)
    || !cutoffEqual(input.action.cutoff, input.identity.cutoff)
  ) throw new TypeError("angstrom-v4 execution binding mismatch");
  return Object.freeze({
    kind: "angstrom-v4-execution-intent",
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
  return canonicalHash(value, "angstrom-v4.instanceKey");
}
export function captureAngstromV4Evidence(input: {
  readonly observation: AngstromV4ObservationV1;
  readonly pattern: AngstromV4DiscoveryPatternV1;
}): AngstromV4CandidateSeedV1 | null {
  return decodeAngstromV4Candidate(input.observation, input.pattern);
}

export const ANGSTROM_V4_RUNTIME = Object.freeze({
  manifest: ANGSTROM_V4_MANIFEST,
  discover: decodeAngstromV4Candidate,
  capture: captureAngstromV4Evidence,
  nominate: nominateAngstromV4,
  identity: verifyAngstromV4IdentityStage,
  materialize: materializeAngstromV4,
  routes: deriveAngstromV4Routes,
  coarse: coarseAngstromV4,
  exact: exactAngstromV4,
  execute: compileAngstromV4Execution,
});
