import assert from "node:assert/strict";
import { ethers } from "ethers";
import { ADDR } from "../../shared/constants/addresses.js";
import {
  createCanonicalProtocolIdentityAttester,
  EMPTY_PROTOCOL_DISCOVERY_OWNERSHIP,
  executionFingerprint,
  prepareProtocolDiscoveryProjection,
  runProtocolDiscovery,
} from "../protocol-instance-discovery.js";
import { buildStrategyViews } from "../strategy-views.js";
import type {
  ProtocolDiscoveryContext,
  ProtocolDiscoveryReadBackend,
} from "../venues/route-leg-adapter.js";
import {
  fluidCreditAdapter,
  fluidVaultDiscovery,
} from "../venues/credit/fluid.js";
import {
  fluidDexAdapter,
  fluidDexDiscovery,
} from "../venues/swaps/fluid-dex.js";
import { bindRouteInstanceIdentity } from "../venues/route-instance-identity.js";
import {
  createStrictCentralAdapterRuntime,
  type StrictSimulationTransport,
} from "../strict-central-adapter-runtime.js";
import { PRODUCTION_STRICT_VERIFIED_ACTORS } from
  "../venues/production-verified-actors.js";
import { FLUID_DEX_INTERFACE } from
  "../venues/swaps/fluid-dex-family/codec.js";
import { FLUID_CREDIT_PROBE_ACTOR } from
  "../venues/credit/fluid-family/codec.js";

const DEX = ethers.getAddress(ADDR.FLUID_DEX_USDC_USDT);
const VAULT = ethers.getAddress(ADDR.FLUID_VAULT_WSTUSR_USDC);
const TOKEN0 = ethers.getAddress(ADDR.USDC);
const TOKEN1 = ethers.getAddress(ADDR.USDT);
const SUPPLY = ethers.getAddress(ADDR.WSTUSR);
const BORROW = TOKEN0;
const DEX_FACTORY = ethers.getAddress(`0x${"11".repeat(20)}`);
const VAULT_FACTORY = ethers.getAddress(`0x${"22".repeat(20)}`);
const OTHER = ethers.getAddress(`0x${"33".repeat(20)}`);
const WORD = `0x${"00".repeat(32)}`;
const SLOT = `0x${"44".repeat(32)}`;

const dexConstantsIface = new ethers.Interface([
  "function constantsView() view returns ((uint256 dexId,address liquidity,address factory,(address shift,address admin,address colOperations,address debtOperations,address perfectOperationsAndSwapOut) implementations,address deployerContract,address token0,address token1,bytes32 supplyToken0Slot,bytes32 borrowToken0Slot,bytes32 supplyToken1Slot,bytes32 borrowToken1Slot,bytes32 exchangePriceToken0Slot,bytes32 exchangePriceToken1Slot,uint256 oracleMapping) constantsView_)",
]);
const vaultConstantsIface = new ethers.Interface([
  "function constantsView() view returns ((address liquidity,address factory,address adminImplementation,address secondaryImplementation,address supplyToken,address borrowToken,uint8 supplyDecimals,uint8 borrowDecimals,uint256 vaultId,bytes32 liquiditySupplyExchangePriceSlot,bytes32 liquidityBorrowExchangePriceSlot,bytes32 liquidityUserSupplySlot,bytes32 liquidityUserBorrowSlot) constantsView_)",
  "function operate(uint256 nftId,int256 newCol,int256 newDebt,address to) payable returns (uint256,int256,int256)",
]);
const dexFactoryIface = new ethers.Interface([
  "function getDexAddress(uint256 dexId) view returns (address)",
]);
const vaultFactoryIface = new ethers.Interface([
  "function getVaultAddress(uint256 vaultId) view returns (address)",
]);
const erc20 = new ethers.Interface([
  "function approve(address,uint256) returns (bool)",
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
]);
const dexSwap = new ethers.Interface([
  "function swapIn(bool,uint256,uint256,address) returns (uint256)",
]);

