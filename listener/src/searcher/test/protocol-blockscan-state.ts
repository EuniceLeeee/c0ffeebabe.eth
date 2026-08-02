import assert from "node:assert/strict";
import { ethers } from "ethers";
import type { TokenEdge } from "../planner/token-graph.js";
import {
  assertPureSynchronousDeriveMids,
  blockScanEdgeKey,
  createAmbientIoPoisonHarness,
  type BlockScanStateCapability,
  type StateRead,
  type StateReadResult,
} from "../venues/blockscan-state-capability.js";
import { erc4626Adapter } from "../venues/protocols/erc4626.js";
import { erc4626SiloRedeemAdapter } from "../venues/protocols/erc4626-silo-redeem.js";
import { eigenpieAdapter } from "../venues/protocols/eigenpie.js";
import { goldxAdapter } from "../venues/protocols/goldx.js";
import {
  metronomeHgusdcAdapter,
  metronomeSynthAdapter,
} from "../venues/protocols/metronome.js";
import { psmAdapter } from "../venues/protocols/psm.js";
import { rocksolidAdapter } from "../venues/protocols/rocksolid.js";
import { wstethAdapter } from "../venues/protocols/wsteth.js";
import { eigenpieIface } from "../venues/protocols/eigenpie-discovery.js";
import { metronomeSynthPoolIface } from "../venues/protocols/protocol-quote.js";
import { ADDR } from "../../shared/constants/addresses.js";
import { PRODUCTION_ADAPTER_FAMILIES } from "../venues/production-registry.js";

const block = 25_593_210;
const blockHash = `0x${"11".repeat(32)}`;
const abort = new AbortController();
const tokenA = "0x00000000000000000000000000000000000000a1";
const tokenB = "0x00000000000000000000000000000000000000b2";
const tokenC = "0x00000000000000000000000000000000000000c3";
const vault = "0x00000000000000000000000000000000000000d4";
const router = "0x00000000000000000000000000000000000000e5";

const erc4626Iface = new ethers.Interface([
  "function previewDeposit(uint256) view returns (uint256)",
  "function previewRedeem(uint256) view returns (uint256)",
  "function previewWithdraw(uint256) view returns (uint256)",
]);
const wstethIface = new ethers.Interface([
  "function getWstETHByStETH(uint256) view returns (uint256)",
  "function getStETHByWstETH(uint256) view returns (uint256)",
]);
const psmIface = new ethers.Interface([
  "function tin() view returns (uint256)",
  "function tout() view returns (uint256)",
]);
const goldxIface = new ethers.Interface(["function unit() view returns (uint256)"]);
const rocksolidIface = new ethers.Interface([
  "function convertToShares(uint256) view returns (uint256)",
]);
const curveIface = new ethers.Interface([
  "function get_dy(int128,int128,uint256) view returns (uint256)",
]);
const vaultIface = new ethers.Interface([
  "function previewRedeem(uint256) view returns (uint256)",
]);
const decimalsIface = new ethers.Interface(["function decimals() view returns (uint8)"]);

interface Case {
  readonly name: string;
  readonly familyId: string;
  readonly capability: BlockScanStateCapability;
  readonly edges: readonly TokenEdge[];
  response(read: StateRead): string;
}

