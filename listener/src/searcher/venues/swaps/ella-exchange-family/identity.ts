import { ethers } from "ethers";
import type { IdentitySemantics } from "../../adapter-family-plugin.js";
import type { CanonicalSource } from "../../adapter-request-program.js";
import { hashCanonical } from "../../canonical-value.js";
import { ELLA_ID, ELLA_LINEAGE } from "./manifest.js";
import { EXCHANGE_CODE_HASH, FACTORY_CODE_HASH, ORACLE, TOKEN, address, assertSource, call, lower, resultSource, returned, same, storage, uint } from "./codec.js";
import type { EllaBinding, EllaCandidate, EllaIdentity } from "./types.js";

interface Evidence {
  phase: "layout" | "factory" | "complete";
  source: CanonicalSource;
  binding: EllaBinding;
  rejection?: string;
  requestIds: readonly string[];
}
export const ellaIdentity = {
  memoReuse: "recheck-identity",
  identityKey: identity => lower(identity.subject),
  // Runtime and stored fee-service binding prove behavior, not CREATE ancestry.
  // A custom constructor can install the same runtime and initial storage.
  variants: [{ id: "verified-native-base-runtime", kind: "standalone-contract", lineageId: ELLA_LINEAGE,
    applies: c => c.candidateKind === "ella-exchange",
    requirements({ evidence }) {
      const prior = evidence as Evidence | undefined;
      return { transports: !prior ? ["get-code", "get-storage"] : prior.phase === "layout" ? ["get-code", "eth-call"] : ["get-code"] };
    },
    buildRequests({ candidate, evidence }) {
      const prior = evidence as Evidence | undefined;
      if (!prior) return [{ id: "code", kind: "get-code", address: candidate.pool },
        storage("token", candidate.pool, 1), storage("factory-native", candidate.pool, 2),
        storage("secretary", candidate.pool, 10), storage("oracle", candidate.pool, 15)];
      if (prior.rejection) return [];
      if (prior.phase === "layout") return [
        { id: "factory-code", kind: "get-code", address: prior.binding.factory },
        { id: "token-code", kind: "get-code", address: prior.binding.token },
        { id: "oracle-code", kind: "get-code", address: prior.binding.oracle },
        call("decimals", prior.binding.token, TOKEN.encodeFunctionData("decimals")),
        call("aggregator", prior.binding.oracle, ORACLE.encodeFunctionData("aggregator")),
      ];
      return [{ id: "aggregator-code", kind: "get-code", address: prior.binding.aggregator }];
    },
    decode({ step, results }): Evidence {
      const source = resultSource(results), requestIds = results.map(r => r.id);
      const prior = step.evidence as Evidence | undefined;
      if (!prior) {
        const codeHash = ethers.keccak256(returned(results, "code").data);
        const packed = uint(returned(results, "factory-native").data);
        const factory = ethers.getAddress(ethers.toBeHex(packed & ((1n << 160n) - 1n), 20));
        const token = address(returned(results, "token").data), oracle = address(returned(results, "oracle").data);
        const secretary = address(returned(results, "secretary").data);
        const rejection = codeHash !== EXCHANGE_CODE_HASH ? "unsupported-exchange-runtime" :
          packed >> 160n !== 1n ? "not-native-base-exchange" :
          !same(factory, secretary) || same(factory, ethers.ZeroAddress) ? "factory-secretary-mismatch" :
          same(token, ethers.ZeroAddress) || same(oracle, ethers.ZeroAddress) ? "invalid-token-oracle" : undefined;
        return { phase: "layout", source, requestIds, ...(rejection ? { rejection } : {}),
          binding: { pool: ethers.getAddress(step.candidate.pool), token, factory, oracle, aggregator: ethers.ZeroAddress,
            decimals: 0, codeHash, factoryCodeHash: "" } };
      }
      assertSource(source, prior.source);
      if (prior.phase === "layout") {
        const factoryCodeHash = ethers.keccak256(returned(results, "factory-code").data);
        const decimals = Number(uint(returned(results, "decimals").data));
        const aggregator = address(returned(results, "aggregator").data);
        const rejection = factoryCodeHash !== FACTORY_CODE_HASH ? "unsupported-factory-runtime" :
          returned(results, "token-code").data === "0x" || returned(results, "oracle-code").data === "0x" ? "missing-token-oracle-code" :
          decimals !== 18 ? "unsupported-token-scale" : same(aggregator, ethers.ZeroAddress) ? "missing-oracle-aggregator" : undefined;
        return { ...prior, phase: "factory", requestIds, binding: { ...prior.binding, factoryCodeHash, decimals, aggregator }, ...(rejection ? { rejection } : {}) };
      }
      if (returned(results, "aggregator-code").data === "0x") throw new Error("ella oracle aggregator unavailable");
      return { ...prior, phase: "complete", requestIds };
    },
    decide({ evidence }) {
      const prior = evidence as Evidence | undefined;
      if (!prior) return { status: "continue" };
      if (prior.rejection) return { status: "chain-proven-rejected", reasonCode: prior.rejection, evidenceRequestIds: prior.requestIds };
      if (prior.phase !== "complete") return { status: "continue" };
      return { status: "verified", identity: { familyId: ELLA_ID, lineageId: ELLA_LINEAGE,
        subject: prior.binding.pool, facts: prior.binding, provenance: [{ kind: "ella-compiled-runtime-factory-storage",
          subject: prior.binding.factory, evidenceHash: hashCanonical({ binding: { ...prior.binding }, source: { ...prior.source } }) }] } };
    },
  }],
} satisfies IdentitySemantics<EllaCandidate, EllaIdentity>;
