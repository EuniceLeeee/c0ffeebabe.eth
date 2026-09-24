import { ethers } from "ethers";
import { bindRequestResultRound, collectRequestProgramResults, type CompiledMutationIndex, type PricingSemantics } from "../../adapter-family-plugin.js";
import { compileAddressMutations, createMutationLookup } from "../../mutation-index.js";
import { VAULT, ROUTER, PERMIT2, VAULT_ABI, assertSource, call, hooksConfig, poolInfo, probeAmounts, queryData,
  resultSource, returned, same, uint } from "./codec.js";
import { staticBinding } from "./instance.js";
import { assertRoute } from "./routes.js";
import { decodeSwapLog } from "./discovery.js";
import type { BalancerV3Descriptor, BalancerV3PricingDescriptor, BalancerV3Route, BalancerV3Snapshot } from "./types.js";
import { decodeLocalState, localStateRequests, quoteLocal } from "./local-state.js";

function state(descriptor: BalancerV3PricingDescriptor, results: Parameters<typeof resultSource>[0]) {
  assertRoute(descriptor.instance, descriptor.route);
  const info = poolInfo(returned(results, "current-tokens").data);
  const binding = descriptor.instance.binding;
  const hooks = hooksConfig(returned(results, "current-hooks").data);
  if (info.tokens.length !== binding.tokens.length || info.tokens.some((token, i) => !same(token, binding.tokens[i]) ||
      info.tokenInfo[i].tokenType !== binding.tokenInfo[i].tokenType ||
      !same(info.tokenInfo[i].rateProvider, binding.tokenInfo[i].rateProvider) ||
      info.tokenInfo[i].paysYieldFees !== binding.tokenInfo[i].paysYieldFees) ||
      !same(hooks.address, binding.hooks.address) || hooks.flags.some((flag, i) => flag !== binding.hooks.flags[i])) {
    throw new Error("balancer-v3 current binding changed");
  }
  const balanceIn = info.balances[descriptor.route.i], balanceOut = info.balances[descriptor.route.j];
  if (balanceIn <= 0n || balanceOut <= 0n) throw new Error("balancer-v3 no current liquidity");
  return { balanceIn, balanceOut, amounts: probeAmounts(binding.decimals[descriptor.route.i], balanceIn) };
}
export const balancerV3Pricing = {
  // A ramps and rate providers can change with block time without pool logs.
  // The existing coordinator refreshes raw and effective together; no private cache.
  refreshPolicy: "each-block" as const,
  stateKey: route => route.routeKey,
  staticBindingProjection: ({ descriptor, routes }) => ({ ...staticBinding(descriptor), routeKeys: routes.map(route => route.routeKey) }),
  snapshotCompatibilityProjection: ({ descriptor, routes }) => ({ ...staticBinding(descriptor), routeKeys: routes.map(route => route.routeKey) }),
  compileDraft({ descriptor, routes }) {
    if (routes.length !== 1) throw new Error("balancer-v3 pricing requires one direction");
    assertRoute(descriptor, routes[0]);
    return { instance: descriptor, route: routes[0] };
  },
  finalizePricingDescriptor: ({ draft }) => Object.freeze({ ...draft }),
  current: {
    requirements: () => ({ transports: ["eth-call"] }),
    buildRequests({ descriptor }) {
      assertRoute(descriptor.instance, descriptor.route);
      if (descriptor.instance.binding.localModel) return localStateRequests(descriptor.instance);
      return [call("current-tokens", VAULT, VAULT_ABI.encodeFunctionData("getPoolTokenInfo", [descriptor.instance.pool])),
        call("current-hooks", VAULT, VAULT_ABI.encodeFunctionData("getHooksConfig", [descriptor.instance.pool]))];
    },
    buildDependentProgram({ current, completedRound, initialResults, priorEvidence }) {
      if (current.descriptor.instance.binding.localModel) return null;
      if (completedRound > 1) return null;
      const results = collectRequestProgramResults(initialResults, priorEvidence);
      assertSource(resultSource(results), current.source);
      const { amounts, balanceOut } = state(current.descriptor, results);
      if (completedRound === 1) {
        const matches = results.filter(read => read.id === "current-quote:0");
        if (matches.length !== 1) throw new Error("balancer-v3 missing/duplicate current quote");
        const read = matches[0];
        if (read.ok && read.completion === "returned") {
          const amountOut = uint(read.data);
          if (amountOut > 0n && amountOut < balanceOut) return null;
        }
      }
      // The decoder chooses the first usable probe; fetch the rest only if needed.
      const offset = completedRound === 0 ? 0 : 1;
      const probes = completedRound === 0 ? amounts.slice(0, 1) : amounts.slice(1);
      if (probes.length === 0) return null;
      const { route } = current.descriptor;
      return bindRequestResultRound({ transports: ["eth-call"] }, probes.map((amount, i) => ({
        ...call(`current-quote:${i + offset}`, ROUTER, queryData(route.pool, route.tokenIn, route.tokenOut, amount, ethers.ZeroAddress)),
        required: false,
      })));
    },
    decodeSnapshot({ descriptor, initialResults, dependentEvidence }) {
      if (descriptor.instance.binding.localModel) {
        if (dependentEvidence.length !== 0) throw new Error("balancer-v3 unexpected local pricing round");
        const local = decodeLocalState(descriptor.instance, initialResults);
        const { route } = descriptor;
        const balanceIn = local.balancesRaw[route.i], balanceOut = local.balancesRaw[route.j];
        for (const amountIn of probeAmounts(descriptor.instance.binding.decimals[route.i], balanceIn)) {
          // Preserve the existing first-usable probe policy, now with no quote I/O.
          try {
            const amountOut = quoteLocal(descriptor.instance, route, local, amountIn, local.source);
            if (amountOut > 0n && amountOut < balanceOut) return Object.freeze({
              source: local.source, balanceIn, balanceOut, amountIn, amountOut });
          } catch { /* A minimum/maximum amount failure is not a pool rejection. */ }
        }
        throw new Error("balancer-v3 local current quote unresolved");
      }
      const results = collectRequestProgramResults(initialResults, dependentEvidence);
      const source = resultSource(results);
      const { balanceIn, balanceOut, amounts } = state(descriptor, results);
      for (let i = 0; i < amounts.length; i++) {
        const matches = results.filter(read => read.id === `current-quote:${i}`);
        if (matches.length !== 1) throw new Error("balancer-v3 missing/duplicate current quote");
        const read = matches[0];
        if (!read.ok || read.completion !== "returned") continue;
        const amountOut = uint(read.data);
        if (amountOut > 0n && amountOut < balanceOut) return Object.freeze({ source, balanceIn, balanceOut, amountIn: amounts[i], amountOut });
      }
      // Reverts at selected amounts are not proof that every amount is unavailable.
      throw new Error("balancer-v3 current quote unresolved");
    },
    deriveMids({ descriptor, snapshot, routes }) {
      if (routes.length !== 1 || routes[0].routeKey !== descriptor.route.routeKey) throw new Error("balancer-v3 pricing route mismatch");
      const route = routes[0]; assertRoute(descriptor.instance, route);
      const mid = Number(snapshot.amountOut) / Number(snapshot.amountIn);
      if (!Number.isFinite(mid) || mid <= 0 || snapshot.balanceIn <= 0n || snapshot.balanceOut <= 0n) throw new Error("balancer-v3 invalid mid");
      return new Map([[route.routeKey, { kind: "external-swap" as const, pool: route.pool,
        edges: [{ adapterId: "balancer-v3-router-swap", target: route.pool, tokenIn: route.tokenIn, tokenOut: route.tokenOut,
          instanceKey: route.instanceKey, slotKind: "swap" as const, edgeKind: "swap" as const, leavesStandingPosition: false }],
        mid, feeBps: 0, reserveA: snapshot.balanceIn, reserveB: snapshot.balanceOut,
        depthProxy: Number(snapshot.balanceIn < snapshot.balanceOut ? snapshot.balanceIn : snapshot.balanceOut) }]]);
    },
  },
  dependencies: ({ descriptor }) => [...new Set([descriptor.instance.pool, VAULT, ROUTER, PERMIT2,
    ...descriptor.instance.binding.tokens, ...[descriptor.instance.binding.hooks.address, ...descriptor.instance.binding.tokenInfo.map(info => info.rateProvider)]
      .filter(address => address !== ethers.ZeroAddress)])],
  mutation: {
    compile({ entries }): CompiledMutationIndex {
      const direct = compileAddressMutations(entries, ({ descriptor, routes }) => ({
        addresses: [descriptor.instance.pool, ...descriptor.instance.binding.tokens,
          descriptor.instance.binding.hooks.address, ...descriptor.instance.binding.tokenInfo.map(info => info.rateProvider)],
        keys: routes.map(route => route.routeKey),
      }), { kinds: ["log", "call"] });
      const vault = VAULT.toLowerCase();
      const pools = createMutationLookup();
      for (const entry of entries) {
        // Preserve the old per-entry dependency gate, not merely its union.
        if (entry.dependencies.some(address => address.toLowerCase() === vault)) {
          pools.add(entry.descriptor.instance.pool, entry.routes.map(route => route.routeKey));
        }
      }
      return {
        dependencies: [...new Set([...direct.dependencies, ...(pools.addresses().length === 0 ? [] : [vault])])],
        affectedStateKeys({ observation }) {
          // Vault logs always take this branch, including when Vault also
          // appears as a token/hook dependency. Decode once for all directions.
          if (observation.kind === "log" && observation.address.toLowerCase() === vault) {
            const swap = decodeSwapLog(observation);
            return swap === null ? [] : pools.get(swap.pool);
          }
          return direct.affectedStateKeys({ observation });
        },
      };
    },
    affectedStateKeys({ descriptor, routes, observation }) {
    if (observation.kind === "log" && same(observation.address, VAULT)) {
      const swap = decodeSwapLog(observation);
      return swap && same(swap.pool, descriptor.instance.pool) ? routes.map(route => route.routeKey) : [];
    }
    const target = observation.kind === "call" ? observation.target : observation.kind === "log" ? observation.address : null;
    return target && [descriptor.instance.pool, ...descriptor.instance.binding.tokens,
      descriptor.instance.binding.hooks.address, ...descriptor.instance.binding.tokenInfo.map(info => info.rateProvider)].some(address => same(address, target))
      ? routes.map(route => route.routeKey) : [];
  } },
  liveStateProjection: { project: ({ descriptor, snapshot }) => ({ kind: descriptor.instance.binding.localModel
    ? "balancer-v3-local-exact-in" : "balancer-v3-router-exact-in", pool: descriptor.instance.pool,
    i: descriptor.route.i, j: descriptor.route.j, ...snapshot, source: { ...snapshot.source } }) },
} satisfies PricingSemantics<BalancerV3Descriptor, BalancerV3Route, BalancerV3PricingDescriptor, BalancerV3Snapshot>;
