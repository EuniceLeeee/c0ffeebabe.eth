import { ethers } from "ethers";
import type { IdentitySemantics } from "../../adapter-family-plugin.js";
import type { CanonicalSource } from "../../adapter-request-program.js";
import { hashCanonical } from "../../canonical-value.js";
import { address, call, cloneImplementation, FACTORY, implementationModel, lower, MODEL, POOL, poolAddress, returned, TOKEN, uint, validateResults, WETH, type Model } from "./codec.js";
import { ID, LINEAGE } from "./manifest.js";
import type { Binding, Candidate, Identity } from "./types.js";
interface Proof {
  phase: "clone" | "implementation" | "binding" | "complete";
  source: CanonicalSource; pool: string; implementation: string; codeHash: string;
  implementationCodeHash?: string; model?: Model; binding?: Binding; rejection?: string; ids: readonly string[];
}
export const identity = {
  memoReuse: "recheck-identity", identityKey: i => lower(i.subject),
  variants: [{ id: "immutable-vyper-clone-factory-registration", kind: "standalone-contract", lineageId: LINEAGE,
    applies: c => c.candidateKind === "univ1-exchange",
    requirements: ({ evidence }) => {
      const p = evidence as Proof | undefined;
      return { transports: p?.rejection || p?.phase === "complete" ? []
        : !p || p.phase === "clone" ? ["get-code"]
        : p.phase === "implementation" ? ["eth-call"] : ["eth-call", "get-code"] };
    },
    buildRequests({ candidate: c, evidence }) {
      const p = evidence as Proof | undefined;
      // Classify bytecode before protocol getters. Canonical V1 has no issuer():
      // its old Vyper proxy traps that call with InvalidJump.
      if (!p) return [{ id: "code", kind: "get-code", address: c.pool }];
      if (p.rejection || p.phase === "complete") return [];
      if (p.phase === "clone") return [{ id: "implementation-code", kind: "get-code", address: p.implementation }];
      if (p.phase === "implementation") return [call("token", c.pool, POOL.encodeFunctionData("tokenAddress")),
        call("factory", c.pool, POOL.encodeFunctionData("factoryAddress")),
        ...(p.model === MODEL ? [call("issuer", c.pool, POOL.encodeFunctionData("issuer"))] : [])];
      if (!p.binding) throw new Error("univ1 missing identity binding");
      return [{ id: "factory-code", kind: "get-code", address: p.binding.factory },
        { id: "token-code", kind: "get-code", address: p.binding.token },
        call("exchange", p.binding.factory, FACTORY.encodeFunctionData("getExchange", [p.binding.token])),
        call("reverse-token", p.binding.factory, FACTORY.encodeFunctionData("getToken", [c.pool])),
        call("decimals", p.binding.token, TOKEN.encodeFunctionData("decimals"))];
    },
    decode({ step, results }): Proof {
      const p = step.evidence as Proof | undefined;
      const ids = !p ? ["code"] : p.phase === "clone" ? ["implementation-code"] : p.phase === "implementation"
        ? ["token", "factory", ...(p.model === MODEL ? ["issuer"] : [])]
        : ["factory-code", "token-code", "exchange", "reverse-token", "decimals"];
      const source = validateResults(results, ids, p?.source), pool = lower(step.candidate.pool);
      if (!p) {
        const code = returned(results, "code"), implementation = cloneImplementation(code);
        return { phase: "clone", source, pool, ids, implementation: implementation ?? ethers.ZeroAddress,
          codeHash: ethers.keccak256(code), ...(!implementation ? { rejection: "unsupported-univ1-clone" } : {}) };
      }
      if (p.pool !== pool || p.rejection || p.phase === "complete") throw new Error("univ1 invalid identity continuation");
      if (p.phase === "clone") {
        const implementationCodeHash = ethers.keccak256(returned(results, "implementation-code"));
        const model = implementationModel(implementationCodeHash);
        return { ...p, phase: "implementation", ids, implementationCodeHash,
          ...(model ? { model } : { rejection: "unsupported-univ1-implementation" }) };
      }
      if (p.phase === "implementation") {
        if (!p.model || !p.implementationCodeHash) throw new Error("univ1 missing implementation evidence");
        const token = poolAddress(returned(results, "token")), factory = poolAddress(returned(results, "factory"));
        const issuer = p.model === MODEL ? poolAddress(returned(results, "issuer")) : ethers.ZeroAddress;
        const actors = [token, factory, ...(p.model === MODEL ? [issuer] : [])];
        const rejection = actors.includes(ethers.ZeroAddress) || token === WETH || actors.includes(pool) || issuer === token
          ? "invalid-univ1-binding" : undefined;
        return { ...p, phase: "binding", ids, ...(rejection ? { rejection } : {}), binding: {
          pool, token, factory, issuer, implementation: p.implementation, codeHash: p.codeHash,
          implementationCodeHash: p.implementationCodeHash, factoryCodeHash: "", decimals: 0, model: p.model } };
      }
      if (!p.binding) throw new Error("univ1 missing identity binding");
      const factory = returned(results, "factory-code"), token = returned(results, "token-code");
      const decimals = uint(returned(results, "decimals"));
      const rejection = factory === "0x" || token === "0x" ? "missing-univ1-code" :
        address(returned(results, "exchange")) !== pool || address(returned(results, "reverse-token")) !== p.binding.token
          ? "univ1-factory-registration-mismatch" : decimals > 36n ? "unsupported-token-decimals" : undefined;
      return { ...p, phase: "complete", ids, ...(rejection ? { rejection } : {}), binding: { ...p.binding,
        decimals: Number(decimals), factoryCodeHash: ethers.keccak256(factory) } };
    },
    decide({ candidate, evidence }) {
      const p = evidence as Proof | undefined;
      if (!p) return { status: "continue" };
      if (p.pool !== lower(candidate.pool)) return { status: "invalid-program", reasonCode: "foreign-univ1-candidate" };
      if (p.rejection) return { status: "chain-proven-rejected", reasonCode: p.rejection, evidenceRequestIds: p.ids };
      if (p.phase !== "complete") return { status: "continue" };
      if (!p.binding) return { status: "invalid-program", reasonCode: "missing-univ1-binding" };
      return { status: "verified", identity: { familyId: ID, lineageId: LINEAGE, subject: p.pool, facts: p.binding,
        provenance: [{ kind: "immutable-vyper-bytecode-and-bidirectional-factory-registration", subject: p.binding.factory,
          evidenceHash: hashCanonical({ binding: { ...p.binding }, source: { ...p.source } }) }] } };
    },
  }],
} satisfies IdentitySemantics<Candidate, Identity>;
