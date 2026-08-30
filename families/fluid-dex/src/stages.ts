import { hashDomain, type Hash } from "../../../packages/canonical-codec/src/index.ts";
import {
  FLUID_DEX_CONTRACT_EVIDENCE_TOPIC,
  FLUID_DEX_FAMILY_ID,
  FLUID_DEX_FAMILY_VERSION,
  FLUID_DEX_MANIFEST,
  FLUID_DEX_SOURCE_WINDOW_BLOCKS,
} from "./manifest.ts";
import { observedQuote, positiveAmount } from "./kernel/math.ts";
import {
  assertCutoff,
  canonicalAddress,
  cutoffEqual,
  familyCandidateKey,
  type FluidDexActionV1,
  type FluidDexCandidateV1,
  type FluidDexExecutionIntentV1,
  type FluidDexIdentityReadFactsV1,
  type FluidDexIdentityV1,
  type FluidDexMaterializedStateV1,
  type FluidDexObservationV1,
  type FluidDexQuoteV1,
  type FluidDexRouteV1,
  type FluidDexStateReadFactsV1,
} from "./types.ts";

export const FLUID_DEX_CONTRACT_PATTERN = "fluid-dex-contract-log" as const;
export type FluidDexDiscoveryPatternV1 = typeof FLUID_DEX_CONTRACT_PATTERN;
export interface FluidDexCandidateSeedV1 {
  readonly target: string;
  readonly evidence: FluidDexObservationV1;
}

export function decodeFluidDexCandidate(
  observation: FluidDexObservationV1,
  pattern: FluidDexDiscoveryPatternV1,
): FluidDexCandidateSeedV1 | null {
  if (pattern !== FLUID_DEX_CONTRACT_PATTERN
    || observation.kind !== "log"
    || observation.topic !== FLUID_DEX_CONTRACT_EVIDENCE_TOPIC) return null;
  const target = canonicalAddress(observation.target);
  return Object.freeze({ target, evidence: Object.freeze({ ...observation, target }) });
}
export function instanceNominationKey(input: FluidDexCandidateSeedV1 | FluidDexCandidateV1): string {
  return canonicalAddress(input.target);
}
export function candidateSnapshotHash(input: FluidDexObservationV1): Hash {
  return hashDomain("aloha/fluid-dex/candidate-snapshot/v1", {
    familyId: FLUID_DEX_FAMILY_ID,
    target: canonicalAddress(input.target),
    cutoff: input.cutoff,
    blockNumber: input.blockNumber,
    blockHash: input.blockHash,
    txHash: input.txHash,
    logIndex: input.logIndex,
    topic: input.topic,
    rawLocatorHash: input.rawLocatorHash,
  });
}

export type FluidDexNominationOutcomeV1 =
  | { readonly status: "nominated"; readonly candidate: FluidDexCandidateV1 }
  | { readonly status: "chain-proven-rejected"; readonly reasonCode: "evidence-before-window" | "evidence-after-cutoff" };

export function nominateFluidDex(input: FluidDexCandidateSeedV1): FluidDexNominationOutcomeV1 {
  const cutoff = assertCutoff(input.evidence.cutoff);
  const block = BigInt(input.evidence.blockNumber);
  const end = BigInt(cutoff.number);
  if (block > end) return Object.freeze({ status: "chain-proven-rejected", reasonCode: "evidence-after-cutoff" });
  if (block < end - BigInt(FLUID_DEX_SOURCE_WINDOW_BLOCKS - 1)) return Object.freeze({ status: "chain-proven-rejected", reasonCode: "evidence-before-window" });
  const target = canonicalAddress(input.target);
  const evidence = Object.freeze({ ...input.evidence, target, cutoff });
  const instanceKey = instanceNominationKey({ target, evidence });
  return Object.freeze({
    status: "nominated",
    candidate: Object.freeze({
      target,
      instanceNominationKey: instanceKey,
      candidateSnapshotHash: candidateSnapshotHash(evidence),
      evidence,
    }),
  });
}
export function candidateFamilyKey(candidate: FluidDexCandidateV1): Hash {
  return familyCandidateKey(candidate.instanceNominationKey);
}

export type FluidDexIdentityOutcomeV1 =
  | { readonly status: "verified"; readonly identity: FluidDexIdentityV1 }
  | { readonly status: "chain-proven-rejected"; readonly reasonCode: "reverse-identity-mismatch" | "asset-pair-invalid" };