function fakeBackend(input: {
  readonly wrongDexFactory?: boolean;
  readonly simulate?: boolean;
} = {}): ProtocolDiscoveryReadBackend {
  const backend: ProtocolDiscoveryReadBackend = {
    async call(req) {
      const target = ethers.getAddress(req.to);
      const selector = req.data.slice(0, 10).toLowerCase();
      if (target === DEX && selector === dexConstantsIface.getFunction("constantsView")!.selector) {
        return dexConstantsIface.encodeFunctionResult("constantsView", [[
          7n,
          OTHER,
          DEX_FACTORY,
          [OTHER, OTHER, OTHER, OTHER, OTHER],
          OTHER,
          TOKEN0,
          TOKEN1,
          WORD,
          WORD,
          WORD,
          WORD,
          WORD,
          WORD,
          0n,
        ]]);
      }
      if (target === VAULT && selector === vaultConstantsIface.getFunction("constantsView")!.selector) {
        return vaultConstantsIface.encodeFunctionResult("constantsView", [[
          OTHER,
          VAULT_FACTORY,
          OTHER,
          OTHER,
          SUPPLY,
          BORROW,
          18,
          6,
          9n,
          WORD,
          WORD,
          WORD,
          WORD,
        ]]);
      }
      if (target === DEX_FACTORY) {
        return dexFactoryIface.encodeFunctionResult(
          "getDexAddress",
          [input.wrongDexFactory ? OTHER : DEX],
        );
      }
      if (target === VAULT_FACTORY) {
        return vaultFactoryIface.encodeFunctionResult("getVaultAddress", [VAULT]);
      }
      if (
        [TOKEN0, TOKEN1].includes(target) &&
        selector === erc20.getFunction("decimals")!.selector
      ) {
        return erc20.encodeFunctionResult("decimals", [6]);
      }
      if (target === DEX && selector === dexSwap.getFunction("swapIn")!.selector) {
        // Fluid's ADDRESS_DEAD quote path reports the quote through its
        // declared FluidDexSwapResult custom error (return-or-revert-data).
        const decoded = dexSwap.decodeFunctionData("swapIn", req.data);
        const amountIn = BigInt(decoded[1]);
        const amountOut = amountIn * 9n / 10n;
        throw Object.assign(
          new Error("execution reverted: FluidDexSwapResult"),
          {
            code: "CALL_EXCEPTION",
            data: FLUID_DEX_INTERFACE.encodeErrorResult(
              "FluidDexSwapResult",
              [amountOut],
            ),
          },
        );
      }
      throw Object.assign(new Error(`execution reverted: unsupported call ${target} ${selector}`), {
        code: "CALL_EXCEPTION",
        data: "0x",
      });
    },
    async getCode(address) {
      return [DEX, VAULT, TOKEN0, TOKEN1, SUPPLY, DEX_FACTORY, VAULT_FACTORY]
          .includes(ethers.getAddress(address))
        ? "0x60006000"
        : "0x";
    },
    async getStorageAt() { return WORD; },
    async getLogs() { return []; },
    async getTransactionReceipt() { return null; },
    async traceTransaction() { throw new Error("unused"); },
    async createAccessList(req) {
      return [{ address: req.to, storageKeys: [SLOT] }];
    },
  };
  if (input.simulate !== false) {
    backend.simulateCalls = async (req) => {
      if (req.calls.length === 1) {
        const value = Object.values(req.stateOverrides ?? {})
          .flatMap((entry) => Object.values(entry.stateDiff ?? {}))[0] ?? WORD;
        return [{ status: 1, returnData: erc20.encodeFunctionResult("balanceOf", [BigInt(value)]), logs: [] }];
      }
      const action = req.calls[3];
      const funded = Object.values(req.stateOverrides ?? {})
        .flatMap((entry) => Object.values(entry.stateDiff ?? {}))[0] ?? WORD;
      const amountIn = BigInt(funded);
      if (ethers.getAddress(action.to) === DEX) {
        const decoded = dexSwap.decodeFunctionData("swapIn", action.data);
        const exactIn = BigInt(decoded[1]);
        const amountOut = exactIn * 9n / 10n;
        return [
          simulatedUint(amountIn),
          simulatedUint(0n),
          simulatedBool(true),
          { status: 1, returnData: dexSwap.encodeFunctionResult("swapIn", [amountOut]), logs: [] },
          simulatedUint(0n),
          simulatedUint(amountOut),
        ];
      }
      const decoded = vaultConstantsIface.decodeFunctionData("operate", action.data);
      const collateral = BigInt(decoded[1]);
      const debt = BigInt(decoded[2]);
      return [
        simulatedUint(amountIn),
        simulatedUint(0n),
        simulatedBool(true),
        {
          status: 1,
          returnData: vaultConstantsIface.encodeFunctionResult(
            "operate",
            [1n, collateral, debt],
          ),
          logs: [],
        },
        simulatedUint(0n),
        simulatedUint(debt),
      ];
    };
  }
  return backend;
}

