import { bindRequestResultRound, collectRequestProgramResults, type PricingSemantics } from "../../adapter-family-plugin.js";
import { compileAddressMutations } from "../../mutation-index.js";
import { quotedPoolMid } from "../blockscan-state-shared.js";
import { rootRequests, decodeRoot, reverseRequests, assertReverse, call, uint, sourceOf } from "./codec.js";
import { binding } from "./instance.js";
import { assertRoute } from "./routes.js";
import { ACTION } from "./manifest.js";
import type { Descriptor, Route, Snapshot, RootState } from "./types.js";
export function priceRequests(d: Descriptor, s: RootState) {
  return [...reverseRequests(d, s), ...d.tokens.flatMap((token, i) => [
    call(`min:${i}`, s.priceFeed, "getPrice", [token, false, s.includeAmmPrice, true]),
    call(`max:${i}`, s.priceFeed, "getPrice", [token, true, s.includeAmmPrice, true]),
    call(`pool:${i}`, d.vault, "poolAmounts", [token]), call(`reserved:${i}`, d.vault, "reservedAmounts", [token]),
    call(`buffer:${i}`, d.vault, "bufferAmounts", [token]),
    call(`fee:${i}`, s.utils, "getSwapFeeBasisPoints", [token, d.tokens[1-i], 0n]),
  ])];
}
export const pricing = {
  // Oracle rounds and mutable helper addresses need current-head reads even if
  // the Vault has no log. Pointers are resolved afresh, never frozen into Ready.
  refreshPolicy: "each-block",
  stateKey: r => r.instanceKey,
  staticBindingProjection: ({ descriptor: d }) => binding(d),
  snapshotCompatibilityProjection: ({ descriptor: d }) => binding(d),
  compileDraft({ descriptor: d, stateKey, routes }) {
    if (stateKey !== d.instanceKey || !routes.length || routes.length > 2) throw new Error("vault-spot pricing group");
    routes.forEach(r => assertRoute(d, r)); return d;
  },
  finalizePricingDescriptor: ({ draft }) => draft,
  current: {
    requirements: () => ({ transports: ["get-code", "eth-call"] }),
    buildRequests: ({ descriptor: d }) => rootRequests(d),
    buildDependentProgram({ current: i, completedRound, initialResults }) {
      if (completedRound !== 0) return null;
      const s = decodeRoot(i.descriptor, initialResults, i.source);
      return bindRequestResultRound({ transports: ["get-code", "eth-call"] }, priceRequests(i.descriptor, s));
    },
    decodeSnapshot({ descriptor: d, initialResults, dependentEvidence }): Snapshot {
      if (dependentEvidence.length !== 1) throw new Error("vault-spot missing pricing round");
      const s = decodeRoot(d, initialResults), all = collectRequestProgramResults(initialResults, dependentEvidence);
      sourceOf(all, s.source); assertReverse(d, s, all);
      const pool = d.tokens.map((_, i) => uint(all, `pool:${i}`, "poolAmounts"));
      const available = pool.map((p, i) => {
        const reserved = uint(all, `reserved:${i}`, "reservedAmounts"), buffer = uint(all, `buffer:${i}`, "bufferAmounts");
        const floor = reserved > buffer ? reserved : buffer; return p > floor ? p-floor : 0n;
      });
      const minPrices = d.tokens.map((_, i) => uint(all, `min:${i}`, "getPrice"));
      const maxPrices = d.tokens.map((_, i) => uint(all, `max:${i}`, "getPrice"));
      const fees = d.tokens.map((_, i) => uint(all, `fee:${i}`, "getSwapFeeBasisPoints"));
      if (fees.some(f => f >= 10000n) || minPrices.some((p, i) => p <= 0n || p > maxPrices[i])) throw new Error("vault-spot invalid price or fee");
      return { ...s, pool, available, minPrices, maxPrices, fees };
    },
    deriveMids({ descriptor: d, routes, snapshot: s }) {
      const mids = new Map<Route["routeKey"], ReturnType<typeof quotedPoolMid>>();
      for (const r of routes) {
        assertRoute(d, r);
        if (!s.active || s.available[r.j] <= 0n) continue;
        // Only the zero-size marginal rate. Exact simulates the unchanged
        // requested input with dynamic fees and gross-output capacity checks.
        mids.set(r.routeKey, quotedPoolMid({ kind: "external-swap",
          amountIn: s.maxPrices[r.j] * 10n**s.decimals[r.i] * 10000n,
          amountOut: s.minPrices[r.i] * 10n**s.decimals[r.j] * (10000n-s.fees[r.i]),
          depthIn: s.pool[r.i], depthOut: s.available[r.j], feeBps: Number(s.fees[r.i]),
          edge: { adapterId: ACTION, instanceKey: d.instanceKey, target: d.vault, tokenIn: r.tokenIn, tokenOut: r.tokenOut,
            slotKind: "swap", edgeKind: "swap", leavesStandingPosition: false } }));
      }
      return mids;
    },
    classifyUnavailable({ descriptor: d, snapshot: s, routes }) {
      const unavailable = new Map<Route["routeKey"], string>();
      for (const r of routes) {
        assertRoute(d, r);
        if (!s.active) unavailable.set(r.routeKey, "vault-spot-inactive");
        else if (s.available[r.j] <= 0n) unavailable.set(r.routeKey, "vault-spot-no-output-pool-capacity");
      }
      return unavailable;
    },
  },
  dependencies: ({ descriptor: d }) => [d.vault],
  mutation: {
    compile: ({ entries }) => compileAddressMutations(entries, ({ descriptor: d }) => ({ addresses: [d.vault], keys: [d.instanceKey] }), { kinds: ["log", "call"] }),
    affectedStateKeys({ descriptor: d, observation: o }) {
      const a = o.kind === "log" ? o.address : o.kind === "call" ? o.target : null;
      return a?.toLowerCase() === d.vault ? [d.instanceKey] : [];
    },
  },
  liveStateProjection: { project: ({ snapshot: s }) => ({ ...s, source: { ...s.source }, decimals: [...s.decimals], pool: [...s.pool],
    available: [...s.available], minPrices: [...s.minPrices], maxPrices: [...s.maxPrices], fees: [...s.fees] }) },
} satisfies PricingSemantics<Descriptor, Route, Descriptor, Snapshot>;
