import { ethers } from "ethers";
import type { IdentitySemantics } from "../../adapter-family-plugin.js";
import type { AdapterRequest, AdapterRequestResult, CanonicalSource } from "../../adapter-request-program.js";
import { RequiredAdapterRequestError } from "../../adapter-request-failure.js";
import { hashCanonical } from "../../canonical-value.js";
import { runtimeProgramScript } from "../../../../adapters/runtime-amount-program.js";
import { buildSubscriptCalldata } from "../../../../shared/executor/botvm-program-entry.js";
import { ABI, PROBE_RECEIVER, address, assertSource, decode, rows, scales } from "./codec.js";
import { takeProgram } from "./execution.js";
import { FAMILY, LINEAGE } from "./manifest.js";
import { sampleBudget } from "./pricing.js";
import { cloneImplementation, proveImplementation } from "./runtime-shape.js";
import { decodeState, dependencyRequests, quoteBudget, stateRequests, surfaceRequests } from "./state.js";
import type { Binding, Candidate, Identity, State } from "./types.js";
type Root = Pick<Binding, "target" | "sold" | "want" | "implementation" | "cloneCodeHash"> & { soldScale: bigint };
export interface Proof { readonly phase: "root" | "state" | "behavior" | "program" | "complete" | "unavailable";
  readonly source?: CanonicalSource; readonly root?: Root; readonly binding?: Binding; readonly state?: State;
  readonly executor?: string; readonly behaviorHash?: string; readonly reason?: string }
