import "../../shared/adapters/index.js";

import { ethers } from "ethers";
import { listAll } from "../../adapters/registry.js";
import { ADDR } from "../../shared/constants/addresses.js";
import { deriveEdgeTaxonomy } from "../strategy-taxonomy.js";
import {
  mergeDeclaredProtocolVenues,
  POOL_REGISTRY,
  type PoolEntry,
  type TokenQueryBackend,
} from "../planner/token-graph.js";
import { quoteV2ExactInput } from "../solver/v2-fee.js";
import {
  LEGACY_PRODUCTION_ROUTE_EDGES,
  PRODUCTION_IDENTITY_RESOLVERS,
  PRODUCTION_ROUTE_ADAPTERS,
} from "../venues/production-registry.js";
import {
  deriveTemplateTradeAdapterIds,
  FLASH_LEND_SWAP_REPAY,
  FLASH_SWAP_REPAY,
} from "../templates/path-template.js";
import { RouteLegRegistry } from "../venues/route-leg-registry.js";
import { createRouteAdapterRegistry } from "../venues/route-adapter-registry.js";
import { runProtocolDiscoveryShadow } from "../venues/protocol-discovery.js";
import type { SwapAdapter } from "../venues/route-leg-adapter.js";

function assert(cond: boolean, message: string): asserts cond {
  if (!cond) throw new Error(`FAIL: ${message}`);
}

function assertSetEqual(actual: ReadonlySet<string>, expected: ReadonlySet<string>, message: string): void {
  const missing = [...expected].filter((item) => !actual.has(item));
  const extra = [...actual].filter((item) => !expected.has(item));
  assert(missing.length === 0 && extra.length === 0, `${message}: missing=${missing} extra=${extra}`);
}

const pair = "0x00000000000000000000000000000000000000A1";
const curvePool = "0x00000000000000000000000000000000000000C1";
const curveUnderlyingPool = "0x00000000000000000000000000000000000000C2";
const token0 = "0x0000000000000000000000000000000000000001";
const token1 = "0x0000000000000000000000000000000000000002";
const uniswapV2Factory = "0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f";
const pairIface = new ethers.Interface([
  "function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)",
  "function factory() view returns (address)",
  "function token0() view returns (address)",
  "function token1() view returns (address)",
]);
const curveIface = new ethers.Interface([
  "function coins(uint256 i) view returns (address)",
  "function coins(int128 i) view returns (address)",
  "function get_dy(int128 i, int128 j, uint256 dx) view returns (uint256)",
]);
const curveUnderlyingIface = new ethers.Interface([
  "function underlying_coins(int128 i) view returns (address)",
  "function get_dy_underlying(int128 i, int128 j, uint256 dx) view returns (uint256)",
]);

const backend: TokenQueryBackend = {
  async call(req) {
    const selector = req.data.slice(0, 10);
    if (selector === pairIface.getFunction("getReserves")!.selector) {
      return pairIface.encodeFunctionResult("getReserves", [1_000_000n, 2_000_000n, 1n]);
    }
    if (selector === pairIface.getFunction("token0")!.selector) {
      return pairIface.encodeFunctionResult("token0", [token0]);
    }
    if (selector === pairIface.getFunction("token1")!.selector) {
      return pairIface.encodeFunctionResult("token1", [token1]);
    }
    if (selector === pairIface.getFunction("factory")!.selector) {
      return pairIface.encodeFunctionResult("factory", [uniswapV2Factory]);
    }
    throw new Error(`unexpected selector ${selector}`);
  },
};

const curveBackend: TokenQueryBackend = {
  async call(req) {
    const selector = req.data.slice(0, 10);
    const uintCoins = curveIface.getFunction("coins(uint256)")!;
    const intCoins = curveIface.getFunction("coins(int128)")!;
    if (selector === uintCoins.selector || selector === intCoins.selector) {
      const fn = selector === uintCoins.selector ? uintCoins : intCoins;
      const index = Number(curveIface.decodeFunctionData(fn, req.data)[0]);
      const token = index === 0 ? token0 : index === 1 ? token1 : ethers.ZeroAddress;
      return curveIface.encodeFunctionResult(fn, [token]);
    }
    if (selector === curveIface.getFunction("get_dy")!.selector) {
      const amountIn = BigInt(curveIface.decodeFunctionData("get_dy", req.data)[2]);
      return curveIface.encodeFunctionResult("get_dy", [amountIn * 2n]);
    }
    throw new Error(`unexpected Curve selector ${selector}`);
  },
};

