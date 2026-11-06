import assert from "node:assert/strict";
import { ethers } from "ethers";
import { ADDR } from "../../shared/constants/addresses.js";
import type { UnifiedObservation } from "../venues/adapter-family-plugin.js";
import type { CanonicalSource } from "../venues/adapter-request-program.js";
import { plugin as univ4FeeHookStrictFamilyPlugin } from "../venues/production-families/univ4-fee-hook.production.js";
import { UNIV4_POOL_MANAGER_INTERFACE } from "../venues/swaps/univ4-abi.js";
import { v4PoolId } from "../venues/swaps/univ4-common.js";
import {
  UNIV4_FEE_HOOK_ADDRESS,
  UNIV4_FEE_HOOK_CODE_HASH,
  UNIV4_FEE_HOOK_PATTERN_IDS,
} from "../venues/swaps/univ4-fee-hook-family/manifest.js";

const SOURCE: CanonicalSource = Object.freeze({
  number: 25_800_000,
  hash: `0x${'cd'.repeat(32)}`,
  generation: 9,
});
const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
const OTHER_HOOK = "0x4000000000000000000000000000000000000004";
const KEY = Object.freeze({
  currency0: USDC,
  currency1: WETH,
  fee: 0x800000,
  tickSpacing: 10,
  hooks: UNIV4_FEE_HOOK_ADDRESS,
});
const POOL_ID = v4PoolId(KEY);
const Q96 = 1n << 96n;
const LIQUIDITY = 130_000_000_000_000_000_000n;

const initialize = UNIV4_POOL_MANAGER_INTERFACE.encodeEventLog(
  UNIV4_POOL_MANAGER_INTERFACE.getEvent("Initialize")!,
  [POOL_ID, USDC, WETH, KEY.fee, KEY.tickSpacing, KEY.hooks, Q96, 0],
);
const initializeObservation: UnifiedObservation = Object.freeze({
  kind: "log",
  source: SOURCE,
  address: ADDR.UNISWAP_V4_POOL_MANAGER,
  topics: Object.freeze(initialize.topics),
  data: initialize.data,
});
const candidate = univ4FeeHookStrictFamilyPlugin.discovery.decodeCandidate({
  observation: initializeObservation,
  matchedPatternId: UNIV4_FEE_HOOK_PATTERN_IDS.initialize,
});
assert(candidate !== null);
assert.equal(candidate.poolId, POOL_ID);
assert.equal(candidate.hooks.toLowerCase(), UNIV4_FEE_HOOK_ADDRESS.toLowerCase());
assert.equal(BigInt(candidate.fee), 0x800000n);

const identityVariant = univ4FeeHookStrictFamilyPlugin.identity.variants[0];
assert.deepEqual(identityVariant.decide({ candidate, step: 0 }), { status: "continue" });
assert.deepEqual(
  identityVariant.decide({
    candidate: {
      ...candidate,
      poolId: v4PoolId({ ...KEY, hooks: OTHER_HOOK }),
      hooks: OTHER_HOOK,
    },
    step: 1,
    evidence: { managerCodeHash: ethers.id("fixture-manager"), hookCodeHash: ethers.id("unknown hook"),
      sqrtPriceX96: Q96, liquidity: LIQUIDITY },
  }),
  { status: "chain-proven-rejected", reasonCode: "unknown_hook_fail_closed", evidenceRequestIds: [] },
);
assert.deepEqual(
  identityVariant.decide({ candidate: { ...candidate, manager: WETH }, step: 0 }),
  { status: "chain-proven-rejected", reasonCode: "foreign_pool_manager", evidenceRequestIds: [] },
);
const verified = identityVariant.decide({
  candidate,
  step: 1,
  evidence: {
    phase: "fee-hook-active-proof",
    managerCodeHash: `0x${'11'.repeat(32)}`,
    hookCodeHash: UNIV4_FEE_HOOK_CODE_HASH,
    sqrtPriceX96: Q96,
    liquidity: LIQUIDITY,
  },
});
assert.equal(verified.status, "verified");
if (verified.status !== "verified") throw new Error("fee-hook identity fixture");
assert.equal(verified.identity.facts.poolKey.hooks.toLowerCase(), UNIV4_FEE_HOOK_ADDRESS.toLowerCase());
assert.equal(verified.identity.facts.hookCodeHash.toLowerCase(), UNIV4_FEE_HOOK_CODE_HASH.toLowerCase());
assert.equal(verified.identity.familyId, "univ4-fee-hook");
assert.deepEqual(
  identityVariant.decide({
    candidate,
    step: 1,
    evidence: {
      phase: "fee-hook-active-proof",
      managerCodeHash: `0x${'11'.repeat(32)}`,
      hookCodeHash: `0x${'22'.repeat(32)}`,
      sqrtPriceX96: Q96,
      liquidity: LIQUIDITY,
    },
  }),
  { status: "chain-proven-rejected", reasonCode: "hook_code_hash_changed", evidenceRequestIds: ["hook-code"] },
);

