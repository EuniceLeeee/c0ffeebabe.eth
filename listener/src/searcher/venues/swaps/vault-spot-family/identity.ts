import { ethers } from "ethers";
import type { IdentitySemantics } from "../../adapter-family-plugin.js";
import { codeRequest, returnedResult } from "../../protocols/standard-family/common.js";
import { hashCanonical } from "../../canonical-value.js";
import { CODE_HASH, pair, key, rootRequests, decodeRoot, reverseRequests, assertReverse, sourceOf } from "./codec.js";
import { ID, LINEAGE } from "./manifest.js";
import type { Candidate, Identity, Binding, RootState } from "./types.js";
type State = { phase: "unsupported" } | { phase: "code" } | { phase: "root"; binding: Binding; root: RootState } |
  { phase: "verified"; binding: Binding; root: RootState; proof: string };
export const identity = {
  memoReuse: "recheck-identity",
  variants: [{ id: "vault-reverse-registered-market", kind: "registry-member", lineageId: LINEAGE,
    applies: c => c.candidateKind === "vault-spot-pair",
    requirements: ({ evidence }) => ({ transports: evidence === undefined ? ["get-code"] : ["get-code", "eth-call"] }),
    buildRequests({ candidate: c, evidence }) {
      const s = evidence as State | undefined, b = pair(c.vault, c.tokens);
      if (!s) return [codeRequest("vault-code", b.vault)];
      if (s.phase === "code") return rootRequests(b);
      if (s.phase === "root") return reverseRequests(b, s.root);
      return [];
    },
    decode({ step, results }): State {
      const s = step.evidence as State | undefined, b = pair(step.candidate.vault, step.candidate.tokens);
      sourceOf(results);
      if (!s) return { phase: ethers.keccak256(returnedResult(results, "vault-code").data) === CODE_HASH ? "code" : "unsupported" };
      if (s.phase === "code") return { phase: "root", binding: b, root: decodeRoot(b, results) };
      if (s.phase !== "root") throw new Error("vault-spot unexpected identity phase");
      assertReverse(b, s.root, results);
      return { ...s, phase: "verified", proof: hashCanonical({ binding: { ...b, tokens: [...b.tokens] }, root: { ...s.root, source: { ...s.root.source }, decimals: [...s.root.decimals] } }) };
    },
    decide({ evidence }) {
      const s = evidence as State | undefined;
      if (s?.phase === "unsupported") return { status: "chain-proven-rejected", reasonCode: "vault_spot_runtime_unsupported", evidenceRequestIds: ["vault-code"] };
      if (s?.phase !== "verified") return { status: "continue" };
      if (!s.root.active) return { status: "retryable", reasonCode: "vault_spot_disabled_or_pair_unlisted" };
      return { status: "verified", identity: { familyId: ID, lineageId: LINEAGE, subject: s.binding.vault, facts: s.binding,
        provenance: [{ kind: "runtime-profile-and-reverse-vault-registration", subject: s.root.usdg, evidenceHash: s.proof }] } };
    },
  }],
  identityKey: i => key(i.facts),
} satisfies IdentitySemantics<Candidate, Identity>;
