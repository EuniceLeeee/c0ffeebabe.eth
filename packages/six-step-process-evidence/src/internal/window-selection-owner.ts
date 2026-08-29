import {
  assertDecimalString,
  assertExactKeys,
  assertHash,
  encodeCanonicalJson,
  hashDomain,
  type Hash,
} from "../../../canonical-codec/src/index.ts";
import {
  readFinalDurableWindowBindingV1,
  type FinalDurableWindowCapabilityV1,
} from "../../../final-durable-window/src/index.ts";
import {
  readSearcherProductionSixStepCompleteAppendMaterialV1,
  type SearcherProductionSixStepCompleteAppendCapabilityV1,
} from "./complete-append-owner.ts";

export type SearcherProductionSixStepWindowSelectionCapabilityV1 = object;

export const SIX_STEP_WINDOW_SELECTION_POLICY_DIGEST = hashDomain(
  "aloha/searcher-production-six-step-window-selection-policy/v1",
  Object.freeze({
    denominator: "active-exact-100-performance-window",
    eligibility: "complete-successful-dry-run",
    order: Object.freeze(["ordinal", "lane:blockscan-before-backrun", "candidate-stable-key", "producer-terminal-id"]),
    selection: "first",
  }),
);

export type SearcherProductionSixStepWindowSelectionV1 =
  | Readonly<{
      readonly kind: "aloha.searcher-production-six-step-window-selection-v1";
      readonly status: "selected";
      readonly finalDurableWindowId: Hash;
      readonly windowId: Hash;
      readonly selectionPolicyDigest: Hash;
      readonly eligibleSuccessCount: string;
      readonly eligibleSuccessRoot: Hash;
      readonly selectedIndex: "0";
      readonly selectedProducerTerminalId: Hash;
      readonly completeAppend: SearcherProductionSixStepCompleteAppendCapabilityV1;
      readonly selectionRoot: Hash;
    }>
  | Readonly<{
      readonly kind: "aloha.searcher-production-six-step-window-selection-v1";
      readonly status: "missing";
      readonly reason: "no-successful-dry-run";
      readonly finalDurableWindowId: Hash;
      readonly windowId: Hash;
      readonly selectionPolicyDigest: Hash;
      readonly eligibleSuccessCount: "0";
      readonly eligibleSuccessRoot: Hash;
      readonly selectedIndex: null;
      readonly selectedProducerTerminalId: null;
      readonly completeAppend: null;
      readonly selectionRoot: Hash;
    }>
  ;

const states = new WeakMap<object, SearcherProductionSixStepWindowSelectionV1>();

export interface SixStepWindowEligibleSuccessV1 {
  readonly ordinal: string;
  readonly lane: "blockscan" | "backrun";
  readonly candidateStableKey: Hash;
  readonly producerTerminalId: Hash;
  readonly performanceEventId: Hash;
  readonly producerTerminalEventId: Hash;
}

export interface SixStepWindowSelectionFactsV1 {
  readonly orderedEligible: readonly SixStepWindowEligibleSuccessV1[];
  readonly eligibleSuccessCount: string;
  readonly eligibleSuccessRoot: Hash;
  readonly selectedIndex: "0" | null;
  readonly selectedProducerTerminalId: Hash | null;
  readonly selectionRoot: Hash;
}

function sameCanonical(left: unknown, right: unknown): boolean {
  return encodeCanonicalJson(left) === encodeCanonicalJson(right);
}

