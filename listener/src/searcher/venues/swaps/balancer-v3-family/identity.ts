import { ethers } from "ethers";
import type { IdentityDecision, IdentitySemantics } from "../../adapter-family-plugin.js";
import type { CanonicalSource } from "../../adapter-request-program.js";
import { hashCanonical } from "../../canonical-value.js";
import { VAULT, ROUTER, PERMIT2, ROUTER_ABI, VAULT_ABI, POOL_ABI, TOKEN_ABI, addressWord, bool, call, lower,
  nonzero, hooksConfig, hasSwapHooks, UNSUPPORTED_SWAP_HOOK, poolInfo, resultSource, returned, same, assertSource, uint } from "./codec.js";
import { BALANCER_V3_FAMILY_ID, BALANCER_V3_LINEAGE } from "./manifest.js";
import type { BalancerV3Binding, BalancerV3Candidate, BalancerV3Identity } from "./types.js";

interface Evidence {
  readonly phase: "membership" | "tokens" | "complete";
  readonly pool: string;
  readonly source: CanonicalSource;
  readonly binding: BalancerV3Binding;
  readonly proofHashes: readonly string[];
  readonly requestIds: readonly string[];
  readonly rejection?: string;
}
export const balancerV3Identity: IdentitySemantics<BalancerV3Candidate, BalancerV3Identity> = {
  variants: [{
    id: "vault-registered-pool", kind: "registry-member", lineageId: BALANCER_V3_LINEAGE,
    applies: candidate => candidate.candidateKind === "balancer-v3-pool",
    requirements: ({ evidence }) => {
      const prior = evidence as Evidence | undefined;
      return { transports: !prior || (prior.phase === "tokens" && prior.binding.hooks.address !== ethers.ZeroAddress)
        ? ["eth-call", "get-code"] : ["eth-call"] };
    },
    buildRequests({ candidate, evidence }) {
      const prior = evidence as Evidence | undefined;
      const pool = nonzero(candidate.pool);
      if (!prior) return [
        { id: "pool-code", kind: "get-code", address: pool },
        { id: "vault-code", kind: "get-code", address: VAULT },
        { id: "router-code", kind: "get-code", address: ROUTER },
        { id: "permit2-code", kind: "get-code", address: PERMIT2 },
        call("router-permit2", ROUTER, ROUTER_ABI.encodeFunctionData("getPermit2")),
        call("pool-vault", pool, POOL_ABI.encodeFunctionData("getVault")),
        call("registered", VAULT, VAULT_ABI.encodeFunctionData("isPoolRegistered", [pool])),
      ];
      if (!same(prior.pool, pool)) throw new Error("balancer-v3 foreign identity evidence");
      if (prior.rejection) return [];
      if (prior.phase === "membership") return [
        call("tokens", VAULT, VAULT_ABI.encodeFunctionData("getPoolTokenInfo", [pool])),
        call("hooks", VAULT, VAULT_ABI.encodeFunctionData("getHooksConfig", [pool])),
      ];
      if (prior.phase === "tokens") return [
        ...prior.binding.tokens.map((token, i) => call(`decimals:${i}`, token, TOKEN_ABI.encodeFunctionData("decimals"))),
        ...(prior.binding.hooks.address === ethers.ZeroAddress ? [] : [
          { id: "hook-code", kind: "get-code" as const, address: prior.binding.hooks.address },
        ]),
      ];
      return [];
    },
    decode({ step, results }): Evidence {
      const prior = step.evidence as Evidence | undefined;
      const source = resultSource(results);
      if (prior) assertSource(source, prior.source);
      const pool = nonzero(step.candidate.pool);
      if (prior && !same(prior.pool, pool)) throw new Error("balancer-v3 foreign identity evidence");
      const requestIds = results.map(read => read.id);
      const proof = hashCanonical({ source: { ...source }, reads: results.map(read => {
        if (!read.ok) throw new Error(`balancer-v3 unresolved identity ${read.id}`);
        return { id: read.id, completion: read.completion, data: read.data };
      }) });
      if (!prior) {
        const codes = ["pool-code", "vault-code", "router-code", "permit2-code"].map(id => {
          const code = returned(results, id).data;
          if (!ethers.isHexString(code) || code.length % 2 !== 0) throw new Error("balancer-v3 malformed code");
          return code;
        });
        // Absence of trusted infrastructure is not a terminal pool rejection.
        if (codes.slice(1).some(code => code === "0x") ||
            !same(addressWord(returned(results, "router-permit2").data), PERMIT2)) {
          throw new Error("balancer-v3 infrastructure unavailable or foreign Permit2");
        }
        let rejection: string | undefined;
        if (codes[0] === "0x") rejection = "no-pool-code";
        else if (!bool(returned(results, "registered").data)) rejection = "no-vault-membership";
        else if (!same(addressWord(returned(results, "pool-vault").data), VAULT)) rejection = "foreign-vault";
        return { phase: "membership", source, pool, requestIds, proofHashes: [proof],
          binding: { vault: VAULT, router: ROUTER, permit2: PERMIT2, poolCodeHash: ethers.keccak256(codes[0]),
            vaultCodeHash: ethers.keccak256(codes[1]), routerCodeHash: ethers.keccak256(codes[2]),
            permit2CodeHash: ethers.keccak256(codes[3]),
            tokens: [], tokenInfo: [], decimals: [], hooks: { address: ethers.ZeroAddress, flags: [], codeHash: ethers.keccak256("0x") } },
          ...(rejection ? { rejection } : {}) };
      }
      if (prior.phase === "membership") {
        const info = poolInfo(returned(results, "tokens").data);
        const hints = [step.candidate.hintedTokenIn, step.candidate.hintedTokenOut];
        if (hints.some(hint => hint !== null && !info.tokens.some(token => same(token, hint))) ||
            (hints[0] !== null && hints[1] !== null && same(hints[0], hints[1]))) {
          throw new Error("balancer-v3 observed tokens do not belong to pool");
        }
        return { ...prior, phase: "tokens", requestIds, proofHashes: [...prior.proofHashes, proof],
          binding: { ...prior.binding, tokens: info.tokens, tokenInfo: info.tokenInfo,
            hooks: { ...hooksConfig(returned(results, "hooks").data), codeHash: ethers.keccak256("0x") } } };
      }
      if (prior.phase !== "tokens") throw new Error("balancer-v3 identity already completed");
      const decimals = prior.binding.tokens.map((_, i) => Number(uint(returned(results, `decimals:${i}`).data)));
      if (decimals.some(d => !Number.isInteger(d) || d < 0 || d > 36)) throw new Error("balancer-v3 unsupported token scale");
      const hookCode = prior.binding.hooks.address === ethers.ZeroAddress ? "0x" : returned(results, "hook-code").data;
      if (!ethers.isHexString(hookCode) || hookCode.length % 2 !== 0 ||
          (prior.binding.hooks.address !== ethers.ZeroAddress && hookCode === "0x")) throw new Error("balancer-v3 hook code unavailable");
      return { ...prior, phase: "complete", requestIds, proofHashes: [...prior.proofHashes, proof],
        binding: { ...prior.binding, decimals, hooks: { ...prior.binding.hooks, codeHash: ethers.keccak256(hookCode) } } };
    },
    decide({ candidate, evidence }): IdentityDecision<BalancerV3Identity> {
      const prior = evidence as Evidence | undefined;
      if (!prior) return { status: "continue" };
      if (!same(prior.pool, candidate.pool)) throw new Error("balancer-v3 foreign identity evidence");
      if (prior.rejection) return { status: "chain-proven-rejected", reasonCode: prior.rejection, evidenceRequestIds: prior.requestIds };
      // This is missing execution semantics, not proof that the pool is absent.
      if (prior.phase !== "membership" && hasSwapHooks(prior.binding.hooks)) return { status: "retryable", reasonCode: UNSUPPORTED_SWAP_HOOK };
      if (prior.phase !== "complete") return { status: "continue" };
      return { status: "verified", identity: { familyId: BALANCER_V3_FAMILY_ID, lineageId: BALANCER_V3_LINEAGE,
        subject: prior.pool, facts: { pool: prior.pool, binding: prior.binding, proofSource: prior.source },
        provenance: [{ kind: "source-pinned-vault-membership", subject: VAULT,
          evidenceHash: hashCanonical({ pool: prior.pool, source: { ...prior.source }, proofHashes: [...prior.proofHashes] }) }] } };
    },
  }],
  identityKey: identity => lower(identity.subject),
};
