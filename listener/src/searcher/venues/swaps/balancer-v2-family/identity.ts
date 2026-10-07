import { ethers } from "ethers";
import type { IdentitySemantics } from "../../adapter-family-plugin.js";
import type { CanonicalSource } from "../../adapter-request-program.js";
import { hashCanonical } from "../../canonical-value.js";
import { VAULT, VAULT_ABI, POOL_ABI, TOKEN_ABI, poolIdentity, poolInfo, call, decodeReturn, returned, resultSet, same, uint } from "./codec.js";
import { BALANCER_V2_FAMILY_ID, BALANCER_V2_LINEAGE } from "./manifest.js";
import type { BalancerV2Binding, BalancerV2Candidate, BalancerV2Identity } from "./types.js";
interface Evidence {
  readonly phase: "membership" | "complete"; readonly pool: string; readonly poolId: string;
  readonly source: CanonicalSource; readonly binding: BalancerV2Binding; readonly proofHashes: readonly string[];
  readonly requestIds: readonly string[]; readonly rejection?: string;
}
export const identity: IdentitySemantics<BalancerV2Candidate, BalancerV2Identity> = {
  memoReuse: "recheck-identity", identityKey: value => value.facts.poolId,
  variants: [{
    id: "vault-registered-pool", kind: "registry-member", lineageId: BALANCER_V2_LINEAGE,
    applies: c => c.candidateKind === "balancer-v2-pool",
    requirements: ({ evidence }) => ({ transports: evidence ? ["eth-call"] : ["eth-call", "get-code"] }),
    buildRequests({ candidate, evidence }) {
      const id = poolIdentity(candidate.poolId), prior = evidence as Evidence | undefined;
      if (!same(candidate.pool, id.pool)) throw new Error("balancer-v2 candidate pool/id mismatch");
      if (!prior) return [
        { id: "pool-code", kind: "get-code", address: id.pool }, { id: "vault-code", kind: "get-code", address: VAULT },
        call("pool-vault", id.pool, POOL_ABI.encodeFunctionData("getVault")),
        call("pool-id", id.pool, POOL_ABI.encodeFunctionData("getPoolId")),
        call("membership", VAULT, VAULT_ABI.encodeFunctionData("getPool", [id.poolId])),
        call("tokens", VAULT, VAULT_ABI.encodeFunctionData("getPoolTokens", [id.poolId])),
      ];
      if (prior.poolId !== id.poolId) throw new Error("balancer-v2 foreign identity evidence");
      return prior.phase === "membership" && !prior.rejection
        ? prior.binding.tokens.map((t, i) => call("decimals:" + i, t, TOKEN_ABI.encodeFunctionData("decimals"))) : [];
    },
    decode({ step, results }): Evidence {
      const prior = step.evidence as Evidence | undefined, id = poolIdentity(step.candidate.poolId);
      if (!same(step.candidate.pool, id.pool) || (prior && prior.poolId !== id.poolId)) throw new Error("balancer-v2 foreign identity");
      const ids = prior ? prior.binding.tokens.map((_, i) => "decimals:" + i)
        : ["pool-code", "vault-code", "pool-vault", "pool-id", "membership", "tokens"];
      const source = resultSet(results, ids, prior?.source);
      const proof = hashCanonical({ source: { ...source }, reads: results.map(r => {
        if (!r.ok) throw new Error("balancer-v2 unresolved identity read");
        return { id: r.id, completion: r.completion, data: r.data };
      }) });
      if (!prior) {
        const poolCode = returned(results, "pool-code").data, vaultCode = returned(results, "vault-code").data;
        if (!ethers.isHexString(poolCode, true) || !ethers.isHexString(vaultCode, true) || vaultCode === "0x") throw new Error("balancer-v2 infrastructure unavailable");
        if (poolCode === "0x") return { phase: "membership", ...id, source, requestIds: ids, proofHashes: [proof],
          binding: { vault: VAULT, specialization: id.specialization, poolCodeHash: ethers.keccak256(poolCode),
            vaultCodeHash: ethers.keccak256(vaultCode), tokens: [], decimals: [] }, rejection: "no-pool-code" };
        const member = decodeReturn("getPool", returned(results, "membership").data);
        const info = poolInfo(returned(results, "tokens").data), tokens = info.tokens;
        if (info.lastChangeBlock > BigInt(source.number)) throw new Error("balancer-v2 future token state");
        let rejection: string | undefined;
        if (!same(String(member[0]), id.pool) || Number(member[1]) !== id.specialization) rejection = "no-vault-membership";
        else if (!same(String(decodeReturn("getVault", returned(results, "pool-vault").data, POOL_ABI)[0]), VAULT) ||
            String(decodeReturn("getPoolId", returned(results, "pool-id").data, POOL_ABI)[0]).toLowerCase() !== id.poolId) rejection = "foreign-pool-binding";
        else if (id.specialization === 2 && tokens.length !== 2) rejection = "invalid-two-token-specialization";
        if ([step.candidate.hintedTokenIn, step.candidate.hintedTokenOut].some(t => t !== null && !tokens.some(p => same(p, t)))) {
          throw new Error("balancer-v2 observed token is not registered");
        }
        return { phase: "membership", ...id, source, requestIds: ids, proofHashes: [proof],
          binding: { vault: VAULT, specialization: id.specialization, poolCodeHash: ethers.keccak256(poolCode),
            vaultCodeHash: ethers.keccak256(vaultCode), tokens, decimals: [] }, ...(rejection ? { rejection } : {}) };
      }
      if (prior.phase !== "membership") throw new Error("balancer-v2 identity already complete");
      const decimals = ids.map(key => Number(uint(returned(results, key).data)));
      if (decimals.some(d => !Number.isInteger(d) || d < 0 || d > 36)) throw new Error("balancer-v2 unsupported token scale");
      return { ...prior, phase: "complete", source, requestIds: ids, proofHashes: [...prior.proofHashes, proof],
        binding: { ...prior.binding, decimals } };
    },
    decide({ candidate, evidence }) {
      const prior = evidence as Evidence | undefined;
      if (!prior) return { status: "continue" };
      if (poolIdentity(candidate.poolId).poolId !== prior.poolId || !same(candidate.pool, prior.pool)) throw new Error("balancer-v2 foreign identity");
      if (prior.rejection) return { status: "chain-proven-rejected", reasonCode: prior.rejection, evidenceRequestIds: prior.requestIds };
      if (prior.phase !== "complete") return { status: "continue" };
      return { status: "verified", identity: { familyId: BALANCER_V2_FAMILY_ID, lineageId: BALANCER_V2_LINEAGE, subject: prior.pool,
        facts: { pool: prior.pool, poolId: prior.poolId, binding: prior.binding, proofSource: prior.source },
        provenance: [{ kind: "source-pinned-vault-pool-registration", subject: VAULT,
          evidenceHash: hashCanonical({ poolId: prior.poolId, source: { ...prior.source }, proofs: [...prior.proofHashes] }) }] } };
    },
  }],
};
