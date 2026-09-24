import { univ4Pricing } from "../univ4-family/pricing.js";
import { deepGuardCopy } from "./guard-copy.js";
import type { PricingSemantics } from "../../adapter-family-plugin.js";
import { compileAddressMutations } from "../../mutation-index.js";
import { directedPoolMid } from "../blockscan-state-shared.js";
import { deriveEdgeTaxonomy } from "../../../strategy-taxonomy.js";
import { assertSameSource, requireSuccessfulResult, sameAddress } from "../univ4-family/codec.js";
import { SAT1, SAT1_MAX_BUY, SAT1_FAIR_SUPPLY_CAP } from "./sat1.js";
import type { FeeHookDescriptor, FeeHookRoute, FeeHookPricingDescriptor, FeeHookPricingSnapshot, Sat1PricingSnapshot } from "./types.js";

/**
 * Slot0/liquidity math and precision reads are hook-agnostic. A deep copy
 * gives the Family guard a distinct mutable object graph (nested objects
 * included) while the implementation functions stay shared; the standard
 * univ4 Family object stays untouched.
 */
const base = deepGuardCopy(univ4Pricing);
const fields = ["ethCum", "marginalPrice", "totalMintedFair", "selfDeprecated"] as const;
const isSat = (snapshot: FeeHookPricingSnapshot): snapshot is Sat1PricingSnapshot => "kind" in snapshot && snapshot.kind === "sat1";
const inactive = (s: Sat1PricingSnapshot, buy: boolean) => s.marginalPrice <= 0n || s.ethCum < 0n ||
  s.fairSupply < 0n || s.actualSupply < 0n || (buy
    ? s.deprecated || s.fairSupply >= SAT1_FAIR_SUPPLY_CAP
    : s.ethCum === 0n || s.fairSupply === 0n || s.actualSupply === 0n);
