import { ethers } from "ethers";
import { ADDR } from "../../../../shared/constants/addresses.js";
import type { IdentityVariant } from "../../adapter-family-plugin.js";
import { hashCanonical } from "../../canonical-value.js";
import { UNIV4_STATE_VIEW_INTERFACE } from "../univ4-abi.js";
import { assertPoolKeyIdentity, assertSameSource, canonicalAddress, canonicalPoolKey,
  poolKeyProjection, requireCodeHash, requireSuccessfulResult, sameAddress } from "../univ4-family/codec.js";
import { UNIV4_FEE_HOOK_FAMILY_ID, UNIV4_FEE_HOOK_LINEAGE_ID } from "./manifest.js";
import { SAT1, SAT1_HOOK_CODE_HASH, SAT1_TOKEN_CODE_HASH, sat1Permissions } from "./sat1.js";
import type { FeeHookCandidate, FeeHookIdentity } from "./types.js";

const getters = ["POOL_MANAGER", "SAT1_TOKEN", "GENESIS_BLOCK", "poolInitialized"] as const;
interface Proof {
  source: { number: number; hash: string; generation: number };
  managerCodeHash: string; hookCodeHash: string; tokenCodeHash: string;
  manager: string; token: string; minter: string; genesis: bigint; initialized: boolean; sqrtPriceX96: bigint;
}
export const sat1IdentityVariant: IdentityVariant<FeeHookCandidate, FeeHookIdentity> = {
  id: "sat1-code-and-poolkey-proof", kind: "singleton-subinstance", lineageId: UNIV4_FEE_HOOK_LINEAGE_ID,
  applies: candidate => sat1Permissions(candidate.poolKey.hooks),
  requirements: () => ({ transports: ["get-code", "eth-call"] }),
  buildRequests({ candidate }) {
    return [
      { id: "manager-code", kind: "get-code", address: candidate.manager },
      { id: "hook-code", kind: "get-code", address: candidate.poolKey.hooks },
      { id: "token-code", kind: "get-code", address: candidate.poolKey.currency1 },
      { id: "pool-slot0", kind: "eth-call", to: ADDR.UNISWAP_V4_STATE_VIEW,
        data: UNIV4_STATE_VIEW_INTERFACE.encodeFunctionData("getSlot0", [candidate.poolId]), completion: "return-data" },
      ...getters.map(fn => ({ id: fn, kind: "eth-call" as const, to: candidate.poolKey.hooks,
        data: SAT1.encodeFunctionData(fn), completion: "return-data" as const })),
      { id: "minter", kind: "eth-call", to: candidate.poolKey.currency1,
        data: SAT1.encodeFunctionData("minter"), completion: "return-data" },
    ];
  },
  decode({ results }) {
    const source = requireSuccessfulResult(results, "manager-code").source;
    for (const result of results) assertSameSource(source, result.source);
    const get = (fn: string) => SAT1.decodeFunctionResult(fn, requireSuccessfulResult(results, fn).data)[0];
    return { source, managerCodeHash: requireCodeHash(results, "manager-code"),
      hookCodeHash: requireCodeHash(results, "hook-code"), tokenCodeHash: requireCodeHash(results, "token-code"),
      sqrtPriceX96: BigInt(UNIV4_STATE_VIEW_INTERFACE.decodeFunctionResult("getSlot0", requireSuccessfulResult(results, "pool-slot0").data)[0]),
      manager: String(get("POOL_MANAGER")), token: String(get("SAT1_TOKEN")), minter: String(get("minter")),
      genesis: BigInt(get("GENESIS_BLOCK")), initialized: Boolean(get("poolInitialized")) } satisfies Proof;
  },
  decide({ candidate, evidence }) {
    if (!evidence) return { status: "continue" };
    const proof = evidence as Proof;
    const key = canonicalPoolKey(candidate.poolKey);
    try { assertPoolKeyIdentity(candidate.poolId, key); } catch {
      return { status: "chain-proven-rejected", reasonCode: "poolkey_reverse_binding_failed", evidenceRequestIds: [] };
    }
    if (proof.hookCodeHash !== SAT1_HOOK_CODE_HASH || proof.tokenCodeHash !== SAT1_TOKEN_CODE_HASH ||
      !sameAddress(candidate.manager, ADDR.UNISWAP_V4_POOL_MANAGER) || !sameAddress(proof.manager, candidate.manager) ||
      !sameAddress(key.currency0, ethers.ZeroAddress) || !sameAddress(proof.token, key.currency1) ||
      !sameAddress(proof.minter, key.hooks) || key.fee !== 3000) {
      return { status: "chain-proven-rejected", reasonCode: "sat1_code_or_reverse_binding_failed",
        evidenceRequestIds: ["hook-code", "token-code", ...getters, "minter"] };
    }
    // The first 100 blocks have swapper/parent-hash entropy. Do not represent
    // their actor-dependent price by the post-launch deterministic raw model.
    if (!proof.initialized || proof.sqrtPriceX96 <= 0n || BigInt(proof.source.number) < proof.genesis + 100n) {
      return { status: "retryable", reasonCode: "sat1_not_initialized_or_entropy_window" };
    }
    const manager = canonicalAddress(candidate.manager), poolId = candidate.poolId.toLowerCase();
    return { status: "verified", identity: {
      subject: manager.toLowerCase() + "\u001f" + poolId,
      familyId: UNIV4_FEE_HOOK_FAMILY_ID, lineageId: UNIV4_FEE_HOOK_LINEAGE_ID,
      provenance: [{ kind: "sat1-code-and-poolkey-proof", subject: key.hooks,
        evidenceHash: hashCanonical({ ...proof, source: { ...proof.source }, poolKey: poolKeyProjection(key) }) }],
      facts: { poolId, poolKey: key, hookCodeHash: proof.hookCodeHash, hookModel: "sat1",
        managerBinding: { manager, stateView: canonicalAddress(ADDR.UNISWAP_V4_STATE_VIEW),
          quoter: canonicalAddress(ADDR.UNISWAP_V4_QUOTER), managerCodeHash: proof.managerCodeHash } },
    } };
  },
};
