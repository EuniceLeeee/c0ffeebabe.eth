import { bindRequestResultRound, collectRequestProgramResults, type PricingSemantics } from "../../adapter-family-plugin.js";
import { Interface } from "ethers";
import { assertSameSource, callRequest, codeRequest, protocolMid, requireRuntimeCode, returnedResult, successfulResult } from "../standard-family/common.js";
import { xwinSimulationRequirements as simulationRequirements } from "./xwin.js";
import { assertXwinBinding, checkXwinDependencies, decodeXwinReceipt, decodeXwinSurface, xwinDependencyRequests, xwinSimulation, xwinStateRequests } from "./xwin.js";
import type { ConversionDescriptor, ConversionPricingDescriptor, ConversionRoute, ConversionSnapshot } from "./types.js";

type Descriptor = Extract<ConversionDescriptor, { variant: "xwin-allocations-v1" }>;
type PricingDescriptor = Extract<ConversionPricingDescriptor, { variant: "xwin-allocations-v1" }>;
// Explicit execution-receipt baseline for same-state validation only. Startup
// pricing uses the NAV reference below; this is not its fallback.
export const xwinSimulationCurrent = {
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

const NAV_ABI = new Interface(["function getUnitPrice() view returns(uint256)"]);
const WAD = 10n ** 18n;
export const xwinCurrent = {
  requirements: () => ({ transports: ["get-code", "get-storage", "eth-call"], caller: "executor" }),
  buildRequests: ({ descriptor: d }) => xwinStateRequests("current-xwin", d.target),
  buildDependentProgram({ current: { descriptor: d }, completedRound, initialResults }) {
    const s = decodeXwinSurface(initialResults, "current-xwin", d.target);
    assertXwinBinding(s, d);
    return completedRound === 0 ? bindRequestResultRound({ transports: ["get-code", "eth-call"], caller: "executor" }, [
      ...xwinDependencyRequests("current-xwin", s),
      callRequest("current-xwin-nav", s.target, NAV_ABI.encodeFunctionData("getUnitPrice"), { kind: "executor" }),
    ]) : null;
  },
  decodeSnapshot({ descriptor: d, initialResults, dependentEvidence }) {
    const s = decodeXwinSurface(initialResults, "current-xwin", d.target);
    assertXwinBinding(s, d);
    const results = collectRequestProgramResults(initialResults, dependentEvidence);
    const unit = checkXwinDependencies(results, "current-xwin", s);
    const normalizedNav = BigInt(NAV_ABI.decodeFunctionResult("getUnitPrice", returnedResult(results, "current-xwin-nav").data)[0]);
    const scale = WAD / unit;
    if (normalizedNav % scale !== 0n) throw new Error("xWin normalized NAV is not an integral base-token reference");
    const navBase = normalizedNav / scale;
    // These reciprocal points express NAV in raw token units, solely for the
    // frozen startup amount-sizing table. They are NOT deposit/withdraw amounts:
    // neither internal V3 impact nor caller-specific fees are approximated here.
    // Effective and Solver always use the full local amount transition instead.
    const quotes = Object.fromEntries(d.routes.flatMap(route => navBase === 0n ? [] : [[route.routeKey,
      route.direction === "mint" ? { amountIn: navBase, amountOut: WAD } : { amountIn: WAD, amountOut: navBase }]]));
    return { source: s.source, supply: s.supply, backing: 0n, quotes };
  },
  deriveMids: xwinSimulationCurrent.deriveMids,
  classifyUnavailable: ({ snapshot, routes }) => new Map(routes.filter(route => !snapshot.quotes[route.routeKey]).map(route => [route.routeKey, "xwin_zero_nav_reference"])),
} satisfies PricingSemantics<Descriptor, ConversionRoute, PricingDescriptor, ConversionSnapshot>["current"];