const cases: readonly Case[] = [
  {
    name: "erc4626 all production quote shapes",
    familyId: erc4626Adapter.id,
    capability: erc4626Adapter.pricingState,
    edges: [
      edge("erc4626-deposit", vault, tokenA, vault, "wrap"),
      edge("erc4626-redeem", vault, vault, tokenA, "redeem"),
    ],
    response(read) {
      if (selector(read) === selectorOf(decimalsIface, "decimals")) return uint8(18);
      if (selector(read) === selectorOf(erc4626Iface, "previewDeposit")) {
        const amount = BigInt(
          erc4626Iface.decodeFunctionData("previewDeposit", read.data)[0],
        );
        return erc4626Iface.encodeFunctionResult(
          "previewDeposit",
          [(amount * 105n) / 100n],
        );
      }
      if (selector(read) === selectorOf(erc4626Iface, "previewRedeem")) {
        const amount = BigInt(
          erc4626Iface.decodeFunctionData("previewRedeem", read.data)[0],
        );
        return erc4626Iface.encodeFunctionResult(
          "previewRedeem",
          [(amount * 95n) / 100n],
        );
      }
      if (selector(read) === selectorOf(erc4626Iface, "previewWithdraw")) {
        return erc4626Iface.encodeFunctionResult("previewWithdraw", [1_100_000_000_000_000_000n]);
      }
      throw new Error(`unexpected ERC4626 read ${read.id}`);
    },
  },
  {
    name: "erc4626 silo current two-contract quote",
    familyId: erc4626SiloRedeemAdapter.id,
    capability: erc4626SiloRedeemAdapter.pricingState,
    edges: [edge("erc4626-redeem-silo", vault, vault, tokenB, "redeem")],
    response(read) {
      if (selector(read) === selectorOf(decimalsIface, "decimals")) return uint8(18);
      if (selector(read) === selectorOf(erc4626Iface, "previewRedeem")) {
        return erc4626Iface.encodeFunctionResult(
          "previewRedeem",
          [950_000_000_000_000_000n],
        );
      }
      if (selector(read) === selectorOf(erc4626Iface, "previewWithdraw")) {
        return erc4626Iface.encodeFunctionResult(
          "previewWithdraw",
          [1_100_000_000_000_000_000n],
        );
      }
      throw new Error(`unexpected ERC4626 silo read ${read.id}`);
    },
  },
  {
    name: "wstETH current exchange rate",
    familyId: wstethAdapter.id,
    capability: wstethAdapter.pricingState,
    edges: [
      edge("wsteth-wrap", ADDR.WSTETH, ADDR.STETH, ADDR.WSTETH, "wrap"),
      edge("wsteth-unwrap", ADDR.WSTETH, ADDR.WSTETH, ADDR.STETH, "unwrap"),
    ],
    response(read) {
      if (selector(read) === selectorOf(decimalsIface, "decimals")) return uint8(18);
      if (selector(read) === selectorOf(wstethIface, "getWstETHByStETH")) {
        return wstethIface.encodeFunctionResult("getWstETHByStETH", [850_000_000_000_000_000n]);
      }
      if (selector(read) === selectorOf(wstethIface, "getStETHByWstETH")) {
        return wstethIface.encodeFunctionResult("getStETHByWstETH", [1_176_470_588_235_294_117n]);
      }
      throw new Error(`unexpected wstETH read ${read.id}`);
    },
  },
  {
    name: "PSM nonzero current fee",
    familyId: psmAdapter.id,
    capability: psmAdapter.pricingState,
    edges: [edge("psm", ADDR.SKY_PSM_LITE, ADDR.USDC, ADDR.DAI, "convert")],
    response(read) {
      if (selector(read) === selectorOf(decimalsIface, "decimals")) return uint8(6);
      if (selector(read) === selectorOf(psmIface, "tin")) {
        return psmIface.encodeFunctionResult("tin", [1_000_000_000_000_000n]);
      }
      throw new Error(`unexpected PSM read ${read.id}`);
    },
  },
  {
    name: "Eigenpie pair-scoped quote and receipt attestation",
    familyId: eigenpieAdapter.id,
    capability: eigenpieAdapter.pricingState,
    edges: [edge("eigenpie-deposit-asset", router, tokenA, tokenB, "wrap")],
    response(read) {
      if (selector(read) === selectorOf(decimalsIface, "decimals")) return uint8(18);
      if (selector(read) === selectorOf(eigenpieIface, "getMLRTAmountToMint")) {
        return eigenpieIface.encodeFunctionResult(
          "getMLRTAmountToMint",
          [1_010_000_000_000_000_000n, tokenB],
        );
      }
      throw new Error(`unexpected Eigenpie read ${read.id}`);
    },
  },
  {
    name: "GOLDx current unit",
    familyId: goldxAdapter.id,
    capability: goldxAdapter.pricingState,
    edges: [edge("goldx-mint", ADDR.GOLDX, ADDR.PAXG, ADDR.GOLDX, "convert")],
    response(read) {
      if (selector(read) === selectorOf(decimalsIface, "decimals")) return uint8(18);
      if (selector(read) === selectorOf(goldxIface, "unit")) {
        return goldxIface.encodeFunctionResult("unit", [1_001_000_000_000_000_000n]);
      }
      throw new Error(`unexpected GOLDx read ${read.id}`);
    },
  },
  {
    name: "RockSolid current shares",
    familyId: rocksolidAdapter.id,
    capability: rocksolidAdapter.pricingState,
    edges: [
      edge(
        "rocksolid-sync-deposit",
        ADDR.ROCKSOLID_RETH,
        ADDR.RETH,
        ADDR.ROCKSOLID_RETH,
        "wrap",
      ),
    ],
    response(read) {
      if (selector(read) === selectorOf(decimalsIface, "decimals")) return uint8(18);
      if (selector(read) === selectorOf(rocksolidIface, "convertToShares")) {
        return rocksolidIface.encodeFunctionResult("convertToShares", [999_000_000_000_000_000n]);
      }
      throw new Error(`unexpected RockSolid read ${read.id}`);
    },
  },
  {
    name: "Metronome synth current directed quotes",
    familyId: metronomeSynthAdapter.id,
    capability: metronomeSynthAdapter.pricingState,
    edges: [
      edge(
        "metronome-synth-swap",
        ADDR.METRONOME_SYNTH_POOL,
        ADDR.MSUSD,
        ADDR.MSETH,
        "convert",
      ),
    ],
    response(read) {
      if (selector(read) === selectorOf(decimalsIface, "decimals")) return uint8(18);
      if (selector(read) === selectorOf(metronomeSynthPoolIface, "quoteSwapOut")) {
        return metronomeSynthPoolIface.encodeFunctionResult(
          "quoteSwapOut",
          [500_000_000_000_000n, 1_000_000_000_000n],
        );
      }
      throw new Error(`unexpected Metronome synth read ${read.id}`);
    },
  },
  {
    name: "Metronome hgUSDC dependent Curve and vault quote",
    familyId: metronomeHgusdcAdapter.id,
    capability: metronomeHgusdcAdapter.pricingState,
    edges: [
      edge(
        "metronome-hgusdc-exit",
        ADDR.METRONOME_HGUSDC_ROUTER,
        ADDR.MSUSD,
        ADDR.USDC,
        "redeem",
      ),
    ],
    response(read) {
      if (selector(read) === selectorOf(decimalsIface, "decimals")) return uint8(18);
      if (selector(read) === selectorOf(curveIface, "get_dy")) {
        return curveIface.encodeFunctionResult("get_dy", [1_002_000_000_000_000_000n]);
      }
      if (selector(read) === selectorOf(vaultIface, "previewRedeem")) {
        return vaultIface.encodeFunctionResult("previewRedeem", [1_001_000n]);
      }
      throw new Error(`unexpected Metronome hgUSDC read ${read.id}`);
    },
  },
];

