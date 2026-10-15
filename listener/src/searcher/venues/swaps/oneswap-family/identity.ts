import { ethers } from "ethers";
import type { IdentitySemantics } from "../../adapter-family-plugin.js";
import type { CanonicalSource } from "../../adapter-request-program.js";
import { hashCanonical } from "../../canonical-value.js";
import { address, call, code, FACTORY, FACTORY_HASH, IMPLEMENTATION_HASH, lower, normalizedToken, POOL, resultsSource, returned } from "./codec.js";
import { ID, LINEAGE } from "./manifest.js";
import { decodeProxy } from "./proxy.js";
import type { Binding, Candidate, Identity } from "./types.js";
interface Proof { phase: "proxy" | "factory" | "complete"; source: CanonicalSource; facts?: Binding; rejection?: string; ids: readonly string[] }
export const identity = {
  memoReuse: "recheck-identity", identityKey: i => lower(i.subject),
  variants: [{ id: "proxy-and-bidirectional-factory-registration", kind: "standalone-contract", lineageId: LINEAGE,
    applies: c => c.candidateKind === "oneswap",
    requirements({ evidence }) {
      return { transports: (evidence as Proof | undefined)?.phase === "proxy" ? ["eth-call", "get-code"] : ["get-code"] };
    },
    buildRequests({ candidate: c, evidence }) {
      const p = evidence as Proof | undefined;
      if (!p) return [code("proxy", c.pool)];
      if (!p.facts || p.rejection) return [];
      const d = p.facts;
      if (p.phase === "proxy") return [code("factory-code", d.factory), call("logic", d.factory, FACTORY.encodeFunctionData("pairLogic")),
        call("registered-tokens", d.factory, FACTORY.encodeFunctionData("getTokensFromPair", [d.pool])),
        call("registered-pair", d.factory, FACTORY.encodeFunctionData("tokensToPair", [d.stock, d.money, d.isOnlySwap])),
        call("stock", d.pool, POOL.encodeFunctionData("stock")), call("money", d.pool, POOL.encodeFunctionData("money"))];
      return [code("implementation-code", d.implementation)];
    },
    decode({ step, results }): Proof {
      const p = step.evidence as Proof | undefined;
      const ids = !p ? ["proxy"] : p.phase === "proxy" ? ["factory-code", "logic", "registered-tokens", "registered-pair", "stock", "money"] : ["implementation-code"];
      const source = resultsSource(results, ids, p?.source), data = (id: string) => returned(results, id);
      if (!p) {
        const runtime = data("proxy"), binding = decodeProxy(runtime), pool = lower(step.candidate.pool);
        if (!binding || normalizedToken(binding.stock) === normalizedToken(binding.money) || [binding.stock, binding.money, binding.factory, binding.ones].includes(pool))
          return { phase: "proxy", source, ids, rejection: "unsupported-oneswap-proxy" };
        return { phase: "proxy", source, ids, facts: { ...binding, pool, codeHash: ethers.keccak256(runtime),
          implementation: ethers.ZeroAddress, implementationCodeHash: "", factoryCodeHash: "" } };
      }
      if (!p.facts || p.rejection || p.facts.pool !== lower(step.candidate.pool)) throw new Error("oneswap invalid identity continuation");
      if (p.phase === "proxy") {
        const factoryCodeHash = ethers.keccak256(data("factory-code"));
        const tokens = FACTORY.decodeFunctionResult("getTokensFromPair", data("registered-tokens"));
        const implementation = address(data("logic"));
        const rejection = factoryCodeHash !== FACTORY_HASH ? "unsupported-oneswap-factory-runtime" :
          address(data("registered-pair")) !== p.facts.pool || lower(tokens[0]) !== p.facts.stock || lower(tokens[1]) !== p.facts.money ||
          address(data("stock")) !== p.facts.stock || address(data("money")) !== p.facts.money || implementation === ethers.ZeroAddress
            ? "oneswap-registration-mismatch" : undefined;
        return { ...p, phase: "factory", ids, facts: { ...p.facts, factoryCodeHash, implementation }, ...(rejection ? { rejection } : {}) };
      }
      const implementationCodeHash = ethers.keccak256(data("implementation-code"));
      return { ...p, phase: "complete", ids, facts: { ...p.facts, implementationCodeHash },
        ...(implementationCodeHash !== IMPLEMENTATION_HASH ? { rejection: "unsupported-oneswap-implementation" } : {}) };
    },
    decide({ evidence }) {
      const p = evidence as Proof | undefined;
      if (p?.rejection) return { status: "chain-proven-rejected", reasonCode: p.rejection, evidenceRequestIds: p.ids };
      if (p?.phase !== "complete" || !p.facts) return { status: "continue" };
      return { status: "verified", identity: { familyId: ID, lineageId: LINEAGE, subject: p.facts.pool, facts: p.facts,
        provenance: [{ kind: "oneswap-verified-proxy-factory-registration-implementation", subject: p.facts.factory,
          evidenceHash: hashCanonical({ facts: { ...p.facts }, source: { ...p.source } }) }] } };
    },
  }],
} satisfies IdentitySemantics<Candidate, Identity>;
