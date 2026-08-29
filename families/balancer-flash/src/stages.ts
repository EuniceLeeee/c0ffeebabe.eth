import { hashDomain, type Hash } from "../../../packages/canonical-codec/src/index.ts";
import { assertFundingRepaymentObligation, makeFundingRepaymentObligation, type FundingEffectExpectationV1 } from "../../../packages/funding/src/index.ts";
import {
  BALANCER_FLASH_ACTION_OWNER_ID,
  BALANCER_FLASH_CONTRACT_EVIDENCE_TOPIC,
  BALANCER_FLASH_FAMILY_ID,
  BALANCER_FLASH_FAMILY_VERSION,
  BALANCER_FLASH_MANIFEST,
  BALANCER_FLASH_SOURCE_WINDOW_BLOCKS,
  BALANCER_VAULT,
} from "./manifest.ts";
import { observedQuote, positiveAmount } from "./kernel/math.ts";
import {
  assertCutoff,
  canonicalAddress,
  cutoffEqual,
  familyCandidateKey,
  type BalancerFlashActionV1,
  type BalancerFlashCandidateV1,
  type BalancerFlashExecutionIntentV1,
  type BalancerFlashEffectV1,
  type BalancerFlashIdentityReadFactsV1,
  type BalancerFlashIdentityV1,
  type BalancerFlashMaterializedStateV1,
  type BalancerFlashObservationV1,
  type BalancerFlashQuoteV1,
  type BalancerFlashRouteV1,
  type BalancerFlashStateReadFactsV1,
} from "./types.ts";

export const BALANCER_FLASH_CONTRACT_PATTERN = "balancer-flash-contract-log" as const;
export type BalancerFlashDiscoveryPatternV1 = typeof BALANCER_FLASH_CONTRACT_PATTERN;
export interface BalancerFlashCandidateSeedV1 {
  readonly target: string;
  readonly evidence: BalancerFlashObservationV1;
}

