import assert from "node:assert/strict";
import { ethers } from "ethers";
import {
  BlockScanStateCoordinator,
  type BlockScanStateReadBackend,
} from "../blockscan-state-coordinator.js";
import type { TokenEdge } from "../planner/token-graph.js";
import { deriveEdgeTaxonomy } from "../strategy-taxonomy.js";
import {
  createVerifiedGraphView,
  registerBlockScanStateFamily,
  type StateRead,
  type StateReadResult,
  type StateReadSuccess,
} from "../venues/blockscan-state-capability.js";
import { CURVE_METAREGISTRY } from "../venues/curve-underlying.js";
import {
  BLOCKSCAN_MULTICALL3,
  blockScanErc20Iface,
  blockScanMulticallIface,
} from "../venues/swaps/blockscan-state-shared.js";
import { curveUnderlyingBlockScanState } from "../venues/swaps/curve-underlying.js";

const SOURCE_BLOCK = 25_599_790;
const SOURCE_HASH = `0x${"cd".repeat(32)}`;
const POOL = "0x2222222222222222222222222222222222222222";
const TOKENS = Object.freeze([
  "0x5555555555555555555555555555555555555555",
  "0x6666666666666666666666666666666666666666",
  "0x7777777777777777777777777777777777777777",
  "0x8888888888888888888888888888888888888888",
]);
const DECIMALS = Object.freeze([18n, 18n, 6n, 6n]);
const BALANCES = Object.freeze([
  76n * 10n ** 18n,
  13n * 10n ** 18n,
  13_700_000n,
  50_000_000n,
]);
const taxonomy = deriveEdgeTaxonomy("swap");
const curveUnderlyingIface = new ethers.Interface([
  "function get_dy_underlying(int128 i,int128 j,uint256 dx) view returns (uint256)",
]);
const curveMetaRegistryStateIface = new ethers.Interface([
  "function get_underlying_decimals(address pool) view returns (uint256[8])",
  "function get_underlying_balances(address pool) view returns (uint256[8])",
]);

class CurveUnderlyingBackend implements BlockScanStateReadBackend {
  registryPhysicalReads = 0;
  brokenDecimalsCalls = 0;

  constructor(
    private readonly failedDirection: readonly [number, number] | null = null,
  ) {}

  async readBatch(
    _lane: "swap" | "protocol",
    reads: readonly StateRead[],
    control: {
      readonly sourceBlock: number;
      readonly sourceBlockHash: string;
      readonly sourceGeneration: number;
    },
  ): Promise<readonly StateReadResult[]> {
    assert.equal(control.sourceBlock, SOURCE_BLOCK);
    assert.equal(control.sourceBlockHash, SOURCE_HASH);
    return reads.map((read) =>
      success(
        read,
        control.sourceGeneration,
        this.respondMulticall(read),
      )
    );
  }

  async verifyCanonicalSource(source: {
    readonly number: number;
    readonly hash: string;
  }): Promise<void> {
    assert.equal(source.number, SOURCE_BLOCK);
    assert.equal(source.hash, SOURCE_HASH);
  }

  private respondMulticall(read: StateRead): string {
    assert.equal(read.to.toLowerCase(), BLOCKSCAN_MULTICALL3.toLowerCase());
    const calls = blockScanMulticallIface.decodeFunctionData(
      "aggregate3",
      read.data,
    )[0] as readonly { target: string; callData: string }[];
    if (calls.some(({ callData }) =>
      callData.slice(0, 10) ===
        curveMetaRegistryStateIface.getFunction(
          "get_underlying_decimals",
        )!.selector
    )) {
      this.registryPhysicalReads++;
    }
    const responses = calls.map(({ target, callData }) => {
      const selector = callData.slice(0, 10);
      if (
        target.toLowerCase() === CURVE_METAREGISTRY.toLowerCase() &&
        selector ===
          curveMetaRegistryStateIface.getFunction(
            "get_underlying_decimals",
          )!.selector
      ) {
        return ok(
          curveMetaRegistryStateIface.encodeFunctionResult(
            "get_underlying_decimals",
            [[...DECIMALS, 0, 0, 0, 0]],
          ),
        );
      }
      if (
        target.toLowerCase() === CURVE_METAREGISTRY.toLowerCase() &&
        selector ===
          curveMetaRegistryStateIface.getFunction(
            "get_underlying_balances",
          )!.selector
      ) {
        return ok(
          curveMetaRegistryStateIface.encodeFunctionResult(
            "get_underlying_balances",
            [[...BALANCES, 0, 0, 0, 0]],
          ),
        );
      }
      if (
        selector === blockScanErc20Iface.getFunction("decimals")!.selector
      ) {
        const tokenIndex = TOKENS.findIndex((token) =>
          token.toLowerCase() === target.toLowerCase()
        );
        assert(tokenIndex >= 0);
        if (tokenIndex === 0) {
          this.brokenDecimalsCalls++;
          return { success: false, returnData: "0x" };
        }
        return ok(
          blockScanErc20Iface.encodeFunctionResult(
            "decimals",
            [DECIMALS[tokenIndex]],
          ),
        );
      }
      if (
        selector ===
          curveUnderlyingIface.getFunction("get_dy_underlying")!.selector
      ) {
        const decoded = curveUnderlyingIface.decodeFunctionData(
          "get_dy_underlying",
          callData,
        );
        const i = Number(decoded[0]);
        const j = Number(decoded[1]);
        const amountIn = BigInt(decoded[2]);
        if (
          this.failedDirection?.[0] === i &&
          this.failedDirection[1] === j
        ) {
          return { success: false, returnData: "0x" };
        }
        return ok(
          curveUnderlyingIface.encodeFunctionResult(
            "get_dy_underlying",
            [amountIn * 2n],
          ),
        );
      }
      throw new Error(`unexpected Curve-underlying inner call ${selector}`);
    });
    return blockScanMulticallIface.encodeFunctionResult(
      "aggregate3",
      [responses],
    );
  }
}