const pureFixtureFamilyIds = new Set<string>();
for (const item of cases) {
  let schema = await item.capability.compileStaticSchema({
    edges: item.edges,
    deadlineAtMs: Date.now() + 10_000,
    signal: abort.signal,
  });
  const staticReads = item.capability.buildStaticSchemaReads?.({
    sourceBlock: block,
    sourceBlockHash: blockHash,
    schema,
    edges: item.edges,
  }) ?? [];
  if (staticReads.length > 0) {
    const staticResults = staticReads.map((read): StateReadResult => ({
      id: read.id,
      ok: true,
      sourceBlock: block,
      sourceBlockHash: blockHash,
      provenance: {
        kind: "eip1898",
        source: { number: block, hash: blockHash, generation: 1 },
        requireCanonical: true,
      },
      data: item.response(read),
    }));
    schema = item.capability.hydrateStaticSchema!(schema, staticResults);
  }
  const results: StateReadResult[] = [];
  for (let round = 0; round < 4; round++) {
    const reads = round === 0
      ? item.capability.buildCurrentBlockReads({
          sourceBlock: block,
          sourceBlockHash: blockHash,
          schema,
          edges: item.edges,
        })
      : item.capability.buildDependentBlockReads?.({
          sourceBlock: block,
          sourceBlockHash: blockHash,
          schema,
          edges: item.edges,
          completedRound: round - 1,
          priorResults: results,
        }) ?? [];
    if (reads.length === 0) break;
    for (const read of reads) {
      assert.equal(read.sourceBlock, block, `${item.name}: source block`);
      assert.equal(read.sourceBlockHash, blockHash, `${item.name}: source hash`);
      results.push({
        id: read.id,
        ok: true,
        sourceBlock: block,
        sourceBlockHash: blockHash,
        provenance: {
          kind: "eip1898",
          source: {
            number: block,
            hash: blockHash,
            generation: 1,
          },
          requireCanonical: true,
        },
        data: item.response(read),
      });
    }
  }
  const snapshot = item.capability.decodeState(schema, results);
  const mids = item.capability.deriveMids(snapshot, item.edges);
  assert.deepEqual(
    [...mids.keys()].sort(),
    item.edges.map(blockScanEdgeKey).sort(),
    `${item.name}: exact edge coverage`,
  );
  for (const mid of mids.values()) {
    assert(Number.isFinite(mid.mid) && mid.mid > 0, `${item.name}: positive finite mid`);
  }
  assertPureSynchronousDeriveMids({
    capability: item.capability,
    snapshot,
    edges: item.edges,
    harness: createAmbientIoPoisonHarness(),
  });
  const production = PRODUCTION_ADAPTER_FAMILIES
    .pricing("protocol-conversion")
    .find((family) => family.id === item.familyId);
  assert(production, `non-production protocol purity fixture ${item.familyId}`);
  assert.equal(
    production.pricingState,
    item.capability,
    `${item.familyId}: fixture tests the wrong pricingState capability`,
  );
  assert(
    !pureFixtureFamilyIds.has(item.familyId),
    `duplicate protocol purity fixture ${item.familyId}`,
  );
  pureFixtureFamilyIds.add(item.familyId);
  console.log(`[protocol-blockscan-state] ${item.name}: PASS`);
}
assert.deepEqual(
  [...pureFixtureFamilyIds].sort(),
  PRODUCTION_ADAPTER_FAMILIES
    .pricing("protocol-conversion")
    .map((family) => family.id)
    .sort(),
  "every production protocol pricing family requires one passing purity fixture",
);