const summary = univ4FeeHookStrictFamilyPlugin.manifest;
assert.equal(summary.familyId, "univ4-fee-hook");
assert(summary.ownedActionAdapterIds.includes("univ4-fee-hook-unlock"));
assert(summary.ownedActionAdapterIds.includes("univ4-fee-hook-swap"));
assert.equal(univ4FeeHookStrictFamilyPlugin.actionAdapters.length, 6);

const draft = univ4FeeHookStrictFamilyPlugin.instance.compileDraft(
  verified.identity,
);
const descriptor = univ4FeeHookStrictFamilyPlugin.instance.finalizeDescriptor({
  identity: verified.identity,
  draft,
  sharedBindings: [],
});
const route = univ4FeeHookStrictFamilyPlugin.routes.project({ descriptor })[0];
const amountIn = 1_000_000n;
const amountOut = 1_001_000n;
const executor = "0x3000000000000000000000000000000000000003";
const transactionOrigin = "0x7000000000000000000000000000000000000007";
const quoteInput = { descriptor, route, amountIn, source: SOURCE, executor, transactionOrigin, runtimeEvidence: [] };
const method = univ4FeeHookStrictFamilyPlugin.exact.methods(quoteInput).find((m) => m.kind === "request-program");
assert(method?.kind === "request-program");
const [request] = method.program.buildRequests(quoteInput);
assert.equal(request.kind, "effect-delta-simulation");
const quote = method.program.decode({ programInput: quoteInput, dependentEvidence: [], initialResults: [{
  id: request.id, ok: true, source: SOURCE, completion: "returned", data: "0x",
  provenance: { kind: "fixture", fingerprint: "tiered-unit-receipt" },
  effects: { tokenDeltas: [{ token: route.tokenIn, account: executor, delta: -amountIn },
    { token: route.tokenOut, account: executor, delta: amountOut }], nativeDeltas: [{ account: executor, delta: 0n }] },
}] });
assert.equal(quote.amountOut, amountOut);
const fragmentInput = { ...quoteInput, quotedAmountOut: quote.amountOut,
  minAmountOut: quote.amountOut, exactEvidence: quote.evidence };
const fragment = univ4FeeHookStrictFamilyPlugin.execution.buildFragment(fragmentInput);
assert.throws(() => univ4FeeHookStrictFamilyPlugin.execution.buildFragment({
  ...fragmentInput, exactEvidence: { ...quote.evidence, kind: "univ4-fee-hook-quoter" },
}), /incompatible exact evidence/);
assertPlanTokensAreCanonical(fragment.nodes);

console.log("univ4 fee-hook strict Family plugin tests passed");

function assertPlanTokensAreCanonical(
  nodes: readonly { readonly tokenIn: string; readonly tokenOut: string; readonly children: readonly unknown[] }[],
): void {
  const pending = [...nodes] as Array<{
    readonly tokenIn: string;
    readonly tokenOut: string;
    readonly children: readonly unknown[];
  }>;
  while (pending.length > 0) {
    const node = pending.pop()!;
    assert.match(node.tokenIn, /^0x[0-9a-fA-F]{40}$/);
    assert.match(node.tokenOut, /^0x[0-9a-fA-F]{40}$/);
    pending.push(...node.children as typeof pending);
  }
}
