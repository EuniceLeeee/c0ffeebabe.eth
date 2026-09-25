import type { PricingSemantics } from "../../adapter-family-plugin.js";
import { compileAddressMutations } from "../../mutation-index.js";
import { quotedPoolMid } from "../blockscan-state-shared.js";
import { FEE_DENOMINATOR, MOONISWAP_ACTION, POOL, assertRoute, binding, call, lower, resultSet, returned, uint } from "./codec.js";
import { balanceRequest, bindingRequests, currentGovernance, decodeActive, governanceRound } from "./state.js";
import type { MooniswapDescriptor, MooniswapRoute, MooniswapSnapshot } from "./types.js";

const IDS = ["governance", "token0", "token1", "balance0", "balance1", "addition0", "addition1", "removal0", "removal1", "fee", "slippageFee"];
const dependencies = (d: MooniswapDescriptor) => [d.pool, d.token0, d.token1];
function unavailable(s: MooniswapSnapshot, forward: boolean): string | null {
  if (!s.active) return "mooniswap-factory-shutdown";
  if (s.balance0 === 0n || s.balance1 === 0n) return "mooniswap-empty-real-balance";
  if ((forward ? s.addition0 : s.addition1) === 0n || (forward ? s.removal1 : s.removal0) === 0n) return "mooniswap-empty-virtual-balance";
  return null;
}
export const mooniswapPricing = {
  // Virtual balances and voted parameters depend on the execution timestamp,
  // including blocks with no pool/token/governance observations.
  refreshPolicy: "each-block",
  stateKey: route => route.instanceKey,
  staticBindingProjection: ({ descriptor }) => binding(descriptor),
  snapshotCompatibilityProjection: ({ descriptor }) => binding(descriptor),
  compileDraft({ descriptor, stateKey, routes }) {
    if (stateKey !== descriptor.instanceKey || !routes.length || routes.length > 2 || new Set(routes.map(r => r.routeKey)).size !== routes.length) throw new Error("mooniswap invalid pricing group");
    routes.forEach(route => assertRoute(descriptor, route));
    return descriptor;
  },
  finalizePricingDescriptor: ({ draft }) => draft,
  current: {
    requirements: () => ({ transports: ["eth-call"], caller: "executor" }),
    buildRequests({ descriptor: d }) {
      return [...bindingRequests(d), balanceRequest("balance0", d.token0, d.pool), balanceRequest("balance1", d.token1, d.pool),
        ...([0, 1] as const).map(i => call(`addition${i}`, d.pool, POOL.encodeFunctionData("getBalanceForAddition", [i === 0 ? d.token0 : d.token1]))),
        ...([0, 1] as const).map(i => call(`removal${i}`, d.pool, POOL.encodeFunctionData("getBalanceForRemoval", [i === 0 ? d.token0 : d.token1]))),
        call("fee", d.pool, POOL.encodeFunctionData("fee")), call("slippageFee", d.pool, POOL.encodeFunctionData("slippageFee"))];
    },
    buildDependentProgram({ current, completedRound, initialResults }) {
      if (completedRound !== 0) return null;
      resultSet(initialResults, IDS, current.source);
      return governanceRound(current.descriptor, initialResults, current.source);
    },
    decodeSnapshot({ descriptor: d, initialResults: results, dependentEvidence }): MooniswapSnapshot {
      const source = resultSet(results, IDS), governance = currentGovernance(d, results, source);
      const read = (id: string) => uint(returned(results, id, source).data);
      const balance0 = read("balance0"), balance1 = read("balance1"), addition0 = read("addition0"), addition1 = read("addition1"),
        removal0 = read("removal0"), removal1 = read("removal1"), fee = read("fee"), slippageFee = read("slippageFee");
      if (addition0 < balance0 || addition1 < balance1 || removal0 > balance0 || removal1 > balance1 ||
          fee >= FEE_DENOMINATOR || slippageFee > FEE_DENOMINATOR) throw new Error("mooniswap invalid current virtual balances/fees");
      return { source, governance, active: decodeActive(dependentEvidence, source), balance0, balance1, addition0, addition1, removal0, removal1, fee, slippageFee };
    },
    deriveMids({ descriptor: d, snapshot: s, routes }) {
      const mids = new Map<MooniswapRoute["routeKey"], ReturnType<typeof quotedPoolMid>>();
      for (const route of routes) {
        assertRoute(d, route);
        const forward = lower(route.tokenIn) === lower(d.token0);
        if (unavailable(s, forward)) continue;
        const addition = forward ? s.addition0 : s.addition1, removal = forward ? s.removal1 : s.removal0;
        // Marginal rate uses CURRENT virtual balances and voted fee. Slippage
        // penalty tends to one at zero size. This is not a finite amount quote;
        // Exact always calls getReturn with the user's unchanged raw amount.
        mids.set(route.routeKey, quotedPoolMid({ kind: "external-swap", amountIn: addition * FEE_DENOMINATOR,
          amountOut: removal * (FEE_DENOMINATOR - s.fee), depthIn: forward ? s.balance0 : s.balance1,
          depthOut: forward ? s.balance1 : s.balance0, feeBps: Number(s.fee) / 1e14,
          edge: { adapterId: MOONISWAP_ACTION, instanceKey: route.instanceKey, target: d.pool, tokenIn: route.tokenIn, tokenOut: route.tokenOut,
            slotKind: "swap", edgeKind: "swap", leavesStandingPosition: false } }));
      }
      return mids;
    },
    classifyUnavailable({ descriptor, snapshot, routes }) {
      return new Map(routes.flatMap(route => {
        assertRoute(descriptor, route);
        const reason = unavailable(snapshot, lower(route.tokenIn) === lower(descriptor.token0));
        return reason ? [[route.routeKey, reason] as const] : [];
      }));
    },
  },
  dependencies: ({ descriptor }) => dependencies(descriptor),
  mutation: {
    compile: ({ entries }) => compileAddressMutations(entries, ({ descriptor }) => ({ addresses: dependencies(descriptor), keys: [descriptor.instanceKey] }), { kinds: ["log", "call"] }),
    affectedStateKeys({ descriptor, observation }) {
      const address = observation.kind === "log" ? observation.address : observation.kind === "call" ? observation.target : null;
      return address && dependencies(descriptor).some(d => lower(d) === lower(address)) ? [descriptor.instanceKey] : [];
    },
  },
  liveStateProjection: { project: ({ snapshot }) => ({ ...snapshot, source: { ...snapshot.source } }) },
} satisfies PricingSemantics<MooniswapDescriptor, MooniswapRoute, MooniswapDescriptor, MooniswapSnapshot>;