// A failed dynamic call is never decoded into a zero/default quote.
{
  const item = cases[2];
  let schema = await item.capability.compileStaticSchema({
    edges: item.edges,
    deadlineAtMs: Date.now() + 10_000,
    signal: abort.signal,
  });
  const staticReads = item.capability.buildStaticSchemaReads?.({
    sourceBlock: block,
    sourceBlockHash: blockHash,
    schema,
    edges: item.edges,
  }) ?? [];
  if (staticReads.length > 0) {
    schema = item.capability.hydrateStaticSchema!(
      schema,
      staticReads.map((read): StateReadResult => ({
        id: read.id,
        ok: true,
        sourceBlock: block,
        sourceBlockHash: blockHash,
        provenance: {
          kind: "eip1898",
          source: { number: block, hash: blockHash, generation: 1 },
          requireCanonical: true,
        },
        data: item.response(read),
      })),
    );
  }
  assert.throws(
    () => item.capability.decodeState(schema, [{
      id: "tin",
      ok: false,
      sourceBlock: block,
      sourceBlockHash: blockHash,
      kind: "rpc",
      error: "forced fee read failure",
    }]),
    /forced fee read failure/,
    "PSM fee failure must stay unresolved",
  );
  console.log("[protocol-blockscan-state] dynamic read failure is fail-closed: PASS");
}

await assertErc4626AdaptiveProbe();

{
  const logicalA: TokenEdge = {
    ...edge("erc4626-deposit", vault, tokenA, tokenB, "wrap"),
    instanceKey: JSON.stringify([vault.toLowerCase(), "logical-a"]),
    executionVariantKey: "erc4626-deposit",
  };
  const logicalB: TokenEdge = {
    ...logicalA,
    instanceKey: JSON.stringify([vault.toLowerCase(), "logical-b"]),
  };
  assert.notEqual(
    erc4626Adapter.pricingState.stateKey(logicalA),
    erc4626Adapter.pricingState.stateKey(logicalB),
    "protocol state groups must preserve family instance identity",
  );
  assert.notEqual(
    blockScanEdgeKey(logicalA),
    blockScanEdgeKey(logicalB),
    "block-scan edge identity must preserve logical instances",
  );
  console.log("[protocol-blockscan-state] logical instance state isolation: PASS");
}

