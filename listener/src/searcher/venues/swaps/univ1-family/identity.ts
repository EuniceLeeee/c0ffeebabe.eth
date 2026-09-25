import { ethers } from "ethers";
import type { IdentitySemantics } from "../../adapter-family-plugin.js";
import type { CanonicalSource } from "../../adapter-request-program.js";
import { hashCanonical } from "../../canonical-value.js";
import { address, call, cloneImplementation, FACTORY, IMPLEMENTATION, lower, MODEL, POOL, poolAddress, returned, TOKEN, uint, validateResults, WETH } from "./codec.js";
import { ID, LINEAGE } from "./manifest.js";
import type { Binding, Candidate, Identity } from "./types.js";
interface Proof { phase: "base" | "complete"; source: CanonicalSource; binding: Binding; rejection?: string; ids: readonly string[] }
export const identity = {
  memoReuse: "recheck-identity", identityKey: i => lower(i.subject),
  variants: [{ id: "immutable-vyper-clone-factory-registration", kind: "standalone-contract", lineageId: LINEAGE,
    applies: c => c.candidateKind === "univ1-exchange",
    requirements: () => ({ transports: ["eth-call", "get-code"] }),
    buildRequests({ candidate: c, evidence }) {
      const p = evidence as Proof | undefined;
      if (!p) return [{ id: "code", kind: "get-code", address: c.pool },
        call("token", c.pool, POOL.encodeFunctionData("tokenAddress")),
        call("factory", c.pool, POOL.encodeFunctionData("factoryAddress")), call("issuer", c.pool, POOL.encodeFunctionData("issuer"))];
      if (p.rejection || p.phase === "complete") return [];
      return [{ id: "implementation-code", kind: "get-code", address: p.binding.implementation },
        { id: "factory-code", kind: "get-code", address: p.binding.factory },
        { id: "token-code", kind: "get-code", address: p.binding.token },
        call("exchange", p.binding.factory, FACTORY.encodeFunctionData("getExchange", [p.binding.token])),
        call("reverse-token", p.binding.factory, FACTORY.encodeFunctionData("getToken", [c.pool])),
        call("decimals", p.binding.token, TOKEN.encodeFunctionData("decimals"))];
    },
    decode({ step, results }): Proof {
      const p = step.evidence as Proof | undefined;
      const ids = p ? ["implementation-code", "factory-code", "token-code", "exchange", "reverse-token", "decimals"] : ["code", "token", "factory", "issuer"];
      const source = validateResults(results, ids, p?.source);
      if (!p) {
        const code = returned(results, "code"), implementation = cloneImplementation(code);
        const token = poolAddress(returned(results, "token")), factory = poolAddress(returned(results, "factory")), issuer = poolAddress(returned(results, "issuer"));
        const pool = lower(step.candidate.pool);
        const rejection = implementation !== IMPLEMENTATION ? "unsupported-univ1-implementation" :
          [token, factory, issuer].includes(ethers.ZeroAddress) || token === WETH || [token, factory, issuer].includes(pool) || issuer === token
            ? "invalid-univ1-binding" : undefined;
        return { phase: "base", source, ids, ...(rejection ? { rejection } : {}), binding: { pool, token, factory, issuer,
          implementation: implementation ?? ethers.ZeroAddress, codeHash: ethers.keccak256(code), implementationCodeHash: "", factoryCodeHash: "", decimals: 0, model: MODEL } };
      }
      if (p.phase !== "base" || p.rejection || p.binding.pool !== lower(step.candidate.pool)) throw new Error("univ1 invalid identity continuation");
      const impl = returned(results, "implementation-code"), factory = returned(results, "factory-code"), token = returned(results, "token-code");
      const decimals = uint(returned(results, "decimals"));
      const rejection = impl === "0x" || factory === "0x" || token === "0x" ? "missing-univ1-code" :
        address(returned(results, "exchange")) !== p.binding.pool || address(returned(results, "reverse-token")) !== p.binding.token
          ? "univ1-factory-registration-mismatch" : decimals > 36n ? "unsupported-token-decimals" : undefined;
      return { ...p, phase: "complete", ids, ...(rejection ? { rejection } : {}), binding: { ...p.binding,
        decimals: Number(decimals), implementationCodeHash: ethers.keccak256(impl), factoryCodeHash: ethers.keccak256(factory) } };
    },
    decide({ candidate, evidence }) {
      const p = evidence as Proof | undefined;
      if (!p) return { status: "continue" };
      if (p.binding.pool !== lower(candidate.pool)) return { status: "invalid-program", reasonCode: "foreign-univ1-candidate" };
      if (p.rejection) return { status: "chain-proven-rejected", reasonCode: p.rejection, evidenceRequestIds: p.ids };
      if (p.phase !== "complete") return { status: "continue" };
      return { status: "verified", identity: { familyId: ID, lineageId: LINEAGE, subject: p.binding.pool, facts: p.binding,
        provenance: [{ kind: "immutable-vyper-implementation-and-bidirectional-factory-registration", subject: p.binding.factory,
          evidenceHash: hashCanonical({ binding: { ...p.binding }, source: { ...p.source } }) }] } };
    },
  }],
} satisfies IdentitySemantics<Candidate, Identity>;
