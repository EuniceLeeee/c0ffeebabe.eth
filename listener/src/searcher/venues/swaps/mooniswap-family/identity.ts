import { ethers } from "ethers";
import type { IdentitySemantics } from "../../adapter-family-plugin.js";
import type { CanonicalSource } from "../../adapter-request-program.js";
import { hashCanonical } from "../../canonical-value.js";
import { MOONISWAP_ID, MOONISWAP_LINEAGE, POOL, TOKEN, call, lower, nonzero, resultSet, returned, uint } from "./codec.js";
import { verifyPoolRuntime } from "./runtime.js";
import type { MooniswapBinding, MooniswapCandidate, MooniswapIdentity } from "./types.js";

interface Evidence {
  readonly phase: "runtime" | "tokens";
  readonly source: CanonicalSource;
  readonly binding: MooniswapBinding;
  readonly valid: boolean;
  readonly ids: readonly string[];
}
const code = (id: string, address: string) => ({ id, kind: "get-code" as const, address });
export const mooniswapIdentity = {
  identityKey: identity => lower(identity.subject),
  // Proves executable runtime and immutable pair, not factory CREATE ancestry.
  // Governance is mutable, so it is resolved by each current quote/state read.
  variants: [{ id: "verified-erc20-runtime", kind: "standalone-contract", lineageId: MOONISWAP_LINEAGE,
    applies: candidate => candidate.candidateKind === "mooniswap",
    requirements: () => ({ transports: ["get-code", "eth-call"], caller: "executor" }),
    buildRequests({ candidate, evidence }) {
      const prior = evidence as Evidence | undefined;
      if (!prior) return [code("code", nonzero(candidate.pool)), call("token0", candidate.pool, POOL.encodeFunctionData("token0")),
        call("token1", candidate.pool, POOL.encodeFunctionData("token1"))];
      return [code("token0-code", prior.binding.token0), code("token1-code", prior.binding.token1),
        call("decimals0", prior.binding.token0, TOKEN.encodeFunctionData("decimals")),
        call("decimals1", prior.binding.token1, TOKEN.encodeFunctionData("decimals"))];
    },
    decode({ step, results }): Evidence {
      const prior = step.evidence as Evidence | undefined;
      const ids = prior ? ["token0-code", "token1-code", "decimals0", "decimals1"] : ["code", "token0", "token1"];
      const source = resultSet(results, ids, prior?.source);
      const data = (id: string) => returned(results, id, source).data;
      if (!prior) {
        const address = (id: string) => {
          const word = uint(data(id));
          if (word >= 1n << 160n) throw new Error("mooniswap noncanonical token address");
          return lower(ethers.toBeHex(word, 20));
        };
        const token0 = address("token0"), token1 = address("token1"), runtime = data("code");
        return { phase: "runtime", source, ids, valid: verifyPoolRuntime(runtime, token0, token1),
          binding: { pool: nonzero(step.candidate.pool), token0, token1, codeHash: ethers.keccak256(runtime) } };
      }
      const valid = data("token0-code") !== "0x" && data("token1-code") !== "0x" && uint(data("decimals0")) <= 77n && uint(data("decimals1")) <= 77n;
      return { ...prior, source, ids, phase: "tokens", valid: prior.valid && valid };
    },
    decide({ evidence }) {
      const prior = evidence as Evidence | undefined;
      if (!prior) return { status: "continue" };
      if (!prior.valid) return { status: "chain-proven-rejected", reasonCode: "unsupported-mooniswap-runtime-or-token", evidenceRequestIds: prior.ids };
      if (prior.phase !== "tokens") return { status: "continue" };
      return { status: "verified", identity: { ...prior.binding, familyId: MOONISWAP_ID, lineageId: MOONISWAP_LINEAGE,
        subject: prior.binding.pool, provenance: [{ kind: "mooniswap-runtime-immutable-pair", subject: prior.binding.pool,
          evidenceHash: hashCanonical({ binding: { ...prior.binding }, source: { ...prior.source } }) }] } };
    },
  }],
} satisfies IdentitySemantics<MooniswapCandidate, MooniswapIdentity>;
