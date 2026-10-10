import { ethers } from "ethers";
import type { IdentitySemantics } from "../../adapter-family-plugin.js";
import type { AdapterRequest, AdapterRequestResult, CanonicalSource } from "../../adapter-request-program.js";
import { RequiredAdapterRequestError } from "../../adapter-request-failure.js";
import { hashCanonical } from "../../canonical-value.js";
import { ABI, PROBE_RECEIVER, address, assertSource, call, decode, implementationWord, rows } from "./codec.js";
import { FAMILY, LINEAGE } from "./manifest.js";
import { proveImplementation, proveProxy } from "./runtime-shape.js";
import { assertCapacity, dependencyRequests, dynamic, dynamicRequests, formula, surfaceRequests } from "./state.js";
import type { Binding, Candidate, Direction, Identity, State } from "./types.js";
type Root = Pick<Binding, "target" | "implementation" | "proxyCodeHash" | "gem" | "stable"> & { gemScale: bigint; stableScale: bigint };
interface Proof { readonly phase: "root" | "behavior" | "complete" | "unavailable"; readonly source?: CanonicalSource;
  readonly root?: Root; readonly binding?: Binding; readonly state?: State; readonly exempt?: boolean; readonly behaviorHash?: string; readonly reason?: string }
const caller = { kind: "executor" as const };
const deps = (r: Root) => [...dependencyRequests(r), ...dynamicRequests(r.target),
  call("receiver-exempt", r.target, ABI.encodeFunctionData("whitelist", [PROBE_RECEIVER]))];