export const univ4FeeHookPricing = {
  ...base,
  staticBindingProjection: input => ({ base: base.staticBindingProjection(input), hookModel: input.descriptor.hookModel ?? "fee" }),
  snapshotCompatibilityProjection: input => ({ base: base.snapshotCompatibilityProjection(input), hookModel: input.descriptor.hookModel ?? "fee" }),
  compileDraft(input) {
    return { ...base.compileDraft(input), ...(input.descriptor.hookModel === "sat1" ? { hookModel: "sat1" as const } : {}) };
  },
  current: {
    requirements: base.current.requirements,
    buildRequests(input) {
      if (input.descriptor.hookModel !== "sat1") return base.current.buildRequests(input);
      return [...fields, "totalSupply"].map(fn => ({ id: `sat1:${fn}`, kind: "eth-call" as const,
        to: fn === "totalSupply" ? input.descriptor.poolKey.currency1 : input.descriptor.poolKey.hooks,
        data: SAT1.encodeFunctionData(fn), completion: "return-data" as const }));
    },
    buildDependentProgram: input => input.current.descriptor.hookModel === "sat1" ? null : base.current.buildDependentProgram(input),
    decodeSnapshot(input) {
      if (input.descriptor.hookModel !== "sat1") return base.current.decodeSnapshot(input);
      const source = requireSuccessfulResult(input.initialResults, "sat1:ethCum").source;
      const get = (fn: string) => {
        const result = requireSuccessfulResult(input.initialResults, `sat1:${fn}`);
        assertSameSource(source, result.source);
        return SAT1.decodeFunctionResult(fn, result.data)[0];
      };
      return { kind: "sat1" as const, source, ethCum: BigInt(get("ethCum")), marginalPrice: BigInt(get("marginalPrice")),
        fairSupply: BigInt(get("totalMintedFair")), actualSupply: BigInt(get("totalSupply")), deprecated: Boolean(get("selfDeprecated")) };
    },
    deriveMids(input) {
      const snapshot = input.snapshot;
      if (!isSat(snapshot)) return base.current.deriveMids({ ...input, snapshot });
      if (input.descriptor.hookModel !== "sat1") throw new Error("foreign Sat1 snapshot");
      const mids = new Map<FeeHookRoute["routeKey"], ReturnType<typeof directedPoolMid>>();
      for (const route of input.routes) {
        const buy = route.direction === "zero-for-one";
        if (inactive(snapshot, buy)) continue;
        const descriptor = input.descriptor;
        if (route.poolId !== descriptor.poolId || route.instanceKey !== descriptor.instanceKey ||
          !sameAddress(route.tokenIn, buy ? descriptor.graphToken0 : descriptor.graphToken1) ||
          !sameAddress(route.tokenOut, buy ? descriptor.graphToken1 : descriptor.graphToken0)) throw new Error("Sat1 price route mismatch");
        // Raw marginal curve derivative only. Amount-sensitive effective/Solver
        // both use exact.ts and the real Quoter, including limits/cooldown.
        const mid = buy ? 1e18 / Number(snapshot.marginalPrice) * 0.997
          : Number(snapshot.marginalPrice) / 1e18 * Number(snapshot.fairSupply) / Number(snapshot.actualSupply) * 0.997;
        mids.set(route.routeKey, directedPoolMid({ kind: "v4", mid, feeBps: 30,
          // Mint-side depth proxies are the contract input limit and remaining
          // fair supply cap, NOT pre-existing inventory. Exact checks capacity.
          reserveIn: buy ? SAT1_MAX_BUY : snapshot.actualSupply,
          reserveOut: buy ? SAT1_FAIR_SUPPLY_CAP - snapshot.fairSupply : snapshot.ethCum,
          edge: { adapterId: "univ4-fee-hook-unlock", target: descriptor.managerBinding.manager,
            instanceKey: route.instanceKey, tokenIn: route.tokenIn, tokenOut: route.tokenOut,
            poolId: descriptor.poolId, poolToken0: descriptor.graphToken0, poolToken1: descriptor.graphToken1,
            v4PoolKey: descriptor.poolKey, slotKind: "swap", ...deriveEdgeTaxonomy("swap") },
        }));
      }
      return mids;
    },
    classifyUnavailable(input) {
      if (!isSat(input.snapshot)) return base.current.classifyUnavailable({ ...input, snapshot: input.snapshot });
      const s = input.snapshot;
      return new Map(input.routes.filter(route => inactive(s, route.direction === "zero-for-one"))
        .map(route => [route.routeKey, "sat1 direction inactive"]));
    },
  },
  dependencies: input => [...base.dependencies(input), input.descriptor.poolKey.hooks],
  mutation: {
    compile({ entries }) {
      const manager = base.mutation.compile({ entries });
      const hooks = compileAddressMutations(entries, ({ descriptor }) => ({
        addresses: [descriptor.poolKey.hooks, ...(descriptor.hookModel === "sat1" ? [descriptor.poolKey.currency1] : [])], keys: [descriptor.poolId],
      }), { kinds: ["call", "log"] });
      return { dependencies: [...new Set([...manager.dependencies, ...hooks.dependencies])],
        affectedStateKeys(input) { return [...new Set([...manager.affectedStateKeys(input), ...hooks.affectedStateKeys(input)])]; } };
    },
    affectedStateKeys(input) {
      const { descriptor, observation } = input;
      const address = observation.kind === "call" ? observation.target : observation.kind === "log" ? observation.address : undefined;
      if (address && (sameAddress(address, descriptor.poolKey.hooks) ||
        (descriptor.hookModel === "sat1" && sameAddress(address, descriptor.poolKey.currency1)))) return [descriptor.poolId];
      return base.mutation.affectedStateKeys(input);
    },
  },
  liveStateProjection: {
    project(input) {
      if (!isSat(input.snapshot)) return base.liveStateProjection.project({ ...input, snapshot: input.snapshot });
      return { ...input.snapshot, source: { ...input.snapshot.source }, poolId: input.descriptor.poolId };
    },
  },
} satisfies PricingSemantics<FeeHookDescriptor, FeeHookRoute, FeeHookPricingDescriptor, FeeHookPricingSnapshot>;