export function verifyFluidDexIdentityStage(input: {
  readonly candidate: FluidDexCandidateV1;
  readonly reads: FluidDexIdentityReadFactsV1;
}): FluidDexIdentityOutcomeV1 {
  const reads = {
    ...input.reads,
    cutoff: assertCutoff(input.reads.cutoff),
    target: canonicalAddress(input.reads.target),
    reverseTarget: canonicalAddress(input.reads.reverseTarget),
    inputAsset: canonicalAddress(input.reads.inputAsset),
    outputAsset: canonicalAddress(input.reads.outputAsset),
  };
  if (!cutoffEqual(reads.cutoff, input.candidate.evidence.cutoff)) throw new TypeError("fluid-dex identity cutoff mismatch");
  if (reads.target !== canonicalAddress(input.candidate.target) || reads.reverseTarget !== reads.target) {
    return Object.freeze({ status: "chain-proven-rejected", reasonCode: "reverse-identity-mismatch" });
  }
  if (reads.inputAsset === reads.outputAsset) {
    return Object.freeze({ status: "chain-proven-rejected", reasonCode: "asset-pair-invalid" });
  }
  const facts = Object.freeze({ target: reads.target, inputAsset: reads.inputAsset, outputAsset: reads.outputAsset });
  const factsHash = hashDomain("aloha/fluid-dex/identity-facts/v1", facts);
  return Object.freeze({
    status: "verified",
    identity: Object.freeze({
      cutoff: reads.cutoff,
      candidateSnapshotHash: input.candidate.candidateSnapshotHash,
      instanceKey: reads.target,
      factsHash,
      facts,
    }),
  });
}
export function identityDescriptorHash(identity: FluidDexIdentityV1): Hash {
  return hashDomain("aloha/fluid-dex/instance-descriptor/v1", {
    familyId: FLUID_DEX_FAMILY_ID,
    version: FLUID_DEX_FAMILY_VERSION,
    instanceKey: identity.instanceKey,
    factsHash: identity.factsHash,
  });
}

export type FluidDexMaterializationOutcomeV1 =
  | { readonly status: "verified"; readonly state: FluidDexMaterializedStateV1 }
  | { readonly status: "chain-proven-rejected"; readonly reasonCode: "instance-mismatch" | "state-invalid" };

export function materializeFluidDex(input: {
  readonly identity: FluidDexIdentityV1;
  readonly read: FluidDexStateReadFactsV1;
}): FluidDexMaterializationOutcomeV1 {
  const read = {
    ...input.read,
    cutoff: assertCutoff(input.read.cutoff),
    instanceKey: canonicalAddress(input.read.instanceKey),
  };
  if (!cutoffEqual(read.cutoff, input.identity.cutoff)) throw new TypeError("fluid-dex materialization cutoff mismatch");
  if (read.instanceKey !== input.identity.instanceKey) return Object.freeze({ status: "chain-proven-rejected", reasonCode: "instance-mismatch" });
  try {
    positiveAmount(read.reserveIn, "reserveIn");
    positiveAmount(read.reserveOut, "reserveOut");
  } catch {
    return Object.freeze({ status: "chain-proven-rejected", reasonCode: "state-invalid" });
  }
  const stateHash = hashDomain("aloha/fluid-dex/materialized-state/v1", {
    identityFactsHash: input.identity.factsHash,
    reserveIn: read.reserveIn,
    reserveOut: read.reserveOut,
  });
  return Object.freeze({
    status: "verified",
    state: Object.freeze({ ...read, identityFactsHash: input.identity.factsHash, stateHash }),
  });
}
export function resealFluidDexState(state: FluidDexMaterializedStateV1): Hash {
  return hashDomain("aloha/fluid-dex/materialized-state/v1", {
    identityFactsHash: state.identityFactsHash,
    reserveIn: state.reserveIn,
    reserveOut: state.reserveOut,
  });
}

export function deriveFluidDexRoutes(identity: FluidDexIdentityV1): readonly FluidDexRouteV1[] {
  const route = {
    instanceKey: identity.instanceKey,
    inputAsset: identity.facts.inputAsset,
    outputAsset: identity.facts.outputAsset,
  };
  return Object.freeze([Object.freeze({
    ...route,
    routeBindingHash: hashDomain("aloha/fluid-dex/route-binding/v1", route),
  })]);
}
export function assertFluidDexRoute(route: FluidDexRouteV1, identity: FluidDexIdentityV1): void {
  const expected = hashDomain("aloha/fluid-dex/route-binding/v1", {
    instanceKey: route.instanceKey,
    inputAsset: route.inputAsset,
    outputAsset: route.outputAsset,
  });
  if (
    route.instanceKey !== identity.instanceKey
    || route.inputAsset !== identity.facts.inputAsset
    || route.outputAsset !== identity.facts.outputAsset
    || route.routeBindingHash !== expected
  ) throw new TypeError("fluid-dex route identity mismatch");
}

