import assert from "node:assert/strict";
import { ethers } from "ethers";
import type { StateBackend } from "../../shared/state/state-backend.js";
import {
  BlockScanStateCoordinator,
  type BlockScanStateReadBackend,
} from "../blockscan-state-coordinator.js";
import type { TokenEdge } from "../planner/token-graph.js";
import { curvePlainGetDy } from "../solver/curve-math.js";
import { PoolStateCache } from "../solver/pool-state-cache.js";
import { deriveEdgeTaxonomy } from "../strategy-taxonomy.js";
import {
  createVerifiedGraphView,
  registerBlockScanStateFamily,
  type StateRead,
  type StateReadSuccess,
} from "../venues/blockscan-state-capability.js";
import { CURVE_NATIVE_ASSET } from "../venues/curve-assets.js";
import {
  BLOCKSCAN_MULTICALL3,
  bigintRatio,
  blockScanErc20Iface,
  blockScanMulticallIface,
} from "../venues/swaps/blockscan-state-shared.js";
import {
  curvePlainBlockScanState,
} from "../venues/swaps/curve-plain.js";

const SOURCE_BLOCK = 25_585_380;
const SOURCE_HASH =
  "0x6cf953cd24df65a1d0505aa661b8361b69178dbc74eb73085e3531df284c8f22";
const LEGACY_STETH_POOL =
  "0xdc24316b9ae028f1497c275eb9192a3ea0f67022";
const FACTORY_STETH_POOL =
  "0x21e27a5e5513d6e65c4f830167390997aa84843a";
const STETH = "0xae7ab96520de3a18e5e111b5eaab095312d7fe84";
const UNIT = 10n ** 18n;
const taxonomy = deriveEdgeTaxonomy("swap");
const curveStateIface = new ethers.Interface([
  "function coins(uint256 i) view returns (address)",
  "function A() view returns (uint256)",
  "function fee() view returns (uint256)",
  "function offpeg_fee_multiplier() view returns (uint256)",
  "function balances(uint256 i) view returns (uint256)",
  "function stored_rates() view returns (uint256[])",
]);

const edges = Object.freeze([
  ...poolEdges(LEGACY_STETH_POOL),
  ...poolEdges(FACTORY_STETH_POOL),
]);
let nativeDecimalsCalls = 0;
const staticReadTargets: string[] = [];

const backend: BlockScanStateReadBackend = {
  async readBatch(_lane, reads, control) {
    return reads.map((read) => {
      if (read.id.startsWith("curve-decimals:")) {
        staticReadTargets.push(read.to.toLowerCase());
      }
      return successfulRead(
        read,
        control.sourceGeneration,
        respondStateCall(read.to, read.data),
      );
    });
  },
  async verifyCanonicalSource() {},
};

const graph = createVerifiedGraphView({
  id: "curve-native-assets",
  generation: 1,
  sourceBlock: SOURCE_BLOCK,
  sourceBlockHash: SOURCE_HASH,
  completenessWatermark: SOURCE_BLOCK,
  perSourceCoverage: [{
    familyId: "curve-plain",
    sourceId: "fixture",
    sourceFingerprint: "curve-native-assets-v1",
    completeThroughBlock: SOURCE_BLOCK,
    completeThroughHash: SOURCE_HASH,
  }],
  edges,
  familyIdForEdge: () => "curve-plain",
});
const family = registerBlockScanStateFamily({
  familyId: "curve-plain",
  lane: "swap",
  capability: curvePlainBlockScanState,
  ownsEdge: (edge) => edge.adapterId === "curve-exchange-plain",
});
const coordinated = await new BlockScanStateCoordinator(backend).prepare({
  graph,
  families: [family],
  requiresPricing: () => true,
  deadlineAtMs: Date.now() + 5_000,
});
if (coordinated.status !== "complete") {
  assert.fail(
    "one native Curve coin must not degrade the current family publication: " +
      coordinated.issues.map((issue) => issue.message).join("; "),
  );
}
assert.deepEqual(coordinated.snapshot.resolvedFamilyIds, ["curve-plain"]);
assert.deepEqual(coordinated.snapshot.incompleteFamilyIds, []);
assert.equal(coordinated.snapshot.coverage.unresolvedEdgeKeys.length, 0);
assert.equal(coordinated.snapshot.mids.size, edges.length);
for (const mid of coordinated.snapshot.mids.values()) {
  const edge = mid.edges[0];
  assert(edge, `current-N mid ${mid.pool} must retain its source edge`);
  const expected = expectedCurveState(edge.target);
  const i = edge.curveI;
  const j = edge.curveJ;
  assert(i !== undefined && j !== undefined, "Curve mid must retain graph indices");
  const reserveIn = expected.balances[i];
  const reserveOut = expected.balances[j];
  assert.equal(mid.reserveA, reserveIn, `current-N ${mid.pool} reserveIn`);
  assert.equal(mid.reserveB, reserveOut, `current-N ${mid.pool} reserveOut`);
  const amountIn = reserveIn / 1_000_000n;
  const amountOut = curvePlainGetDy(expected, i, j, amountIn);
  assert.equal(
    mid.mid,
    bigintRatio(amountOut, amountIn),
    `current-N ${mid.pool} A/fee-derived mid`,
  );
}
assert.deepEqual(
  staticReadTargets,
  [STETH],
  "static schema must read ERC-20 decimals only for the actual token",
);