export function sealSixStepWindowSelectionFactsV1(input: Readonly<{
  readonly finalDurableWindowId: Hash;
  readonly windowId: Hash;
  readonly eligibleSuccesses: readonly SixStepWindowEligibleSuccessV1[];
}>): SixStepWindowSelectionFactsV1 {
  assertExactKeys(input, ["finalDurableWindowId", "windowId", "eligibleSuccesses"], "sixStepWindowSelectionFacts");
  if (!Array.isArray(input.eligibleSuccesses)) throw new TypeError("Six-Step eligible successes must be an array");
  const orderedEligible = input.eligibleSuccesses.map((entry, index) => {
    assertExactKeys(entry, ["ordinal", "lane", "candidateStableKey", "producerTerminalId", "performanceEventId", "producerTerminalEventId"], `sixStepWindowSelectionFacts.eligibleSuccesses[${index}]`);
    if (entry.lane !== "blockscan" && entry.lane !== "backrun") throw new TypeError("Six-Step eligible success lane is invalid");
    return Object.freeze({
      ordinal: assertDecimalString(entry.ordinal, `sixStepWindowSelectionFacts.eligibleSuccesses[${index}].ordinal`),
      lane: entry.lane,
      candidateStableKey: assertHash(entry.candidateStableKey, `sixStepWindowSelectionFacts.eligibleSuccesses[${index}].candidateStableKey`),
      producerTerminalId: assertHash(entry.producerTerminalId, `sixStepWindowSelectionFacts.eligibleSuccesses[${index}].producerTerminalId`),
      performanceEventId: assertHash(entry.performanceEventId, `sixStepWindowSelectionFacts.eligibleSuccesses[${index}].performanceEventId`),
      producerTerminalEventId: assertHash(entry.producerTerminalEventId, `sixStepWindowSelectionFacts.eligibleSuccesses[${index}].producerTerminalEventId`),
    });
  }).sort((left, right) => {
    const ordinal = BigInt(left.ordinal) - BigInt(right.ordinal);
    if (ordinal !== 0n) return ordinal < 0n ? -1 : 1;
    if (left.lane !== right.lane) return left.lane === "blockscan" ? -1 : 1;
    const candidate = left.candidateStableKey.localeCompare(right.candidateStableKey);
    return candidate === 0 ? left.producerTerminalId.localeCompare(right.producerTerminalId) : candidate;
  });
  if (new Set(orderedEligible.map(entry => entry.producerTerminalId)).size !== orderedEligible.length) {
    throw new TypeError("Six-Step window has conflicting complete appends for one Producer terminal");
  }
  const eligibleSuccessRoot = hashDomain(
    "aloha/searcher-production-six-step-window-eligible-successes/v1",
    orderedEligible,
  );
  const selected = orderedEligible[0] ?? null;
  const payload = Object.freeze({
    finalDurableWindowId: assertHash(input.finalDurableWindowId, "sixStepWindowSelectionFacts.finalDurableWindowId"),
    windowId: assertHash(input.windowId, "sixStepWindowSelectionFacts.windowId"),
    selectionPolicyDigest: SIX_STEP_WINDOW_SELECTION_POLICY_DIGEST,
    eligibleSuccessCount: orderedEligible.length.toString(),
    eligibleSuccessRoot,
    orderedEligible,
    selectedIndex: selected === null ? null : "0",
    selectedProducerTerminalId: selected?.producerTerminalId ?? null,
  });
  return Object.freeze({
    orderedEligible: Object.freeze(orderedEligible),
    eligibleSuccessCount: payload.eligibleSuccessCount,
    eligibleSuccessRoot,
    selectedIndex: payload.selectedIndex,
    selectedProducerTerminalId: payload.selectedProducerTerminalId,
    selectionRoot: hashDomain("aloha/searcher-production-six-step-window-selection/v1", payload),
  });
}

/** Production-evidence owner only. It supplies the complete append
 * capabilities retained across the exact current-process window; this owner
 * validates their immutable release/window lineage and seals one selection. */