export type FluidDexCoarseOutcomeV1 =
  | { readonly status: "rankable"; readonly quote: FluidDexQuoteV1 }
  | { readonly status: "unavailable"; readonly reasonCode: "invalid-observation" | "route-mismatch" };

export function coarseFluidDex(input: {
  readonly identity: FluidDexIdentityV1;
  readonly route: FluidDexRouteV1;
  readonly amountIn: string;
  readonly observedAmountOut: string;
}): FluidDexCoarseOutcomeV1 {
  try {
    assertFluidDexRoute(input.route, input.identity);
    const observed = observedQuote(input.amountIn, input.observedAmountOut);
    const payload = {
      cutoff: input.identity.cutoff,
      routeBindingHash: input.route.routeBindingHash,
      amountIn: observed.amountIn,
      observedAmountOut: observed.observedAmountOut,
    };
    return Object.freeze({
      status: "rankable",
      quote: Object.freeze({ ...payload, quoteHash: hashDomain("aloha/fluid-dex/quote/v1", payload) }),
    });
  } catch (error) {
    return Object.freeze({
      status: "unavailable",
      reasonCode: error instanceof TypeError && error.message.includes("route") ? "route-mismatch" : "invalid-observation",
    });
  }
}
export const exactFluidDex = coarseFluidDex;

export function buildFluidDexAction(input: {
  readonly identity: FluidDexIdentityV1;
  readonly quote: FluidDexQuoteV1;
  readonly calldata: string;
}): FluidDexActionV1 {
  if (!/^0x(?:[0-9a-fA-F]{2})*$/.test(input.calldata)) throw new TypeError("fluid-dex calldata must be even-length hex bytes");
  if (!cutoffEqual(input.identity.cutoff, input.quote.cutoff)) throw new TypeError("fluid-dex action cutoff mismatch");
  const expectedRouteBindingHash = hashDomain("aloha/fluid-dex/route-binding/v1", {
    instanceKey: input.identity.instanceKey,
    inputAsset: input.identity.facts.inputAsset,
    outputAsset: input.identity.facts.outputAsset,
  });
  if (input.quote.routeBindingHash !== expectedRouteBindingHash) throw new TypeError("fluid-dex action route binding mismatch");
  const payload = {
    cutoff: input.identity.cutoff,
    target: canonicalAddress(input.identity.instanceKey),
    calldata: input.calldata.toLowerCase(),
    exactQuoteHash: input.quote.quoteHash,
  };
  return Object.freeze({ ...payload, actionHash: hashDomain("aloha/fluid-dex/action/v1", payload) });
}
export function compileFluidDexExecution(input: {
  readonly identity: FluidDexIdentityV1;
  readonly action: FluidDexActionV1;
}): FluidDexExecutionIntentV1 {
  if (
    input.action.target !== canonicalAddress(input.identity.instanceKey)
    || !cutoffEqual(input.action.cutoff, input.identity.cutoff)
  ) throw new TypeError("fluid-dex execution binding mismatch");
  return Object.freeze({
    kind: "fluid-dex-execution-intent",
    cutoff: input.action.cutoff,
    target: input.action.target,
    calldata: input.action.calldata,
    actionHash: input.action.actionHash,
    exactQuoteHash: input.action.exactQuoteHash,
  });
}
export function captureFluidDexEvidence(input: {
  readonly observation: FluidDexObservationV1;
  readonly pattern: FluidDexDiscoveryPatternV1;
}): FluidDexCandidateSeedV1 | null {
  return decodeFluidDexCandidate(input.observation, input.pattern);
}

export const FLUID_DEX_RUNTIME = Object.freeze({
  manifest: FLUID_DEX_MANIFEST,
  discover: decodeFluidDexCandidate,
  capture: captureFluidDexEvidence,
  nominate: nominateFluidDex,
  identity: verifyFluidDexIdentityStage,
  materialize: materializeFluidDex,
  routes: deriveFluidDexRoutes,
  coarse: coarseFluidDex,
  exact: exactFluidDex,
  execute: compileFluidDexExecution,
});
export const FLUID_DEX_NOMINATION_RUNTIME = Object.freeze({ stage: "nomination", run: nominateFluidDex });
export const FLUID_DEX_IDENTITY_RUNTIME = Object.freeze({ stage: "identity", run: verifyFluidDexIdentityStage });
export const FLUID_DEX_MATERIALIZATION_RUNTIME = Object.freeze({ stage: "materialization", run: materializeFluidDex });
export const FLUID_DEX_PROJECTION_RUNTIME = Object.freeze({ stage: "projection", run: deriveFluidDexRoutes });
export const FLUID_DEX_REHYDRATION_RUNTIME = Object.freeze({ stage: "rehydration", run: deriveFluidDexRoutes });
