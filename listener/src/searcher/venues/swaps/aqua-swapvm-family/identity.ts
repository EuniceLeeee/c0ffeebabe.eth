import { ethers } from "ethers";
import type { IdentitySemantics } from "../../adapter-family-plugin.js";
import { codeRequest, returnedResult } from "../../protocols/standard-family/common.js";
import { hashCanonical } from "../../canonical-value.js";
import { binding, key, profile, CODE_HASH, stateRequests, decodeState, sourceOf } from "./codec.js";
import { ID, LINEAGE } from "./manifest.js";
import type { Binding, Candidate, Identity, State } from "./types.js";
type Proof = { phase: "unsupported" | "code" } | { phase: "verified"; binding: Binding; state: State; proof: string };
export const identity = {
  memoReuse: "recheck-identity",
  variants: [{ id: "registered-concentrated-xyc-order", kind: "registry-member", lineageId: LINEAGE,
    applies: c => c.candidateKind === "aqua-registered-strategy",
    requirements: ({ evidence }) => ({ transports: evidence === undefined ? ["get-code"] : ["get-code", "eth-call"] }),
    buildRequests({ candidate: c, evidence }) {
      const p = evidence as Proof | undefined;
      if (!p) return [codeRequest("router-code", c.router)];
      return p.phase === "code" ? stateRequests(binding(c.router, c.order, c.tokens)) : [];
    },
    decode({ step, results }): Proof {
      const p = step.evidence as Proof | undefined, b = binding(step.candidate.router, step.candidate.order, step.candidate.tokens);
      sourceOf(results);
      if (!p) return { phase: ethers.keccak256(returnedResult(results, "router-code").data) === CODE_HASH ? "code" : "unsupported" };
      if (p.phase !== "code") throw new Error("aqua unexpected identity phase");
      const state = decodeState(b, results);
      return { phase: "verified", binding: b, state, proof: hashCanonical({ ...b, order: { ...b.order }, tokens: [...b.tokens],
        source: { ...state.source }, balances: [...state.balances] }) };
    },
    decide({ candidate: c, evidence }) {
      if (!profile(c.order)) return { status: "invalid-program", reasonCode: "aqua_v1_strategy_variant_not_supported" };
      const p = evidence as Proof | undefined;
      if (p?.phase === "unsupported") return { status: "chain-proven-rejected", reasonCode: "aqua_router_runtime_unsupported", evidenceRequestIds: ["router-code"] };
      if (p?.phase !== "verified") return { status: "continue" };
      // Docking and maker approvals are mutable; absence is not permanent identity rejection.
      if (!p.state.active) return { status: "retryable", reasonCode: "aqua_order_not_active_two_token_registration" };
      return { status: "verified", identity: { familyId: ID, lineageId: LINEAGE, subject: p.binding.router, facts: p.binding,
        provenance: [{ kind: "aqua-registered-order-hash-token-reverse-binding", subject: p.binding.aqua, evidenceHash: p.proof }] } };
    },
  }], identityKey: i => key(i.facts),
} satisfies IdentitySemantics<Candidate, Identity>;