const legacyState = {
  async call(req: { to: string; data: string }): Promise<string> {
    return respondStateCall(req.to, req.data);
  },
} as unknown as StateBackend;
for (const pool of [LEGACY_STETH_POOL, FACTORY_STETH_POOL]) {
  const cache = new PoolStateCache();
  cache.setTickBlock(SOURCE_BLOCK);
  const amountOut = await cache.quoteCurve(
    legacyState,
    pool,
    CURVE_NATIVE_ASSET,
    STETH,
    UNIT,
  );
  assert(amountOut > 0n, `legacy warm path must quote native Curve pool ${pool}`);
  const snapshot = cache.snapshotCurve(pool, SOURCE_BLOCK);
  assertExactCurveSnapshot(snapshot, pool, "lazy");
}

const batchCache = new PoolStateCache();
batchCache.setTickBlock(SOURCE_BLOCK);
await batchCache.warmCurvesBatch(legacyState, [
  LEGACY_STETH_POOL,
  FACTORY_STETH_POOL,
]);
for (const pool of [LEGACY_STETH_POOL, FACTORY_STETH_POOL]) {
  const snapshot = batchCache.snapshotCurve(pool, SOURCE_BLOCK);
  assertExactCurveSnapshot(snapshot, pool, "batch");
}
assert.equal(
  nativeDecimalsCalls,
  0,
  "no current or legacy path may call decimals() on Curve's native sentinel",
);

console.log("curve-native-state coordinator + legacy warm PASS");

function poolEdges(pool: string): readonly TokenEdge[] {
  return Object.freeze([
    {
      adapterId: "curve-exchange-plain",
      target: pool,
      tokenIn: CURVE_NATIVE_ASSET,
      tokenOut: STETH,
      slotKind: "swap",
      curveI: 0,
      curveJ: 1,
      ...taxonomy,
    },
    {
      adapterId: "curve-exchange-plain",
      target: pool,
      tokenIn: STETH,
      tokenOut: CURVE_NATIVE_ASSET,
      slotKind: "swap",
      curveI: 1,
      curveJ: 0,
      ...taxonomy,
    },
  ]);
}

function respondStateCall(to: string, data: string): string {
  const target = to.toLowerCase();
  if (target === CURVE_NATIVE_ASSET) {
    if (
      data.slice(0, 10) ===
      blockScanErc20Iface.getFunction("decimals")!.selector
    ) {
      nativeDecimalsCalls++;
      return "0x";
    }
    throw new Error(`unexpected native-asset call ${data.slice(0, 10)}`);
  }
  if (target === STETH) {
    if (
      data.slice(0, 10) ===
      blockScanErc20Iface.getFunction("decimals")!.selector
    ) {
      return blockScanErc20Iface.encodeFunctionResult("decimals", [18]);
    }
    throw new Error(`unexpected stETH call ${data.slice(0, 10)}`);
  }
  if (target === BLOCKSCAN_MULTICALL3.toLowerCase()) {
    const calls = blockScanMulticallIface.decodeFunctionData(
      "aggregate3",
      data,
    )[0] as readonly {
      readonly target: string;
      readonly callData: string;
    }[];
    return blockScanMulticallIface.encodeFunctionResult("aggregate3", [
      calls.map((call) => {
        try {
          return {
            success: true,
            returnData: respondStateCall(call.target, call.callData),
          };
        } catch {
          return { success: false, returnData: "0x" };
        }
      }),
    ]);
  }
  return respondCurveCall(to, data);
}