export function probes(p: Proof) {
  if (!p.binding || !p.state) throw new Error("PSV missing behavior binding"); const d = p.binding, s = p.state;
  return (["sell-gem", "buy-gem"] as const).flatMap(direction => probeAmounts(d, s, direction).map(amount => {
    const sell = direction === "sell-gem", fn = sell ? "sellGem" : "buyGem";
    const q = formula(d, s, direction, amount, p.exempt);
    assertCapacity(d, s, direction, amount, q.amountOut, q.fee);
    const tokenIn = sell ? d.gem : d.stable, tokenOut = sell ? d.stable : d.gem;
    const request: AdapterRequest = { id: `behavior-${direction}-${amount}`, kind: "effect-delta-simulation",
      preCalls: [0n, amount].map(n => ({ caller, to: tokenIn, data: ABI.encodeFunctionData("approve", [d.target, n]) })),
      call: { caller, executionMode: "impersonated-call-frame", to: d.target, data: ABI.encodeFunctionData(fn, [PROBE_RECEIVER, amount]) },
      overrideIntent: { caller, tokenBalances: [{ token: tokenIn, amount }] },
      observeTokenBalances: [{ token: tokenIn, account: caller }, { token: tokenIn, account: d.target },
        { token: tokenOut, account: PROBE_RECEIVER }, { token: tokenOut, account: d.target }, { token: tokenOut, account: s.treasury }],
      observe: ["return-data", "revert-data", "token-delta", "logs"] };
    return { request, direction, fn, amount, tokenIn, tokenOut, ...q };
  }));
}
function probeAmounts(d: Binding, s: State, direction: Direction): bigint[] {
  const sell = direction === "sell-gem", decimals = sell ? d.gemDecimals : d.stableDecimals;
  const scale = 10n ** BigInt(18 - decimals), unit = 10n ** BigInt(decimals);
  const reserveWad = (sell ? s.stableReserve : s.gemReserve) * 10n ** BigInt(18 - (sell ? d.stableDecimals : d.gemDecimals));
  const capWad = [10n ** 19n, reserveWad, ...(s.maxPerTransaction ? [s.maxPerTransaction] : []), ...(s.maxPerBlock ? [s.remaining] : [])].reduce((a,b) => a < b ? a : b);
  const high = capWad / scale;
  const outputScale = 10n ** BigInt(18 - (sell ? d.stableDecimals : d.gemDecimals));
  // Fees are at most 10%, rounded down in output units: the first positive
  // gross output is also positive net output. Never select a half that rounds
  // to zero when two distinct legal input amounts exist above this threshold.
  const minimum = (outputScale + scale - 1n) / scale;
  const preferred = high > unit ? unit : high / 2n;
  const low = preferred > minimum ? preferred : minimum;
  // Each call is isolated. Exercise distinct positive sizes where capacity
  // allows; a legal one-raw-unit market is not rejected for lacking a second.
  const sizes = [...new Set([low, high])].filter(a => a > 0n && a <= high && formula(d, s, direction, a).amountOut > 0n);
  if (!sizes.length) throw new Error("PSV no positive behavior capacity"); return sizes;
}
export function verifyBehavior(p: Proof, results: readonly AdapterRequestResult[]) {
  const d = p.binding!, s = p.state!, samples = probes(p);
  if (results.length !== samples.length) throw new Error("PSV missing behavior samples");
  for (const sample of samples) {
    const matches = results.filter(r => r.id === sample.request.id); if (matches.length !== 1) throw new Error("PSV duplicate/missing behavior");
    const r = matches[0]; if (!r.ok) throw new RequiredAdapterRequestError(r); assertSource(r.source, p.source!);
    if (r.completion !== "returned" || decode(sample.fn, r.data)[0] !== sample.amountOut) throw new Error("PSV behavior return mismatch");
    const deltas = r.effects?.tokenDeltas;
    const actors = deltas?.filter(v => v.token.toLowerCase() === sample.tokenIn && v.account.toLowerCase() !== d.target);
    if (!deltas || deltas.length !== 5 || actors?.length !== 1) throw new Error("PSV incomplete effects");
    const actor = address(actors[0].account);
    if ([d.target, d.gem, d.stable, d.implementation, s.treasury, PROBE_RECEIVER].includes(actor)) throw new Error("PSV aliased behavior actor");
    const expected = [[sample.tokenIn, actor, -sample.amount], [sample.tokenIn, d.target, sample.amount],
      [sample.tokenOut, PROBE_RECEIVER, sample.amountOut], [sample.tokenOut, d.target, -sample.amountOut - sample.fee],
      [sample.tokenOut, s.treasury, sample.fee]] as const;
    for (const [token, account, delta] of expected) {
      const found = deltas.filter(v => v.token.toLowerCase() === token && v.account.toLowerCase() === account);
      if (found.length !== 1 || found[0].delta !== delta) throw new Error("PSV actual debit/receipt/fee mismatch");
    }
    const events = (r.effects?.logs ?? []).filter(e => e.address.toLowerCase() === d.target && e.topics[0]?.toLowerCase() === ABI.getEvent("Swap")!.topicHash.toLowerCase());
    if (events.length !== 1) throw new Error("PSV missing swap event");
    const e = ABI.decodeEventLog("Swap", events[0].data, [...events[0].topics]);
    if (address(e.sender) !== actor || address(e.recipient) !== PROBE_RECEIVER || address(e.tokenIn) !== sample.tokenIn ||
        address(e.tokenOut) !== sample.tokenOut || e.amountIn !== sample.amount || e.amountOut !== sample.amountOut || e.fee !== sample.fee)
      throw new Error("PSV event/effect mismatch");
  }
}
export const identity = {
  memoReuse: "recheck-identity", identityKey: i => i.binding.target,
  variants: [{ id: "source-uups-pair-and-dual-execution", kind: "standalone-contract", lineageId: LINEAGE,
    applies: c => c.candidateKind === "psv",
    requirements: ({ evidence }) => (evidence as Proof | undefined)?.phase === "behavior"
      ? { transports: ["effect-delta-simulation"], caller: "executor", effects: ["return-data", "revert-data", "token-delta", "logs"] }
      : { transports: (evidence as Proof | undefined)?.phase === "root" ? ["get-code", "eth-call"] : ["get-code", "get-storage", "eth-call"] },
    buildRequests({ candidate, evidence }) {
      const p = evidence as Proof | undefined;
      if (!p) return surfaceRequests(candidate.target);
      if (p.phase === "root" && p.root) return deps(p.root);
      if (p.phase === "behavior") return probes(p).map(v => v.request);
      return [];
    },
    decode({ step, results }): Proof {
      const p = step.evidence as Proof | undefined;
      try {
        if (!p) {
          const target = address(step.candidate.target), r = rows(results, surfaceRequests(target));
          const root: Root = { target, proxyCodeHash: proveProxy(r.get("proxy-code")), implementation: implementationWord(r.get("implementation-slot")),
            gem: address(decode("GEM", r.get("GEM"))[0]), stable: address(decode("STABLE", r.get("STABLE"))[0]),
            gemScale: decode("gemToWad", r.get("gemToWad"))[0], stableScale: decode("stableToWad", r.get("stableToWad"))[0] };
          if (new Set([root.target, root.implementation, root.gem, root.stable, PROBE_RECEIVER]).size !== 5) throw new Error("PSV aliased asset surface");
          return { phase: "root", root, source: r.source };
        }
        if (p.phase === "root" && p.root && p.source) {
          const d = p.root, r = rows(results, deps(d), p.source), implementationCodeHash = proveImplementation(r.get("implementation-code"), d.implementation);
          const gemDecimals = Number(decode("decimals", r.get("gem-decimals"))[0]), stableDecimals = Number(decode("decimals", r.get("stable-decimals"))[0]);
          if (gemDecimals > 18 || stableDecimals > 18 || d.gemScale !== 10n ** BigInt(18 - gemDecimals) || d.stableScale !== 10n ** BigInt(18 - stableDecimals) ||
              [r.get("gem-code"), r.get("stable-code")].some(c => c === "0x")) throw new Error("PSV unsupported asset decimals/code");
          const binding: Binding = { target: d.target, implementation: d.implementation, proxyCodeHash: d.proxyCodeHash, implementationCodeHash,
            gem: d.gem, stable: d.stable, gemDecimals, stableDecimals, gemCodeHash: ethers.keccak256(r.get("gem-code")), stableCodeHash: ethers.keccak256(r.get("stable-code")) };
          const state = dynamic(r.get, r.source);
          if ([d.target, d.implementation, d.gem, d.stable, PROBE_RECEIVER].includes(state.treasury)) throw new Error("PSV aliased fee receiver unsupported");
          const next: Proof = { ...p, phase: "behavior", binding, state, exempt: decode("whitelist", r.get("receiver-exempt"))[0] };
          probes(next); return next;
        }
        if (p.phase !== "behavior") throw new Error("PSV invalid identity phase");
        verifyBehavior(p, results); return { ...p, phase: "complete", behaviorHash: hashCanonical(JSON.parse(JSON.stringify(results, (_k,v) => typeof v === "bigint" ? v.toString() : v))) };
      } catch (e) { if (e instanceof RequiredAdapterRequestError) throw e;
        return { phase: "unavailable", reason: e instanceof Error ? e.message : "PSV identity unavailable" }; }
    },
    decide({ evidence }) {
      const p = evidence as Proof | undefined;
      if (p?.phase === "unavailable") return { status: "retryable", reasonCode: p.reason! };
      if (p?.phase !== "complete" || !p.binding || !p.source || !p.behaviorHash) return { status: "continue" };
      return { status: "verified", identity: { familyId: FAMILY, lineageId: LINEAGE, subject: p.binding.target, binding: p.binding,
        provenance: [{ kind: "compiled-uups-source-pair-and-two-direction-effects-not-factory", subject: p.binding.target,
          evidenceHash: hashCanonical({ ...p.binding, source: { ...p.source }, behaviorHash: p.behaviorHash }) }] } };
    },
  }],
} satisfies IdentitySemantics<Candidate, Identity>;
