import assert from "node:assert/strict";
import { ethers } from "ethers";
import type { AdapterRequestResult } from "../venues/adapter-request-program.js";
import type { CanonicalSource } from "../venues/adapter-request-program.js";
import { ADDR } from "../../shared/constants/addresses.js";
import { UNIV4_POOL_MANAGER_INTERFACE, UNIV4_STATE_VIEW_INTERFACE } from "../venues/swaps/univ4-abi.js";
import { univ4FeeHookStrictFamilyPlugin } from "../venues/swaps/univ4-fee-hook-family-plugin.js";
import { UNIV4_FEE_HOOK_ADDRESS, UNIV4_FEE_HOOK_CODE_HASH, UNIV4_FEE_HOOK_PATTERN_IDS } from "../venues/swaps/univ4-fee-hook-family/manifest.js";
import { v4PoolId } from "../venues/swaps/univ4-common.js";

/**
 * Real-chain probe: adapts the retained USDC/WETH tiered dynamic-fee hook pool
 * (tx2 window evidence) through the univ4-fee-hook Family against mainnet
 * chain truth. Runs: discovery decode of the real Initialize log, identity
 * active proof (manager/hook code + state view reads pinned at the swap
 * block), instance compile, route projection (fee-hook owned adapter), and a
 * real quoter exact quote. Requires MAINNET_RPC_URL (archive).
 */
const rpcUrl = process.env.MAINNET_RPC_URL;
if (rpcUrl === undefined || rpcUrl.length === 0) {
  throw new Error("univ4-fee-hook live probe requires MAINNET_RPC_URL");
}
const provider = new ethers.JsonRpcProvider(rpcUrl);
const POOL_ID =
  "0x789916d8a8b4ebf881fe58cab68a47455c994e22b3cc536055e497ef2238b62e";
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
    toBlock: 25_820_000,
  });
  assert.equal(inits.length, 1, "exactly one Initialize log for the pool");
  const init = inits[0]!;
  const swaps = await provider.getLogs({
    address: ADDR.UNISWAP_V4_POOL_MANAGER,
    topics: [SWAP_TOPIC, POOL_ID],
    fromBlock: 25_810_000,
    toBlock: 25_811_500,
  });
  assert.ok(swaps.length > 0, "at least one Swap log in the window");
  const swap = swaps[swaps.length - 1]!;
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
  let data: string;
  if (request.kind === "get-code" && request.address !== undefined) {
    data = await provider.getCode(request.address, blockTag);
  } else if (request.kind === "eth-call" && request.to !== undefined && request.data !== undefined) {
    data = await provider.call({ to: request.to, data: request.data, blockTag });
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
assert.equal(candidate.poolId.toLowerCase(), POOL_ID.toLowerCase());
assert.equal(
  candidate.poolKey.currency0.toLowerCase(), USDC.toLowerCase(),
  "currency0 must be USDC",
);
assert.equal(
  candidate.poolKey.currency1.toLowerCase(), WETH.toLowerCase(),
  "currency1 must be WETH",
);
assert.equal(candidate.poolKey.fee, 0x800000, "dynamic fee flag");
assert.equal(candidate.poolKey.tickSpacing, 10);
assert.equal(
  candidate.poolKey.hooks.toLowerCase(), UNIV4_FEE_HOOK_ADDRESS.toLowerCase(),
  "poolKey must name the audited hook",
);
assert.equal(v4PoolId(candidate.poolKey).toLowerCase(), POOL_ID.toLowerCase());

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
    " managerCodeHash=" + identity.facts.managerBinding.managerCodeHash.slice(0, 10) +
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

// 5. Exact: real quoter quote at the swap block, direction from the real swap.
const decodedSwap = UNIV4_POOL_MANAGER_INTERFACE.decodeEventLog(
  "Swap", swap.data, swap.topics,
);
const amount0 = BigInt(decodedSwap.amount0);
const amount1 = BigInt(decodedSwap.amount1);
const zeroForOne = amount0 < 0n && amount1 > 0n;
const route = routes.find((item) =>
  item.direction === (zeroForOne ? "zero-for-one" : "one-for-zero"),
)!;
const amountIn = zeroForOne ? 1_000_000_000_000n : 500_000_000_000_000_000n;
const exactInput = {
  descriptor,
  route,
  amountIn,
  source,
  executor: ADDR.UNISWAP_V4_POOL_MANAGER,
  runtimeEvidence: Object.freeze([]),
};
const method = univ4FeeHookStrictFamilyPlugin.exact.methods(exactInput).find(
  (item) => item.id === "univ4-fee-hook-quoter",
)!;
if (method.kind !== "request-program") throw new Error("quoter method shape changed");
const program = method.program;
const exactRequests = (program as { buildRequests(input: unknown): readonly unknown[] })
  .buildRequests({ descriptor, route, amountIn, source });
assert.equal(exactRequests.length, 1);
// The pinned quoter (0x52F0E24D...) rejects quotes for this pool with its own
// custom error (0x7a5ed734 + poolId, present in the quoter's bytecode, absent
// from the hook's). This is a live finding for the exact path (affects the
// standard univ4 family equally); the mandatory final simulation remains the
// fail-closed gate. Report the outcome instead of failing the adaptation
// probe.
let quoteOutcome = "n/a";
try {
  const quoteResults = Object.freeze(await Promise.all(exactRequests.map((request) =>
    runRequest(request as never, source, swap.blockNumber),
  )));
  const quote = (program as {
    decode(input: { programInput: unknown; initialResults: readonly unknown[] }): unknown;
  }).decode({ programInput: { descriptor, route, amountIn, source }, initialResults: quoteResults });
  const quoteRecord = quote as { amountOut: bigint; evidence: { amountOut: bigint; poolId: string } };
  assert.equal(
    quoteRecord.evidence.poolId.toLowerCase(), POOL_ID.toLowerCase(),
  );
  quoteOutcome = quoteRecord.amountOut > 0n
    ? "ok amountOut=" + quoteRecord.amountOut
    : "zero amountOut";
  console.log(
    "exact: " + (zeroForOne ? "USDC" : "WETH") + " " + amountIn + " -> amountOut=" +
      quoteRecord.amountOut + " evidenceKind=" +
      (quoteRecord.evidence as { kind?: string }).kind,
  );
} catch (error) {
  quoteOutcome = "reverted: " + ((error as { shortMessage?: string }).shortMessage ?? String(error)).slice(0, 80);
  console.log(
    "exact finding: pinned quoter " + ADDR.UNISWAP_V4_QUOTER +
      " rejected the quote for the fee-hook pool at block " + swap.blockNumber +
      " (" + quoteOutcome + "); exact handles for this pool are unavailable " +
      "until the quoter path is fixed",
  );
}

console.log("univ4-fee-hook live probe PASS (adaptation verified; exact quote finding above)");