function simulatedUint(value: bigint) {
  return { status: 1, returnData: erc20.encodeFunctionResult("balanceOf", [value]), logs: [] };
}

const fluidFixtureSimulator: StrictSimulationTransport = {
  async simulate({ request }) {
    if (request.kind !== "effect-delta-simulation") {
      throw new Error("fluid fixture simulator requires effect-delta-simulation");
    }
    const call = request.call as { readonly to: string; readonly data: string };
    if (ethers.getAddress(call.to) !== VAULT) {
      throw new Error("fluid fixture simulator unexpected call target");
    }
    const decoded = vaultConstantsIface.decodeFunctionData("operate", call.data);
    const collateralAmount = BigInt(decoded[1]);
    const debtAmount = BigInt(decoded[2]);
    // Observe declares return-data + token-delta only; no logs.
    return {
      data: vaultConstantsIface.encodeFunctionResult("operate", [
        1n,
        collateralAmount,
        debtAmount,
      ]),
      effects: {
        tokenDeltas: [
          { token: SUPPLY, account: FLUID_CREDIT_PROBE_ACTOR, delta: -collateralAmount },
          { token: BORROW, account: FLUID_CREDIT_PROBE_ACTOR, delta: debtAmount },
        ],
      },
    };
  },
};

function simulatedBool(value: boolean) {
  return { status: 1, returnData: erc20.encodeFunctionResult("approve", [value]), logs: [] };
}

function context(backend: ProtocolDiscoveryReadBackend): ProtocolDiscoveryContext {
  return {
    backend,
    blockNumber: 1,
    fromBlock: 1,
    toBlock: 1,
    chainId: "1",
    graphTokens: [TOKEN0, TOKEN1, SUPPLY],
    retainedInstances: [],
  };
}

async function candidates(ctx: ProtocolDiscoveryContext) {
  const dex = await fluidDexDiscovery.candidateFromAddress!({
    target: DEX,
    codeHash: ethers.keccak256("0x60006000"),
    implementationWord: WORD,
  }, ctx);
  const vault = await fluidVaultDiscovery.candidateFromAddress!({
    target: VAULT,
    codeHash: ethers.keccak256("0x60006000"),
    implementationWord: WORD,
  }, ctx);
  assert(dex);
  assert(vault);
  return new Map([
    [fluidDexAdapter.id, [dex]],
    [fluidCreditAdapter.id, [vault]],
  ]);
}

async function runAdmission(backend: ProtocolDiscoveryReadBackend) {
  const ctx = context(backend);
  const identityRuntime = createStrictCentralAdapterRuntime({
    provider: backend as never,
    // The vault's active operate proof is effect-delta-simulation; the
    // fixture transport mirrors the production revm transport.
    simulator: fluidFixtureSimulator,
    generationFence: Object.freeze({
      kind: "catalog-relative" as const,
      assertCurrent: () => undefined,
      verifyCanonicalSource: () => true,
    }),
    verifiedActors: PRODUCTION_STRICT_VERIFIED_ACTORS,
  });
  return runProtocolDiscovery({
    adapters: [fluidDexAdapter, fluidCreditAdapter],
    context: ctx,
    // Fluid swap/credit are not governed by SEARCHER_ENABLE_PROTOCOL_EDGES.
    protocolEdgesEnabled: false,
    attestIdentity: createCanonicalProtocolIdentityAttester({
      identityRuntime,
    }),
    candidatesByAdapter: await candidates(ctx),
  });
}

