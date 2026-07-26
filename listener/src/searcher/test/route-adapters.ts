import "../../shared/adapters/index.js";

import { ethers } from "ethers";
import { listAll } from "../../adapters/registry.js";
import { ADDR } from "../../shared/constants/addresses.js";
import { deriveEdgeTaxonomy } from "../strategy-taxonomy.js";
import {
  buildTokenGraphWithResults,
  mergeDeclaredProtocolVenues,
  POOL_REGISTRY,
  type PoolEntry,
  type TokenQueryBackend,
} from "../planner/token-graph.js";
import { quoteV2ExactInput } from "../solver/v2-fee.js";
import { buildMempoolIntakePlan } from "../mempool-intake.js";
import {
  PRODUCTION_IDENTITY_RESOLVERS,
  PRODUCTION_ADAPTER_FAMILIES,
} from "../venues/production-registry.js";
import {
  deriveTemplateTradeAdapterIds,
  FLASH_LEND_SWAP_REPAY,
  FLASH_SWAP_REPAY,
} from "../templates/path-template.js";
import { AdapterFamilyRegistry } from "../venues/adapter-family-registry.js";
import { RouteLegRegistry } from "../venues/route-leg-registry.js";
import { routeGraphCollectionKey } from "../venues/route-instance-identity.js";
import type { SwapAdapter } from "../venues/route-leg-adapter.js";
import {
  IdentityResolverRegistry,
  resolvePoolIdentity,
} from "../venues/identity.js";
import {
  poolAdapterId,
  venueId,
  venueIdentitySource,
} from "../venues/registry-ids.js";

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
      if (index > 1) {
        throw Object.assign(new Error("underlying coin index out of range"), {
          code: "CALL_EXCEPTION",
        });
      }
      return curveUnderlyingIface.encodeFunctionResult("underlying_coins", [index === 0 ? token0 : token1]);
    }
    if (selector === curveUnderlyingIface.getFunction("get_dy_underlying")!.selector) {
      const amountIn = BigInt(curveUnderlyingIface.decodeFunctionData("get_dy_underlying", req.data)[2]);
      return curveUnderlyingIface.encodeFunctionResult("get_dy_underlying", [amountIn * 3n]);
    }
    // Force the explicitly allowed direct-pool fallback instead of fabricating MetaRegistry state.
    throw Object.assign(
      new Error(`unexpected Curve underlying selector ${selector}`),
      { code: "CALL_EXCEPTION" },
    );
  },
};

async function parentAbortCannotBeShadowedByNestedControl(): Promise<void> {
  for (const operation of ["call", "getLogs"] as const) {
    const parent = new AbortController();
    const nested = new AbortController();
    const parentReason = new Error(`parent cancelled ${operation}`);
    let observedSignal: AbortSignal | undefined;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const never = new Promise<never>(() => {
      // Deliberately ignores AbortSignal. The registry must still fence it.
    });
    const controlledBackend: TokenQueryBackend = {
      call(_req, control) {
        if (operation !== "call") throw new Error("unexpected call");
        observedSignal = control?.signal;
        markStarted();
        return never;
      },
      getLogs(_req, control) {
        if (operation !== "getLogs") throw new Error("unexpected getLogs");
        observedSignal = control?.signal;
        markStarted();
        return never;
      },
    };
    const nestedControlAdapter: SwapAdapter = {
      ...PRODUCTION_ADAPTER_FAMILIES.swaps()[0],
      id: `custom-swap:nested-${operation}-control`,
      async buildEdges(_pool, query) {
        if (operation === "call") {
          await query.call(
            { to: pair, data: "0x" },
            { signal: nested.signal, deadlineAtMs: Date.now() + 10_000 },
          );
        } else {
          await query.getLogs!(
            {
              address: pair,
              topics: [],
              fromBlock: "latest",
              toBlock: "latest",
            },
            { signal: nested.signal, deadlineAtMs: Date.now() + 10_000 },
          );
        }
        return [];
      },
    };
    const building = new RouteLegRegistry([nestedControlAdapter]).buildEdges(
      {
        address: pair,
        adapter: "univ2",
        token0,
        token1,
        score: 1,
      },
      controlledBackend,
      {
        signal: parent.signal,
        deadlineAtMs: Date.now() + 10_000,
      },
    );
    const rejectedBuilding = building.then(
      () => false,
      () => true,
    );
    await started;
    parent.abort(parentReason);
    await new Promise<void>((resolve) => setImmediate(resolve));
    const parentPropagated =
      observedSignal?.aborted === true &&
      observedSignal.reason === parentReason;
    if (!parentPropagated) {
      // Keep this focused regression test from leaving an orphan if it is run
      // against the old nested-signal-replaces-parent implementation.
      nested.abort(new Error("test cleanup"));
    }
    const rejected = await rejectedBuilding;
    assert(rejected, `${operation} build must reject after parent abort`);
    assert(
      parentPropagated,
      `${operation} nested signal must not replace the parent cancellation`,
    );
  }
  console.log("[route-adapters] nested backend control preserves parent abort: PASS");
}

