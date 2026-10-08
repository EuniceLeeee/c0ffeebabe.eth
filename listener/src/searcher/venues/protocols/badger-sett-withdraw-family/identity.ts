import type { IdentitySemantics } from "../../adapter-family-plugin.js";
import type { CanonicalSource } from "../../adapter-request-program.js";
import { hashCanonical } from "../../canonical-value.js";
import { rootRequests, rootBinding, strategyRequests, strategyBinding, dependencyRequests, proveDependencies, requirements } from "./closure.js";
import { CODE } from "./codec.js";
import { FAMILY, LINEAGE } from "./manifest.js";
import type { Binding, RootBinding, Candidate, Identity } from "./types.js";
interface Proof { phase: "root" | "strategy" | "complete" | "unavailable"; source?: CanonicalSource; root?: RootBinding; binding?: Binding; reason?: string }
export const identity = {
  memoReuse: "recheck-identity", identityKey: i => i.binding.vault,
  variants: [{
    id: "source-runtime-proxy-reciprocal-strategy", kind: "standalone-contract", lineageId: LINEAGE,
    applies: c => c.candidateKind === "badger-sett-withdraw",
    requirements: ({ evidence }) => (evidence as Proof | undefined)?.phase === "strategy"
      ? { transports: ["get-code", "eth-call"] } : requirements,
    buildRequests({ candidate, evidence }) {
      const p = evidence as Proof | undefined;
      if (!p) return rootRequests(candidate.vault);
      if (p.phase === "root" && p.root) return strategyRequests(p.root);
      if (p.phase === "strategy" && p.binding) return dependencyRequests(p.binding);
      return [];
    },
    decode({ step, results }): Proof {
      const p = step.evidence as Proof | undefined;
      try {
        if (!p) { const s = rootBinding(step.candidate.vault, results); return { phase: "root", source: s.source, root: s.binding }; }
        if (p.phase === "root" && p.root && p.source) return { ...p, phase: "strategy", binding: strategyBinding(p.root, results, p.source) };
        if (p.phase !== "strategy" || !p.binding || !p.source) throw new Error("badger-sett invalid identity phase");
        proveDependencies(p.binding, results, p.source); return { ...p, phase: "complete" };
      } catch (e) {
        // Upgradeable code, unknown variants and mutable reciprocal bindings
        // are unsupported NOW, never a durable nonexistence/rejection claim.
        return { phase: "unavailable", reason: e instanceof Error ? e.message : "badger-sett identity unavailable" };
      }
    },
    decide({ evidence }) {
      const p = evidence as Proof | undefined;
      if (p?.phase === "unavailable") return { status: "retryable", reasonCode: p.reason! };
      if (p?.phase !== "complete" || !p.binding || !p.source) return { status: "continue" };
      return { status: "verified", identity: { familyId: FAMILY, lineageId: LINEAGE, subject: p.binding.vault, binding: p.binding,
        provenance: [{ kind: "source-runtime-proxy-and-reciprocal-strategy-not-factory", subject: p.binding.vault,
          evidenceHash: hashCanonical({ binding: { ...p.binding }, code: CODE, source: { ...p.source } }) }] } };
    },
  }],
} satisfies IdentitySemantics<Candidate, Identity>;
