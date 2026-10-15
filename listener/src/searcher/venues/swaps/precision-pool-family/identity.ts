import { ethers } from "ethers";
import type { IdentitySemantics } from "../../adapter-family-plugin.js";
import type { CanonicalSource } from "../../adapter-request-program.js";
import { hashCanonical } from "../../canonical-value.js";
import { address, call, code, decodeCanonical, FACTORY, lower, MARKET_TYPE, marketTuple, normalizedToken, POOL, POOL_FIELDS, resultsSource, returned, TOKEN, uint } from "./codec.js";
import { ID, LINEAGE } from "./manifest.js";
import { decodeFactoryRuntime, decodePoolRuntime, POOL_INIT_CODE_HASH } from "./runtime.js";
import type { Binding, Candidate, Identity } from "./types.js";
interface Proof {
  phase: "runtime" | "factory" | "complete"; source: CanonicalSource;
  facts?: Binding; rejection?: string; ids: readonly string[];
}
const FACTORY_IDS = ["factory-code", "trustedExecutor", "poolCode", "poolInitCodeHash", "registered", "reverse", ...POOL_FIELDS.map(k => "pool-" + k)];
export const identity = {
  memoReuse: "recheck-identity", identityKey: i => lower(i.subject),
  variants: [{ id: "direct-runtime-create2-registration", kind: "standalone-contract", lineageId: LINEAGE,
    applies: c => c.candidateKind === "precision-pool",
    requirements({ evidence }) {
      return { transports: evidence ? ["get-code", "eth-call"] : ["get-code"] };
    },
    buildRequests({ candidate: c, evidence }) {
      const p = evidence as Proof | undefined;
      if (!p) return [code("pool-code", c.pool)];
      if (!p.facts || p.rejection) return [];
      const d = p.facts;
      if (p.phase === "runtime") return [code("factory-code", d.factory),
        ...["trustedExecutor", "poolCode", "poolInitCodeHash"].map(k => call(k, d.factory, FACTORY.encodeFunctionData(k))),
        call("registered", d.factory, FACTORY.encodeFunctionData("isPool", [d.pool])),
        call("reverse", d.factory, FACTORY.encodeFunctionData("poolFor", [marketTuple(d)])),
        ...POOL_FIELDS.map(k => call("pool-" + k, d.pool, POOL.encodeFunctionData(k)))];
      return [code("creation-blob", d.poolCode), ...[d.token0, d.token1].flatMap((t, i) => [
        code("token-code-" + i, normalizedToken(t)), call("decimals-" + i, normalizedToken(t), TOKEN.encodeFunctionData("decimals"))])];
    },
    decode({ step, results }): Proof {
      const p = step.evidence as Proof | undefined;
      const ids = !p ? ["pool-code"] : p.phase === "runtime" ? FACTORY_IDS : ["creation-blob", "token-code-0", "decimals-0", "token-code-1", "decimals-1"];
      const source = resultsSource(results, ids, p?.source), data = (id: string) => returned(results, id);
      if (!p) {
        const runtime = data("pool-code"), binding = decodePoolRuntime(runtime), pool = lower(step.candidate.pool);
        if (!binding || [binding.factory, normalizedToken(binding.token0), normalizedToken(binding.token1)].includes(pool))
          return { phase: "runtime", source, ids, rejection: "unsupported-precision-pool-runtime-or-market" };
        return { phase: "runtime", source, ids, facts: { ...binding, pool, codeHash: ethers.keccak256(runtime),
          trustedExecutor: ethers.ZeroAddress, poolCode: ethers.ZeroAddress, poolInitCodeHash: "", factoryCodeHash: "" } };
      }
      if (!p.facts || p.rejection || p.facts.pool !== lower(step.candidate.pool)) throw new Error("precision-pool invalid identity continuation");
      if (p.phase === "runtime") {
        const f = decodeFactoryRuntime(data("factory-code"));
        if (!f) return { ...p, ids, rejection: "unsupported-precision-pool-factory-runtime-or-initcode" };
        const registered = decodeCanonical(FACTORY, "isPool", data("registered"))[0];
        const gettersMatch = POOL_FIELDS.every(k => {
          const value = decodeCanonical(POOL, k, data("pool-" + k))[0];
          return typeof p.facts![k] === "bigint" ? value === p.facts![k] : lower(value) === p.facts![k];
        });
        const valid = registered === true && address(data("reverse")) === p.facts.pool && gettersMatch &&
          address(data("trustedExecutor")) === f.trustedExecutor && address(data("poolCode")) === f.poolCode &&
          data("poolInitCodeHash").toLowerCase() === f.poolInitCodeHash;
        return { ...p, phase: "factory", ids, facts: { ...p.facts, ...f, factoryCodeHash: ethers.keccak256(data("factory-code")) },
          ...(valid ? {} : { rejection: "precision-pool-registration-or-immutable-mismatch" }) };
      }
      if (p.phase !== "factory") throw new Error("precision-pool invalid identity phase");
      const blob = data("creation-blob"), d = p.facts;
      // SSTORE2's leading STOP is data-contract framing, not part of initcode.
      const creation = blob.startsWith("0x00") ? "0x" + blob.slice(4) : "0x";
      const abi = ethers.AbiCoder.defaultAbiCoder();
      const initCode = ethers.concat([creation, abi.encode(["address", MARKET_TYPE], [d.factory, marketTuple(d)])]);
      const predicted = lower(ethers.getCreate2Address(d.factory, ethers.keccak256(abi.encode([MARKET_TYPE], [marketTuple(d)])), ethers.keccak256(initCode)));
      const valid = ethers.keccak256(creation) === POOL_INIT_CODE_HASH && predicted === d.pool &&
        [0, 1].every(i => data("token-code-" + i) !== "0x" && uint(data("decimals-" + i)) <= 77n) &&
        [d.token0, d.token1].every((t, i) => t !== ethers.ZeroAddress || uint(data("decimals-" + i)) === 18n);
      return { ...p, phase: "complete", ids, ...(valid ? {} : { rejection: "precision-pool-create2-blob-or-token-mismatch" }) };
    },
    decide({ evidence }) {
      const p = evidence as Proof | undefined;
      if (p?.rejection) return { status: "chain-proven-rejected", reasonCode: p.rejection, evidenceRequestIds: p.ids };
      if (p?.phase !== "complete" || !p.facts) return { status: "continue" };
      return { status: "verified", identity: { familyId: ID, lineageId: LINEAGE, subject: p.facts.pool, facts: p.facts,
        provenance: [{ kind: "precision-pool-full-runtime-create2-factory-registration", subject: p.facts.factory,
          evidenceHash: hashCanonical({ facts: { ...p.facts }, source: { ...p.source } }) }] } };
    },
  }],
} satisfies IdentitySemantics<Candidate, Identity>;