export function issueSearcherProductionSixStepWindowSelectionV1(input: Readonly<{
  readonly finalDurableWindow: FinalDurableWindowCapabilityV1;
  readonly completeAppends: readonly SearcherProductionSixStepCompleteAppendCapabilityV1[];
}>): SearcherProductionSixStepWindowSelectionCapabilityV1 {
  assertExactKeys(input, ["finalDurableWindow", "completeAppends"], "sixStepWindowSelection");
  const finalWindow = readFinalDurableWindowBindingV1(input.finalDurableWindow);
  if (!Array.isArray(input.completeAppends)) throw new TypeError("Six-Step window complete appends must be an array");
  if (new Set(input.completeAppends).size !== input.completeAppends.length) {
    throw new TypeError("Six-Step window complete append capability is duplicated");
  }
  const entries = input.completeAppends.map(capability => {
    const material = readSearcherProductionSixStepCompleteAppendMaterialV1(capability);
    if (!sameCanonical(material.runtimeAnchor, finalWindow.runtimeAnchor)
      || !sameCanonical(material.serving, finalWindow.serving)
      || material.canonicalHead.chainId !== finalWindow.head.chainId
      || BigInt(material.canonicalHead.number) > BigInt(finalWindow.head.number)
      || material.runtimeFacts.resource.scope.windowId !== finalWindow.windowId) {
      throw new TypeError("Six-Step complete append is outside the final durable window");
    }
    return Object.freeze({
      capability,
      ordinal: material.ordinal,
      lane: material.lane,
      candidateStableKey: material.candidateStableKey,
      producerTerminalId: material.producerTerminalId,
      performanceEventId: material.durableAppend.eventId,
      producerTerminalEventId: material.producerTerminalDurableAppend.eventId,
    });
  });
  const facts = sealSixStepWindowSelectionFactsV1({
    finalDurableWindowId: finalWindow.finalDurableWindowId,
    windowId: finalWindow.windowId,
    eligibleSuccesses: entries.map(entry => ({
    ordinal: entry.ordinal,
    lane: entry.lane,
    candidateStableKey: entry.candidateStableKey,
    producerTerminalId: entry.producerTerminalId,
    performanceEventId: entry.performanceEventId,
    producerTerminalEventId: entry.producerTerminalEventId,
    })),
  });
  const selected = facts.selectedProducerTerminalId === null
    ? null
    : entries.find(entry => entry.producerTerminalId === facts.selectedProducerTerminalId) ?? null;
  const selection: SearcherProductionSixStepWindowSelectionV1 = selected !== null
    ? Object.freeze({
        kind: "aloha.searcher-production-six-step-window-selection-v1" as const,
        status: "selected" as const,
        finalDurableWindowId: finalWindow.finalDurableWindowId,
        windowId: finalWindow.windowId,
        selectionPolicyDigest: SIX_STEP_WINDOW_SELECTION_POLICY_DIGEST,
        eligibleSuccessCount: facts.eligibleSuccessCount,
        eligibleSuccessRoot: facts.eligibleSuccessRoot,
        selectedIndex: "0" as const,
        selectedProducerTerminalId: selected.producerTerminalId,
        completeAppend: selected.capability,
        selectionRoot: facts.selectionRoot,
      })
    : Object.freeze({
        kind: "aloha.searcher-production-six-step-window-selection-v1" as const,
        status: "missing" as const,
        reason: "no-successful-dry-run" as const,
        finalDurableWindowId: finalWindow.finalDurableWindowId,
        windowId: finalWindow.windowId,
        selectionPolicyDigest: SIX_STEP_WINDOW_SELECTION_POLICY_DIGEST,
        eligibleSuccessCount: "0" as const,
        eligibleSuccessRoot: facts.eligibleSuccessRoot,
        selectedIndex: null,
        selectedProducerTerminalId: null,
        completeAppend: null,
        selectionRoot: facts.selectionRoot,
      });
  const capability = Object.freeze(Object.create(null)) as SearcherProductionSixStepWindowSelectionCapabilityV1;
  states.set(capability, selection);
  return capability;
}

export function readSearcherProductionSixStepWindowSelectionCapabilityV1(
  capability: SearcherProductionSixStepWindowSelectionCapabilityV1,
): SearcherProductionSixStepWindowSelectionV1 {
  if (capability === null || typeof capability !== "object" || Reflect.ownKeys(capability).length !== 0) {
    throw new TypeError("Six-Step window selection capability is invalid");
  }
  const selection = states.get(capability);
  if (selection === undefined) throw new TypeError("Six-Step window selection capability was not owner-issued");
  return selection;
}
