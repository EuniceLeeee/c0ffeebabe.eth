import { bindRequestResultRound, collectRequestProgramResults, type CompiledMutationIndex, type PricingSemantics } from "../../adapter-family-plugin.js";
import { compileAddressMutations } from "../../mutation-index.js";
import type { AdapterRequestResult } from "../../adapter-request-program.js";
import { deriveEdgeTaxonomy } from "../../../strategy-taxonomy.js";
import { quotedPoolMid } from "../blockscan-state-shared.js";
import { EKUBO_CORE, EKUBO_ROUTER, encodeEkuboQuote, parseEkuboCoreSwapLog } from "../ekubo/abi.js";
import { call, decodeQuote, decodeSizingProbe, returned, same, validateResults } from "./codec.js";
import { staticBinding } from "./instance.js";
import { EKUBO_ACTION_ID } from "./manifest.js";
import { assertRoute } from "./routes.js";
import type { EkuboDescriptor, EkuboPricingDescriptor, EkuboPricingSnapshot, EkuboRoute } from "./types.js";

function probeInputs(descriptor: EkuboPricingDescriptor, results: readonly AdapterRequestResult[]) {
  const { instance, route } = descriptor;
  const unitIn = 10n ** BigInt(instance.decimals[Number(route.isToken1)]);
  const unitOut = 10n ** BigInt(instance.decimals[Number(!route.isToken1)]);
  const forward = decodeSizingProbe(returned(results, "current-unit-in").data, route.isToken1, unitIn);
  const reverse = decodeSizingProbe(returned(results, "current-unit-out").data, !route.isToken1, unitOut);
  // Two real unit quotes choose a scale meaningful in BOTH token domains.
  // These amounts are probes, not token valuations or asserted pool reserves.
  const witnessed = forward.filledAmountIn > reverse.amountOut ? forward.filledAmountIn : reverse.amountOut;
  // Conservative sizing seed only. Even this smaller depth MUST be re-quoted
  // with exact full input below; never publish a partial fill as capacity/mid.
  const depthIn = witnessed / 4n > 0n ? witnessed / 4n : 1n;
  const amountIn = depthIn / 10_000n > 0n ? depthIn / 10_000n : 1n;
  return { depthIn, amountIn };
}
export const ekuboPricing = {
  stateKey: route => route.routeKey,
  staticBindingProjection: ({ descriptor, routes }) => ({ ...staticBinding(descriptor), routeKeys: routes.map(r => r.routeKey) }),
  snapshotCompatibilityProjection: ({ descriptor, routes }) => ({ ...staticBinding(descriptor), routeKeys: routes.map(r => r.routeKey) }),
  compileDraft({ descriptor, routes }) {
    if (routes.length !== 1) throw new Error("ekubo pricing requires one direction");
    assertRoute(descriptor, routes[0]);
    return { instance: descriptor, route: routes[0] };
  },
  finalizePricingDescriptor: ({ draft }) => Object.freeze({ ...draft }),
  current: {
    requirements: () => ({ transports: ["eth-call"] }),
    buildRequests({ descriptor, routes }) {
      const { instance, route } = descriptor;
      assertRoute(instance, route);
      if (routes.length !== 1 || routes[0].routeKey !== route.routeKey) throw new Error("ekubo pricing route mismatch");
      return [false, true].map(reverse => call(reverse ? "current-unit-out" : "current-unit-in",
        encodeEkuboQuote(instance.poolKey, reverse ? !route.isToken1 : route.isToken1,
          10n ** BigInt(instance.decimals[Number(reverse ? !route.isToken1 : route.isToken1)]))));
    },
    buildDependentProgram({ current, completedRound, initialResults }) {
      if (completedRound !== 0) return null;
      validateResults(initialResults, ["current-unit-in", "current-unit-out"], current.source);
      const { amountIn, depthIn } = probeInputs(current.descriptor, initialResults);
      const { instance, route } = current.descriptor;
      return bindRequestResultRound({ transports: ["eth-call"] }, [
        call("current-small", encodeEkuboQuote(instance.poolKey, route.isToken1, amountIn)),
        call("current-depth", encodeEkuboQuote(instance.poolKey, route.isToken1, depthIn)),
      ]);
    },
    decodeSnapshot({ descriptor, initialResults, dependentEvidence }) {
      assertRoute(descriptor.instance, descriptor.route);
      const results = collectRequestProgramResults(initialResults, dependentEvidence);
      const source = validateResults(results, ["current-unit-in", "current-unit-out", "current-small", "current-depth"]);
      const { amountIn, depthIn } = probeInputs(descriptor, results);
      const small = decodeQuote(returned(results, "current-small").data, descriptor.route.isToken1, amountIn);
      const depth = decodeQuote(returned(results, "current-depth").data, descriptor.route.isToken1, depthIn);
      if (depth.amountOut < small.amountOut) throw new Error("ekubo inconsistent current quote depth");
      return Object.freeze({ source, amountIn, amountOut: small.amountOut, depthIn, depthOut: depth.amountOut, stateAfter: small.stateAfter });
    },
    deriveMids({ descriptor, routes, snapshot }) {
      if (routes.length !== 1 || routes[0].routeKey !== descriptor.route.routeKey) throw new Error("ekubo pricing route mismatch");
      const route = routes[0];
      assertRoute(descriptor.instance, route);
      return new Map([[route.routeKey, quotedPoolMid({ kind: "external-swap", amountIn: snapshot.amountIn, amountOut: snapshot.amountOut,
        // Conservative witnessed-size proxies, not total singleton balances or
        // a quote extrapolated to fictitious capacity. Router quote includes fees.
        depthIn: snapshot.depthIn, depthOut: snapshot.depthOut,
        edge: { adapterId: EKUBO_ACTION_ID, instanceKey: route.instanceKey, target: EKUBO_ROUTER,
          tokenIn: route.tokenIn, tokenOut: route.tokenOut, poolId: route.poolId,
          slotKind: "swap", ...deriveEdgeTaxonomy("swap") },
      })]]);
    },
  },
  dependencies: ({ descriptor }) => [EKUBO_CORE, EKUBO_ROUTER, descriptor.instance.poolKey.token0, descriptor.instance.poolKey.token1],
  mutation: {
    compile({ entries }): CompiledMutationIndex {
      const direct = compileAddressMutations(entries, ({ descriptor, routes }) => ({
        addresses: [EKUBO_CORE, EKUBO_ROUTER, descriptor.instance.poolKey.token0, descriptor.instance.poolKey.token1],
        keys: routes.map(route => route.routeKey),
      }), { kinds: ["log", "call"] });
      const core = EKUBO_CORE.toLowerCase();
      const poolKeys = new Map<string, Set<string>>();
      for (const entry of entries) {
        if (!entry.dependencies.some(address => address.toLowerCase() === core)) continue;
        const poolId = entry.descriptor.instance.poolId;
        const keys = poolKeys.get(poolId) ?? new Set<string>();
        for (const route of entry.routes) keys.add(route.routeKey);
        poolKeys.set(poolId, keys);
      }
      const pools = new Map([...poolKeys].map(([poolId, keys]) => [poolId, Object.freeze([...keys])]));
      return {
        dependencies: direct.dependencies,
        affectedStateKeys({ observation }) {
          if (observation.kind === "log" && observation.address.toLowerCase() === core && observation.topics.length === 0) {
            try {
              return pools.get(parseEkuboCoreSwapLog(observation.data).poolId) ?? [];
            } catch {
              // The old predicate conservatively invalidates all Core owners
              // on a malformed anonymous event; the direct index is that set.
            }
          }
          return direct.affectedStateKeys({ observation });
        },
      };
    },
    affectedStateKeys({ descriptor, routes, observation }) {
    if (observation.kind === "log" && same(observation.address, EKUBO_CORE) && observation.topics.length === 0) {
      try { if (parseEkuboCoreSwapLog(observation.data).poolId !== descriptor.instance.poolId) return []; } catch { /* conservatively invalidate */ }
    }
    const address = observation.kind === "call" ? observation.target : observation.kind === "log" ? observation.address : null;
    return address !== null && [EKUBO_CORE, EKUBO_ROUTER, descriptor.instance.poolKey.token0, descriptor.instance.poolKey.token1].some(a => same(a, address))
      ? routes.map(route => route.routeKey) : [];
  } },
  liveStateProjection: { project: ({ descriptor, snapshot }) => ({ kind: "ekubo-directed-router-quote", poolId: descriptor.instance.poolId,
    isToken1: descriptor.route.isToken1, ...snapshot, source: { ...snapshot.source } }) },
} satisfies PricingSemantics<EkuboDescriptor, EkuboRoute, EkuboPricingDescriptor, EkuboPricingSnapshot>;