async function assertErc4626AdaptiveProbe(): Promise<void> {
  const asset = "0x00000000000000000000000000000000000000a6";
  const adaptiveVault = "0x0000000000000000000000000000000000000462";
  const adaptiveEdge = edge(
    "erc4626-redeem",
    adaptiveVault,
    adaptiveVault,
    asset,
    "redeem",
  );
  const capability = erc4626Adapter.pricingState;
  let schema = await capability.compileStaticSchema({
    edges: [adaptiveEdge],
    deadlineAtMs: Date.now() + 10_000,
    signal: abort.signal,
  });
  const staticReads = capability.buildStaticSchemaReads!({
    sourceBlock: block,
    sourceBlockHash: blockHash,
    schema,
    edges: [adaptiveEdge],
  });
  assert.equal(staticReads.length, 1, "adaptive quote reads only input decimals");
  assert.equal(
    staticReads[0].to.toLowerCase(),
    adaptiveVault.toLowerCase(),
    "redeem probe amount is derived from its input share token",
  );
  schema = capability.hydrateStaticSchema!(
    schema,
    staticReads.map((read): StateReadResult => ({
      id: read.id,
      ok: true,
      sourceBlock: block,
      sourceBlockHash: blockHash,
      provenance: {
        kind: "eip1898",
        source: { number: block, hash: blockHash, generation: 1 },
        requireCanonical: true,
      },
      data: uint8(6),
    })),
  );

  const ladder = [
    [1_000_000n, 0n],
    [1_000_000_000n, 0n],
    [1_000_000_000_000n, 1n],
  ] as const;
  const results: StateReadResult[] = [];
  const observedAmounts: bigint[] = [];
  for (let round = 0; round < ladder.length; round++) {
    const reads = round === 0
      ? capability.buildCurrentBlockReads({
          sourceBlock: block,
          sourceBlockHash: blockHash,
          schema,
          edges: [adaptiveEdge],
        })
      : capability.buildDependentBlockReads!({
          sourceBlock: block,
          sourceBlockHash: blockHash,
          schema,
          edges: [adaptiveEdge],
          completedRound: round - 1,
          priorResults: results,
        });
    assert.equal(reads.length, 1, `adaptive round ${round} emits one quote`);
    const amount = BigInt(
      erc4626Iface.decodeFunctionData("previewRedeem", reads[0].data)[0],
    );
    observedAmounts.push(amount);
    assert.equal(amount, ladder[round][0], `adaptive round ${round} amount`);
    results.push({
      id: reads[0].id,
      ok: true,
      sourceBlock: block,
      sourceBlockHash: blockHash,
      provenance: {
        kind: "eip1898",
        source: { number: block, hash: blockHash, generation: 1 },
        requireCanonical: true,
      },
      data: erc4626Iface.encodeFunctionResult(
        "previewRedeem",
        [ladder[round][1]],
      ),
    });
  }
  assert.deepEqual(observedAmounts, ladder.map(([amount]) => amount));
  assert.deepEqual(
    capability.buildDependentBlockReads!({
      sourceBlock: block,
      sourceBlockHash: blockHash,
      schema,
      edges: [adaptiveEdge],
      completedRound: ladder.length - 1,
      priorResults: results,
    }),
    [],
    "adaptive quote closes on the first positive raw output unit",
  );
  const snapshot = capability.decodeState(schema, results);
  const mid = capability.deriveMids(snapshot, [adaptiveEdge]).get(
    blockScanEdgeKey(adaptiveEdge),
  );
  assert(mid, "adaptive quote publishes the bounded positive result");
  assert.equal(
    mid.reserveA,
    ladder.at(-1)![0] * 10_000n,
    "mid depth uses the first positive probe amount",
  );
  assert.equal(
    mid.reserveB,
    ladder.at(-1)![1] * 10_000n,
    "mid depth preserves the matching first-positive output",
  );
  assert.equal(
    mid.mid,
    Number(ladder.at(-1)![1]) / Number(ladder.at(-1)![0]),
    "mid ratio uses matching input/output units",
  );

  const zeroResults = results.map((result) => ({
    ...result,
    data: erc4626Iface.encodeFunctionResult("previewRedeem", [0n]),
  }));
  const zeroSnapshot = capability.decodeState(schema, zeroResults);
  assert.throws(
    () => capability.deriveMids(zeroSnapshot, [adaptiveEdge]),
    /remained zero within its declared bound/,
    "all-zero quote ladders fail closed instead of expanding without bound",
  );
  await assertErc4626NoPositiveQuoteAmplification(capability);
  console.log("[protocol-blockscan-state] bounded ERC4626 adaptive quote: PASS");
}