const caller = { kind: "executor" as const };
export function samples(p: Proof) {
  if (!p.binding || !p.state) throw new Error("Yearn auction missing behavior state");
  const first = sampleBudget(p.binding, p.state); if (!first) throw new Error("Yearn auction no positive behavior capacity");
  const amounts = [first];
  try { quoteBudget(p.binding, p.state, first + 2n); amounts.push(first + 2n); } catch { /* one legal sample is enough at an arithmetic boundary */ }
  return amounts.map(amount => ({ amount, ...quoteBudget(p.binding!, p.state!, amount) }));
}
export function behaviorRequests(p: Proof): readonly AdapterRequest[] {
  const d = p.binding!, s = p.state!;
  return samples(p).map((q, index) => {
    const executorProgram = p.phase === "program";
    if (executorProgram && !p.executor) throw new Error("Yearn auction missing caller evidence");
    const body = executorProgram ? takeProgram(d, p.executor!, q.amountOut)
      .constant(9, 0n).call(d.want, ABI.encodeFunctionData("allowance", [p.executor!, d.target]), { static: true }).load(8, 0).equal(8, 9) : null;
    return { id: `behavior-${executorProgram ? "program" : "call"}-${index}`, kind: "effect-delta-simulation",
      ...(executorProgram ? {} : { preCalls: [0n, q.amount].map(amount => ({ caller, to: d.want, data: ABI.encodeFunctionData("approve", [d.target, amount]) })) }),
      call: executorProgram ? { caller, executionMode: "executor-program", to: p.executor!, data: buildSubscriptCalldata(runtimeProgramScript(body!.bytes(), q.amount)) }
        : { caller, executionMode: "impersonated-call-frame", to: d.target, data: ABI.encodeFunctionData("take(address,uint256,address)", [d.sold, q.amountOut, PROBE_RECEIVER]) },
      overrideIntent: { caller, tokenBalances: [{ token: d.want, amount: q.amount }] },
      observeTokenBalances: [{ token: d.want, account: caller }, { token: d.want, account: s.receiver },
        { token: d.sold, account: executorProgram ? caller : PROBE_RECEIVER }, { token: d.sold, account: d.target }],
      observe: ["return-data", "revert-data", "token-delta", "native-delta", "logs"] };
  });
}
export function verifyBehavior(p: Proof, results: readonly AdapterRequestResult[]): string {
  const d = p.binding!, s = p.state!, requests = behaviorRequests(p), qs = samples(p);
  if (results.length !== requests.length) throw new Error("Yearn auction missing behavior samples");
  let executor = p.executor;
  for (const [index, request] of requests.entries()) {
    const found = results.filter(r => r.id === request.id); if (found.length !== 1) throw new Error("Yearn auction missing/duplicate behavior");
    const r = found[0], q = qs[index]; if (!r.ok) throw new RequiredAdapterRequestError(r); assertSource(r.source, p.source!);
    if (r.completion !== "returned" || (p.phase === "program" ? r.data !== "0x" : decode("take(address,uint256,address)", r.data)[0] !== q.amountOut))
      throw new Error("Yearn auction behavior return mismatch");
    const deltas = r.effects?.tokenDeltas, actors = deltas?.filter(v => v.token.toLowerCase() === d.want && v.account.toLowerCase() !== s.receiver);
    if (!deltas || deltas.length !== 4 || actors?.length !== 1) throw new Error("Yearn auction incomplete effects");
    const actor = address(actors[0].account);
    if ([d.target, d.implementation, d.want, d.sold, s.receiver, PROBE_RECEIVER].includes(actor) || (executor && executor !== actor)) throw new Error("Yearn auction caller alias/mismatch");
    executor = actor;
    for (const [token, account, delta] of [[d.want, actor, -q.spent], [d.want, s.receiver, q.spent],
      [d.sold, p.phase === "program" ? actor : PROBE_RECEIVER, q.amountOut], [d.sold, d.target, -q.amountOut]] as const) {
      const entries = deltas.filter(v => v.token.toLowerCase() === token && v.account.toLowerCase() === account);
      if (entries.length !== 1 || entries[0].delta !== delta) throw new Error("Yearn auction actual debit/receipt mismatch");
    }
    const native = r.effects?.nativeDeltas;
    if (!native || native.length !== 1 || native[0].account.toLowerCase() !== actor || native[0].delta !== 0n) throw new Error("Yearn auction native conservation mismatch");
  }
  return executor!;
}
export const identity = { memoReuse: "recheck-identity", identityKey: i => `${i.binding.target}:${i.binding.sold}`,
  variants: [{ id: "clone-registered-token-and-budget-execution", kind: "standalone-contract", lineageId: LINEAGE,
    applies: c => c.candidateKind === "yearn-auction",
    requirements: ({ evidence }) => ["behavior", "program"].includes((evidence as Proof | undefined)?.phase ?? "")
      ? { transports: ["effect-delta-simulation"], caller: "executor", effects: ["return-data", "revert-data", "token-delta", "native-delta", "logs"] }
      : { transports: ["get-code", "eth-call"] },
    buildRequests({ candidate, evidence }) {
      const p = evidence as Proof | undefined;
      if (!p) return surfaceRequests(candidate.target, candidate.sold);
      if (p.phase === "root" && p.root) return dependencyRequests(p.root);
      if (p.phase === "state" && p.binding) return stateRequests(p.binding);
      if (["behavior", "program"].includes(p.phase)) return behaviorRequests(p);
      return [];
    },
    decode({ step, results }): Proof {
      const p = step.evidence as Proof | undefined;
      try {
        if (!p) {
          const target = address(step.candidate.target), sold = address(step.candidate.sold), r = rows(results, surfaceRequests(target, sold));
          const root: Root = { target, sold, want: address(decode("want", r.get("want"))[0]), implementation: cloneImplementation(r.get("clone-code")),
            cloneCodeHash: ethers.keccak256(r.get("clone-code")), soldScale: decode("auctions", r.get("auction"))[1] };
          if (decode("version", r.get("version"))[0] !== "1.0.4" || !root.soldScale || new Set([target, sold, root.want, root.implementation, PROBE_RECEIVER]).size !== 5)
            throw new Error("Yearn auction incompatible registered token/version");
          return { phase: "root", root, source: r.source };
        }
        if (p.phase === "root" && p.root && p.source) {
          const d = p.root, r = rows(results, dependencyRequests(d), p.source), implementationCodeHash = proveImplementation(r.get("implementation-code"));
          const wantDecimals = Number(decode("decimals", r.get("want-decimals"))[0]), soldDecimals = Number(decode("decimals", r.get("sold-decimals"))[0]);
          if (scales({ wantDecimals, soldDecimals }).sold !== d.soldScale || [r.get("want-code"), r.get("sold-code")].some(c => c === "0x")) throw new Error("Yearn auction token scale/code mismatch");
          const binding: Binding = { target: d.target, sold: d.sold, want: d.want, implementation: d.implementation, cloneCodeHash: d.cloneCodeHash,
            implementationCodeHash, wantDecimals, soldDecimals, wantCodeHash: ethers.keccak256(r.get("want-code")), soldCodeHash: ethers.keccak256(r.get("sold-code")) };
          return { ...p, phase: "state", binding };
        }
        if (p.phase === "state" && p.binding && p.source) {
          const state = decodeState(p.binding, results, p.source);
          if (state.receiver === PROBE_RECEIVER) throw new Error("Yearn auction aliased probe receiver");
          const next: Proof = { ...p, phase: "behavior", state }; samples(next); return next;
        }
        if (!p.binding || !p.source || !["behavior", "program"].includes(p.phase)) throw new Error("Yearn auction invalid identity phase");
        const executor = verifyBehavior(p, results), behaviorHash = hashCanonical(JSON.parse(JSON.stringify({ previous: p.behaviorHash ?? null, results }, (_k,v) => typeof v === "bigint" ? v.toString() : v)));
        return { ...p, phase: p.phase === "behavior" ? "program" : "complete", executor, behaviorHash };
      } catch (e) { if (e instanceof RequiredAdapterRequestError) throw e;
        return { phase: "unavailable", reason: e instanceof Error ? e.message : "Yearn auction identity unavailable" }; }
    },
    decide({ evidence }) {
      const p = evidence as Proof | undefined;
      if (p?.phase === "unavailable") return { status: "retryable", reasonCode: p.reason! };
      if (p?.phase !== "complete" || !p.binding || !p.source || !p.behaviorHash) return { status: "continue" };
      return { status: "verified", identity: { familyId: FAMILY, lineageId: LINEAGE, subject: `${p.binding.target}:${p.binding.sold}`, binding: p.binding,
        provenance: [{ kind: "compiled-clone-source-registered-token-and-budget-effects-not-factory", subject: p.binding.target,
          evidenceHash: hashCanonical({ ...p.binding, source: { ...p.source }, behaviorHash: p.behaviorHash }) }] } };
    },
  }],
} satisfies IdentitySemantics<Candidate, Identity>;
