import { hashDomain, type Hash } from "../../../packages/canonical-codec/src/index.ts";
import { ASTRA_CHANGE_SELECTOR, ASTRA_CHANGE_TOPIC, ASTRA_FAMILY_ID } from "./manifest.ts";
import type { Address, AstraCandidateV1, AstraObservationV1 } from "./types.ts";

function address(value: string): Address {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(value)) throw new TypeError("Astra address must be 20 bytes");
  return `0x${value.slice(2).toLowerCase()}` as Address;
}

function word(data: string, index: number): string {
  if (!/^0x(?:[0-9a-fA-F]{64})*$/.test(data)) throw new TypeError("Astra calldata must be canonical words");
  const value = data.slice(2 + index * 64, 2 + (index + 1) * 64);
  if (value.length !== 64) throw new TypeError("Astra calldata word is missing");
  return value;
}

function wordAddress(data: string, index: number): Address {
  return address(`0x${word(data, index).slice(24)}`);
}

function wordUint(data: string, index: number): bigint {
  return BigInt(`0x${word(data, index)}`);
}

export interface AstraDiscoveryPatternV1 {
  readonly id: "astra-change-call" | "astra-change-log";
  readonly selectorOrTopic: string;
}

export const ASTRA_DISCOVERY_PATTERNS: readonly AstraDiscoveryPatternV1[] = Object.freeze([
  Object.freeze({ id: "astra-change-call", selectorOrTopic: ASTRA_CHANGE_SELECTOR }),
  Object.freeze({ id: "astra-change-log", selectorOrTopic: ASTRA_CHANGE_TOPIC }),
]);

export function decodeAstraCandidate(
  observation: AstraObservationV1,
  matchedPatternId: AstraDiscoveryPatternV1["id"],
): AstraCandidateV1 | null {
  try {
    let actor: Address;
    let tokenIn: Address;
    let tokenOut: Address;
    let amountIn: bigint;
    let observedAmountOut: bigint | null;
    let minAmountOut: bigint;
    let sourceKind: AstraCandidateV1["sourceKind"];
    if (observation.kind === "call" && matchedPatternId === "astra-change-call") {
      if (observation.dataHex === undefined || observation.dataHex.slice(0, 10).toLowerCase() !== ASTRA_CHANGE_SELECTOR) return null;
      if (observation.sender === undefined) return null;
      const calldata = observation.dataHex.slice(10);
      if (!/^([0-9a-fA-F]{64}){4}$/.test(calldata)) return null;
      actor = address(observation.sender);
      tokenIn = wordAddress(`0x${calldata}`, 0);
      tokenOut = wordAddress(`0x${calldata}`, 1);
      amountIn = wordUint(`0x${calldata}`, 2);
      minAmountOut = wordUint(`0x${calldata}`, 3);
      observedAmountOut = null;
      sourceKind = "observed-change-call";
    } else if (observation.kind === "log" && matchedPatternId === "astra-change-log") {
      if (observation.topics?.[0]?.toLowerCase() !== ASTRA_CHANGE_TOPIC.toLowerCase()) return null;
      if (observation.topics.length < 4 || observation.dataHex === undefined) return null;
      tokenIn = address(`0x${observation.topics[1]!.slice(-40)}`);
      tokenOut = address(`0x${observation.topics[2]!.slice(-40)}`);
      actor = address(`0x${observation.topics[3]!.slice(-40)}`);
      amountIn = wordUint(observation.dataHex, 0);
      observedAmountOut = wordUint(observation.dataHex, 1);
      minAmountOut = observedAmountOut;
      sourceKind = "change-log";
    } else return null;
    if (tokenIn === tokenOut || amountIn <= 0n || minAmountOut < 0n || (observedAmountOut !== null && observedAmountOut <= 0n)) return null;
    const target = address(observation.target);
    const instanceNominationKey = target;
    const snapshot = {
      familyId: ASTRA_FAMILY_ID,
      target,
      actor,
      tokenIn,
      tokenOut,
      amountIn: amountIn.toString(),
      observedAmountOut: observedAmountOut?.toString() ?? null,
      minAmountOut: minAmountOut.toString(),
      source: observation.source,
      blockNumber: observation.blockNumber,
      blockHash: observation.blockHash,
      txHash: observation.txHash,
      logIndex: observation.logIndex,
    };
    return Object.freeze({ target, actor, tokenIn, tokenOut, amountIn, minAmountOut, observedAmountOut, sourceKind, instanceNominationKey, candidateSnapshotHash: hashDomain("aloha/astra-multitoken/candidate-snapshot/v1", snapshot), source: observation.source });
  } catch {
    return null;
  }
}

export function instanceNominationKey(candidate: { readonly target: string }): string {
  return address(candidate.target);
}

export function candidateFamilyKey(candidate: Pick<AstraCandidateV1, "target" | "instanceNominationKey">): Hash {
  if (instanceNominationKey(candidate) !== candidate.instanceNominationKey) throw new TypeError("astra nomination key mismatch");
  return hashDomain("aloha/family-candidate/v1", { familyId: ASTRA_FAMILY_ID, instanceNominationKey: candidate.instanceNominationKey });
}
