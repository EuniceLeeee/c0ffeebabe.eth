import { ethers } from "ethers";
import type { IdentitySemantics } from "../../adapter-family-plugin.js";
import { hashCanonical } from "../../canonical-value.js";
import { callRequest, codeRequest, returnedResult, assertSource } from "../standard-family/common.js";
import { ABI, ERC20, addressWord, word, nonzero, resultSet, verifyRuntime, type MigrationBinding } from "./codec.js";
import { FAMILY, LINEAGE } from "./manifest.js";
import type { Candidate, Identity } from "./types.js";
import type { CanonicalSource } from "../../adapter-request-program.js";
type Evidence = MigrationBinding & { phase: "runtime" | "tokens"; valid: boolean; codeHash: string; source: CanonicalSource; oneToken?: bigint };
const getters = ["BIT_TOKEN_ADDRESS", "MNT_TOKEN_ADDRESS", "TOKEN_CONVERSION_NUMERATOR", "TOKEN_CONVERSION_DENOMINATOR"];
export const identity = {
  variants: [{
    id: "mantle-immutable-runtime", kind: "standalone-contract", lineageId: LINEAGE, applies: () => true,
    requirements: () => ({ transports: ["get-code" as const, "eth-call" as const] }),
    buildRequests({ candidate, evidence }) {
      if (evidence === undefined) return [codeRequest("code", candidate.target), ...getters.map(name => callRequest(name, candidate.target, ABI.encodeFunctionData(name)))];
      const p = evidence as Evidence;
      return [codeRequest("input-code", p.tokenIn), codeRequest("output-code", p.tokenOut),
        callRequest("input-decimals", p.tokenIn, ERC20.encodeFunctionData("decimals")),
        callRequest("output-decimals", p.tokenOut, ERC20.encodeFunctionData("decimals"))];
    },
    decode({ step, results }): Evidence {
      if (step.evidence === undefined) {
        const source = resultSet(results, ["code", ...getters]);
        const data = (name: string) => returnedResult(results, name).data;
        const binding = { tokenIn: addressWord(data(getters[0])), tokenOut: addressWord(data(getters[1])),
          numerator: word(data(getters[2])), denominator: word(data(getters[3])) };
        const code = data("code");
        return { ...binding, phase: "runtime", source, codeHash: ethers.keccak256(code),
          valid: binding.tokenIn !== binding.tokenOut && binding.numerator > 0n && binding.denominator > 0n && verifyRuntime(code, binding) };
      }
      const prior = step.evidence as Evidence;
      const source = resultSet(results, ["input-code", "output-code", "input-decimals", "output-decimals"]);
      assertSource(source, prior.source);
      const inDecimals = word(returnedResult(results, "input-decimals").data);
      const outDecimals = word(returnedResult(results, "output-decimals").data);
      if (inDecimals > 77n || outDecimals > 77n) throw new Error("migration decimals exceed uint256 scale");
      return { ...prior, phase: "tokens", oneToken: 10n ** inDecimals,
        valid: prior.valid && returnedResult(results, "input-code").data !== "0x" && returnedResult(results, "output-code").data !== "0x" };
    },
    decide({ candidate, evidence }) {
      if (evidence === undefined) return { status: "continue" as const };
      const p = evidence as Evidence;
      if (!p.valid) return { status: "chain-proven-rejected" as const, reasonCode: "unsupported-migration-runtime-or-token", evidenceRequestIds: p.phase === "runtime" ? ["code", ...getters] : ["input-code", "output-code"] };
      if (p.phase !== "tokens" || p.oneToken === undefined) return { status: "continue" as const };
      const subject = nonzero(candidate.target);
      return { status: "verified" as const, identity: Object.freeze({
        familyId: FAMILY, lineageId: LINEAGE, subject,
        provenance: [{ kind: "mantle-runtime-immutable-binding", subject, evidenceHash: hashCanonical({ ...p, source: { ...p.source } }) }],
        tokenIn: p.tokenIn, tokenOut: p.tokenOut, numerator: p.numerator, denominator: p.denominator,
        oneToken: p.oneToken, codeHash: p.codeHash,
      }) };
    },
  }],
  identityKey: value => value.subject.toLowerCase(),
} satisfies IdentitySemantics<Candidate, Identity>;