function respondCurveCall(pool: string, data: string): string {
  const target = pool.toLowerCase();
  if (
    target !== LEGACY_STETH_POOL &&
    target !== FACTORY_STETH_POOL
  ) {
    throw new Error(`unexpected Curve target ${pool}`);
  }
  const selector = data.slice(0, 10);
  if (selector === curveStateIface.getFunction("coins")!.selector) {
    const index = Number(
      curveStateIface.decodeFunctionData("coins", data)[0],
    );
    if (index > 1) throw new Error("coin index out of range");
    return tailedCurveResult(curveStateIface.encodeFunctionResult(
      "coins",
      [index === 0 ? CURVE_NATIVE_ASSET : STETH],
    ));
  }
  if (selector === curveStateIface.getFunction("A")!.selector) {
    return tailedCurveResult(curveStateIface.encodeFunctionResult(
      "A",
      [target === LEGACY_STETH_POOL ? 900n : 1_500n],
    ));
  }
  if (selector === curveStateIface.getFunction("fee")!.selector) {
    return tailedCurveResult(curveStateIface.encodeFunctionResult(
      "fee",
      [target === LEGACY_STETH_POOL ? 1_000_000n : 800_000n],
    ));
  }
  if (selector === curveStateIface.getFunction("balances")!.selector) {
    const index = Number(
      curveStateIface.decodeFunctionData("balances", data)[0],
    );
    return tailedCurveResult(curveStateIface.encodeFunctionResult(
      "balances",
      [index === 0 ? 20_000n * UNIT : 22_000n * UNIT],
    ));
  }
  if (
    selector ===
      curveStateIface.getFunction("offpeg_fee_multiplier")!.selector ||
    selector === curveStateIface.getFunction("stored_rates")!.selector
  ) {
    throw new Error("unsupported Curve ABI");
  }
  throw new Error(`unexpected Curve selector ${selector}`);
}

function tailedCurveResult(data: string): string {
  // A short non-zero trailing word makes the old whole-buffer/tail decoders
  // fail deterministically without feeding enormous integers into Curve math.
  // Exact 4096-byte proxy returndata remains covered by
  // token-graph-family-isolation.
  return `${data}${"00".repeat(31)}01`;
}

function expectedCurveState(pool: string) {
  const target = pool.toLowerCase();
  assert(
    target === LEGACY_STETH_POOL || target === FACTORY_STETH_POOL,
    `unexpected Curve pool ${pool}`,
  );
  return {
    A: target === LEGACY_STETH_POOL ? 900n : 1_500n,
    fee: target === LEGACY_STETH_POOL ? 1_000_000n : 800_000n,
    balances: [20_000n * UNIT, 22_000n * UNIT],
    rates: [UNIT, UNIT],
  };
}

function assertExactCurveSnapshot(
  snapshot: ReturnType<PoolStateCache["snapshotCurve"]>,
  pool: string,
  path: "lazy" | "batch",
): void {
  assert(snapshot, `${path} ${pool} snapshot must exist`);
  assert.equal(snapshot.kind, "plain", `${path} ${pool} kind`);
  const expected = expectedCurveState(pool);
  assert.equal(snapshot.plain?.A, expected.A, `${path} ${pool} A`);
  assert.equal(snapshot.plain?.fee, expected.fee, `${path} ${pool} fee`);
  assert.deepEqual(
    snapshot.plain?.balances,
    expected.balances,
    `${path} ${pool} balances`,
  );
  assert.deepEqual(snapshot.plain?.rates, expected.rates, `${path} ${pool} rates`);
}

function successfulRead(
  read: StateRead,
  generation: number,
  data: string,
): StateReadSuccess {
  return Object.freeze({
    id: read.id,
    ok: true,
    sourceBlock: read.sourceBlock,
    sourceBlockHash: read.sourceBlockHash,
    provenance: Object.freeze({
      kind: "eip1898" as const,
      source: Object.freeze({
        number: read.sourceBlock,
        hash: read.sourceBlockHash,
        generation,
      }),
      requireCanonical: true as const,
    }),
    data,
  });
}
