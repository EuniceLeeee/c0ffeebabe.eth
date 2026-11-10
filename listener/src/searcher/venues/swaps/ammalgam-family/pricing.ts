import type { PricingSemantics } from "../../adapter-family-plugin.js";
import { compileAddressMutations } from "../../mutation-index.js";
import { quotedPoolMid } from "../blockscan-state-shared.js";
import { binding } from "./instance.js";
import { ACTION } from "./manifest.js";
import { assertRoute } from "./routes.js";
import { decodeState, netBalances, quotable, stateRequests } from "./state.js";
import type { Descriptor, Route, State } from "./types.js";

/**
 * The zero-size marginal rate is the pair's net reserve ratio. The swap fee is
 * a function of trade size (QuadraticSwapFees), so a finite quote is produced
 * by the exact path against the same state, never by scaling this mid.
 */
export const pricing = {
  refreshPolicy: "on-touch" as const,
  stateKey: (route: Route) => route.instanceKey,
  staticBindingProjection: ({ descriptor }: { readonly descriptor: Descriptor }) => binding(descriptor),
  snapshotCompatibilityProjection: ({ descriptor }: { readonly descriptor: Descriptor }) => binding(descriptor),
  compileDraft({ descriptor, stateKey, routes: group }) {
    if (stateKey !== descriptor.instanceKey || group.length === 0 || group.length > 2 ||
        new Set(group.map(route => route.routeKey)).size !== group.length) {
      throw new Error("ammalgam invalid pricing group");
    }
    group.forEach(route => assertRoute(descriptor, route));
    return descriptor;
  },
  finalizePricingDescriptor: ({ draft }) => draft,
  current: {
    requirements: () => ({ transports: ["eth-call" as const] }),
    buildRequests: ({ descriptor }: { readonly descriptor: Descriptor }) => stateRequests(descriptor),
    decodeSnapshot({ descriptor, initialResults, dependentEvidence }) {
      if (dependentEvidence.length !== 0) throw new Error("ammalgam unexpected pricing rounds");
      return decodeState(descriptor, initialResults);
    },
    deriveMids({ descriptor, snapshot, routes: group }) {
      const mids = new Map<Route["routeKey"], ReturnType<typeof quotedPoolMid>>();
      if (quotable(snapshot)) return mids;
      const [netX, netY] = netBalances(snapshot);
      for (const route of group) {
        assertRoute(descriptor, route);
        const netIn = route.xForY ? netX : netY;
        const netOut = route.xForY ? netY : netX;
        if (netIn <= 0n || netOut <= 0n) continue;
        mids.set(route.routeKey, quotedPoolMid({
          kind: "external-swap",
          amountIn: netIn,
          amountOut: netOut,
          depthIn: netIn,
          depthOut: netOut,
          feeBps: 0,
          edge: {
            adapterId: ACTION,
            instanceKey: route.instanceKey,
            target: descriptor.pair,
            tokenIn: route.tokenIn,
            tokenOut: route.tokenOut,
            slotKind: "swap",
            edgeKind: "swap",
            leavesStandingPosition: false,
          },
        }));
      }
      return mids;
    },
    classifyUnavailable({ snapshot, routes: group }) {
      const reason = quotable(snapshot);
      return new Map(reason ? group.map(route => [route.routeKey, reason] as const) : []);
    },
  },
  dependencies: ({ descriptor }) => [descriptor.pair, descriptor.tokenX, descriptor.tokenY],
  mutation: {
    compile: ({ entries }) =>
      compileAddressMutations(entries, ({ descriptor }) => ({
        addresses: [descriptor.pair, descriptor.tokenX, descriptor.tokenY],
        keys: [descriptor.instanceKey],
      }), { kinds: ["log", "call"] }),
    affectedStateKeys({ descriptor, observation }) {
      const target = observation.kind === "log" ? observation.address : observation.kind === "call" ? observation.target : null;
      return target && [descriptor.pair, descriptor.tokenX, descriptor.tokenY]
        .includes(target.toLowerCase()) ? [descriptor.instanceKey] : [];
    },
  },
  liveStateProjection: {
    project: ({ snapshot }) => ({
      source: { ...snapshot.source },
      reserves: [snapshot.reserves[0], snapshot.reserves[1]],
      references: [snapshot.references[0], snapshot.references[1]],
      assets: [...snapshot.assets],
      balances: [snapshot.balances[0], snapshot.balances[1]],
      lastUpdateTimestamp: snapshot.lastUpdateTimestamp,
    }),
  },
} satisfies PricingSemantics<Descriptor, Route, Descriptor, State>;