const curveUnderlyingBackend: TokenQueryBackend = {
  async call(req) {
    const selector = req.data.slice(0, 10);
    if (selector === curveUnderlyingIface.getFunction("underlying_coins")!.selector) {
      const index = Number(curveUnderlyingIface.decodeFunctionData("underlying_coins", req.data)[0]);
      if (index > 1) throw new Error("underlying coin index out of range");
      return curveUnderlyingIface.encodeFunctionResult("underlying_coins", [index === 0 ? token0 : token1]);
    }
    if (selector === curveUnderlyingIface.getFunction("get_dy_underlying")!.selector) {
      const amountIn = BigInt(curveUnderlyingIface.decodeFunctionData("get_dy_underlying", req.data)[2]);
      return curveUnderlyingIface.encodeFunctionResult("get_dy_underlying", [amountIn * 3n]);
    }
    // Force the explicitly allowed direct-pool fallback instead of fabricating MetaRegistry state.
    throw new Error(`unexpected Curve underlying selector ${selector}`);
  },
};

async function main(): Promise<void> {
  const adapters = PRODUCTION_ROUTE_ADAPTERS.routeLegs.list();
  assert(adapters.length === 15, `production route adapter count ${adapters.length}`);
  for (const routeAdapter of adapters) {
    for (const poolAdapter of routeAdapter.poolAdapters) {
      assert(PRODUCTION_ROUTE_ADAPTERS.routeLegs.forPool(poolAdapter) === routeAdapter, `${routeAdapter.id} pool alias`);
    }
    for (const edgeAdapterId of routeAdapter.edgeAdapterIds) {
      assert(PRODUCTION_ROUTE_ADAPTERS.routeLegs.forEdge(edgeAdapterId) === routeAdapter, `${routeAdapter.id} edge alias`);
    }
    assert(
      (routeAdapter.readMid === null) === (routeAdapter.warm === null),
      `${routeAdapter.id} mid/warm capability mismatch`,
    );
  }
  const adapter = PRODUCTION_ROUTE_ADAPTERS.routeLegs.forEdge("univ2-swap");
  assert(adapter.id === "univ2-standard", `univ2 family ${adapter.id}`);
  assert(PRODUCTION_ROUTE_ADAPTERS.routeLegs.forPool("univ2") === adapter, "pool alias lookup");
  console.log("[route-adapters] registry aliases: PASS");

  const declaredVenues = PRODUCTION_ROUTE_ADAPTERS.protocols.flatMap((protocolAdapter) => {
    const reason = protocolAdapter.undeclaredVenueReason?.trim() ?? "";
    assert(
      protocolAdapter.declaredVenues.length > 0 ? reason.length === 0 : reason.length > 0,
      `${protocolAdapter.id} venue declaration contract`,
    );
    for (const venue of protocolAdapter.declaredVenues) {
      assert(venue.score === undefined, `${protocolAdapter.id} static venue must stay pinned`);
      assert(
        POOL_REGISTRY.some((pool) =>
          pool.address.toLowerCase() === venue.address.toLowerCase() && pool.adapter === venue.adapter
        ),
        `${protocolAdapter.id} declared venue missing from graph registry`,
      );
      PRODUCTION_IDENTITY_RESOLVERS.forPool(venue.adapter);
    }
    return protocolAdapter.declaredVenues;
  });
  assert(declaredVenues.length === 6, `declared static protocol venue count ${declaredVenues.length}`);
  assert(POOL_REGISTRY.length === 29, `production pool registry count ${POOL_REGISTRY.length}`);
  assert(POOL_REGISTRY[0].address === ADDR.GOLDX, "GOLDx graph order changed");
  assert(POOL_REGISTRY[1].address === ADDR.SKY_PSM_LITE, "PSM graph order changed");
  assert(POOL_REGISTRY[2].address === ADDR.WSTETH, "wstETH graph order changed");
  assert(POOL_REGISTRY[3].address === ADDR.ROCKSOLID_RETH, "RockSolid graph order changed");
  assert(POOL_REGISTRY[4].address === ADDR.METRONOME_SYNTH_POOL, "Metronome synth graph order changed");
  assert(POOL_REGISTRY[13].address === ADDR.METRONOME_HGUSDC_ROUTER, "Metronome exit graph order changed");
  const syntheticMerge = mergeDeclaredProtocolVenues(
    [{ address: pair, adapter: "erc4626" }],
    [
      { address: token0, adapter: "goldx", graphOrder: 0 },
      { address: token1, adapter: "psm" },
    ],
  );
  assert(syntheticMerge[0].address === token0, "ordered declared venue must preserve its graph slot");
  assert(syntheticMerge[1].address === pair, "external venue order must be preserved");
  assert(syntheticMerge[2].address === token1, "new declared venue must append automatically");
  let duplicateVenueRejected = false;
  try {
    mergeDeclaredProtocolVenues(
      [{ address: pair, adapter: "erc4626" }],
      [{ address: pair, adapter: "goldx" }],
    );
  } catch {
    duplicateVenueRejected = true;
  }
  assert(duplicateVenueRejected, "declared venue may not duplicate an external registry address");
  let missingDeclarationRejected = false;
  try {
    createRouteAdapterRegistry({
      swaps: [],
      protocols: [{
        ...PRODUCTION_ROUTE_ADAPTERS.protocols[0],
        id: "protocol:missing-venue-declaration",
        declaredVenues: [],
        undeclaredVenueReason: null,
      }],
    });
  } catch {
    missingDeclarationRejected = true;
  }
  assert(missingDeclarationRejected, "protocol adapter without venues/reason must fail closed");
  console.log("[route-adapters] declared protocol venue graph derivation: PASS");

  const attestIface = new ethers.Interface([
    "function stETH() view returns (address)",
    "function gem() view returns (address)",
    "function dai() view returns (address)",
    "function asset() view returns (address)",
    "function unit() view returns (uint256)",
    "function convertToShares(uint256 assets) view returns (uint256 shares)",
  ]);
  const attestBackend = (answers: Record<string, string>): TokenQueryBackend => ({
    async call(req) {
      const answer = answers[req.data.slice(0, 10)];
      if (!answer) throw new Error(`unexpected attest selector ${req.data.slice(0, 10)}`);
      return answer;
    },
  });
  const attestSelector = (fn: string): string => attestIface.getFunction(fn)!.selector;
  const attestAnswer = (fn: string, value: string | bigint): [string, string] =>
    [attestSelector(fn), attestIface.encodeFunctionResult(fn, [value])];
  const declaredPool = (adapterName: string): PoolEntry => {
    const entry = POOL_REGISTRY.find((candidate) => candidate.adapter === adapterName);
    assert(entry !== undefined, `POOL_REGISTRY missing ${adapterName} entry`);
    return entry;
  };
  const attestCases: Array<{
    adapter: string;
    pool: PoolEntry;
    good: Record<string, string>;
    bad: Record<string, string>;
    edgeCount: number;
  }> = [
    {
      adapter: "wsteth", pool: declaredPool("wsteth"),
      good: Object.fromEntries([attestAnswer("stETH", ADDR.STETH)]),
      bad: Object.fromEntries([attestAnswer("stETH", token0)]),
      edgeCount: 2,
    },
    {
      adapter: "psm", pool: declaredPool("psm"),
      good: Object.fromEntries([attestAnswer("gem", ADDR.USDC), attestAnswer("dai", ADDR.DAI)]),
      bad: Object.fromEntries([attestAnswer("gem", token0), attestAnswer("dai", ADDR.DAI)]),
      edgeCount: 1,
    },
    {
      adapter: "goldx", pool: declaredPool("goldx"),
      good: Object.fromEntries([attestAnswer("unit", 10n ** 18n)]),
      bad: Object.fromEntries([attestAnswer("unit", 0n)]),
      edgeCount: 1,
    },
    {
      adapter: "rocksolid", pool: declaredPool("rocksolid"),
      good: Object.fromEntries([attestAnswer("convertToShares", 10n ** 18n)]),
      bad: Object.fromEntries([attestAnswer("convertToShares", 0n)]),
      edgeCount: 1,
    },
    {
      adapter: "metronome-hgusdc", pool: declaredPool("metronome-hgusdc"),
      good: Object.fromEntries([attestAnswer("asset", ADDR.USDC)]),
      bad: Object.fromEntries([attestAnswer("asset", token0)]),
      edgeCount: 1,
    },
    {
      adapter: "erc4626",
      pool: { address: pair, adapter: "erc4626", fixedTokenIn: token0 },
      good: Object.fromEntries([attestAnswer("asset", token0)]),
      bad: Object.fromEntries([attestAnswer("asset", token1)]),
      edgeCount: 2,
    },
  ];
  for (const testCase of attestCases) {
    const built = await PRODUCTION_ROUTE_ADAPTERS.routeLegs.buildEdges(
      testCase.pool, attestBackend(testCase.good),
    );
    assert(
      built.length === testCase.edgeCount,
      `${testCase.adapter} attested edge count ${built.length}`,
    );
    let attestRejected = false;
    try {
      await PRODUCTION_ROUTE_ADAPTERS.routeLegs.buildEdges(testCase.pool, attestBackend(testCase.bad));
    } catch {
      attestRejected = true;
    }
    assert(attestRejected, `${testCase.adapter} attestation mismatch must fail edge build`);
  }
  const siloEdges = await PRODUCTION_ROUTE_ADAPTERS.routeLegs.buildEdges(
    { address: pair, adapter: "erc4626", fixedTokenIn: token0, nonStandardRedeem: true, redeemTokenOut: token1 },
    attestBackend({}),
  );
  assert(siloEdges.length === 1, "silo vault must build without asset() attestation");
  console.log("[route-adapters] declared venue identity attestation: PASS");

  const discoveryIface = new ethers.Interface([
    "function asset() view returns (address)",
    "function totalAssets() view returns (uint256)",
    "function convertToShares(uint256 assets) view returns (uint256 shares)",
    "function convertToAssets(uint256 shares) view returns (uint256 assets)",
    "function previewDeposit(uint256 assets) view returns (uint256 shares)",
    "function previewRedeem(uint256 shares) view returns (uint256 assets)",
  ]);
  const vaultBackend = (consistent: boolean): TokenQueryBackend => ({
    async call(req) {
      const selector = req.data.slice(0, 10);
      const fnFor = (name: string) => discoveryIface.getFunction(name)!;
      if (selector === fnFor("asset").selector) {
        return discoveryIface.encodeFunctionResult("asset", [token0]);
      }
      if (selector === fnFor("totalAssets").selector) {
        return discoveryIface.encodeFunctionResult("totalAssets", [10n ** 12n]);
      }
      for (const doubling of ["convertToShares", "previewDeposit"] as const) {
        if (selector === fnFor(doubling).selector) {
          const amount = BigInt(discoveryIface.decodeFunctionData(doubling, req.data)[0]);
          return discoveryIface.encodeFunctionResult(doubling, [amount * 2n]);
        }
      }
      for (const halving of ["convertToAssets", "previewRedeem"] as const) {
        if (selector === fnFor(halving).selector) {
          const amount = BigInt(discoveryIface.decodeFunctionData(halving, req.data)[0]);
          return discoveryIface.encodeFunctionResult(halving, [consistent ? amount / 2n : amount]);
        }
      }
      throw new Error(`unexpected discovery selector ${selector}`);
    },
  });
  const silentLog = (): void => {};
  const erc4626RouteAdapter = PRODUCTION_ROUTE_ADAPTERS.protocols.find(
    (candidate) => candidate.id === "protocol:erc4626",
  );
  assert(erc4626RouteAdapter !== undefined, "erc4626 route adapter missing");
  const shadowConsistent = await runProtocolDiscoveryShadow({
    adapters: PRODUCTION_ROUTE_ADAPTERS.protocols,
    backend: vaultBackend(true),
    universeTokens: [pair, pair],
    enableProtocolEdges: true,
    parkedCandidates: [token1],
    log: silentLog,
  });
  assert(shadowConsistent.adapters.length === 1, "only discovery-bearing adapters may report");
  const erc4626Report = shadowConsistent.adapters[0];
  assert(erc4626Report.adapterId === "protocol:erc4626", `discovery adapter ${erc4626Report.adapterId}`);
  assert(erc4626Report.candidates === 1, `duplicate candidates must dedupe: ${erc4626Report.candidates}`);
  assert(erc4626Report.attested === 1 && erc4626Report.quarantined === 0, "consistent vault must attest");
  assert(erc4626Report.routes.length === 2, `erc4626 discovery route count ${erc4626Report.routes.length}`);
  assert(
    erc4626Report.routes.every((verdict) =>
      verdict.probe.ok && !verdict.wouldAdmit && verdict.wouldAdmitReason === "receipt_verification_pending"
    ),
    "preview-grade probes must never report admissible",
  );
  assert(
    erc4626Report.parkedWouldDequeue.length === 1 &&
      erc4626Report.parkedWouldDequeue[0] === token1,
    "attest-passing parked candidate must report as dequeueable",
  );
  const shadowInconsistent = await runProtocolDiscoveryShadow({
    adapters: [erc4626RouteAdapter],
    backend: vaultBackend(false),
    universeTokens: [pair],
    enableProtocolEdges: true,
    log: silentLog,
  });
  assert(
    shadowInconsistent.adapters[0].quarantined === 1 &&
      shadowInconsistent.adapters[0].attested === 0 &&
      shadowInconsistent.adapters[0].routes.length === 0,
    "convertTo* round-trip mismatch must quarantine before enumerate/probe",
  );
  const discoveryCalls: string[] = [];
  const fakeDiscoveryAdapter = {
    ...erc4626RouteAdapter,
    id: "protocol:fake-discovery" as const,
    requiresProtocolEdgesFlag: true,
    discovery: {
      async discoverInstances() {
        return [
          { target: token0, source: "universe-token" as const },
          { target: token1, source: "universe-token" as const },
        ];
      },
      async attestIdentity(candidate: { target: string }) {
        return candidate.target === token0
          ? null
          : { target: candidate.target, adapter: "erc4626" as const };
      },
      async enumerateRoutes(instance: { target: string }) {
        discoveryCalls.push(`enumerate:${instance.target}`);
        return [
          {
            target: instance.target, tokenIn: token0, tokenOut: instance.target,
            action: "wrap" as const, edgeAdapterId: "erc4626-deposit",
          },
          {
            target: instance.target, tokenIn: instance.target, tokenOut: token0,
            action: "redeem" as const, edgeAdapterId: "erc4626-redeem",
          },
        ];
      },
      async probeRoute(route: { edgeAdapterId: string }) {
        discoveryCalls.push(`probe:${route.edgeAdapterId}`);
        if (route.edgeAdapterId === "erc4626-redeem") throw new Error("probe revert");
        return { ok: true, reason: null, receiptVerified: true };
      },
    },
  };
  const shadowFlagOff = await runProtocolDiscoveryShadow({
    adapters: [fakeDiscoveryAdapter],
    backend: backend,
    universeTokens: [],
    enableProtocolEdges: false,
    log: silentLog,
  });
  const fakeReport = shadowFlagOff.adapters[0];
  assert(fakeReport.quarantined === 1, "attest null must quarantine");
  assert(
    !discoveryCalls.some((entry) => entry.includes(token0.toLowerCase()) || entry.includes(token0)),
    "quarantined candidate must never reach enumerate/probe",
  );
  const depositVerdict = fakeReport.routes.find((v) => v.route.edgeAdapterId === "erc4626-deposit");
  const redeemVerdict = fakeReport.routes.find((v) => v.route.edgeAdapterId === "erc4626-redeem");
  assert(depositVerdict !== undefined && redeemVerdict !== undefined, "fake discovery routes missing");
  assert(
    !depositVerdict.wouldAdmit && depositVerdict.wouldAdmitReason === "protocol_edges_flag_off",
    "flag gate must be re-executed on the coordinator side (P0-3)",
  );
  assert(
    !redeemVerdict.probe.ok && !redeemVerdict.wouldAdmit &&
      redeemVerdict.wouldAdmitReason.startsWith("probe_failed"),
    "probe revert must fail closed",
  );
  const shadowFlagOn = await runProtocolDiscoveryShadow({
    adapters: [fakeDiscoveryAdapter],
    backend: backend,
    universeTokens: [],
    enableProtocolEdges: true,
    log: silentLog,
  });
  const admittedVerdict = shadowFlagOn.adapters[0].routes.find(
    (v) => v.route.edgeAdapterId === "erc4626-deposit",
  );
  assert(
    admittedVerdict !== undefined && admittedVerdict.wouldAdmit &&
      admittedVerdict.wouldAdmitReason === "admissible",
    "verified route with flag on must report admissible",
  );
  console.log("[route-adapters] shadow discovery coordinator: PASS");

  const pool: PoolEntry = { address: pair, adapter: "univ2", token0, token1, score: 7 };
  const edges = await PRODUCTION_ROUTE_ADAPTERS.routeLegs.buildEdges(pool, backend);
  assert(edges.length === 2, `univ2 edge count ${edges.length}`);
  assert(edges[0].adapterId === "univ2-swap", `edge adapter ${edges[0].adapterId}`);
  assert(edges[0].tokenIn === ethers.getAddress(token0), `edge token0 ${edges[0].tokenIn}`);
  assert(edges[0].tokenOut === ethers.getAddress(token1), `edge token1 ${edges[0].tokenOut}`);
  assert(edges.every((edge) => edge.edgeKind === "swap" && !edge.leavesStandingPosition), "edge taxonomy");
  assert(edges.every((edge) => edge.score === 7), "edge score propagation");
  console.log("[route-adapters] univ2 graph equivalence: PASS");

  const amountIn = 10_000n;
  const quoted = await adapter.quoteExact({
    state: backend as never,
    target: pair,
    edgeAdapterId: "univ2-swap",
    tokenIn: token0,
    tokenOut: token1,
    amountIn,
  });
  assert(
    quoted === quoteV2ExactInput(1_000_000n, 2_000_000n, amountIn, 30n),
    `univ2 quote ${quoted}`,
  );
  assert(adapter.prepared?.quote !== null && adapter.prepared?.quote !== undefined, "univ2 prepared quote");
  const preparedV2Context = {
    request: {
      adapterId: "univ2-swap", target: pair, tokenIn: token0, tokenOut: token1, amountIn,
    },
    edge: edges[0],
    async callPrepared(to: string, data: string) {
      return {
        output: await backend.call({ to, data }),
        latencyMs: 1,
        cacheStats: { warmHits: 1, coldMisses: 0 },
      };
    },
    readChain: (req: { to: string; data: string }) => backend.call(req),
  };
  const preparedV2Quote = await adapter.prepared.quote(preparedV2Context);
  assert(preparedV2Quote.amountOut === quoted, `univ2 prepared quote ${preparedV2Quote.amountOut}`);
  const preparedV2Calls = await adapter.prepared.encodeQuotePrewarm!(preparedV2Context);
  assert(preparedV2Calls.length === 1, `univ2 prepared prewarm count ${preparedV2Calls.length}`);
  console.log("[route-adapters] univ2 quote equivalence: PASS");

  const fragment = await adapter.buildPlanFragment({
    edge: edges[0],
    amountIn,
    amountOut: quoted,
    executor: "0x00000000000000000000000000000000000000E1",
    state: backend as never,
  });
  assert(fragment.requirements.length === 0, "univ2 has no sibling requirement");
  assert(fragment.nodes.length === 1, "univ2 one wrapper node");
  assert(fragment.nodes[0].adapterId === "univ2-swap", "univ2 wrapper action");
  assert(fragment.nodes[0].children[0]?.adapterId === "erc20-transfer", "univ2 callback transfer");
  console.log("[route-adapters] univ2 plan fragment equivalence: PASS");

  const curveAdapter = PRODUCTION_ROUTE_ADAPTERS.routeLegs.forFamily("curve-plain");
  const curveEdges = await PRODUCTION_ROUTE_ADAPTERS.routeLegs.buildEdges(
    { address: curvePool, adapter: "curve", score: 5 },
    curveBackend,
  );
  assert(curveEdges.length === 2, `curve edge count ${curveEdges.length}`);
  assert(curveEdges.every((edge) => edge.curveI !== edge.curveJ && edge.score === 5), "curve indices/score");
  const curveQuote = await curveAdapter.quoteExact({
    state: curveBackend as never,
    target: curvePool,
    edgeAdapterId: "curve-exchange-plain",
    tokenIn: token0,
    tokenOut: token1,
    amountIn,
  });
  assert(curveQuote === amountIn * 2n, `curve quote ${curveQuote}`);
  assert(curveAdapter.prepared?.quote !== null && curveAdapter.prepared?.quote !== undefined, "curve prepared quote");
  const preparedCurveContext = {
    request: {
      adapterId: "curve-exchange-plain", target: curvePool,
      tokenIn: token0, tokenOut: token1, amountIn,
    },
    edge: curveEdges[0],
    async callPrepared(to: string, data: string) {
      return { output: await curveBackend.call({ to, data }), latencyMs: 1 };
    },
    readChain: (req: { to: string; data: string }) => curveBackend.call(req),
  };
  const preparedCurveQuote = await curveAdapter.prepared.quote(preparedCurveContext);
  assert(
    preparedCurveQuote.amountOut === curveQuote,
    `curve prepared quote ${preparedCurveQuote.amountOut}`,
  );
  const preparedCurveCalls = await curveAdapter.prepared.encodeQuotePrewarm!(preparedCurveContext);
  assert(preparedCurveCalls.length === 2, `curve prepared prewarm count ${preparedCurveCalls.length}`);
  const curveFragment = await curveAdapter.buildPlanFragment({
    edge: curveEdges[0], amountIn, amountOut: curveQuote,
    executor: ethers.ZeroAddress, state: curveBackend as never,
  });
  assert(curveFragment.requirements[0]?.kind === "approve", "curve approval requirement");
  assert(curveFragment.nodes[0]?.adapterId === "curve-exchange-plain", "curve plain action");
  console.log("[route-adapters] curve plain graph/quote/plan equivalence: PASS");

  const underlyingAdapter = PRODUCTION_ROUTE_ADAPTERS.routeLegs.forFamily("curve-underlying");
  const underlyingEdges = await PRODUCTION_ROUTE_ADAPTERS.routeLegs.buildEdges(
    { address: curveUnderlyingPool, adapter: "curve-underlying", score: 3 },
    curveUnderlyingBackend,
  );
  assert(underlyingEdges.length === 2, `curve underlying edge count ${underlyingEdges.length}`);
  const underlyingQuote = await underlyingAdapter.quoteExact({
    state: curveUnderlyingBackend as never,
    target: curveUnderlyingPool,
    edgeAdapterId: "curve-exchange-underlying",
    tokenIn: token0,
    tokenOut: token1,
    amountIn,
  });
  assert(underlyingQuote === amountIn * 3n, `curve underlying quote ${underlyingQuote}`);
  const underlyingFragment = await underlyingAdapter.buildPlanFragment({
    edge: underlyingEdges[0], amountIn, amountOut: underlyingQuote,
    executor: ethers.ZeroAddress, state: curveUnderlyingBackend as never,
  });
  assert(underlyingFragment.requirements[0]?.kind === "approve", "underlying approval requirement");
  assert(underlyingFragment.nodes[0]?.adapterId === "curve-exchange-underlying", "underlying action");
  console.log("[route-adapters] curve underlying graph/quote/plan equivalence: PASS");

  const actionIds = new Set(listAll().map((action) => action.id));
  for (const routeAdapter of adapters) {
    for (const actionId of routeAdapter.actionAdapterIds) {
      assert(actionIds.has(actionId), `missing action adapter ${actionId}`);
    }
    for (const edgeAdapterId of routeAdapter.edgeAdapterIds) {
      assert(actionIds.has(edgeAdapterId), `missing edge action adapter ${edgeAdapterId}`);
      if (routeAdapter.kind === "protocol-conversion") {
        assert(
          routeAdapter.actionAdapterIds.includes(edgeAdapterId),
          `${routeAdapter.id} protocol edge ${edgeAdapterId} missing from actionAdapterIds`,
        );
      }
    }
  }
  for (const legacy of LEGACY_PRODUCTION_ROUTE_EDGES) {
    assert(
      actionIds.has(legacy.edgeAdapterId),
      `missing legacy edge action adapter ${legacy.edgeAdapterId}`,
    );
  }
  console.log("[route-adapters] action registry coverage: PASS");

  const expectedTemplateAdapters = deriveTemplateTradeAdapterIds(
    PRODUCTION_ROUTE_ADAPTERS.routeLegs.list(),
    LEGACY_PRODUCTION_ROUTE_EDGES,
  );
  for (const template of [FLASH_LEND_SWAP_REPAY, FLASH_SWAP_REPAY]) {
    const slotAdapters = template.slots.find((slot) => slot.id === "swap")?.adapters ?? [];
    assertSetEqual(
      new Set(slotAdapters),
      new Set(expectedTemplateAdapters),
      `${template.name} trade adapter registry drift`,
    );
  }
  const withSynthetic = deriveTemplateTradeAdapterIds([
    ...PRODUCTION_ROUTE_ADAPTERS.routeLegs.list(),
    {
      edgeAdapterIds: ["synthetic-route-adapter"],
      allowedTaxonomy: [{ slotKind: "swap" }],
    },
  ], LEGACY_PRODUCTION_ROUTE_EDGES);
  assert(
    withSynthetic.includes("synthetic-route-adapter"),
    "new registry adapter must flow into path templates without a second allowlist",
  );
  assert(
    expectedTemplateAdapters.includes("fluid-dex-swap"),
    "fixture-blocked Fluid DEX legacy route must stay explicitly admitted",
  );
  console.log("[route-adapters] path-template registry derivation: PASS");

  for (const protocolAdapter of PRODUCTION_ROUTE_ADAPTERS.protocols) {
    const blockscanAdmitted = protocolAdapter.allowedTaxonomy.some((taxonomy) =>
      taxonomy.slotKind === "protocol" &&
      !deriveEdgeTaxonomy(taxonomy.slotKind, taxonomy.protocolAction).leavesStandingPosition
    );
    if (!blockscanAdmitted) continue;
    assert(protocolAdapter.readMid !== null, `${protocolAdapter.id} missing blockscan mid reader`);
    assert(
      protocolAdapter.warm?.kind === "protocol-mid",
      `${protocolAdapter.id} missing blockscan protocol-mid warm capability`,
    );
  }
  console.log("[route-adapters] blockscan protocol mid capability coverage: PASS");

  const coldCache = new Proxy({}, {
    get() {
      return () => null;
    },
  });
  for (const routeAdapter of adapters) {
    if (!routeAdapter.readMid) continue;
    const result = routeAdapter.readMid({
      cache: coldCache as never,
      sourceBlock: 1,
      a: token0.toLowerCase(),
      b: token1.toLowerCase(),
      pool: pair.toLowerCase(),
      edges: [edges[0]],
    });
    assert(!(result instanceof Promise), `${routeAdapter.id} mid reader returned Promise`);
  }
  console.log("[route-adapters] sync-over-prewarmed mid contract: PASS");

  const preparedQuoteEdges = new Set([
    "curve-exchange",
    "curve-exchange-nr",
    "curve-exchange-plain",
    "curve-exchange-received-uint",
    "curve-exchange-underlying",
    "univ2-swap",
    "univ3-swap",
    "univ4-unlock",
    "dodo-v2-swap",
    "psm",
    "metronome-synth-swap",
    "goldx-mint",
  ]);
  for (const routeAdapter of adapters) {
    assert("prepared" in routeAdapter, `${routeAdapter.id} must declare prepared capability`);
    const expectsPreparedQuote = routeAdapter.edgeAdapterIds.some((edgeId) =>
      preparedQuoteEdges.has(edgeId)
    );
    assert(
      Boolean(routeAdapter.prepared?.quote) === expectsPreparedQuote,
      `${routeAdapter.id} prepared quote coverage`,
    );
    if (routeAdapter.prepared) {
      assert(
        (routeAdapter.prepared.quote === null) !==
          (routeAdapter.prepared.quoteUnsupportedReason === null),
        `${routeAdapter.id} must declare either prepared quote or unsupported reason`,
      );
      assert(
        routeAdapter.prepared.encodeQuotePrewarm !== null,
        `${routeAdapter.id} must explicitly declare prepared prewarm encoding`,
      );
      assert(
        routeAdapter.prepared.allowanceSpender !== null,
        `${routeAdapter.id} must explicitly declare prepared allowance policy`,
      );
      assert(
        routeAdapter.prepared.prewarmAddresses !== null,
        `${routeAdapter.id} must explicitly declare prepared address policy`,
      );
    }
  }
  console.log("[route-adapters] prepared-state capability coverage: PASS");

  const badAdapter: SwapAdapter = {
    ...adapter,
    id: "custom-swap:bad",
    kind: "swap",
    poolAdapters: ["univ2"],
    edgeAdapterIds: ["bad-edge"],
    observation: {
      topics: [],
      canonicalIntakeTargets: [],
      observedPoolIdentity() {
        return null;
      },
      async decodeSwapImpacts() {
        return [];
      },
    },
    async buildEdges() {
      return [{
        ...edges[0],
        adapterId: "bad-edge",
        ...deriveEdgeTaxonomy("protocol", "wrap"),
      }];
    },
  };
  const badRegistry = new RouteLegRegistry([badAdapter]);
  let rejected = false;
  try {
    await badRegistry.buildEdges(pool, backend);
  } catch {
    rejected = true;
  }
  assert(rejected, "runtime taxonomy mismatch must reject");
  console.log("[route-adapters] dynamic taxonomy guard: PASS");

  console.log("route-adapters PASS (15/15)");
}

await main();
