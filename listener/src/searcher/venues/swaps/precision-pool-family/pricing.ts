import { ethers } from "ethers";
import type { PricingSemantics } from "../../adapter-family-plugin.js";
import { compileAddressMutations } from "../../mutation-index.js";
import { quotedPoolMid } from "../blockscan-state-shared.js";
import { FEE_DENOM, lower, normalizedToken } from "./codec.js";
import { binding } from "./instance.js";
import { ACTION } from "./manifest.js";
import { assertRoute } from "./routes.js";
import { decodeState, stateRequests } from "./state.js";
import type { Descriptor, Route, State } from "./types.js";
export const dependencies = (d: Descriptor) => [...new Set([d.pool, d.token0, d.token1, normalizedToken(d.token0), normalizedToken(d.token1), d.factory, d.poolCode])].filter(a => a !== ethers.ZeroAddress);
export const pricing = {
  stateKey: r => r.instanceKey, staticBindingProjection: ({ descriptor }) => binding(descriptor),
  snapshotCompatibilityProjection: ({ descriptor }) => binding(descriptor),
  compileDraft({ descriptor, stateKey, routes }) {
    if (stateKey !== descriptor.instanceKey || !routes.length || routes.length > 2 || new Set(routes.map(r => r.routeKey)).size !== routes.length)
      throw new Error("precision-pool invalid pricing group");
    routes.forEach(r => assertRoute(descriptor, r)); return descriptor;
  },
  finalizePricingDescriptor: ({ draft }) => draft,
  current: {
    requirements: () => ({ transports: ["eth-call", "get-code"] }), buildRequests: ({ descriptor }) => stateRequests(descriptor),
    decodeSnapshot({ descriptor, initialResults, dependentEvidence }) {
      if (dependentEvidence.length) throw new Error("precision-pool unexpected state rounds");
      return decodeState(descriptor, initialResults);
    },
    deriveMids({ descriptor: d, snapshot: s, routes }) {
      const mids = new Map<Route["routeKey"], ReturnType<typeof quotedPoolMid>>();
      // Virtual reserves are independently floored functions of LP supply.
      // This marginal ratio is not a finite quote or a band-capacity guarantee.
      const augmented0 = s.reserve0 + s.supply * 10n ** 18n / d.sqrtPHigh;
      const augmented1 = s.reserve1 + s.supply * d.sqrtPLow / 10n ** 18n;
      for (const r of routes) {
        assertRoute(d, r);
        if (!s.supply || !s.reserve0 || !s.reserve1) continue;
        mids.set(r.routeKey, quotedPoolMid({ kind: "external-swap",
          amountIn: (r.zeroForOne ? augmented0 : augmented1) * FEE_DENOM,
          amountOut: (r.zeroForOne ? augmented1 : augmented0) * (FEE_DENOM - d.fee),
          depthIn: r.zeroForOne ? s.reserve0 : s.reserve1, depthOut: r.zeroForOne ? s.reserve1 : s.reserve0, feeBps: Number(d.fee) / 100,
          edge: { adapterId: ACTION, instanceKey: r.instanceKey, target: d.pool, tokenIn: r.tokenIn, tokenOut: r.tokenOut,
            slotKind: "swap", edgeKind: "swap", leavesStandingPosition: false } }));
      }
      return mids;
    },
    classifyUnavailable({ snapshot, routes }) {
      return new Map(routes.flatMap(r => !snapshot.supply || !snapshot.reserve0 || !snapshot.reserve1
        ? [[r.routeKey, "precision-pool-empty-liquidity"] as const] : []));
    },
  },
  dependencies: ({ descriptor }) => dependencies(descriptor),
  mutation: {
    compile: ({ entries }) => compileAddressMutations(entries, ({ descriptor }) => ({ addresses: dependencies(descriptor), keys: [descriptor.instanceKey] }), { kinds: ["log", "call"] }),
    affectedStateKeys({ descriptor, observation }) {
      const target = observation.kind === "log" ? observation.address : observation.kind === "call" ? observation.target : null;
      return target && dependencies(descriptor).includes(lower(target)) ? [descriptor.instanceKey] : [];
    },
  },
  liveStateProjection: { project: ({ snapshot }) => ({ ...snapshot, source: { ...snapshot.source } }) },
} satisfies PricingSemantics<Descriptor, Route, Descriptor, State>;
