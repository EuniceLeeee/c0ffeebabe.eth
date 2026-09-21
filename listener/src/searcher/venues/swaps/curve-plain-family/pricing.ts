import { compileAddressMutations } from "../../mutation-index.js";
import { bindRequestResultRound, collectRequestProgramResults, type PricingSemantics } from "../../adapter-family-plugin.js";
import { deriveEdgeTaxonomy } from "../../../strategy-taxonomy.js";
import { quotedPoolMid } from "../blockscan-state-shared.js";
import { POOL, call, getterPool, probeAmount, quotePool, resultSource, returned, same, uint } from "./codec.js";
import { staticBinding } from "./instance.js";
import { actionId, assertRoute } from "./routes.js";
import type { CurvePlainDescriptor, CurvePlainPricingDescriptor, CurvePlainPricingSnapshot, CurvePlainRoute } from "./types.js";

export const curvePlainPricing = {
  stateKey: route => route.routeKey,
  staticBindingProjection: ({ descriptor, routes }) => ({ ...staticBinding(descriptor), routeKeys: routes.map(r => r.routeKey) }),
  snapshotCompatibilityProjection: ({ descriptor, routes }) => ({ ...staticBinding(descriptor), routeKeys: routes.map(r => r.routeKey) }),
  compileDraft({ descriptor, routes }) {
    if (routes.length !== 1) throw new Error("curve-plain pricing requires one direction");
    assertRoute(descriptor, routes[0]);
    return { instance: descriptor, route: routes[0] };
  },
  finalizePricingDescriptor: ({ draft }) => Object.freeze({ ...draft }),
  current: {
    requirements: () => ({ transports: ["eth-call"] }),
    buildRequests({ descriptor }) {
      const { instance, route } = descriptor;
      assertRoute(instance, route);
      const balances = getterPool(instance.binding.balanceAbi);
      return [call("current-A", instance.pool, POOL.encodeFunctionData("A")),
        call("current-fee", instance.pool, POOL.encodeFunctionData("fee")),
        call("current-balance-in", instance.pool, balances.encodeFunctionData("balances", [route.i])),
        call("current-balance-out", instance.pool, balances.encodeFunctionData("balances", [route.j]))];
    },
    buildDependentProgram({ current, completedRound, initialResults }) {
      if (completedRound !== 0) return null;
      const { instance, route } = current.descriptor;
      const balanceIn = uint(returned(initialResults, "current-balance-in").data);
      const amountIn = probeAmount(instance.binding.decimals[route.i], balanceIn);
      return bindRequestResultRound({ transports: ["eth-call"] }, [
        call("current-get-dy", instance.pool, quotePool(route.quoteAbi).encodeFunctionData("get_dy", [route.i, route.j, amountIn])),
      ]);
    },
    decodeSnapshot({ descriptor, initialResults, dependentEvidence }) {
      const results = collectRequestProgramResults(initialResults, dependentEvidence);
      const source = resultSource(results);
      const balanceIn = uint(returned(results, "current-balance-in").data);
      const balanceOut = uint(returned(results, "current-balance-out").data);
      const amplification = uint(returned(results, "current-A").data);
      const fee = uint(returned(results, "current-fee").data);
      const amountOut = uint(returned(results, "current-get-dy").data);
      if (amplification <= 0n || fee >= 10_000_000_000n || amountOut <= 0n || amountOut >= balanceOut) {
        throw new Error("curve-plain no valid current liquidity/quote");
      }
      return Object.freeze({ source, balanceIn, balanceOut, amplification, fee, amountOut,
        amountIn: probeAmount(descriptor.instance.binding.decimals[descriptor.route.i], balanceIn) });
    },
    deriveMids({ descriptor, routes, snapshot }) {
      if (routes.length !== 1 || routes[0].routeKey !== descriptor.route.routeKey) throw new Error("curve-plain pricing route mismatch");
      const route = routes[0];
      assertRoute(descriptor.instance, route);
      return new Map([[route.routeKey, quotedPoolMid({ kind: "curve", amountIn: snapshot.amountIn,
        amountOut: snapshot.amountOut, depthIn: snapshot.balanceIn, depthOut: snapshot.balanceOut,
        // get_dy already includes static and NG dynamic fees; do not subtract again.
        edge: { adapterId: actionId(route.executionMode), instanceKey: route.instanceKey, target: route.pool,
          tokenIn: route.tokenIn, tokenOut: route.tokenOut, slotKind: "swap", ...deriveEdgeTaxonomy("swap") },
      })]]);
    },
  },
  dependencies: ({ descriptor }) => [descriptor.instance.pool, descriptor.instance.binding.registry, ...descriptor.instance.binding.coins],
  mutation: {
    compile: ({ entries }) => compileAddressMutations(entries, ({ descriptor, routes }) => ({
      addresses: [descriptor.instance.pool, ...descriptor.instance.binding.coins],
      keys: routes.map(route => route.routeKey),
    }), { kinds: ["log", "call"] }),
    affectedStateKeys({ descriptor, routes, observation }) {
    const target = observation.kind === "call" ? observation.target : observation.kind === "log" ? observation.address : null;
    return target !== null && [descriptor.instance.pool, ...descriptor.instance.binding.coins].some(a => same(a, target))
      ? routes.map(route => route.routeKey) : [];
  } },
  liveStateProjection: { project: ({ descriptor, snapshot }) => ({ kind: "curve-plain-directed-get-dy",
    pool: descriptor.instance.pool, i: descriptor.route.i, j: descriptor.route.j, ...snapshot, source: { ...snapshot.source } }) },
} satisfies PricingSemantics<CurvePlainDescriptor, CurvePlainRoute, CurvePlainPricingDescriptor, CurvePlainPricingSnapshot>;