async function assertErc4626NoPositiveQuoteAmplification(
  capability: NonNullable<typeof erc4626Adapter.pricingState>,
): Promise<void> {
  const asset = "0x00000000000000000000000000000000000000a6";
  const edges = Array.from({ length: 17 }, (_, index) => {
    const vault = ethers.getAddress(
      `0x${(0x5000 + index).toString(16).padStart(40, "0")}`,
    );
    return edge("erc4626-redeem", vault, vault, asset, "redeem");
  });
  let schema = await capability.compileStaticSchema({
    edges,
    deadlineAtMs: Date.now() + 10_000,
    signal: abort.signal,
  });
  const staticReads = capability.buildStaticSchemaReads!({
    sourceBlock: block,
    sourceBlockHash: blockHash,
    schema,
    edges,
  });
  assert.equal(
    staticReads.length,
    edges.length,
    "17 vault groups require 17 input-decimal reads, not 34 input/output reads",
  );
  assert(
    staticReads.every((read) =>
      edges.some((candidate) =>
        candidate.tokenIn.toLowerCase() === read.to.toLowerCase()
      )
    ),
    "adaptive metadata reads are input-token scoped",
  );
  schema = capability.hydrateStaticSchema!(
    schema,
    staticReads.map((read): StateReadResult => ({
      id: read.id,
      ok: true,
      sourceBlock: block,
      sourceBlockHash: blockHash,
      provenance: {
        kind: "eip1898",
        source: { number: block, hash: blockHash, generation: 1 },
        requireCanonical: true,
      },
      data: uint8(18),
    })),
  );
  let initialReadCount = 0;
  let dependentReadCount = 0;
  for (const candidate of edges) {
    const initial = capability.buildCurrentBlockReads({
      sourceBlock: block,
      sourceBlockHash: blockHash,
      schema,
      edges: [candidate],
    });
    initialReadCount += initial.length;
    const positive = initial.map((read): StateReadResult => ({
      id: read.id,
      ok: true,
      sourceBlock: block,
      sourceBlockHash: blockHash,
      provenance: {
        kind: "eip1898",
        source: { number: block, hash: blockHash, generation: 1 },
        requireCanonical: true,
      },
      data: erc4626Iface.encodeFunctionResult("previewRedeem", [1n]),
    }));
    dependentReadCount += capability.buildDependentBlockReads!({
      sourceBlock: block,
      sourceBlockHash: blockHash,
      schema,
      edges: [candidate],
      completedRound: 0,
      priorResults: positive,
    }).length;
  }
  assert.equal(initialReadCount, 17);
  assert.equal(
    dependentReadCount,
    0,
    "positive one-token quotes do not amplify into sequential RPC rounds",
  );
}

function edge(
  adapterId: string,
  target: string,
  tokenIn: string,
  tokenOut: string,
  protocolAction: TokenEdge["protocolAction"],
): TokenEdge {
  return {
    adapterId,
    target: ethers.getAddress(target),
    tokenIn: ethers.getAddress(tokenIn),
    tokenOut: ethers.getAddress(tokenOut),
    slotKind: "protocol",
    protocolAction,
    edgeKind: "protocol",
    leavesStandingPosition: false,
  };
}

function selector(read: StateRead): string {
  return read.data.slice(0, 10).toLowerCase();
}

function selectorOf(iface: ethers.Interface, fn: string): string {
  return iface.getFunction(fn)!.selector.toLowerCase();
}

function uint8(value: number): string {
  return decimalsIface.encodeFunctionResult("decimals", [value]);
}