async function main(): Promise<void> {
  const adapters = PRODUCTION_ADAPTER_FAMILIES.routes().list();
  assert(adapters.length === 18, `production route adapter count ${adapters.length}`);
  for (const routeAdapter of adapters) {
    for (const poolAdapter of routeAdapter.poolAdapters) {
      assert(PRODUCTION_ADAPTER_FAMILIES.routes().forPool(poolAdapter) === routeAdapter, `${routeAdapter.id} pool alias`);
    }
    for (const edgeAdapterId of routeAdapter.edgeAdapterIds) {
      assert(PRODUCTION_ADAPTER_FAMILIES.routes().forEdge(edgeAdapterId) === routeAdapter, `${routeAdapter.id} edge alias`);
    }
  }
  const adapter = PRODUCTION_ADAPTER_FAMILIES.routes().forEdge("univ2-swap");
  assert(adapter.id === "univ2-standard", `univ2 family ${adapter.id}`);
  assert(PRODUCTION_ADAPTER_FAMILIES.routes().forPool("univ2") === adapter, "pool alias lookup");
  console.log("[route-adapters] registry aliases: PASS");

  const customPoolAdapter = poolAdapterId("test-custom-pool");
  const customVenue = venueId("test-custom-venue");
  const customIdentitySource = venueIdentitySource("test-custom-identity");
  const customAddress = "0x00000000000000000000000000000000000000D1";
  const customFamily: SwapAdapter = {
    ...PRODUCTION_ADAPTER_FAMILIES.swaps()[0],
    id: "custom-swap:registry-id-conformance",
    poolAdapters: [customPoolAdapter],
    landedEvents: {
      swaps: PRODUCTION_ADAPTER_FAMILIES.swaps()[0].landedEvents.swaps.map(
        (event) => ({
          ...event,
          id: `custom-${event.id}`,
          discovery: {
            ...event.discovery,
            poolAdapter: customPoolAdapter,
            label: "custom-family",
          },
        }),
      ),
      mutations: PRODUCTION_ADAPTER_FAMILIES.swaps()[0].landedEvents.mutations.map(
        (event) => ({ ...event, id: `custom-${event.id}` }),
      ),
    },
    victimModel: {
      id: "pool-swap:registry-id-conformance",
      mode: "detect-only",
    },
    identityPolicies: [{
      poolAdapter: customPoolAdapter,
      policy: "trusted-singleton-seed",
      canonicalAddress: customAddress,
      canonicalVenueId: customVenue,
      canonicalIdentitySource: customIdentitySource,
      registeredVenueIds: [customVenue],
      registeredIdentitySources: [customIdentitySource],
    }],
  };
  const customFamilyRegistry = new AdapterFamilyRegistry([customFamily]);
  assert(
    customFamilyRegistry.routes().forPool(customPoolAdapter) === customFamily,
    "family-registered custom pool adapter must route",
  );
  assert(
    customFamilyRegistry.isRegisteredVenueId(customVenue),
    "family-registered custom venue must be visible",
  );
  assert(
    customFamilyRegistry.isRegisteredIdentitySource(customIdentitySource),
    "family-registered custom identity source must be visible",
  );
  assert(
    customFamilyRegistry.landedEvents()
      .eventsForFamily(customFamily.id).some(
        (event) => event.discovery.poolAdapter === customPoolAdapter,
      ),
    "family-owned landed event must enter the scanner/intake view automatically",
  );
  assert(
    customFamilyRegistry.landedEvents().warmTopics.includes(
      customFamily.landedEvents.mutations[0].topic,
    ),
    "family-owned mutation event must enter the warm invalidation view automatically",
  );
  assert(
    customFamilyRegistry.victimModels().forEdge(customFamily.edgeAdapterIds[0])
      ?.runtime === null,
    "family-owned detect-only victim model must enter the victim view automatically",
  );
  const customIntake = buildMempoolIntakePlan({
    pools: [],
    swaps: customFamilyRegistry.swaps(),
    options: { hotPoolTopN: 0, filteredMaxAddresses: 100 },
  });
  assert(
    customFamily.observation.canonicalIntakeTargets.every((target) =>
      customIntake.fullTargets.some((item) =>
        item.toLowerCase() === target.toLowerCase()
      )
    ),
    "registered custom family must enter public-mempool intake automatically",
  );
  const productionSwapEventCount =
    PRODUCTION_ADAPTER_FAMILIES.landedEvents().swapEvents.length;
  let badPluginRejected = false;
  try {
    new AdapterFamilyRegistry([{
      ...customFamily,
      id: "custom-swap:bad-plugin-boundary",
      landedEvents: {
        ...customFamily.landedEvents,
        swaps: [{
          ...customFamily.landedEvents.swaps[0],
          id: "bad-plugin-event",
          topic: "0x1234",
        }],
      },
      victimModel: {
        id: "pool-swap:bad-plugin-boundary",
        mode: "detect-only",
      },
    }]);
  } catch (error) {
    badPluginRejected = error instanceof Error &&
      error.message.includes("invalid topic");
  }
  assert(badPluginRejected, "invalid family event declaration must reject that registration");
  assert(
    PRODUCTION_ADAPTER_FAMILIES.landedEvents().swapEvents.length ===
      productionSwapEventCount &&
      PRODUCTION_ADAPTER_FAMILIES.routes().findForEdge("univ2-swap") !== null,
    "a rejected family registration must not poison existing families",
  );
  const observedErc4626Family = PRODUCTION_ADAPTER_FAMILIES.protocols().find(
    (family) => family.id === "protocol:erc4626",
  )!;
  let unenumerableObservedSourceRejected = false;
  try {
    new AdapterFamilyRegistry([{
      ...observedErc4626Family,
      discovery: {
        ...observedErc4626Family.discovery!,
        eventTopics: [],
      },
    }]);
  } catch (error) {
    unenumerableObservedSourceRejected = error instanceof Error &&
      error.message.includes("no enumerable event topic");
  }
  assert(
    unenumerableObservedSourceRejected,
    "an observed source without an event-enumeration surface must fail conformance",
  );
  const customIdentityRegistry = new IdentityResolverRegistry(
    customFamily.identityPolicies,
    (poolAdapter) => customFamilyRegistry.routes().findForPool(poolAdapter) !== null,
  );
  const customIdentity = await resolvePoolIdentity(
    { async call() { throw new Error("trusted singleton must not call"); } },
    customAddress,
    customPoolAdapter,
    { identityRegistry: customIdentityRegistry },
  );
  assert(
    customIdentity.ok &&
      customIdentity.venueId === customVenue &&
      customIdentity.identitySource === customIdentitySource,
    "family-registered custom identity ids must resolve",
  );

  for (
    const [label, mutate] of [
      [
        "empty pool adapter",
        (family: SwapAdapter): SwapAdapter => ({
          ...family,
          poolAdapters: ["" as typeof customPoolAdapter],
          identityPolicies: [{
            ...family.identityPolicies[0],
            poolAdapter: "" as typeof customPoolAdapter,
          }],
        }),
      ],
      [
        "unregistered custom venue",
        (family: SwapAdapter): SwapAdapter => ({
          ...family,
          identityPolicies: [{
            ...family.identityPolicies[0],
            registeredVenueIds: [],
          }],
        }),
      ],
      [
        "unregistered custom identity source",
        (family: SwapAdapter): SwapAdapter => ({
          ...family,
          identityPolicies: [{
            ...family.identityPolicies[0],
            registeredIdentitySources: [],
          }],
        }),
      ],
      [
        "duplicate custom venue",
        (family: SwapAdapter): SwapAdapter => ({
          ...family,
          identityPolicies: [{
            ...family.identityPolicies[0],
            registeredVenueIds: [customVenue, customVenue],
          }],
        }),
      ],
      [
        "duplicate custom identity source",
        (family: SwapAdapter): SwapAdapter => ({
          ...family,
          identityPolicies: [{
            ...family.identityPolicies[0],
            registeredIdentitySources: [customIdentitySource, customIdentitySource],
          }],
        }),
      ],
    ] as const
  ) {
    let rejected = false;
    try {
      new AdapterFamilyRegistry([mutate(customFamily)]);
    } catch {
      rejected = true;
    }
    assert(rejected, `${label} must fail registry conformance`);
  }

  const unregisteredRuntimeVenue = venueId("test-unregistered-runtime-venue");
  const runtimePolicy = {
    poolAdapter: customPoolAdapter,
    policy: "onchain-resolver" as const,
    async resolve() {
      return {
        ok: true as const,
        adapter: customPoolAdapter,
        venueId: unregisteredRuntimeVenue,
        identitySource: "seed" as const,
      };
    },
  };
  const runtimeIdentityRegistry = new IdentityResolverRegistry(
    [runtimePolicy],
    () => true,
  );
  let unregisteredRuntimeRejected = false;
  try {
    await resolvePoolIdentity(
      { async call() { return "0x"; } },
      customAddress,
      customPoolAdapter,
      { identityRegistry: runtimeIdentityRegistry },
    );
  } catch {
    unregisteredRuntimeRejected = true;
  }
  assert(
    unregisteredRuntimeRejected,
    "resolver-emitted unregistered custom venue must fail closed",
  );
  console.log("[route-adapters] extensible registry ids: PASS");

  const declaredVenues = PRODUCTION_ADAPTER_FAMILIES.protocols().flatMap((protocolAdapter) => {
    const reason = protocolAdapter.undeclaredVenueReason?.trim() ?? "";
    assert(
      protocolAdapter.declaredVenues.length > 0
        ? reason.length === 0
        : protocolAdapter.discovery !== undefined &&
          protocolAdapter.discoveryIdentityResolver !== undefined &&
          protocolAdapter.discoveryIdentityAuthority !== undefined &&
          protocolAdapter.discovery.candidateSources.length > 0,
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
  // ERC4626 and non-standard silo venues are provenance-only candidates; no
  // executable vault row may bootstrap either family's identity or route.
  assert(POOL_REGISTRY.length === 6, `production pool registry count ${POOL_REGISTRY.length}`);
  assert(
    !POOL_REGISTRY.some((entry) =>
      entry.adapter === "fluid-dex" || entry.adapter === "fluid-vault"
    ),
    "Fluid executable fallbacks must be discovery-owned",
  );
  assert(
    POOL_REGISTRY.filter((entry) => entry.adapter === "erc4626" && !entry.nonStandardRedeem).length === 0,
    "standard ERC4626 executable fallback count",
  );
  const erc4626Family = PRODUCTION_ADAPTER_FAMILIES.protocols().find(
    (entry) => entry.id === "protocol:erc4626",
  );
  assert(
    erc4626Family?.discovery?.candidateAddressHints?.length === 20,
    "standard ERC4626 provenance hint count",
  );
  const registryAddresses = new Set(POOL_REGISTRY.map((entry) => entry.address.toLowerCase()));
  for (
    const [address, label] of [
      [ADDR.GOLDX, "GOLDx"],
      [ADDR.SKY_PSM_LITE, "PSM"],
      [ADDR.WSTETH, "wstETH"],
      [ADDR.ROCKSOLID_RETH, "RockSolid"],
      [ADDR.METRONOME_SYNTH_POOL, "Metronome synth"],
      [ADDR.METRONOME_HGUSDC_ROUTER, "Metronome exit"],
    ] as const
  ) {
    assert(registryAddresses.has(address.toLowerCase()), `${label} declared venue missing from registry`);
  }
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
  const logicalMerge = mergeDeclaredProtocolVenues(
    [],
    [
      {
        address: pair,
        adapter: "erc4626",
        logicalInstanceId: "pair-a",
      },
      {
        address: pair,
        adapter: "erc4626",
        logicalInstanceId: "pair-b",
      },
    ],
  );
  assert(
    logicalMerge.length === 2,
    "one contract may declare two distinct logical route instances",
  );
  const declarationFamily = PRODUCTION_ADAPTER_FAMILIES.protocols().find(
    (item) => item.declaredVenues.length > 0,
  )!;
  const { graphOrder: _graphOrder, ...declarationVenue } =
    declarationFamily.declaredVenues[0];
  const multiLogicalDeclarationRegistry = new AdapterFamilyRegistry([{
    ...declarationFamily,
    id: "protocol:multi-logical-declaration",
    declaredVenues: [
      { ...declarationVenue, logicalInstanceId: "pair-a" },
      { ...declarationVenue, logicalInstanceId: "pair-b" },
    ],
  }]);
  assert(
    multiLogicalDeclarationRegistry.protocols()[0].declaredVenues.length === 2,
    "registry must admit distinct logical instances at one contract",
  );
  let duplicateLogicalDeclarationRejected = false;
  try {
    new AdapterFamilyRegistry([{
      ...declarationFamily,
      id: "protocol:duplicate-logical-declaration",
      declaredVenues: [
        { ...declarationVenue, logicalInstanceId: "pair-a" },
        { ...declarationVenue, logicalInstanceId: "pair-a" },
      ],
    }]);
  } catch {
    duplicateLogicalDeclarationRejected = true;
  }
  assert(
    duplicateLogicalDeclarationRejected,
    "registry must reject a true duplicate logical declaration",
  );
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
  let duplicateLogicalVenueRejected = false;
  try {
    mergeDeclaredProtocolVenues(
      [],
      [
        {
          address: pair,
          adapter: "erc4626",
          logicalInstanceId: "pair-a",
        },
        {
          address: pair,
          adapter: "erc4626",
          logicalInstanceId: "pair-a",
        },
      ],
    );
  } catch {
    duplicateLogicalVenueRejected = true;
  }
  assert(
    duplicateLogicalVenueRejected,
    "the same declared logical route instance must be rejected",
  );
  const logicalGraph = await buildTokenGraphWithResults(
    backend,
    [
      {
        address: pair,
        adapter: "univ2",
        token0,
        token1,
        logicalInstanceId: "pair-a",
      },
      {
        address: pair,
        adapter: "univ2",
        token0,
        token1,
        logicalInstanceId: "pair-b",
      },
    ],
    { quiet: true },
  );
  assert(
    logicalGraph.successful.length === 2 &&
      logicalGraph.edges.length === 4 &&
      new Set(logicalGraph.edges.map((edge) => edge.instanceKey)).size === 2,
    "token graph must preserve same-address logical instances",
  );
  const duplicateLogicalGraph = await buildTokenGraphWithResults(
    backend,
    [
      {
        address: pair,
        adapter: "univ2",
        token0,
        token1,
        logicalInstanceId: "pair-a",
      },
      {
        address: pair,
        adapter: "univ2",
        token0,
        token1,
        logicalInstanceId: "pair-a",
      },
    ],
    { quiet: true },
  );
  assert(
    duplicateLogicalGraph.successful.length === 1 &&
      duplicateLogicalGraph.failed.length === 1 &&
      duplicateLogicalGraph.failed[0].reason.includes("duplicate route instance"),
    "token graph must reject a true duplicate route instance",
  );
  const neutralPool = {
    address: pair,
    adapter: "erc4626" as const,
  };
  assert(
    routeGraphCollectionKey({ id: "protocol:a" }, neutralPool) ===
      routeGraphCollectionKey({ id: "protocol:b" }, neutralPool),
    "unowned cross-family rows must retain fail-closed neutral graph identity",
  );
  assert(
    routeGraphCollectionKey(
      { id: "protocol:a" },
      { ...neutralPool, discoveryOwnerAdapterId: "protocol:a" },
    ) !==
      routeGraphCollectionKey(
        { id: "protocol:b" },
        { ...neutralPool, discoveryOwnerAdapterId: "protocol:b" },
      ),
    "arbitrated discovery owners must isolate graph collection rows",
  );
  let mismatchedProjectionOwnerRejected = false;
  try {
    routeGraphCollectionKey(
      { id: "protocol:a" },
      { ...neutralPool, discoveryOwnerAdapterId: "protocol:b" },
    );
  } catch {
    mismatchedProjectionOwnerRejected = true;
  }
  assert(
    mismatchedProjectionOwnerRejected,
    "graph collection must reject a discovery owner/family mismatch",
  );
  let missingDeclarationRejected = false;
  try {
    new AdapterFamilyRegistry([{
        ...PRODUCTION_ADAPTER_FAMILIES.protocols().find(
          (item) => item.declaredVenues.length > 0,
        )!,
        id: "protocol:missing-venue-declaration",
        declaredVenues: [],
        undeclaredVenueReason: null,
        discovery: undefined,
        discoveryIdentityResolver: undefined,
        discoveryIdentityAuthority: undefined,
      }]);
  } catch {
    missingDeclarationRejected = true;
  }
  assert(
    missingDeclarationRejected,
    "protocol adapter without venues or discovery must fail closed",
  );
  let reasonOnlyProtocolRejected = false;
  try {
    const declared = PRODUCTION_ADAPTER_FAMILIES.protocols().find(
      (item) => item.declaredVenues.length > 0,
    )!;
    new AdapterFamilyRegistry([{
      ...declared,
      id: "protocol:reason-only-dead-family",
      declaredVenues: [],
      undeclaredVenueReason: "not implemented yet",
    }]);
  } catch {
    reasonOnlyProtocolRejected = true;
  }
  assert(
    reasonOnlyProtocolRejected,
    "a reason string must not activate a family without discovery/identity/source",
  );
  const grandfatheredProtocol = PRODUCTION_ADAPTER_FAMILIES.protocols().find(
    (item) => !item.requiresProtocolEdgesFlag,
  );
  assert(grandfatheredProtocol !== undefined, "test requires one grandfathered protocol adapter");
  let ungatedDiscoveryRejected = false;
  try {
    new AdapterFamilyRegistry([{
        ...grandfatheredProtocol,
        id: "protocol:ungated-discovery",
        discovery: {
          candidateSources: [],
          eventTopics: [],
          callSelectors: [],
          async probeCandidate() { return []; },
        },
      }]);
  } catch {
    ungatedDiscoveryRejected = true;
  }
  assert(ungatedDiscoveryRejected, "dynamic protocol discovery must stay behind feature admission");
  let unversionedAddressMatcherRejected = false;
  try {
    new AdapterFamilyRegistry([{
        ...PRODUCTION_ADAPTER_FAMILIES.protocols().find((item) => item.id === "protocol:erc4626")!,
        discovery: {
          candidateSources: ["dex-token-domain"],
          eventTopics: [],
          callSelectors: [],
          async candidateFromAddress() { return null; },
          async probeCandidate() { return []; },
        },
      }]);
  } catch {
    unversionedAddressMatcherRejected = true;
  }
  assert(
    unversionedAddressMatcherRejected,
    "address discovery matcher must version persisted positive/negative evidence",
  );
  let unprovenAddressCacheRejected = false;
  try {
    const base = PRODUCTION_ADAPTER_FAMILIES.protocols().find(
      (item) => item.id === "protocol:erc4626",
    )!;
    new AdapterFamilyRegistry([{
      ...base,
      discovery: {
        ...base.discovery!,
        addressMatcherCachePolicy: {
          kind: "current-block-dependency-fingerprint",
          invariant: "unproven-output-invariant",
          version: "bad-cache-contract-v1",
          async currentDependencyFingerprint() {
            return `0x${"00".repeat(32)}`;
          },
        } as unknown as NonNullable<
          typeof base.discovery
        >["addressMatcherCachePolicy"],
      },
    }]);
  } catch {
    unprovenAddressCacheRejected = true;
  }
  assert(
    unprovenAddressCacheRejected,
    "cross-block address cache reuse requires the typed immutability contract",
  );
  let unbackedAddressHintsRejected = false;
  try {
    new AdapterFamilyRegistry([{
        ...erc4626Family!,
        discovery: {
          candidateSources: ["observed-interaction"],
          candidateAddressHints: [pair],
          eventTopics: [],
          callSelectors: [],
          observedMatcherVersion: "test-v1",
          async candidateFromObservedCall() { return null; },
          async probeCandidate() { return []; },
        },
      }]);
  } catch {
    unbackedAddressHintsRejected = true;
  }
  assert(
    unbackedAddressHintsRejected,
    "candidate address hints without dex-token-domain matcher must fail closed",
  );
  console.log("[route-adapters] declared protocol venue graph derivation: PASS");

  const attestIface = new ethers.Interface([
    "function stETH() view returns (address)",
    "function gem() view returns (address)",
    "function dai() view returns (address)",
    "function asset() view returns (address)",
    "function unit() view returns (uint256)",
    "function convertToShares(uint256 assets) view returns (uint256 shares)",
  ]);
  const attestBackend = (answers: Record<string, string>, expectedTo?: string): TokenQueryBackend => ({
    async call(req) {
      if (expectedTo !== undefined && req.to.toLowerCase() !== expectedTo.toLowerCase()) {
        throw new Error(`attest call sent to ${req.to}, expected ${expectedTo}`);
      }
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
    /** The contract the attest eth_call must target; defaults to the pool address. */
    attestTarget?: string;
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
      attestTarget: ADDR.HGUSDC,
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
    const attestTarget = testCase.attestTarget ?? testCase.pool.address;
    const built = await PRODUCTION_ADAPTER_FAMILIES.routes().buildEdges(
      testCase.pool, attestBackend(testCase.good, attestTarget),
    );
    assert(
      built.length === testCase.edgeCount,
      `${testCase.adapter} attested edge count ${built.length}`,
    );
    let attestError = "";
    try {
      await PRODUCTION_ADAPTER_FAMILIES.routes().buildEdges(
        testCase.pool, attestBackend(testCase.bad, attestTarget),
      );
    } catch (err) {
      attestError = err instanceof Error ? err.message : String(err);
    }
    assert(
      attestError.includes("identity attestation failed"),
      `${testCase.adapter} bad case must fail on the attestation check, got: ${attestError}`,
    );
  }
  const quarantinedLegacySiloEdges = await PRODUCTION_ADAPTER_FAMILIES.routes().buildEdges(
    { address: pair, adapter: "erc4626", fixedTokenIn: token0, nonStandardRedeem: true, redeemTokenOut: token1 },
    attestBackend({}),
  );
  assert(
    quarantinedLegacySiloEdges.length === 0,
    "legacy silo metadata must not bootstrap an executable edge",
  );
  const siloEdges = await PRODUCTION_ADAPTER_FAMILIES.routes().buildEdges(
    {
      address: pair,
      adapter: "erc4626-silo-redeem",
      verifiedRoutes: [{
        edgeAdapterId: "erc4626-redeem-silo",
        tokenIn: pair,
        tokenOut: token1,
        slotKind: "protocol",
        protocolAction: "redeem",
      }],
    },
    attestBackend(Object.fromEntries([attestAnswer("asset", token0)])),
  );
  assert(
    siloEdges.length === 1 &&
      siloEdges[0].adapterId === "erc4626-redeem-silo",
    "probe-verified silo family must emit exactly one edge",
  );
  console.log("[route-adapters] declared venue identity attestation: PASS");

  const pool: PoolEntry = { address: pair, adapter: "univ2", token0, token1, score: 7 };
  const edges = await PRODUCTION_ADAPTER_FAMILIES.routes().buildEdges(pool, backend);
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

  const curveAdapter = PRODUCTION_ADAPTER_FAMILIES.routes().forFamily("curve-plain");
  const curveEdges = await PRODUCTION_ADAPTER_FAMILIES.routes().buildEdges(
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

  const underlyingAdapter = PRODUCTION_ADAPTER_FAMILIES.routes().forFamily("curve-underlying");
  const underlyingEdges = await PRODUCTION_ADAPTER_FAMILIES.routes().buildEdges(
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
  const underlyingPreparedQuote = underlyingAdapter.prepared?.quote;
  assert(
    underlyingPreparedQuote !== null &&
      underlyingPreparedQuote !== undefined,
    "curve underlying prepared quote",
  );
  let preparedUnderlyingCallCount = 0;
  const preparedUnderlyingQuote = await underlyingPreparedQuote({
    request: {
      adapterId: "curve-exchange-underlying",
      target: curveUnderlyingPool,
      tokenIn: token0,
      tokenOut: token1,
      amountIn,
    },
    edge: underlyingEdges[0],
    async callPrepared(to: string, data: string) {
      preparedUnderlyingCallCount++;
      return {
        output: await curveUnderlyingBackend.call({ to, data }),
        latencyMs: 1,
      };
    },
    readChain: (req: { to: string; data: string }) =>
      curveUnderlyingBackend.call(req),
  });
  assert(
    preparedUnderlyingQuote.amountOut === underlyingQuote &&
      preparedUnderlyingCallCount === 1,
    "prepared Curve-underlying quote must use edge indices in one physical call",
  );
  const underlyingFragment = await underlyingAdapter.buildPlanFragment({
    edge: underlyingEdges[0], amountIn, amountOut: underlyingQuote,
    executor: ethers.ZeroAddress, state: curveUnderlyingBackend as never,
  });
  assert(underlyingFragment.requirements[0]?.kind === "approve", "underlying approval requirement");
  assert(underlyingFragment.nodes[0]?.adapterId === "curve-exchange-underlying", "underlying action");
  console.log("[route-adapters] curve underlying graph/quote/plan equivalence: PASS");

  const actionIds = new Set(listAll().map((action) => action.id));
  for (const routeAdapter of adapters) {
    for (const actionId of [
      ...routeAdapter.ownedActionAdapterIds,
      ...routeAdapter.requiredInfraActionAdapterIds,
    ]) {
      assert(actionIds.has(actionId), `missing action adapter ${actionId}`);
    }
    for (const edgeAdapterId of routeAdapter.edgeAdapterIds) {
      if (routeAdapter.kind === "protocol-conversion") {
        assert(
          routeAdapter.ownedActionAdapterIds.includes(edgeAdapterId),
          `${routeAdapter.id} protocol edge ${edgeAdapterId} missing from ownedActionAdapterIds`,
        );
      }
    }
  }
  console.log("[route-adapters] action registry coverage: PASS");

  const expectedTemplateAdapters = deriveTemplateTradeAdapterIds(
    PRODUCTION_ADAPTER_FAMILIES.routes().list(),
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
    ...PRODUCTION_ADAPTER_FAMILIES.routes().list(),
    {
      edgeAdapterIds: ["synthetic-route-adapter"],
      allowedTaxonomy: [{ slotKind: "swap" }],
    },
  ]);
  assert(
    withSynthetic.includes("synthetic-route-adapter"),
    "new registry adapter must flow into path templates without a second allowlist",
  );
  assert(
    expectedTemplateAdapters.includes("fluid-dex-swap"),
    "Fluid DEX family route must stay admitted through the universal registry",
  );
  console.log("[route-adapters] path-template registry derivation: PASS");

  for (const protocolAdapter of PRODUCTION_ADAPTER_FAMILIES.protocols()) {
    const blockscanAdmitted = protocolAdapter.allowedTaxonomy.some((taxonomy) =>
      taxonomy.slotKind === "protocol" &&
      !deriveEdgeTaxonomy(taxonomy.slotKind, taxonomy.protocolAction).leavesStandingPosition
    );
    if (!blockscanAdmitted) continue;
    assert(
      protocolAdapter.pricingState !== null,
      `${protocolAdapter.id} missing family-owned current-N pricing state`,
    );
  }
  console.log("[route-adapters] current-N protocol pricing capability coverage: PASS");

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
    "fluid-dex-swap",
    "psm",
    "metronome-synth-swap",
    "goldx-mint",
    "eigenpie-deposit-asset",
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
    landedEvents: {
      swaps: [],
      mutations: [],
    },
    observation: {
      topics: [],
      canonicalIntakeTargets: [],
      observedPoolIdentity() {
        return null;
      },
      async decodeReceiptImpacts() {
        return { status: "no-match" };
      },
    },
    victimModel: {
      id: "pool-swap:bad-detect-only",
      mode: "detect-only",
    },
    pricingState: {
      stateKey: (edge) => edge.target.toLowerCase(),
      compileStaticSchema: () => null,
      buildCurrentBlockReads: () => [],
      decodeState: () => null,
      deriveMids: () => new Map(),
      dependencies: () => [],
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

  let unstableIdentityToggle = false;
  const unstableIdentityAdapter: SwapAdapter = {
    ...PRODUCTION_ADAPTER_FAMILIES.swaps()[0],
    id: "custom-swap:unstable-route-identity",
    routeIdentity: {
      instanceKey() {
        unstableIdentityToggle = !unstableIdentityToggle;
        return unstableIdentityToggle ? "instance-a" : "instance-b";
      },
      executionVariantKey(edge) {
        return edge.adapterId;
      },
    },
    async buildEdges() {
      return [{ ...edges[0] }];
    },
  };
  let unstableIdentityRejected = false;
  try {
    await new RouteLegRegistry([unstableIdentityAdapter]).buildEdges(pool, backend);
  } catch {
    unstableIdentityRejected = true;
  }
  assert(
    unstableIdentityRejected,
    "family route identity must be stable across one registry build",
  );

  const duplicateIdentityAdapter: SwapAdapter = {
    ...PRODUCTION_ADAPTER_FAMILIES.swaps()[0],
    id: "custom-swap:duplicate-route-identity",
    async buildEdges() {
      return [{ ...edges[0] }, { ...edges[0] }];
    },
  };
  let duplicateIdentityRejected = false;
  try {
    await new RouteLegRegistry([duplicateIdentityAdapter]).buildEdges(pool, backend);
  } catch {
    duplicateIdentityRejected = true;
  }
  assert(
    duplicateIdentityRejected,
    "family route identity must be unique within one directed instance",
  );

  const discoverable = PRODUCTION_ADAPTER_FAMILIES.protocols().find(
    (family) => family.discovery !== undefined,
  )!;
  let invalidAuthorityRejected = false;
  try {
    new AdapterFamilyRegistry([{
      ...discoverable,
      id: "protocol:invalid-authority",
      discoveryIdentityAuthority: {
        class: "canonical-onchain",
        strength: -1,
      },
    }]);
  } catch {
    invalidAuthorityRejected = true;
  }
  assert(
    invalidAuthorityRejected,
    "registry must reject invalid typed identity authority strength",
  );

  const sharedOnly = new AdapterFamilyRegistry([{
    ...discoverable,
    id: "protocol:shared-infra-only",
    ownedActionAdapterIds: [],
    requiredInfraActionAdapterIds: [
      ...discoverable.requiredInfraActionAdapterIds,
      ...discoverable.ownedActionAdapterIds,
    ],
  }]);
  assert(
    sharedOnly.actionIds().owned.length === 0 &&
      sharedOnly.actionIds().requiredInfra.length > 0,
    "a light family may reuse shared ActionAdapters without inventing a dummy owner",
  );
  console.log("[route-adapters] family instance/authority conformance: PASS");

  await parentAbortCannotBeShadowedByNestedControl();

  console.log("route-adapters PASS (17/17)");
}

await main();
