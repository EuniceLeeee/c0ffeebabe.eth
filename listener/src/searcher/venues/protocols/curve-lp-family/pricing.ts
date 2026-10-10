import { ethers } from "ethers";
import type { PricingSemantics, UnifiedObservation } from "../../adapter-family-plugin.js";
import { compileAddressMutations } from "../../mutation-index.js";
import { protocolMid } from "../standard-family/common.js";
import { ABI, DECIMALS, call, decode, rows } from "./codec.js";
import { binding } from "./instance.js";
import { ACTION } from "./manifest.js";
import { assertRoute } from "./routes.js";
import { decodeState, requirements, stateRequests } from "./state.js";
import { mintQuote } from "./model.js";
import type { Binding, Descriptor, Route, State } from "./types.js";
interface Snapshot extends State { readonly withdraw: readonly [bigint, bigint] }
const dependencies = (d: Binding) => [d.pool, d.lp, ...d.coins];
const reads = (d: Binding) => [...stateRequests(d), ...[0, 1].map(i => call(`mid-withdraw-${i}`, d.pool, ABI.encodeFunctionData("calc_withdraw_one_coin", [10n ** 18n, i])))];
function sample(s: Snapshot, r: Route) {
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
export const pricing = { refreshPolicy: "on-touch", stateKey: r => r.instanceKey,
  staticBindingProjection: ({ descriptor }) => binding(descriptor), snapshotCompatibilityProjection: ({ descriptor }) => binding(descriptor),
  compileDraft({ descriptor: d, stateKey, routes }) { if (stateKey !== d.instanceKey || !routes.length) throw new Error("curve-lp pricing group"); routes.forEach(r => assertRoute(d, r)); return d; },
  finalizePricingDescriptor: ({ draft }) => draft,
  current: { requirements: () => requirements, buildRequests: ({ descriptor }) => reads(descriptor),
    decodeSnapshot({ descriptor: d, initialResults }) { const r = rows(initialResults, reads(d));
      return { ...decodeState(d, initialResults.filter(v => !v.id.startsWith("mid-withdraw-"))),
        withdraw: [0, 1].map(i => decode("calc_withdraw_one_coin", r.get(`mid-withdraw-${i}`))[0]) as [bigint, bigint] }; },
    deriveMids: ({ descriptor: d, snapshot: s, routes }) => new Map(routes.flatMap(r => { assertRoute(d, r); const q = sample(s, r);
      return q ? [[r.routeKey, protocolMid({ route: r, adapterId: ACTION, target: d.pool, quote: q })] as const] : []; })),
    classifyUnavailable: ({ snapshot: s, routes }) => new Map(routes.filter(r => !sample(s, r)).map(r => [r.routeKey, "curve-lp-no-positive-capacity"])),
  }, dependencies: ({ descriptor }) => dependencies(descriptor), liveStateProjection: { project: ({ snapshot }) => ({ ...snapshot, source: { ...snapshot.source } }) },
  mutation: { compile({ entries }) { const index = compileAddressMutations(entries, ({ descriptor: d }) => ({ addresses: dependencies(d), keys: [d.instanceKey] }), { kinds: ["log", "call"] });
    const byKey = new Map(entries.map(e => [String(e.descriptor.instanceKey), e.descriptor]));
    return { dependencies: index.dependencies, affectedStateKeys: ({ observation }) => index.affectedStateKeys({ observation }).filter(k => affected(byKey.get(String(k))!, observation).length > 0) }; },
    affectedStateKeys: ({ descriptor, observation }) => affected(descriptor, observation) },
} satisfies PricingSemantics<Descriptor, Route, Descriptor, Snapshot>;
