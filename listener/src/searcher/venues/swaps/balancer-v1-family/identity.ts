import { ethers } from "ethers";
import type { IdentitySemantics } from "../../adapter-family-plugin.js";
import type { CanonicalSource } from "../../adapter-request-program.js";
import { hashCanonical } from "../../canonical-value.js";
import { BONE, bool, call, FACTORY, FACTORY_ADDRESS, FACTORY_CODE_HASH, members, MODEL, nonzero, POOL, POOL_CODE_HASH, returned, uint, validateResults } from "./codec.js";
import { ID, LINEAGE } from "./manifest.js";
import type { Binding, Candidate, Identity } from "./types.js";
interface Proof {
  readonly phase: "member" | "config" | "complete"; readonly source: CanonicalSource; readonly binding: Binding;
  readonly ids: readonly string[]; readonly rejection?: string; readonly retry?: string;
}
export const identity = {
  memoReuse: "recheck-identity", identityKey: i => nonzero(i.subject),
  variants: [{ id: "factory-created-finalized-bpool", kind: "factory-child", lineageId: LINEAGE,
    applies: c => c.candidateKind === "balancer-v1-pool",
    requirements: ({ evidence }) => ({ transports: evidence ? ["eth-call"] : ["eth-call", "get-code"] }),
    buildRequests({ candidate: c, evidence }) {
      const p = evidence as Proof | undefined;
      if (!p) return [{ id: "pool-code", kind: "get-code", address: c.pool },
        { id: "factory-code", kind: "get-code", address: FACTORY_ADDRESS },
        call("registered", FACTORY_ADDRESS, FACTORY.encodeFunctionData("isBPool", [c.pool]))];
      if (p.binding.pool !== nonzero(c.pool)) throw new Error("balancer-v1 foreign identity continuation");
      if (p.rejection || p.retry || p.phase === "complete") return [];
      if (p.phase === "member") return [call("finalized", c.pool, POOL.encodeFunctionData("isFinalized")),
        call("public", c.pool, POOL.encodeFunctionData("isPublicSwap")),
        { ...call("tokens", c.pool, POOL.encodeFunctionData("getFinalTokens")), required: false },
        call("fee", c.pool, POOL.encodeFunctionData("getSwapFee"))];
      return p.binding.tokens.map((t, i) => call(`weight:${i}`, c.pool, POOL.encodeFunctionData("getDenormalizedWeight", [t])));
    },
    decode({ step, results }): Proof {
      const p = step.evidence as Proof | undefined;
      const ids = !p ? ["pool-code", "factory-code", "registered"] : p.phase === "member"
        ? ["finalized", "public", "tokens", "fee"] : p.binding.tokens.map((_, i) => `weight:${i}`);
      const source = validateResults(results, ids, p?.source), pool = nonzero(step.candidate.pool);
      if (!p) {
        const code = returned(results, "pool-code"), factoryCode = returned(results, "factory-code");
        // Missing/changed infrastructure is not a permanent pool rejection.
        if (ethers.keccak256(factoryCode) !== FACTORY_CODE_HASH) throw new Error("balancer-v1 unsupported factory code");
        const registered = bool(returned(results, "registered"));
        const rejection = code === "0x" ? "no-pool-code" : !registered ? "not-created-by-bfactory" : undefined;
        const retry = !rejection && ethers.keccak256(code) !== POOL_CODE_HASH ? "unsupported-bpool-code" : undefined;
        return { phase: "member", source, ids, ...(rejection ? { rejection } : {}), ...(retry ? { retry } : {}), binding: { pool, factory: FACTORY_ADDRESS,
          poolCodeHash: ethers.keccak256(code), factoryCodeHash: FACTORY_CODE_HASH, model: MODEL, tokens: [], weights: [], swapFee: 0n } };
      }
      if (p.binding.pool !== pool || p.rejection || p.retry || p.phase === "complete") throw new Error("balancer-v1 invalid identity continuation");
      if (p.phase === "member") {
        // These permissions can change before finalize: never terminal-reject
        // a currently private or unfinalized member as an immutable fact.
        if (!bool(returned(results, "finalized")) || !bool(returned(results, "public"))) {
          return { ...p, ids, retry: "bpool-not-finalized-public" };
        }
        const tokens = members(returned(results, "tokens")), swapFee = uint(returned(results, "fee"));
        if (tokens.some(t => t === pool || t === FACTORY_ADDRESS) || swapFee < BONE / 1_000_000n || swapFee > BONE / 10n) {
          throw new Error("balancer-v1 invalid finalized configuration");
        }
        return { ...p, phase: "config", ids, binding: { ...p.binding, tokens, swapFee } };
      }
      const weights = p.binding.tokens.map((_, i) => uint(returned(results, `weight:${i}`)));
      if (weights.some(w => w < BONE || w > 50n * BONE) || weights.reduce((a, b) => a + b, 0n) > 50n * BONE) {
        throw new Error("balancer-v1 invalid finalized weights");
      }
      return { ...p, phase: "complete", ids, binding: { ...p.binding, weights: Object.freeze(weights) } };
    },
    decide({ candidate, evidence }) {
      const p = evidence as Proof | undefined;
      if (!p) return { status: "continue" };
      if (p.binding.pool !== nonzero(candidate.pool)) return { status: "invalid-program", reasonCode: "foreign-balancer-v1-candidate" };
      if (p.rejection) return { status: "chain-proven-rejected", reasonCode: p.rejection, evidenceRequestIds: p.ids };
      if (p.retry) return { status: "retryable", reasonCode: p.retry };
      if (p.phase !== "complete") return { status: "continue" };
      // BFactory's only mapping writer is newBPool(), after CREATE. Matching
      // BPool code alone is NOT creation proof; reverse membership is required.
      return { status: "verified", identity: { familyId: ID, lineageId: LINEAGE, subject: p.binding.pool, facts: p.binding,
        provenance: [{ kind: "bfactory-create-only-registration-and-finalized-code", subject: FACTORY_ADDRESS,
          evidenceHash: hashCanonical({ binding: { ...p.binding }, source: { ...p.source } }) }] } };
    },
  }],
} satisfies IdentitySemantics<Candidate, Identity>;
