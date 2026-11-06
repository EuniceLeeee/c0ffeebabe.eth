import assert from "node:assert/strict";
import { ethers } from "ethers";
import type { AdapterRequestResult } from "../venues/adapter-request-program.js";
import type { CanonicalSource } from "../venues/adapter-request-program.js";
import { ADDR } from "../../shared/constants/addresses.js";
import { UNIV4_POOL_MANAGER_INTERFACE } from "../venues/swaps/univ4-abi.js";
import { plugin as univ4FeeHookStrictFamilyPlugin } from "../venues/production-families/univ4-fee-hook.production.js";
import { DEFAULT_SEARCHER_EXECUTOR, DEFAULT_SEARCHER_OWNER } from "../../shared/executor/botvm-executor.js";
import { executeAdapterWork } from "../adapter-work-intent.js";
import { openHistoricalFamilyEvm } from "./historical-family-evm.js";
import { UNIV4_FEE_HOOK_ADDRESS, UNIV4_FEE_HOOK_CODE_HASH, UNIV4_FEE_HOOK_PATTERN_IDS } from "../venues/swaps/univ4-fee-hook-family/manifest.js";
import { v4PoolId } from "../venues/swaps/univ4-common.js";

/**
 * Real-chain probe: adapts the retained USDC/WETH tiered dynamic-fee hook pool
 * (tx2 window evidence) through the univ4-fee-hook Family against mainnet
 * chain truth. Runs: discovery decode of the real Initialize log, identity
 * active proof (manager/hook code + state view reads pinned at the swap
 * block), instance compile, route projection (fee-hook owned adapter), and a
 * real executor-bound receipt Exact quote on an isolated local EVM. Requires MAINNET_RPC_URL (archive).
 */
const rpcUrl = process.env.MAINNET_RPC_URL;
if (rpcUrl === undefined || rpcUrl.length === 0) {
  throw new Error("univ4-fee-hook live probe requires MAINNET_RPC_URL");
}
const provider = new ethers.JsonRpcProvider(rpcUrl);
const POOL_ID =
  "0x789916d8a8b4ebf881fe58cab68a47455c994e22b3cc536055e497ef2238b62e";
const SWAP_BLOCK = 25_811_499;
const SWAP_TX =
  "0x65d0517289a6de7ad8c813799011907fadbb6b2bf6e5e8f8cf1ff872f93725f6";
const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
const INIT_TOPIC = ethers.id(
  "Initialize(bytes32,address,address,uint24,int24,address,uint160,int24)",
);
const SWAP_TOPIC = ethers.id(
  "Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)",
);

async function findEvidence() {
  const inits = await provider.getLogs({
    address: ADDR.UNISWAP_V4_POOL_MANAGER,
    topics: [INIT_TOPIC, POOL_ID],
    fromBlock: 25_800_000,
    toBlock: SWAP_BLOCK,
  });
  assert.equal(inits.length, 1, "exactly one Initialize log for the pool");
  const init = inits[0]!;
  const swaps = await provider.getLogs({
    address: ADDR.UNISWAP_V4_POOL_MANAGER,
    topics: [SWAP_TOPIC, POOL_ID],
    fromBlock: SWAP_BLOCK,
    toBlock: SWAP_BLOCK,
  });
  const swap = swaps.find(
    (log) => log.transactionHash.toLowerCase() === SWAP_TX,
  );
  assert(swap !== undefined, "the retained fee-hook Swap must exist");
  return { init, swap };
}

function sourceOf(block: { number: number; hash: string }): CanonicalSource {
  return Object.freeze({
    number: block.number,
    hash: block.hash,
    generation: block.number,
  });
}

async function runRequest(
  request: { id: string; kind: string; address?: string; to?: string; data?: string },
  source: CanonicalSource,
  blockTag: number,
): Promise<AdapterRequestResult> {
  assert.equal(blockTag, source.number);
  let data: string;
  if (request.kind === "get-code" && request.address !== undefined) {
    data = await provider.send("eth_getCode", [request.address, { blockHash: source.hash, requireCanonical: true }]);
  } else if (request.kind === "eth-call" && request.to !== undefined && request.data !== undefined) {
    data = await provider.send("eth_call", [{ to: request.to, data: request.data }, { blockHash: source.hash, requireCanonical: true }]);
  } else {
    throw new Error("unsupported probe request kind " + request.kind);
  }
  return Object.freeze({
    id: request.id,
    ok: true as const,
    source,
    provenance: Object.freeze({
      kind: "probe-direct",
      fingerprint: "univ4-fee-hook-live-probe",
    }),
    completion: "returned" as const,
    data,
  });
}

