import { ethers } from "ethers";
import { bindRequestResultRound, collectRequestProgramResults, type PricingSemantics } from "../../adapter-family-plugin.js";
import { VAULT, VAULT_ABI, call, assertSource, poolInfo, probeAmounts, queryData, quoteOutput, resultSet, resultSource, returned, same } from "./codec.js";
import { staticBinding } from "./instance.js";
import { assertRoute } from "./routes.js";
import { decodeSwapLog } from "./discovery.js";
import type { BalancerV2Descriptor, BalancerV2Route, BalancerV2PricingDescriptor, BalancerV2Snapshot } from "./types.js";
function state(d: BalancerV2PricingDescriptor, reads: Parameters<typeof resultSource>[0]) {
  assertRoute(d.instance, d.route);
  const info = poolInfo(returned(reads, "current-tokens").data), source = resultSource(reads);
  if (info.tokens.length !== d.instance.binding.tokens.length ||
      info.tokens.some((t, i) => !same(t, d.instance.binding.tokens[i])) || info.lastChangeBlock > BigInt(source.number)) {
    throw new Error("balancer-v2 current token binding changed");
  }
  const balanceIn = info.balances[d.route.i], balanceOut = info.balances[d.route.j];
  if (balanceIn <= 0n || balanceOut <= 0n) throw new Error("balancer-v2 no current liquidity");
  return { balanceIn, balanceOut, amounts: probeAmounts(d.instance.binding.decimals[d.route.i], balanceIn) };
}
export const pricing = {
  // Vault pools may depend on time, rates or mutable pool-side configuration.
  // No static-weight/local-state proof is assumed by this generic chain path.
  refreshPolicy: "each-block" as const,
  stateKey: route => route.routeKey,
  staticBindingProjection: ({ descriptor, routes }) => ({ ...staticBinding(descriptor), routeKeys: routes.map(r => r.routeKey) }),
  snapshotCompatibilityProjection: ({ descriptor, routes }) => ({ ...staticBinding(descriptor), routeKeys: routes.map(r => r.routeKey) }),
  compileDraft({ descriptor, routes }) {
    if (routes.length !== 1) throw new Error("balancer-v2 pricing requires one direction");
    assertRoute(descriptor, routes[0]); return { instance: descriptor, route: routes[0] };
  },
  finalizePricingDescriptor: ({ draft }) => Object.freeze({ ...draft }),
  current: {
    requirements: () => ({ transports: ["eth-call"] }),
    buildRequests({ descriptor: d }) {
      assertRoute(d.instance, d.route);
      return [call("current-tokens", VAULT, VAULT_ABI.encodeFunctionData("getPoolTokens", [d.instance.poolId]))];
    },
    buildDependentProgram({ current, completedRound, initialResults, priorEvidence }) {
      resultSet(initialResults, ["current-tokens"], current.source);
      if (completedRound > 1) return null;
      const reads = collectRequestProgramResults(initialResults, priorEvidence);
      assertSource(resultSource(reads), current.source);
      const { amounts, balanceOut } = state(current.descriptor, reads);
      if (completedRound === 1) {
        const matches = reads.filter(r => r.id === "current-quote:0");
        if (matches.length !== 1) throw new Error("balancer-v2 missing/duplicate first quote");
        const read = matches[0];
        if (read.ok && read.completion === "returned") {
          const amountOut = quoteOutput(read.data, amounts[0], true);
          if (amountOut > balanceOut) throw new Error("balancer-v2 output exceeds registered balance");
          if (amountOut > 0n) return null;
        }
      }
      const offset = completedRound === 0 ? 0 : 1;
      const probes = completedRound === 0 ? amounts.slice(0, 1) : amounts.slice(1);
      if (!probes.length) return null;
      const d = current.descriptor;
      return bindRequestResultRound({ transports: ["eth-call"] }, probes.map((amount, i) => ({
        ...call("current-quote:" + (i + offset), VAULT,
          queryData(d.instance.poolId, d.route.tokenIn, d.route.tokenOut, amount, ethers.ZeroAddress)), required: false,
      })));
    },
    decodeSnapshot({ descriptor: d, initialResults, dependentEvidence }) {
      resultSet(initialResults, ["current-tokens"]);
      const reads = collectRequestProgramResults(initialResults, dependentEvidence), source = resultSource(reads);
      const { balanceIn, balanceOut, amounts } = state(d, reads);
      for (let i = 0; i < amounts.length; i++) {
        const matches = reads.filter(r => r.id === "current-quote:" + i);
        if (matches.length !== 1) throw new Error("balancer-v2 missing/duplicate current quote");
        const read = matches[0];
        if (!read.ok || read.completion !== "returned") continue;
        const amountOut = quoteOutput(read.data, amounts[i], true);
        if (amountOut === 0n) continue;
        if (amountOut > balanceOut) throw new Error("balancer-v2 output exceeds registered balance");
        return Object.freeze({ source, balanceIn, balanceOut, amountIn: amounts[i], amountOut });
      }
      throw new Error("balancer-v2 current quote unresolved");
    },
    deriveMids({ descriptor: d, snapshot: s, routes }) {
      if (routes.length !== 1 || routes[0].routeKey !== d.route.routeKey) throw new Error("balancer-v2 pricing route mismatch");
      const r = routes[0]; assertRoute(d.instance, r);
      const mid = Number(s.amountOut) / Number(s.amountIn);
      if (!Number.isFinite(mid) || mid <= 0 || s.balanceIn <= 0n || s.balanceOut <= 0n) throw new Error("balancer-v2 invalid mid");
      return new Map([[r.routeKey, { kind: "external-swap" as const, pool: d.instance.pool,
        edges: [{ adapterId: "balancer-v2-vault-swap", target: d.instance.pool, tokenIn: r.tokenIn, tokenOut: r.tokenOut,
          instanceKey: r.instanceKey, slotKind: "swap" as const, edgeKind: "swap" as const, leavesStandingPosition: false }],
        mid, feeBps: 0, reserveA: s.balanceIn, reserveB: s.balanceOut,
        depthProxy: Number(s.balanceIn < s.balanceOut ? s.balanceIn : s.balanceOut) }]]);
    },
  },
  dependencies: ({ descriptor: d }) => [VAULT, d.instance.pool, ...d.instance.binding.tokens],
  mutation: {
    affectedStateKeys({ descriptor: d, routes, observation }) {
      if (observation.kind === "log" && same(observation.address, VAULT)) {
        const swap = decodeSwapLog(observation);
        return !swap || swap.poolId === d.instance.poolId ? routes.map(r => r.routeKey) : [];
      }
      const target = observation.kind === "call" ? observation.target : observation.kind === "log" ? observation.address : null;
      return target && (same(target, VAULT) || same(target, d.instance.pool)) ? routes.map(r => r.routeKey) : [];
    },
  },
  liveStateProjection: { project: ({ descriptor: d, snapshot: s }) => ({
    kind: "balancer-v2-vault-exact-in", pool: d.instance.pool, poolId: d.instance.poolId, i: d.route.i, j: d.route.j,
    ...s, source: { ...s.source },
  }) },
} satisfies PricingSemantics<BalancerV2Descriptor, BalancerV2Route, BalancerV2PricingDescriptor, BalancerV2Snapshot>;