const edges = Object.freeze(curveEdges());
const healthyBackend = new CurveUnderlyingBackend();
const healthy = await prepare(healthyBackend, 1);
assert.equal(healthy.status, "complete", JSON.stringify(healthy.issues));
assert.equal(healthy.snapshot.graph.edges.length, 12, "graph is not reduced");
assert.equal(healthy.snapshot.mids.size, 12);
assert.equal(healthy.coverage.resolvedEdgeKeys.length, 12);
assert.equal(healthy.coverage.unresolvedEdgeKeys.length, 0);
assert.equal(healthy.coverage.unavailableEdgeKeys.length, 0);
assert.equal(
  healthyBackend.registryPhysicalReads,
  1,
  "identical MetaRegistry scale probes are physically deduplicated per pool",
);
assert(
  healthyBackend.brokenDecimalsCalls > 0,
  "the non-standard token fallback is exercised",
);

const failedBackend = new CurveUnderlyingBackend([0, 1]);
const partial = await prepare(failedBackend, 2);
assert.equal(partial.status, "degraded");
assert.equal(partial.snapshot.graph.edges.length, 12, "graph remains unchanged");
assert.equal(partial.snapshot.mids.size, 11);
assert.equal(partial.coverage.resolvedEdgeKeys.length, 11);
assert.equal(partial.coverage.unresolvedEdgeKeys.length, 1);
assert.equal(partial.coverage.unavailableEdgeKeys.length, 0);
assert(
  partial.coverage.unresolvedEdgeKeys[0].includes(
    `${TOKENS[0].toLowerCase()}>${TOKENS[1].toLowerCase()}`,
  ),
  "the unresolved edge is exactly the injected 0->1 direction",
);
assert(
  partial.issues.some((issue) =>
    issue.familyId === "curve-underlying" &&
    issue.stateKey?.includes(POOL.toLowerCase()) &&
    issue.stateKey.includes("\u001f0\u001f1\u001f") &&
    issue.message.includes("returned no positive result")
  ),
  "one failed direction remains attributable without poisoning siblings",
);

console.log(
  "[curve-underlying-decimals-isolation] registry scale + direction isolation: PASS",
);

async function prepare(
  backend: CurveUnderlyingBackend,
  generation: number,
) {
  return new BlockScanStateCoordinator(backend).prepare({
    graph: createVerifiedGraphView({
      id: `curve-underlying-decimals-isolation-${generation}`,
      generation,
      sourceBlock: SOURCE_BLOCK,
      sourceBlockHash: SOURCE_HASH,
      completenessWatermark: SOURCE_BLOCK,
      perSourceCoverage: [{
        familyId: "curve-underlying",
        sourceId: "curve-underlying-decimals-isolation",
        sourceFingerprint: "curve-underlying-decimals-isolation-v2",
        completeThroughBlock: SOURCE_BLOCK,
        completeThroughHash: SOURCE_HASH,
      }],
      edges,
      familyIdForEdge: () => "curve-underlying",
    }),
    families: [registerBlockScanStateFamily({
      familyId: "curve-underlying",
      lane: "swap",
      capability: curveUnderlyingBlockScanState,
      ownsEdge: (edge) => edge.adapterId === "curve-exchange-underlying",
    })],
    deadlineAtMs: Date.now() + 2_000,
  });
}

function curveEdges(): TokenEdge[] {
  const out: TokenEdge[] = [];
  for (let i = 0; i < TOKENS.length; i++) {
    for (let j = 0; j < TOKENS.length; j++) {
      if (i === j) continue;
      out.push({
        adapterId: "curve-exchange-underlying",
        target: POOL,
        tokenIn: TOKENS[i],
        tokenOut: TOKENS[j],
        curveI: i,
        curveJ: j,
        slotKind: "swap",
        ...taxonomy,
      });
    }
  }
  return out;
}

function ok(returnData: string): {
  readonly success: true;
  readonly returnData: string;
} {
  return Object.freeze({ success: true, returnData });
}

function success(
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