const { init, swap } = await findEvidence();
console.log(
  "evidence: initBlock=" + init.blockNumber + " swapBlock=" + swap.blockNumber +
    " swapTx=" + swap.transactionHash,
);
const source = sourceOf({ number: swap.blockNumber, hash: swap.blockHash! });

// 1. Discovery: decode the real Initialize log through the fee-hook Family.
const candidate = univ4FeeHookStrictFamilyPlugin.discovery.decodeCandidate({
  observation: Object.freeze({
    kind: "log",
    source: sourceOf({ number: init.blockNumber, hash: init.blockHash! }),
    address: init.address,
    topics: Object.freeze([...init.topics]),
    data: init.data,
  }),
  matchedPatternId: UNIV4_FEE_HOOK_PATTERN_IDS.initialize,
});
assert(candidate !== null, "fee-hook discovery must decode the real Initialize log");
const poolKey = {
  currency0: candidate.currency0,
  currency1: candidate.currency1,
  fee: Number(candidate.fee),
  tickSpacing: Number(candidate.tickSpacing),
  hooks: candidate.hooks,
};
assert.equal(candidate.poolId.toLowerCase(), POOL_ID.toLowerCase());
assert.equal(
  poolKey.currency0.toLowerCase(), USDC.toLowerCase(),
  "currency0 must be USDC",
);
assert.equal(
  poolKey.currency1.toLowerCase(), WETH.toLowerCase(),
  "currency1 must be WETH",
);
assert.equal(poolKey.fee, 0x800000, "dynamic fee flag");
assert.equal(poolKey.tickSpacing, 10);
assert.equal(
  poolKey.hooks.toLowerCase(), UNIV4_FEE_HOOK_ADDRESS.toLowerCase(),
  "poolKey must name the audited hook",
);
assert.equal(v4PoolId(poolKey).toLowerCase(), POOL_ID.toLowerCase());

// 2. Identity: real active proof at the swap block.
const variant = univ4FeeHookStrictFamilyPlugin.identity.variants[0]!;
const requests = variant.buildRequests({ candidate, step: 0 });
assert.equal(requests.length, 4);
const results = Object.freeze(await Promise.all(requests.map((request) =>
  runRequest(request as never, source, swap.blockNumber),
)));
const evidence = variant.decode({ step: { candidate, step: 0 }, results });
const decision = variant.decide({ candidate, step: 1, evidence });
assert.equal(decision.status, "verified", "identity must verify against real chain truth");
if (decision.status !== "verified") throw new Error("unreachable");
const identity = decision.identity;
assert.equal(identity.familyId, "univ4-fee-hook");
assert.equal(
  identity.facts.hookCodeHash.toLowerCase(), UNIV4_FEE_HOOK_CODE_HASH.toLowerCase(),
  "real hook code hash must equal the audited hash",
);
assert.equal(
  identity.facts.managerBinding.manager.toLowerCase(),
  ADDR.UNISWAP_V4_POOL_MANAGER.toLowerCase(),
);
assert.ok(identity.facts.hookCodeHash.startsWith("0x"));
console.log(
  "identity: verified subject=" + identity.subject +
    " managerCodeHash=" + evidence.managerCodeHash.slice(0, 10) +
    " hookCodeHash=" + identity.facts.hookCodeHash.slice(0, 10) +
    " evidenceProvenance=" + identity.provenance[0]!.kind,
);

// 3. Instance compile.
const draft = univ4FeeHookStrictFamilyPlugin.instance.compileDraft(identity);
const descriptor = univ4FeeHookStrictFamilyPlugin.instance.finalizeDescriptor({
  identity,
  draft,
  sharedBindings: Object.freeze([]),
});
assert.equal(descriptor.familyId, "univ4-fee-hook");
assert.equal(descriptor.hookPolicy, "fee-hook");
assert.equal(
  (descriptor as { hook?: string }).hook?.toLowerCase() ?? "",
  UNIV4_FEE_HOOK_ADDRESS.toLowerCase(),
);
assert.equal(descriptor.poolId.toLowerCase(), POOL_ID.toLowerCase());

