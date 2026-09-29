import { ethers } from "ethers";
import type { IdentityDecision, IdentitySemantics } from "../../adapter-family-plugin.js";
import type { CanonicalSource } from "../../adapter-request-program.js";
import { hashCanonical } from "../../canonical-value.js";
import { EKUBO_CORE, EKUBO_ROUTER, encodeEkuboQuote } from "../ekubo/abi.js";
import { ekuboPoolId, ekuboPoolExtension } from "../ekubo/pool-key.js";
import { extensionRegistrationSlot, validateExtensionProof, EKUBO_SUPPORTED_CORE_HASH, EKUBO_SUPPORTED_ROUTER_HASH } from "./extension.js";
import { ERC20, call, decimals, decodeQuote, decodeSizingProbe, returned, validateResults, supportedKey } from "./codec.js";
import { EKUBO_FAMILY_ID, EKUBO_LINEAGE } from "./manifest.js";
import type { EkuboBinding, EkuboCandidate, EkuboIdentity } from "./types.js";

interface Evidence {
  readonly phase: "structure" | "quotes";
  readonly source: CanonicalSource;
  readonly binding: EkuboBinding;
  readonly probeAmounts: readonly [bigint, bigint];
  readonly quoteRounds: number;
  readonly proof: readonly { readonly isToken1: boolean; readonly amountIn: bigint; readonly amountOut: bigint; readonly stateAfter: string }[];
  readonly rejection?: string;
  readonly unavailable?: string;
}
function assertCandidate(candidate: EkuboCandidate, prior?: Evidence): void {
  const key = supportedKey(candidate.poolKey);
  if (candidate.candidateKind !== "ekubo-pool-key" || ekuboPoolId(key) !== candidate.poolId ||
      (prior && candidate.poolId !== prior.binding.poolId)) throw new Error("ekubo inconsistent pool identity");
}
function structureRequests(candidate: EkuboCandidate) {
  const extension = ekuboPoolExtension(candidate.poolKey.config);
  return [
    { id: "core-code", kind: "get-code" as const, address: EKUBO_CORE },
    { id: "router-code", kind: "get-code" as const, address: EKUBO_ROUTER },
    ...([candidate.poolKey.token0, candidate.poolKey.token1].flatMap((token, i) => token === ethers.ZeroAddress ? [] :
      [call(`decimals:${i}`, ERC20.encodeFunctionData("decimals"), token)])),
    ...(extension === ethers.ZeroAddress ? [] : [
      { id: "extension-code", kind: "get-code" as const, address: extension },
      { id: "extension-registration", kind: "get-storage" as const, address: EKUBO_CORE, slot: extensionRegistrationSlot(extension) },
    ]),
  ];
}
export const ekuboIdentity = {
  variants: [{
    id: "vanilla-core-key-active-quote", kind: "singleton-subinstance", lineageId: EKUBO_LINEAGE,
    applies(candidate) { try { assertCandidate(candidate); return true; } catch { return false; } },
    requirements: ({ candidate, evidence }) => ({ transports: evidence === undefined ?
      (ekuboPoolExtension(candidate.poolKey.config) === ethers.ZeroAddress ? ["get-code", "eth-call"] : ["get-code", "eth-call", "get-storage"]) : ["eth-call"] }),
    buildRequests({ candidate, evidence }) {
      const prior = evidence as Evidence | undefined;
      assertCandidate(candidate, prior);
      if (!prior) return structureRequests(candidate);
      if (prior.rejection || (!prior.unavailable && prior.proof.length === 4) || prior.quoteRounds >= 2) return [];
      return [false, true].flatMap(isToken1 => [1n, 2n].map(multiplier => call(`quote:${Number(isToken1)}:${multiplier}`,
        encodeEkuboQuote(candidate.poolKey, isToken1, multiplier * prior.probeAmounts[Number(isToken1)]))));
    },
    decode({ step, results }) {
      const prior = step.evidence as Evidence | undefined;
      assertCandidate(step.candidate, prior);
      if (!prior) {
        const source = validateResults(results, structureRequests(step.candidate).map(r => r.id));
        const coreCode = returned(results, "core-code").data, routerCode = returned(results, "router-code").data;
        if (!ethers.isHexString(coreCode) || !ethers.isHexString(routerCode)) throw new Error("ekubo invalid code evidence");
        const key = supportedKey(step.candidate.poolKey);
        const coreCodeHash = ethers.keccak256(coreCode), routerCodeHash = ethers.keccak256(routerCode);
        let extensionCodeHash: string | undefined, rejection: string | undefined;
        if (key.token0 === ethers.ZeroAddress && (coreCodeHash !== EKUBO_SUPPORTED_CORE_HASH || routerCodeHash !== EKUBO_SUPPORTED_ROUTER_HASH)) {
          rejection = "unsupported-native-core-router-behavior";
        }
        if (ekuboPoolExtension(key.config) !== ethers.ZeroAddress) {
          const code = returned(results, "extension-code").data, registration = returned(results, "extension-registration").data;
          try { extensionCodeHash = validateExtensionProof(coreCodeHash, routerCodeHash, code, registration); }
          catch { rejection = "unsupported-or-unregistered-extension-behavior"; }
        }
        const binding: EkuboBinding = { poolId: step.candidate.poolId, poolKey: key,
          coreCodeHash: ethers.keccak256(coreCode), routerCodeHash: ethers.keccak256(routerCode),
          ...(extensionCodeHash === undefined ? {} : { extensionCodeHash }),
          decimals: [key.token0 === ethers.ZeroAddress ? 18 : decimals(returned(results, "decimals:0").data), decimals(returned(results, "decimals:1").data)] };
        return { phase: "structure", source, binding, proof: [], quoteRounds: 0,
          probeAmounts: [10n ** BigInt(binding.decimals[0]), 10n ** BigInt(binding.decimals[1])],
          ...(rejection ? { rejection } : coreCode === "0x" || routerCode === "0x" ? { rejection: "no-core-or-router-code" } : {}) } satisfies Evidence;
      }
      if ((!prior.unavailable && prior.proof.length === 4) || prior.quoteRounds >= 2) throw new Error("ekubo identity already completed");
      validateResults(results, ["quote:0:1", "quote:0:2", "quote:1:1", "quote:1:2"], prior.source);
      const proof: Evidence["proof"][number][] = [];
      const hints = new Map<boolean, bigint>();
      for (const isToken1 of [false, true]) for (const multiplier of [1n, 2n]) {
        const id = `quote:${Number(isToken1)}:${multiplier}`;
        const result = results.find(r => r.id === id)!;
        if (!result.ok) throw new Error(`ekubo unresolved ${id}: ${result.failure}`);
        const amountIn = multiplier * prior.probeAmounts[Number(isToken1)];
        if (result.completion !== "returned") continue;
        try {
          const hint = decodeSizingProbe(result.data, isToken1, amountIn).filledAmountIn;
          const previous = hints.get(isToken1);
          if (previous === undefined || hint < previous) hints.set(isToken1, hint);
        } catch { /* No usable sizing hint. */ }
        try { proof.push({ isToken1, amountIn, ...decodeQuote(result.data, isToken1, amountIn) }); }
        catch { /* Partial fills, dust and absent liquidity are not terminal identity rejection. */ }
      }
      const complete = proof.length === 4 && proof[1].amountOut > proof[0].amountOut && proof[3].amountOut > proof[2].amountOut;
      const nextAmount = (isToken1: boolean): bigint => {
        const directed = proof.filter(p => p.isToken1 === isToken1);
        if (directed.length === 2 && directed[1].amountOut > directed[0].amountOut) return prior.probeAmounts[Number(isToken1)];
        const hint = hints.get(isToken1) ?? prior.probeAmounts[Number(isToken1)];
        return hint / 100n > 0n ? hint / 100n : 1n;
      };
      const { unavailable: _previousUnavailable, ...retained } = prior;
      return { ...retained, phase: "quotes", proof, quoteRounds: prior.quoteRounds + 1,
        probeAmounts: [nextAmount(false), nextAmount(true)],
        ...(!complete ? { unavailable: "no-positive-full-fill-bidirectional-proof" } : {}) } satisfies Evidence;
    },
    decide({ candidate, evidence }): IdentityDecision<EkuboIdentity> {
      const prior = evidence as Evidence | undefined;
      try { assertCandidate(candidate, prior); } catch { return { status: "invalid-program", reasonCode: "unsupported-or-inconsistent-pool-key" }; }
      if (!prior) return { status: "continue" };
      if (prior.rejection) return { status: "chain-proven-rejected", reasonCode: prior.rejection,
        evidenceRequestIds: structureRequests(candidate).filter(r => r.kind === "get-code" || r.kind === "get-storage").map(r => r.id) };
      if (prior.unavailable) return prior.quoteRounds < 2 ? { status: "continue" } : { status: "retryable", reasonCode: prior.unavailable };
      if (prior.phase === "structure") return { status: "continue" };
      return { status: "verified", identity: { familyId: EKUBO_FAMILY_ID, lineageId: EKUBO_LINEAGE,
        subject: candidate.poolId, facts: prior.binding,
        provenance: [{ kind: "source-pinned-core-key-and-router-full-fill", subject: EKUBO_CORE,
          evidenceHash: hashCanonical({ binding: { ...prior.binding, poolKey: { ...prior.binding.poolKey }, decimals: [...prior.binding.decimals] },
            source: { ...prior.source }, proof: prior.proof.map(p => ({ ...p })) }) }] } };
    },
  }],
  identityKey: identity => identity.subject,
} satisfies IdentitySemantics<EkuboCandidate, EkuboIdentity>;