assert.deepEqual(fluidDexDiscovery.candidateAddressHints, [ADDR.FLUID_DEX_USDC_USDT]);
assert(
  !fluidDexDiscovery.candidateAddressHints!.some(
    (address) => address.toLowerCase() === "0xea734b615888c669667038d11950f44b177f15c0",
  ),
  "the historical wrong Fluid DEX address must never be a candidate",
);

const admitted = await runAdmission(fakeBackend());
assert.equal(admitted.wouldAdmit.length, 2);
const dexAdmission = admitted.wouldAdmit.find((item) => item.adapterId === fluidDexAdapter.id);
const vaultAdmission = admitted.wouldAdmit.find((item) => item.adapterId === fluidCreditAdapter.id);
assert(dexAdmission);
assert(vaultAdmission);
assert.equal(dexAdmission.edges.length, 2);
assert.deepEqual(
  dexAdmission.edges.map((edge) => [edge.tokenIn, edge.tokenOut]),
  [[TOKEN0, TOKEN1], [TOKEN1, TOKEN0]],
);
assert(dexAdmission.edges.every((edge) =>
  edge.poolToken0 === TOKEN0 && edge.poolToken1 === TOKEN1 &&
  edge.slotKind === "swap" && !edge.leavesStandingPosition
));
assert.equal(vaultAdmission.edges.length, 1);
assert.equal(vaultAdmission.edges[0].tokenIn, SUPPLY);
assert.equal(vaultAdmission.edges[0].tokenOut, BORROW);
assert.equal(vaultAdmission.edges[0].slotKind, "lend");
assert.equal(vaultAdmission.edges[0].leavesStandingPosition, true);

const projection = prepareProtocolDiscoveryProjection({
  currentOwnership: EMPTY_PROTOCOL_DISCOVERY_OWNERSHIP,
  result: admitted,
  currentBackrunPools: [],
  currentBackrunGraph: [],
  buildStrategyViews: (pools) => buildStrategyViews(pools, [], [], {
    blockscanMaxPools: 100,
    poolUniverseGeneratedAt: "test",
  }),
});
assert.equal(projection.backrunGraph.length, 3);
assert.equal(projection.strategyViews.backrun.length, 2);
assert(projection.strategyViews.backrun.every((pool) => pool.verifiedRoutes?.length));
const rebuilt = (
  await Promise.all(projection.strategyViews.backrun.map((pool) => {
    const backend = fakeBackend();
    return (pool.adapter === "fluid-dex" ? fluidDexAdapter : fluidCreditAdapter)
      .buildEdges(pool, { call: backend.call.bind(backend) });
  }))
).flat();
assert.deepEqual(
  rebuilt.map((edge) => [edge.adapterId, edge.tokenIn, edge.tokenOut, edge.slotKind]).sort(),
  projection.backrunGraph
    .map((edge) => [edge.adapterId, edge.tokenIn, edge.tokenOut, edge.slotKind])
    .sort(),
  "projected verified routes must rebuild exactly",
);
const {
  instanceKey: _instanceKey,
  executionVariantKey: _executionVariantKey,
  canonicalEdgeId: _canonicalEdgeId,
  ...unboundDexEdge
} = dexAdmission.edges[0];
const [reorderedDexEdge] = bindRouteInstanceIdentity(
  fluidDexAdapter,
  {
    ...dexAdmission.instance.pool,
    token0: TOKEN1,
    token1: TOKEN0,
  },
  [{
    ...unboundDexEdge,
    poolToken0: TOKEN1,
    poolToken1: TOKEN0,
  }],
);
assert.notEqual(
  executionFingerprint(dexAdmission.edges[0]),
  executionFingerprint(reorderedDexEdge),
  "Fluid token order must be execution-fingerprint critical",
);

const wrongFactory = await runAdmission(fakeBackend({ wrongDexFactory: true }));
assert(
  !wrongFactory.wouldAdmit.some((item) => item.adapterId === fluidDexAdapter.id),
  "factory reverse lookup mismatch must fail closed",
);
const noSimulation = await runAdmission(fakeBackend({ simulate: false }));
assert.equal(noSimulation.wouldAdmit.length, 0, "active nonzero simulation is mandatory");

console.log("[fluid-family-admission] identity/probe/parity/flag/fail-closed: PASS");
