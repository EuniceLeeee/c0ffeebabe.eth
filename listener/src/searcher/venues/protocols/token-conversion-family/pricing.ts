import { bindRequestResultRound, collectRequestProgramResults, type PricingSemantics } from "../../adapter-family-plugin.js";
import type { AdapterRequestResult } from "../../adapter-request-program.js";
import { compileAddressMutations } from "../../mutation-index.js";
import { assertSameSource, callRequest, codeRequest, decodeUint, protocolMid, requireRuntimeCode, sameAddress, successfulResult } from "../standard-family/common.js";
import { assertInvocation, staticProjection } from "./binding.js";
import { ABI, MAX_UINT, proveBearRuntime } from "./variants.js";
import { proveConversionAssetRuntime } from "./asset-runtime.js";
import { conversionSimulation, decodeConversionReceipt, simulationRequirements } from "./simulation.js";
import type { ConversionDescriptor, ConversionPricingDescriptor, ConversionRoute, ConversionSnapshot, Direction } from "./types.js";
import { xwinCurrent } from "./xwin-pricing.js";
import { xwinStateRequests } from "./xwin.js";

function state(d: ConversionDescriptor, results: readonly AdapterRequestResult[]) {
  if (d.variant !== "btb-bear-v1") throw new Error("bear state decoder received another conversion variant");
  const source = assertSameSource(results.map(r => successfulResult(results, r.id)));
  if (proveBearRuntime(requireRuntimeCode(results, "current-code"), d.target, d.asset) !== d.codeHash) throw new Error("conversion runtime changed");
  if (proveConversionAssetRuntime(requireRuntimeCode(results, "current-asset-code"), d.asset) !== d.assetCodeHash) throw new Error("conversion asset runtime changed");
  return { source, supply: decodeUint(ABI, "totalSupply", results, "current-supply"), backing: decodeUint(ABI, "balanceOf", results, "current-backing") };
}
function sample(s: { supply: bigint; backing: bigint }, direction: Direction) {
  return (direction === "mint" ? [10n ** 18n, MAX_UINT - s.supply] : [10n ** 18n, s.supply, s.backing]).reduce((a,b) => a < b ? a : b);
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
    buildRequests: ({ descriptor: d }) => d.variant === "xwin-allocations-v1" ? xwinStateRequests("current-xwin", d.target) : [
      codeRequest("current-code", d.target),
      codeRequest("current-asset-code", d.asset),
      callRequest("current-supply", d.target, ABI.encodeFunctionData("totalSupply")),
      callRequest("current-backing", d.asset, ABI.encodeFunctionData("balanceOf", [d.target])),
    ],
    buildDependentProgram({ current, completedRound, initialResults, priorEvidence }) {
      const d = current.descriptor;
      if (d.variant === "xwin-allocations-v1") return xwinCurrent.buildDependentProgram({ current: { ...current, descriptor: d }, completedRound, initialResults, priorEvidence });
      if (completedRound !== 0) return null;
      const s = state(d, initialResults);
      const requests = d.routes.flatMap(r => {
        const amount = sample(s, r.direction);
        return amount > 0n ? [conversionSimulation(`current-${r.direction}`, d.target, d.asset, r.direction, amount)] : [];
      });
      return requests.length ? bindRequestResultRound(simulationRequirements, requests) : null;
    },
    decodeSnapshot({ descriptor: d, initialResults, dependentEvidence }) {
      if (d.variant === "xwin-allocations-v1") return xwinCurrent.decodeSnapshot({ descriptor: d, initialResults, dependentEvidence });
      const s = state(d, initialResults);
      const results = collectRequestProgramResults(initialResults, dependentEvidence);
      assertSameSource(results.map(r => successfulResult(results, r.id)));
      const quotes: Record<string, { amountIn: bigint; amountOut: bigint }> = {};
      for (const r of d.routes) {
        const amountIn = sample(s, r.direction);
        if (amountIn === 0n) continue;
        const receipt = decodeConversionReceipt(results, `current-${r.direction}`, d.target, d.asset, r.direction, amountIn);
        quotes[r.routeKey] = { amountIn, amountOut: receipt.amountOut };
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