export function decodeBalancerFlashCandidate(
  observation: BalancerFlashObservationV1,
  pattern: BalancerFlashDiscoveryPatternV1,
): BalancerFlashCandidateSeedV1 | null {
  if (pattern !== BALANCER_FLASH_CONTRACT_PATTERN
    || observation.kind !== "log"
    || observation.topic !== BALANCER_FLASH_CONTRACT_EVIDENCE_TOPIC) return null;
  const target = canonicalAddress(observation.target);
  return Object.freeze({ target, evidence: Object.freeze({ ...observation, target }) });
}
export function instanceNominationKey(input: BalancerFlashCandidateSeedV1 | BalancerFlashCandidateV1): string {
  return canonicalAddress(input.target);
}
export function candidateSnapshotHash(input: BalancerFlashObservationV1): Hash {
  return hashDomain("aloha/balancer-flash/candidate-snapshot/v1", {
    familyId: BALANCER_FLASH_FAMILY_ID,
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

export type BalancerFlashNominationOutcomeV1 =
  | { readonly status: "nominated"; readonly candidate: BalancerFlashCandidateV1 }
  | { readonly status: "chain-proven-rejected"; readonly reasonCode: "evidence-before-window" | "evidence-after-cutoff" };

export function nominateBalancerFlash(input: BalancerFlashCandidateSeedV1): BalancerFlashNominationOutcomeV1 {
  const cutoff = assertCutoff(input.evidence.cutoff);
  const block = BigInt(input.evidence.blockNumber);
  const end = BigInt(cutoff.number);
  if (block > end) return Object.freeze({ status: "chain-proven-rejected", reasonCode: "evidence-after-cutoff" });
  if (block < end - BigInt(BALANCER_FLASH_SOURCE_WINDOW_BLOCKS - 1)) return Object.freeze({ status: "chain-proven-rejected", reasonCode: "evidence-before-window" });
  const target = canonicalAddress(input.target);
  const evidence = Object.freeze({ ...input.evidence, target, cutoff });
  const instanceKey = canonicalAddress(target);
  return Object.freeze({
    status: "nominated",
    candidate: Object.freeze({
      target,
      instanceNominationKey: instanceKey,
      candidateSnapshotHash: candidateSnapshotHash(evidence),
      cutoff,
    }),
  });
}
export function candidateFamilyKey(candidate: BalancerFlashCandidateV1): Hash {
  return familyCandidateKey(candidate.instanceNominationKey);
}

export type BalancerFlashIdentityOutcomeV1 =
  | { readonly status: "verified"; readonly identity: BalancerFlashIdentityV1 }
  | { readonly status: "chain-proven-rejected"; readonly reasonCode: "singleton-mismatch" | "reverse-identity-mismatch" | "asset-pair-invalid" };

export function verifyBalancerFlashIdentityStage(input: {
  readonly candidate: BalancerFlashCandidateV1;
  readonly reads: BalancerFlashIdentityReadFactsV1;
}): BalancerFlashIdentityOutcomeV1 {
  const reads = {
    ...input.reads,
    cutoff: assertCutoff(input.reads.cutoff),
    target: canonicalAddress(input.reads.target),
    reverseTarget: canonicalAddress(input.reads.reverseTarget),
    inputAsset: canonicalAddress(input.reads.inputAsset),
    outputAsset: canonicalAddress(input.reads.outputAsset),
  };
  if (!cutoffEqual(reads.cutoff, input.candidate.cutoff)) throw new TypeError("balancer-flash identity cutoff mismatch");
  if (reads.target !== canonicalAddress(BALANCER_VAULT) || canonicalAddress(input.candidate.target) !== reads.target) {
    return Object.freeze({ status: "chain-proven-rejected", reasonCode: "singleton-mismatch" });
  }
  if (reads.reverseTarget !== reads.target) {
    return Object.freeze({ status: "chain-proven-rejected", reasonCode: "reverse-identity-mismatch" });
  }
  if (reads.inputAsset === reads.outputAsset) {
    return Object.freeze({ status: "chain-proven-rejected", reasonCode: "asset-pair-invalid" });
  }
  const facts = Object.freeze({ target: reads.target, inputAsset: reads.inputAsset, outputAsset: reads.outputAsset });
  const factsHash = hashDomain("aloha/balancer-flash/identity-facts/v1", facts);
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
export function identityDescriptorHash(identity: BalancerFlashIdentityV1): Hash {
  return hashDomain("aloha/balancer-flash/instance-descriptor/v1", {
    familyId: BALANCER_FLASH_FAMILY_ID,
    version: BALANCER_FLASH_FAMILY_VERSION,
    instanceKey: identity.instanceKey,
    factsHash: identity.factsHash,
  });
}

export type BalancerFlashMaterializationOutcomeV1 =
  | { readonly status: "verified"; readonly state: BalancerFlashMaterializedStateV1 }
  | { readonly status: "chain-proven-rejected"; readonly reasonCode: "instance-mismatch" | "state-invalid" };

export function materializeBalancerFlash(input: {
  readonly identity: BalancerFlashIdentityV1;
  readonly read: BalancerFlashStateReadFactsV1;
}): BalancerFlashMaterializationOutcomeV1 {
  const read = {
    ...input.read,
    cutoff: assertCutoff(input.read.cutoff),
    instanceKey: canonicalAddress(input.read.instanceKey),
  };
  if (!cutoffEqual(read.cutoff, input.identity.cutoff)) throw new TypeError("balancer-flash materialization cutoff mismatch");
  if (read.instanceKey !== input.identity.instanceKey) return Object.freeze({ status: "chain-proven-rejected", reasonCode: "instance-mismatch" });
  try {
    positiveAmount(read.reserveIn, "reserveIn");
    positiveAmount(read.reserveOut, "reserveOut");
  } catch {
    return Object.freeze({ status: "chain-proven-rejected", reasonCode: "state-invalid" });
  }
  const stateHash = hashDomain("aloha/balancer-flash/materialized-state/v1", {
    identityFactsHash: input.identity.factsHash,
    reserveIn: read.reserveIn,
    reserveOut: read.reserveOut,
  });
  return Object.freeze({
    status: "verified",
    state: Object.freeze({ ...read, identityFactsHash: input.identity.factsHash, stateHash }),
  });
}
export function resealBalancerFlashState(state: BalancerFlashMaterializedStateV1): Hash {
  return hashDomain("aloha/balancer-flash/materialized-state/v1", {
    identityFactsHash: state.identityFactsHash,
    reserveIn: state.reserveIn,
    reserveOut: state.reserveOut,
  });
}

export function deriveBalancerFlashRoutes(identity: BalancerFlashIdentityV1): readonly BalancerFlashRouteV1[] {
  const route = {
    instanceKey: identity.instanceKey,
    inputAsset: identity.facts.inputAsset,
    outputAsset: identity.facts.outputAsset,
  };
  return Object.freeze([Object.freeze({
    ...route,
    routeBindingHash: hashDomain("aloha/balancer-flash/route-binding/v1", route),
  })]);
}
export function assertBalancerFlashRoute(route: BalancerFlashRouteV1, identity: BalancerFlashIdentityV1): void {
  const expected = hashDomain("aloha/balancer-flash/route-binding/v1", {
    instanceKey: route.instanceKey,
    inputAsset: route.inputAsset,
    outputAsset: route.outputAsset,
  });
  if (
    route.instanceKey !== identity.instanceKey
    || route.inputAsset !== identity.facts.inputAsset
    || route.outputAsset !== identity.facts.outputAsset
    || route.routeBindingHash !== expected
  ) throw new TypeError("balancer-flash route identity mismatch");
}

export type BalancerFlashCoarseOutcomeV1 =
  | { readonly status: "rankable"; readonly quote: BalancerFlashQuoteV1 }
  | { readonly status: "unavailable"; readonly reasonCode: "invalid-observation" | "route-mismatch" };

export function coarseBalancerFlash(input: {
  readonly identity: BalancerFlashIdentityV1;
  readonly route: BalancerFlashRouteV1;
  readonly amountIn: string;
  readonly observedAmountOut: string;
}): BalancerFlashCoarseOutcomeV1 {
  try {
    assertBalancerFlashRoute(input.route, input.identity);
    const observed = observedQuote(input.amountIn, input.observedAmountOut);
    const payload = {
      cutoff: input.identity.cutoff,
      routeBindingHash: input.route.routeBindingHash,
      amountIn: observed.amountIn,
      observedAmountOut: observed.observedAmountOut,
    };
    return Object.freeze({
      status: "rankable",
      quote: Object.freeze({ ...payload, quoteHash: hashDomain("aloha/balancer-flash/quote/v1", payload) }),
    });
  } catch (error) {
    return Object.freeze({
      status: "unavailable",
      reasonCode: error instanceof TypeError && error.message.includes("route") ? "route-mismatch" : "invalid-observation",
    });
  }
}
export const exactBalancerFlash = coarseBalancerFlash;

export function buildBalancerFlashAction(input: {
  readonly identity: BalancerFlashIdentityV1;
  readonly quote: BalancerFlashQuoteV1;
  readonly calldata: string;
  readonly receiver: string;
  readonly fee: string;
}): BalancerFlashActionV1 {
  if (!/^0x(?:[0-9a-fA-F]{2})*$/.test(input.calldata)) throw new TypeError("balancer-flash calldata must be even-length hex bytes");
  if (!cutoffEqual(input.identity.cutoff, input.quote.cutoff)) throw new TypeError("balancer-flash action cutoff mismatch");
  const expectedRouteBindingHash = hashDomain("aloha/balancer-flash/route-binding/v1", {
    instanceKey: input.identity.instanceKey,
    inputAsset: input.identity.facts.inputAsset,
    outputAsset: input.identity.facts.outputAsset,
  });
  if (input.quote.routeBindingHash !== expectedRouteBindingHash) throw new TypeError("balancer-flash action route binding mismatch");
  const target = canonicalAddress(input.identity.instanceKey);
  const receiver = canonicalAddress(input.receiver);
  const payload = {
    cutoff: input.identity.cutoff,
    target,
    calldata: input.calldata.toLowerCase(),
    exactQuoteHash: input.quote.quoteHash,
    receiver,
    asset: input.identity.facts.inputAsset,
    principal: input.quote.amountIn,
    fee: input.fee,
  };
  const actionIntentHash = hashDomain("aloha/balancer-flash/action-intent/v1", payload);
  const repayment = (BigInt(input.quote.amountIn) + BigInt(input.fee)).toString(10);
  const effects: readonly FundingEffectExpectationV1[] = Object.freeze([
    { asset: input.identity.facts.inputAsset, account: "lender", direction: "decrease", amount: input.quote.amountIn },
    { asset: input.identity.facts.inputAsset, account: "executor", direction: "increase", amount: input.quote.amountIn },
    { asset: input.identity.facts.inputAsset, account: "executor", direction: "decrease", amount: repayment },
    { asset: input.identity.facts.inputAsset, account: "lender", direction: "increase", amount: repayment },
  ]);
  const obligation = makeFundingRepaymentObligation({
    familyId: BALANCER_FLASH_FAMILY_ID,
    instanceKey: input.identity.instanceKey,
    lender: target,
    receiver,
    asset: input.identity.facts.inputAsset,
    principal: input.quote.amountIn,
    fee: input.fee,
    actionIntentHash,
    effects,
  });
  const actionPayload = {
    cutoff: input.identity.cutoff,
    target,
    calldata: input.calldata.toLowerCase(),
    exactQuoteHash: input.quote.quoteHash,
    actionIntentHash,
    obligationHash: obligation.obligationHash,
  };
  return Object.freeze({ ...actionPayload, obligation, actionHash: hashDomain("aloha/balancer-flash/action/v1", actionPayload) });
}
export const BALANCER_FLASH_ACTION_PORT = Object.freeze({
  actionOwnerId: BALANCER_FLASH_ACTION_OWNER_ID,
  actionKind: "flash-loan",
  build: buildBalancerFlashAction,
});

export function expectedBalancerFlashEffects(action: BalancerFlashActionV1): readonly BalancerFlashEffectV1[] {
  return Object.freeze([
    { asset: action.obligation.asset, account: "lender", direction: "decrease", amount: action.obligation.principal },
    { asset: action.obligation.asset, account: "receiver", direction: "increase", amount: action.obligation.principal },
    { asset: action.obligation.asset, account: "receiver", direction: "decrease", amount: action.obligation.repayment },
    { asset: action.obligation.asset, account: "lender", direction: "increase", amount: action.obligation.repayment },
  ]);
}

export function compileBalancerFlashExecution(input: {
  readonly identity: BalancerFlashIdentityV1;
  readonly action: BalancerFlashActionV1;
}): BalancerFlashExecutionIntentV1 {
  if (input.action.target !== canonicalAddress(input.identity.instanceKey) || !cutoffEqual(input.action.cutoff, input.identity.cutoff)) throw new TypeError("balancer-flash execution binding mismatch");
  const obligation = assertFundingRepaymentObligation(input.action.obligation);
  const expectedIntent = hashDomain("aloha/balancer-flash/action-intent/v1", {
    cutoff: input.action.cutoff,
    target: input.action.target,
    calldata: input.action.calldata,
    exactQuoteHash: input.action.exactQuoteHash,
    receiver: obligation.receiver,
    asset: obligation.asset,
    principal: obligation.principal,
    fee: obligation.fee,
  });
  const expectedAction = hashDomain("aloha/balancer-flash/action/v1", {
    cutoff: input.action.cutoff,
    target: input.action.target,
    calldata: input.action.calldata,
    exactQuoteHash: input.action.exactQuoteHash,
    actionIntentHash: expectedIntent,
    obligationHash: obligation.obligationHash,
  });
  if (obligation.actionIntentHash !== expectedIntent || input.action.actionIntentHash !== expectedIntent || input.action.actionHash !== expectedAction) throw new TypeError("balancer-flash execution obligation lineage mismatch");
  return Object.freeze({
    kind: "balancer-flash-execution-intent",
    cutoff: input.action.cutoff,
    target: input.action.target,
    calldata: input.action.calldata,
    actionHash: input.action.actionHash,
    exactQuoteHash: input.action.exactQuoteHash,
    obligationHash: obligation.obligationHash,
    expectedEffects: expectedBalancerFlashEffects(input.action),
  });
}
export function captureBalancerFlashEvidence(input: {
  readonly observation: BalancerFlashObservationV1;
  readonly pattern: BalancerFlashDiscoveryPatternV1;
}): BalancerFlashCandidateSeedV1 | null {
  return decodeBalancerFlashCandidate(input.observation, input.pattern);
}

export const BALANCER_FLASH_RUNTIME = Object.freeze({
  manifest: BALANCER_FLASH_MANIFEST,
  discover: decodeBalancerFlashCandidate,
  capture: captureBalancerFlashEvidence,
  nominate: nominateBalancerFlash,
  identity: verifyBalancerFlashIdentityStage,
  materialize: materializeBalancerFlash,
  routes: deriveBalancerFlashRoutes,
  coarse: coarseBalancerFlash,
  exact: exactBalancerFlash,
  execute: compileBalancerFlashExecution,
});
export const BALANCER_FLASH_NOMINATION_RUNTIME = Object.freeze({ stage: "nomination", run: nominateBalancerFlash });
export const BALANCER_FLASH_IDENTITY_RUNTIME = Object.freeze({ stage: "identity", run: verifyBalancerFlashIdentityStage });
export const BALANCER_FLASH_MATERIALIZATION_RUNTIME = Object.freeze({ stage: "materialization", run: materializeBalancerFlash });
export const BALANCER_FLASH_PROJECTION_RUNTIME = Object.freeze({ stage: "projection", run: deriveBalancerFlashRoutes });
export const BALANCER_FLASH_REHYDRATION_RUNTIME = Object.freeze({ stage: "rehydration", run: deriveBalancerFlashRoutes });