// 4. Routes: fee-hook owned edge adapter.
const routes = univ4FeeHookStrictFamilyPlugin.routes.project({ descriptor });
assert.equal(routes.length, 2);
const graph = univ4FeeHookStrictFamilyPlugin.routes.projectGraph({
  descriptor,
  route: routes[0]!,
});
assert.equal(
  graph.routeActionAdapterId, "univ4-fee-hook-unlock",
  "graph edge must bind the fee-hook owned unlock adapter",
);
console.log(
  "routes: " + routes.map((route) =>
    route.direction + " " + route.tokenIn.slice(0, 8) + "->" + route.tokenOut.slice(0, 8),
  ).join(", "),
);

// 5. Quote the observed input using the active tiered-hook executor receipt.
const decodedSwap = UNIV4_POOL_MANAGER_INTERFACE.decodeEventLog(
  "Swap", swap.data, swap.topics,
);
const amount0 = BigInt(decodedSwap.amount0);
const amount1 = BigInt(decodedSwap.amount1);
const zeroForOne = amount0 < 0n && amount1 > 0n;
assert(
  zeroForOne || (amount1 < 0n && amount0 > 0n),
  "retained Swap must have exactly one input side",
);
const route = routes.find((item) =>
  item.direction === (zeroForOne ? "zero-for-one" : "one-for-zero"),
)!;
const amountIn = zeroForOne ? -amount0 : -amount1;
assert(amountIn > 0n, "retained Swap input must be positive");
const executor = ethers.getAddress(process.env.SEARCHER_TEST_EXECUTOR ?? DEFAULT_SEARCHER_EXECUTOR);
const owner = ethers.getAddress(process.env.SEARCHER_TEST_OWNER ?? DEFAULT_SEARCHER_OWNER);
const session = await openHistoricalFamilyEvm(provider, rpcUrl, source, executor, owner);
const { runtime, control } = session;
try {
  const exactInput = { descriptor, route, amountIn, source, executor, transactionOrigin: owner, runtimeEvidence: [] };
  const method = univ4FeeHookStrictFamilyPlugin.exact.methods(exactInput)
    .find(item => item.id === "tiered-executor-receipt");
  assert(method?.kind === "request-program");
  const reqs = method.program.buildRequests(exactInput);
  assert.equal(reqs.length, 1);
  assert.equal(reqs[0].kind, "effect-delta-simulation");
  const outcome = await executeAdapterWork({
    runtime, control,
    intent: {
      stage: "exact-refine", familyId: univ4FeeHookStrictFamilyPlugin.manifest.familyId,
      source, generation: source.generation, programInput: exactInput,
      program: {
        requirements: () => method.program.requirements(exactInput),
        buildRequests: () => reqs,
        decode: ({ results }) => results,
      },
    },
  });
  assert.equal(outcome.status, "resolved", "the executor receipt must be resolved");
  if (outcome.status !== "resolved") throw new Error("fee-hook Exact did not resolve");
  const result = outcome.executed.evidence[0];
  assert(result.ok && result.completion === "returned" && result.effects);
  const quote = method.program.decode({ programInput: exactInput, initialResults: [result], dependentEvidence: [] });
  assert(quote.amountOut > 0n);
  assert.equal(quote.evidence.poolId.toLowerCase(), POOL_ID.toLowerCase());
  const delta = (token: string) => result.effects!.tokenDeltas!.filter(
    row => row.account.toLowerCase() === executor.toLowerCase() && row.token.toLowerCase() === token.toLowerCase());
  assert.deepEqual(delta(route.tokenIn).map(row => row.delta), [-amountIn]);
  assert.deepEqual(delta(route.tokenOut).map(row => row.delta), [quote.amountOut]);
  console.log("exact: input=" + amountIn + " output=" + quote.amountOut + " method=" + method.id);
  console.log("univ4-fee-hook live probe PASS (historical source, tiered executor receipt)");
} finally {
  await session.close();
  provider.destroy();
}
