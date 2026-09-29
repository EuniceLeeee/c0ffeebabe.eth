import { type PricingSemantics } from "../../adapter-family-plugin.js";
import { compileAddressMutations } from "../../mutation-index.js";
import { protocolMid, sameAddress } from "../standard-family/common.js";
import { assertInvocation, staticProjection } from "./binding.js";
import { bearCapacity, bearStateRequests, decodeBearState, quoteBear, type BearState } from "./bear-local.js";
import type { ConversionDescriptor, ConversionPricingDescriptor, ConversionRoute, ConversionSnapshot, Direction } from "./types.js";
import { xwinCurrent } from "./xwin-pricing.js";
import { xwinStateRequests } from "./xwin.js";

function sample(s: BearState, direction: Direction) {
  const capacity = bearCapacity(s, direction);
  return capacity < 10n ** 18n ? capacity : 10n ** 18n;
}
export const pricing = {
  // Family-wide policy: BTBB also pays per-block effective refresh costs.
  // The current coordinator retains startup raw mids as amount references.
  // xWin execution depends on elapsed blocks as well as mutable callees/caller.
  refreshPolicy: "each-block",
  stateKey: route => route.instanceKey,
  staticBindingProjection: ({ descriptor }) => staticProjection(descriptor),
  snapshotCompatibilityProjection: ({ descriptor }) => staticProjection(descriptor),
  compileDraft({ descriptor, stateKey, routes }) {
    if (stateKey !== descriptor.instanceKey || routes.length !== 2 || new Set(routes.map(r => r.direction)).size !== 2) throw new Error("conversion pricing route set mismatch");
    routes.forEach(r => assertInvocation(descriptor, r));
    return { ...descriptor, routes };
  },
  finalizePricingDescriptor: ({ draft }) => draft,
  current: {
    requirements: i => i.descriptor.variant === "xwin-allocations-v1" ? xwinCurrent.requirements() : { transports: ["get-code", "eth-call"] },
    buildRequests: ({ descriptor: d }) => d.variant === "xwin-allocations-v1" ? xwinStateRequests("current-xwin", d.target) : bearStateRequests("current", d),
    buildDependentProgram({ current, completedRound, initialResults, priorEvidence }) {
      const d = current.descriptor;
      if (d.variant === "xwin-allocations-v1") return xwinCurrent.buildDependentProgram({ current: { ...current, descriptor: d }, completedRound, initialResults, priorEvidence });
      return null;
    },
    decodeSnapshot({ descriptor: d, initialResults, dependentEvidence }) {
      if (d.variant === "xwin-allocations-v1") return xwinCurrent.decodeSnapshot({ descriptor: d, initialResults, dependentEvidence });
      if (dependentEvidence.length) throw new Error("unexpected bear dependent evidence");
      const s = decodeBearState("current", d, initialResults);
      const quotes: Record<string, { amountIn: bigint; amountOut: bigint }> = {};
      for (const r of d.routes) {
        const amountIn = sample(s, r.direction);
        if (amountIn === 0n) continue;
        quotes[r.routeKey] = { amountIn, amountOut: quoteBear(s, r.direction, amountIn) };
      }
      return { ...s, quotes };
    },
    deriveMids({ descriptor, snapshot, routes }) {
      return new Map(routes.flatMap(route => {
        const quote = snapshot.quotes[route.routeKey];
        return quote ? [[route.routeKey, protocolMid({ route, adapterId: route.adapterId, target: descriptor.target, quote })] as const] : [];
      }));
    },
    classifyUnavailable: ({ snapshot, routes }) => new Map(routes.filter(r => !snapshot.quotes[r.routeKey]).map(r => [r.routeKey, "conversion_no_probe_capacity"])),
  },
  dependencies: ({ descriptor: d }) => [d.target, d.asset],
  mutation: {
    compile: ({ entries }) => compileAddressMutations(entries, ({ descriptor: d }) => ({ addresses: [d.target, d.asset], keys: [d.instanceKey] }), { kinds: ["log", "call"] }),
    affectedStateKeys: ({ descriptor: d, observation: o }) => {
      const address = o.kind === "log" ? o.address : o.kind === "call" ? o.target : null;
      return address !== null && [d.target, d.asset].some(a => sameAddress(a, address)) ? [d.instanceKey] : [];
    },
  },
} satisfies PricingSemantics<ConversionDescriptor, ConversionRoute, ConversionPricingDescriptor, ConversionSnapshot>;
