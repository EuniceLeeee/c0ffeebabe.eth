import { bindRequestResultRound, collectRequestProgramResults, type PricingSemantics } from "../../adapter-family-plugin.js";
import { assertSameSource, codeRequest, protocolMid, requireRuntimeCode, successfulResult } from "../standard-family/common.js";
import { xwinSimulationRequirements as simulationRequirements } from "./xwin.js";
import { assertXwinBinding, checkXwinDependencies, decodeXwinReceipt, decodeXwinSurface, xwinDependencyRequests, xwinSimulation, xwinStateRequests } from "./xwin.js";
import type { ConversionDescriptor, ConversionPricingDescriptor, ConversionRoute, ConversionSnapshot } from "./types.js";

type Descriptor = Extract<ConversionDescriptor, { variant: "xwin-allocations-v1" }>;
type PricingDescriptor = Extract<ConversionPricingDescriptor, { variant: "xwin-allocations-v1" }>;
export const xwinCurrent = {
  requirements: () => ({ transports: ["get-code", "get-storage", "eth-call"], caller: "executor" }),
  buildRequests: ({ descriptor: d }) => xwinStateRequests("current-xwin", d.target),
  buildDependentProgram({ current: { descriptor: d }, completedRound, initialResults, priorEvidence }) {
    const s = decodeXwinSurface(initialResults, "current-xwin", d.target);
    assertXwinBinding(s, d);
    if (completedRound === 0) return bindRequestResultRound({ transports: ["get-code", "eth-call"], caller: "executor" }, xwinDependencyRequests("current-xwin", s));
    const results = collectRequestProgramResults(initialResults, priorEvidence);
    const unit = checkXwinDependencies(results, "current-xwin", s);
    const redeemAmount = s.supply < 10n ** 18n ? s.supply : 10n ** 18n;
    if (completedRound === 1) return bindRequestResultRound(simulationRequirements, [
      xwinSimulation("current-xwin-mint", s, "mint", unit),
      ...(redeemAmount === 0n ? [] : [xwinSimulation("current-xwin-redeem", s, "redeem", redeemAmount)]),
    ]);
    const mint = decodeXwinReceipt(results, "current-xwin-mint", s, "mint", unit);
    if (redeemAmount > 0n) decodeXwinReceipt(results, "current-xwin-redeem", s, "redeem", redeemAmount, mint.actor);
    if (completedRound === 2) return bindRequestResultRound({ transports: ["get-code"] }, [codeRequest("current-xwin-actor-code", mint.actor)]);
    return null;
  },
  decodeSnapshot({ descriptor: d, initialResults, dependentEvidence }) {
    const s = decodeXwinSurface(initialResults, "current-xwin", d.target);
    assertXwinBinding(s, d);
    const results = collectRequestProgramResults(initialResults, dependentEvidence);
    const source = assertSameSource(results.map(r => successfulResult(results, r.id)));
    const unit = checkXwinDependencies(results, "current-xwin", s);
    const redeemAmount = s.supply < 10n ** 18n ? s.supply : 10n ** 18n;
    requireRuntimeCode(results, "current-xwin-actor-code");
    const mint = decodeXwinReceipt(results, "current-xwin-mint", s, "mint", unit);
    const redeem = redeemAmount === 0n ? null : decodeXwinReceipt(results, "current-xwin-redeem", s, "redeem", redeemAmount, mint.actor);
    const quotes = Object.fromEntries(d.routes.flatMap(r => {
      const quote = r.direction === "mint" ? { amountIn: unit, amountOut: mint.amountOut } :
        redeem === null ? null : { amountIn: redeemAmount, amountOut: redeem.amountOut };
      return quote === null ? [] : [[r.routeKey, quote]];
    }));
    return { source, supply: s.supply, backing: 0n, quotes };
  },
  deriveMids: ({ descriptor, snapshot, routes }) => new Map(routes.flatMap(route => {
    const quote = snapshot.quotes[route.routeKey];
    return quote ? [[route.routeKey, protocolMid({ route, adapterId: route.adapterId, target: descriptor.target, quote })] as const] : [];
  })),
  classifyUnavailable: ({ snapshot, routes }) => new Map(routes.filter(r => !snapshot.quotes[r.routeKey]).map(r => [r.routeKey, "xwin_no_redeem_supply"])),
} satisfies PricingSemantics<Descriptor, ConversionRoute, PricingDescriptor, ConversionSnapshot>["current"];
