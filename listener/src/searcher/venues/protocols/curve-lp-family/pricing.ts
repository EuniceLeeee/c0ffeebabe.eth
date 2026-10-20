import { hasCryptoClaim, cryptoClaimDependencies, cryptoClaimPricingRequests, cryptoClaimMidRequests, decodeCryptoClaimSnapshot, cryptoClaimRequirements } from "./generic-effects.js";
import { genericStateRequests, decodeGenericState, genericQuoteRequest, genericQuoteResult } from "./generic.js";
import { isZap, zapDependencies, zapPricingRequests, zapMidRequests, decodeZapSnapshot, zapSample, zapSimulationRequirements, type ZapSnapshot } from "./zap.js";
import { STABLE_CALC, CURVE_V1_FACTORY, NATIVE } from "./generic.js";
import { ethers } from "ethers";
import { bindRequestResultRound, collectRequestProgramResults, type PricingSemantics, type UnifiedObservation } from "../../adapter-family-plugin.js";
import { compileAddressMutations } from "../../mutation-index.js";
import { protocolMid } from "../standard-family/common.js";
import { ABI, DECIMALS, META, assertSource, call, decode, rows, uint } from "./codec.js";
import { binding } from "./instance.js";
import { ACTION } from "./manifest.js";
import { assertRoute } from "./routes.js";
import { decodeState, requirements, stateRequests } from "./state.js";
import { mintQuote } from "./model.js";
import type { Binding, Descriptor, Route, State } from "./types.js";
import { NG, ngStateRequests, decodeNgState, ngQuoteRequest } from "./ng.js";
import { RequiredAdapterRequestError } from "../../adapter-request-failure.js";
interface Snapshot extends State { readonly withdraw: readonly bigint[]; readonly mint?: readonly bigint[]; readonly quotes?: ZapSnapshot["quotes"]; readonly ngQuotes?: readonly { readonly direction: "mint" | "redeem"; readonly index: number; readonly amountIn: bigint; readonly amountOut: bigint }[] }
const dependencies = (d: Binding) => isZap(d) ? zapDependencies(d) : [...new Set([d.pool, d.lp, ...d.coins.filter(v => v !== NATIVE), ...(hasCryptoClaim(d) ? cryptoClaimDependencies(d) : []), ...(d.generic ? [META, ...(d.generic.kind === "stable" ? [STABLE_CALC] : []), ...(d.generic.identitySource === "v1-factory" ? [CURVE_V1_FACTORY] : []), ...[d.generic.basePool, d.generic.implementation].filter(v => v !== ethers.ZeroAddress)] : []), ...(d.ng ? [d.ng.factory, d.ng.views, ...d.ng.external.map(v => v.address)] : [])])];
const reads = (d: Binding) => isZap(d) ? zapPricingRequests(d) : hasCryptoClaim(d) ? cryptoClaimPricingRequests(d) : d.generic ? genericStateRequests(d) : d.ng ? ngStateRequests(d) : [...stateRequests(d), ...[0, 1].map(i => call(`mid-withdraw-${i}`, d.pool, ABI.encodeFunctionData("calc_withdraw_one_coin", [10n ** 18n, i])))];
function ngMidAmount(d: Binding, s: State, direction: "mint" | "redeem", index: number): bigint {
  const unit = 10n ** BigInt(direction === "mint" ? (d.generic?.decimals ?? d.ng!.decimals)[index] : 18), balance = direction === "mint" ? s.balances[index] : s.totalSupply;
  const cap = balance / 1_000_000n; return cap < 1n ? 1n : cap < unit ? cap : unit;
}
function sample(d: Binding, s: Snapshot, r: Route) {
  if (isZap(d)) { if (!s.quotes) throw new Error("curve-lp zap missing pricing snapshot"); return zapSample({ ...s, quotes: s.quotes }, r); }
  if (d.ng || d.generic) { if (s.killed || !s.totalSupply) return undefined; const q = s.ngQuotes?.find(q => q.direction === r.direction && q.index === r.index);
    return q && q.amountOut > 0n && (r.direction === "mint" || q.amountIn < s.totalSupply && q.amountOut <= s.balances[r.index])
      ? { amountIn: q.amountIn, amountOut: q.amountOut } : undefined; }
  if (s.killed || !s.totalSupply || s.balances.some(b => b <= 0n)) return undefined;
  try { const amountIn = 10n ** BigInt(r.direction === "mint" ? DECIMALS[r.index] : 18);
    const amountOut = r.direction === "mint" ? mintQuote(s, r.index, amountIn) : s.withdraw[r.index];
    return amountOut > 0n && (r.direction === "mint" || (amountIn < s.totalSupply && amountOut <= s.balances[r.index])) ? { amountIn, amountOut } : undefined;
  } catch { return undefined; }
}
export function affected(d: Descriptor, o: UnifiedObservation): readonly string[] {
  const target = o.kind === "log" ? o.address.toLowerCase() : o.kind === "call" ? o.target.toLowerCase() : null;
  if (!target || !dependencies(d).includes(target)) return [];
  if (o.kind === "log" && target !== d.pool) {
    if (o.topics[0]?.toLowerCase() === ABI.getEvent("Transfer")!.topicHash.toLowerCase()) {
      try { const e = ABI.decodeEventLog("Transfer", o.data, [...o.topics]), from = String(e.from).toLowerCase(), to = String(e.to).toLowerCase();
        if (isZap(d)) return [d.pool, d.zap.metaPool, d.zap.basePool, ethers.ZeroAddress].some(a => a === from || a === to) ? [d.instanceKey] : [];
        if (target === d.lp) return [from, to].includes(ethers.ZeroAddress) ? [d.instanceKey] : [];
        return [from, to].includes(d.pool) ? [d.instanceKey] : [];
      } catch { /* malformed is conservative */ }
    } else if (o.topics[0]?.toLowerCase() === ABI.getEvent("Approval")!.topicHash.toLowerCase()) {
      try { ABI.decodeEventLog("Approval", o.data, [...o.topics]); return []; } catch { /* malformed is conservative */ }
    }
  }
  // Pool mutations include no-log donate_admin_fees and LP minter changes;
  // unknown dependency calls/events are never assumed price-inert.
  return [d.instanceKey];
}
export const pricing = { refreshPolicyForInstance: ({ descriptor: d }) => (d.zap || d.ng || d.generic) ? "each-block" : "on-touch", stateKey: r => r.instanceKey,
  staticBindingProjection: ({ descriptor }) => binding(descriptor), snapshotCompatibilityProjection: ({ descriptor }) => binding(descriptor),
  compileDraft({ descriptor: d, stateKey, routes }) { if (stateKey !== d.instanceKey || !routes.length) throw new Error("curve-lp pricing group"); routes.forEach(r => assertRoute(d, r)); return d; },
  finalizePricingDescriptor: ({ draft }) => draft,
  current: { requirements: ({ descriptor: d }) => isZap(d) ? { ...zapSimulationRequirements, transports: ["get-code", "get-storage", "eth-call", "effect-delta-simulation"] } : hasCryptoClaim(d) ? { ...cryptoClaimRequirements, transports: ["get-code", "eth-call", "effect-delta-simulation"] } : (d.ng || d.generic) ? { transports: ["get-code", "eth-call"] } : requirements, buildRequests: ({ descriptor }) => reads(descriptor),
    buildDependentProgram({ current, completedRound, initialResults }) {
      const d = current.descriptor; if (completedRound !== 0) return null;
      if (isZap(d)) return bindRequestResultRound(zapSimulationRequirements, zapMidRequests(d, initialResults, current.source));
      if (hasCryptoClaim(d)) {
        const requests = cryptoClaimMidRequests(d, initialResults, current.source), transports = [...new Set(requests.map(r => r.kind))];
        return bindRequestResultRound(transports.includes("effect-delta-simulation") ? { ...cryptoClaimRequirements, transports } : { transports }, requests);
      }
      if (!d.ng && !d.generic) return null;
      const s = d.generic ? decodeGenericState(d, initialResults, current.source) : decodeNgState(d, initialResults, current.source);
      if (d.generic) return bindRequestResultRound({ transports: ["eth-call"] }, d.generic.directions.map(q => genericQuoteRequest(d, q.direction, q.index,
        ngMidAmount(d, s, q.direction, q.index), `g-mid-${q.direction}-${q.index}`)));
      return bindRequestResultRound({ transports: ["eth-call"] }, d.ng!.directions.map(q => ngQuoteRequest(d, q.direction, q.index,
        ngMidAmount(d, s, q.direction, q.index), `ng-mid-${q.direction}-${q.index}`)));
    },
    decodeSnapshot({ descriptor: d, initialResults, dependentEvidence }) {
      if (isZap(d)) { const all = collectRequestProgramResults(initialResults, dependentEvidence), ids = new Set(initialResults.map(r => r.id));
        return { ...decodeZapSnapshot(d, initialResults, all.filter(r => !ids.has(r.id))), withdraw: [] }; }
      if (hasCryptoClaim(d)) { const all = collectRequestProgramResults(initialResults, dependentEvidence), ids = new Set(initialResults.map(r => r.id));
        return decodeCryptoClaimSnapshot(d, initialResults, all.filter(r => !ids.has(r.id))); }
      if (d.generic) { const state = decodeGenericState(d, initialResults), results = collectRequestProgramResults(initialResults, dependentEvidence);
        const ngQuotes = d.generic.directions.map(q => { const r = results.find(v => v.id === `g-mid-${q.direction}-${q.index}`);
          if (!r) throw new Error("curve-lp generic missing mid"); if (!r.ok) throw new RequiredAdapterRequestError(r); assertSource(r.source, state.source);
          let amountOut = 0n; if (r.completion === "returned") { try { amountOut = genericQuoteResult(d, r); } catch (e) { if (e instanceof RequiredAdapterRequestError) throw e; } }
          return { ...q, amountIn: ngMidAmount(d, state, q.direction, q.index), amountOut }; });
        return { ...state, withdraw: [], ngQuotes }; }
      if (d.ng) { const state = decodeNgState(d, initialResults), results = collectRequestProgramResults(initialResults, dependentEvidence);
        const ngQuotes = d.ng.directions.map(q => { const r = results.find(v => v.id === `ng-mid-${q.direction}-${q.index}`);
          if (!r) throw new Error("curve-lp NG missing mid");
          if (!r.ok) throw new RequiredAdapterRequestError(r); assertSource(r.source, state.source);
          const amountIn = ngMidAmount(d, state, q.direction, q.index);
          // A confirmed zero/revert is an unavailable stateful quote, never RPC.
          const amountOut = r.completion === "returned" ? uint(NG.decodeFunctionResult(q.direction === "mint" ? "calc_token_amount" : "calc_withdraw_one_coin", r.data)[0]) : 0n;
          return { ...q, amountIn, amountOut }; });
        return { ...state, withdraw: [], ngQuotes }; }
      const r = rows(initialResults, reads(d));
      return { ...decodeState(d, initialResults.filter(v => !v.id.startsWith("mid-withdraw-"))),
        withdraw: [0, 1].map(i => decode("calc_withdraw_one_coin", r.get(`mid-withdraw-${i}`))[0]) as [bigint, bigint] }; },
    deriveMids: ({ descriptor: d, snapshot: s, routes }) => new Map(routes.flatMap(r => { assertRoute(d, r); const q = sample(d, s, r);
      return q ? [[r.routeKey, protocolMid({ route: r, adapterId: ACTION, target: d.pool, quote: q })] as const] : []; })),
    classifyUnavailable: ({ descriptor: d, snapshot: s, routes }) => new Map(routes.filter(r => !sample(d, s, r)).map(r => [r.routeKey, "curve-lp-no-positive-capacity"])),
  }, dependencies: ({ descriptor }) => dependencies(descriptor), liveStateProjection: { project: ({ snapshot }) => ({ ...snapshot, source: { ...snapshot.source } }) },
  mutation: { compile({ entries }) { const index = compileAddressMutations(entries, ({ descriptor: d }) => ({ addresses: dependencies(d), keys: [d.instanceKey] }), { kinds: ["log", "call"] });
    const byKey = new Map(entries.map(e => [String(e.descriptor.instanceKey), e.descriptor]));
    return { dependencies: index.dependencies, affectedStateKeys: ({ observation }) => index.affectedStateKeys({ observation }).filter(k => affected(byKey.get(String(k))!, observation).length > 0) }; },
    affectedStateKeys: ({ descriptor, observation }) => affected(descriptor, observation) },
} satisfies PricingSemantics<Descriptor, Route, Descriptor, Snapshot>;
