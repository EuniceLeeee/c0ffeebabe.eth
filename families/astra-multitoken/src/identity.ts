import { hashDomain, type Hash } from "../../../packages/canonical-codec/src/index.ts";
import { ASTRA_FAMILY_ID } from "./manifest.ts";
import { instanceNominationKey } from "./discovery.ts";
import type { Address, AstraCandidateV1, AstraIdentityReadsV1, AstraIdentityV1 } from "./types.ts";

export type AstraIdentityOutcomeV1 =
  | { readonly status: "verified"; readonly identity: AstraIdentityV1 }
  | { readonly status: "chain-proven-rejected"; readonly reasonCode: string };

function sameSource(left: AstraIdentityReadsV1["source"], right: AstraCandidateV1["source"]): boolean {
  return left.chainId === right.chainId && left.number === right.number && left.hash === right.hash && left.stateRoot === right.stateRoot;
}

function address(value: string, path: string): Address {
  if (!/^0x[0-9a-fA-F]{40}$/.test(value)) throw new TypeError(`invalid Astra address at ${path}`);
  return `0x${value.slice(2).toLowerCase()}` as Address;
}

export function verifyAstraIdentity(input: { readonly candidate: AstraCandidateV1; readonly reads: AstraIdentityReadsV1 }): AstraIdentityOutcomeV1 {
  const { candidate, reads } = input;
  const target = address(reads.target, "reads.target");
  const candidateTarget = address(candidate.target, "candidate.target");
  const actor = address(candidate.actor, "candidate.actor");
  if (instanceNominationKey(candidate) !== candidate.instanceNominationKey) throw new TypeError("astra candidate nomination key mismatch");
  if (target !== candidateTarget || !sameSource(reads.source, candidate.source)) throw new TypeError("astra identity source/target mismatch");
  if (!reads.changesEnabled) return Object.freeze({ status: "chain-proven-rejected", reasonCode: "changes-disabled" });
  const tokens = reads.tokens.map((token, index) => address(token, `reads.tokens[${index}]`));
  const candidateTokenIn = address(candidate.tokenIn, "candidate.tokenIn");
  const candidateTokenOut = address(candidate.tokenOut, "candidate.tokenOut");
  if (tokens.length < 2 || tokens.length > 32 || new Set(tokens).size !== tokens.length || candidateTokenIn === candidateTokenOut || !tokens.includes(candidateTokenIn) || !tokens.includes(candidateTokenOut)) return Object.freeze({ status: "chain-proven-rejected", reasonCode: "invalid-token-registry" });
  if (reads.tokenCodeHashes.length !== reads.tokens.length || reads.weights.length !== reads.tokens.length) throw new TypeError("astra registry partition mismatch");
  if (tokens.some(token => token === "0x0000000000000000000000000000000000000000")) return Object.freeze({ status: "chain-proven-rejected", reasonCode: "zero-token" });
  if (reads.totalPercents <= 0n || reads.changeFee < 0n || reads.changeFee > reads.totalPercents || reads.activeQuote <= 0n) return Object.freeze({ status: "chain-proven-rejected", reasonCode: "inactive-behavior" });
  if (reads.weights.some(weight => weight <= 0n) || reads.tokenCodeHashes.some(hash => !/^0x[0-9a-f]{64}$/.test(hash))) throw new TypeError("astra registry fact malformed");
  const facts = { familyId: ASTRA_FAMILY_ID, actor, target, tokens, tokenCodeHashes: reads.tokenCodeHashes, weights: reads.weights.map(value => value.toString()), changesEnabled: true, totalPercents: reads.totalPercents.toString(), changeFee: reads.changeFee.toString(), inLendingMode: reads.inLendingMode?.toString() ?? null, activeQuote: reads.activeQuote.toString(), source: reads.source };
  const factsHash = hashDomain("aloha/astra-multitoken/identity-facts/v1", facts);
  return Object.freeze({ status: "verified", identity: Object.freeze({ ...reads, actor, target, tokens: Object.freeze(tokens), changesEnabled: true as const, factsHash, instanceKey: target }) });
}
