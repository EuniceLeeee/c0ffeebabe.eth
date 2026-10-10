import { ethers } from "ethers";
import type { IdentitySemantics } from "../../adapter-family-plugin.js";
import type { AdapterRequest, AdapterRequestResult, CanonicalSource } from "../../adapter-request-program.js";
import { RequiredAdapterRequestError } from "../../adapter-request-failure.js";
import { hashCanonical } from "../../canonical-value.js";
import { ABI, DECIMALS, address, assertSource, call, decode, rows } from "./codec.js";
import { bind, dependencyRequests, dynamic, dynamicRequests, surface, surfaceRequests } from "./state.js";
import { mintQuote } from "./model.js";
import { FAMILY, LINEAGE } from "./manifest.js";
import type { Binding, Candidate, Direction, Identity, State } from "./types.js";
interface Proof { readonly phase: "root" | "behavior" | "complete" | "unavailable"; readonly source?: CanonicalSource;
  readonly root?: ReturnType<typeof surface>; readonly binding?: Binding; readonly state?: State; readonly behaviorHash?: string; readonly reason?: string }
export function samples(p: Proof) { const d = p.binding!, s = p.state!;
  if (!d || !s || s.killed || s.balances.some(b => b <= 0n) || s.totalSupply <= 0n) throw new Error("curve-lp insufficient behavior capacity");
  return (["mint", "redeem"] as const).flatMap(direction => ([0, 1] as const).flatMap(index => [1n, 2n].map(n => {
    // Every behavior request is isolated. Never sum probes into a fictitious
    // liquidity requirement; only each redemption must be below total supply.
    const desired = n * 10n ** BigInt(direction === "mint" ? DECIMALS[index] : 18);
    const amount = direction === "redeem" && desired >= s.totalSupply ? s.totalSupply * n / 3n : desired;
    if (amount <= 0n || (direction === "redeem" && amount >= s.totalSupply)) throw new Error("curve-lp insufficient behavior capacity");
    return { direction, index, amount,
      tokenIn: direction === "mint" ? d.coins[index] : d.lp, tokenOut: direction === "mint" ? d.lp : d.coins[index] };
  })));
}
export function behaviorRequests(p: Proof): AdapterRequest[] { const d = p.binding!, caller = { kind: "executor" as const };
  return samples(p).flatMap((q, index) => {
    const amounts = [0n, 0n]; amounts[q.index] = q.amount;
    const fn = q.direction === "mint" ? "add_liquidity" : "remove_liquidity_one_coin";
    const request: AdapterRequest = { id: `behavior-${index}`, kind: "effect-delta-simulation",
      preCalls: q.direction === "mint" ? [0n, q.amount].map(a => ({ caller, to: q.tokenIn, data: ABI.encodeFunctionData("approve", [d.pool, a]) })) : [],
      call: { caller, executionMode: "impersonated-call-frame", to: d.pool, data: ABI.encodeFunctionData(fn,
        q.direction === "mint" ? [amounts, 1n] : [q.amount, q.index, 1n]) },
      overrideIntent: { caller, tokenBalances: [{ token: q.tokenIn, amount: q.amount }] },
      observeTokenBalances: [{ token: q.tokenIn, account: caller }, { token: q.tokenIn, account: d.pool },
        { token: q.tokenOut, account: caller }, { token: q.tokenOut, account: d.pool }],
      observeTotalSupplies: [d.lp], observe: ["return-data", "revert-data", "token-delta", "native-delta", "total-supply-delta", "logs"] };
    return q.direction === "mint" ? [request] : [request, call(`withdraw-view-${index}`, d.pool, ABI.encodeFunctionData("calc_withdraw_one_coin", [q.amount, q.index]))];
  });
}
export function verifyBehavior(p: Proof, results: readonly AdapterRequestResult[]) {
  const d = p.binding!, s = p.state!, requests = behaviorRequests(p), values = rows(results, requests, p.source);
  for (const [index, q] of samples(p).entries()) {
    const fn = q.direction === "mint" ? "add_liquidity" : "remove_liquidity_one_coin", r = results.find(v => v.id === `behavior-${index}`)!;
    if (!r.ok) throw new RequiredAdapterRequestError(r); assertSource(r.source, p.source!);
    const out = q.direction === "mint" ? mintQuote(s, q.index, q.amount) : decode("calc_withdraw_one_coin", values.get(`withdraw-view-${index}`))[0];
    if (!out || decode(fn, r.data)[0] !== out) throw new Error("curve-lp return/quote mismatch");
    const deltas = r.effects?.tokenDeltas, actors = deltas?.filter(v => v.token.toLowerCase() === q.tokenIn && v.account.toLowerCase() !== d.pool);
    if (!deltas || deltas.length !== 4 || actors?.length !== 1) throw new Error("curve-lp incomplete balance effects");
    const actor = address(actors[0].account); if ([d.pool, d.lp, ...d.coins].includes(actor)) throw new Error("curve-lp aliased caller");
    const expected = [[q.tokenIn, actor, -q.amount], [q.tokenIn, d.pool, q.direction === "mint" ? q.amount : 0n],
      [q.tokenOut, actor, out], [q.tokenOut, d.pool, q.direction === "redeem" ? -out : 0n]] as const;
    for (const [token, account, delta] of expected) { const matches = deltas.filter(v => v.token.toLowerCase() === token && v.account.toLowerCase() === account);
      if (matches.length !== 1 || matches[0].delta !== delta) throw new Error("curve-lp debit/receipt mismatch"); }
    const supplies = r.effects?.totalSupplyDeltas;
    if (supplies?.length !== 1 || supplies[0].token.toLowerCase() !== d.lp || supplies[0].delta !== (q.direction === "mint" ? out : -q.amount))
      throw new Error("curve-lp supply mismatch");
    if (r.effects?.nativeDeltas?.some(v => v.delta !== 0n)) throw new Error("curve-lp native balance changed");
  }
}
export const identity = { memoReuse: "recheck-identity", identityKey: i => i.binding.pool,
  variants: [{ id: "registry-minter-source-and-four-directions", kind: "standalone-contract", lineageId: LINEAGE, applies: c => c.candidateKind === "curve-lp",
    requirements: ({ evidence }) => (evidence as Proof | undefined)?.phase === "behavior"
      ? { transports: ["eth-call", "effect-delta-simulation"], caller: "executor", effects: ["return-data", "revert-data", "token-delta", "native-delta", "total-supply-delta", "logs"] }
      : { transports: (evidence as Proof | undefined)?.phase === "root" ? ["get-code", "get-storage", "eth-call"] : ["get-code", "eth-call"] },
    buildRequests({ candidate, evidence }) { const p = evidence as Proof | undefined;
      if (!p) return surfaceRequests(candidate.pool);
      if (p.phase === "root" && p.root) return [...dependencyRequests(p.root), ...dynamicRequests(p.root)];
      if (p.phase === "behavior") return behaviorRequests(p); return []; },
    decode({ step, results }): Proof { const p = step.evidence as Proof | undefined;
      try {
        if (!p) { const r = rows(results, surfaceRequests(step.candidate.pool)); return { phase: "root", source: r.source, root: surface(address(step.candidate.pool), r.get) }; }
        if (p.phase === "root" && p.root) { const r = rows(results, [...dependencyRequests(p.root), ...dynamicRequests(p.root)], p.source);
          const next: Proof = { ...p, phase: "behavior", binding: bind(p.root, r.get), state: dynamic(r.get, r.source) }; samples(next); return next; }
        if (p.phase !== "behavior") throw new Error("curve-lp identity phase"); verifyBehavior(p, results);
        return { ...p, phase: "complete", behaviorHash: hashCanonical(JSON.parse(JSON.stringify(results, (_k, v) => typeof v === "bigint" ? v.toString() : v))) };
      } catch (e) { if (e instanceof RequiredAdapterRequestError) throw e; return { phase: "unavailable", reason: e instanceof Error ? e.message : "curve-lp unavailable" }; }
    },
    decide({ evidence }) { const p = evidence as Proof | undefined;
      if (p?.phase === "unavailable") return { status: "retryable", reasonCode: p.reason! };
      if (p?.phase !== "complete" || !p.binding || !p.behaviorHash || !p.source) return { status: "continue" };
      return { status: "verified", identity: { familyId: FAMILY, lineageId: LINEAGE, subject: p.binding.pool, binding: p.binding,
        provenance: [{ kind: "registry-reverse-lp-minter-and-source-behavior", subject: p.binding.pool,
          evidenceHash: hashCanonical({ ...p.binding, source: { ...p.source }, behaviorHash: p.behaviorHash }) }] } };
    },
  }],
} satisfies IdentitySemantics<Candidate, Identity>;
