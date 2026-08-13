import assert from "node:assert/strict";
import {
  executeAdapterFamilyLifecycleBatch,
  type AdapterFamilyPublication,
  type PreparedFamilyInstance,
} from "./venues/adapter-family-runtime.js";
import {
  PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG,
} from "./venues/production-family-composition.js";
import {
  definedFamilyPluginContractSummary,
} from "./venues/adapter-family-plugin.js";
import type {
  FamilyCapabilityCatalog,
} from "./venues/family-capability-catalog.js";
import {
  UNIV2_FAMILY_ID,
} from "./venues/swaps/univ2-family/manifest.js";
import {
  UNIV2_FACTORY_INTERFACE,
  UNIV2_PAIR_INTERFACE,
  UNIV2_SWAP_CALL_PATTERN_ID,
  UNIV2_SWAP_SELECTOR,
} from "./venues/swaps/univ2-family/codec.js";
import { univ2Exact } from "./venues/swaps/univ2-family/exact.js";
import { univ2Execution } from "./venues/swaps/univ2-family/execution.js";
import { UNIV3_FAMILY_ID } from "./venues/swaps/univ3-family/manifest.js";
import {
  UNIV3_FACTORY_INTERFACE,
  UNIV3_POOL_INTERFACE,
  UNIV3_QUOTER_V2_INTERFACE,
} from "./venues/swaps/univ3-abi.js";
import { UNIV3_SWAP_CALL_PATTERN_ID } from
  "./venues/swaps/univ3-family/codec.js";
import { univ3Exact } from "./venues/swaps/univ3-family/exact.js";
import { univ3Execution } from "./venues/swaps/univ3-family/execution.js";
import { UNIV4_FAMILY_ID } from "./venues/swaps/univ4-family/manifest.js";
import { UNIV4_SWAP_CALL_PATTERN_ID } from
  "./venues/swaps/univ4-family/codec.js";
import {
  UNIV4_POOL_MANAGER_INTERFACE,
  UNIV4_STATE_VIEW_INTERFACE,
  UNIV4_QUOTER_INTERFACE,
} from "./venues/swaps/univ4-abi.js";
import { v4PoolId } from "./venues/swaps/univ4-common.js";
import { ADDR } from "../shared/constants/addresses.js";
import { univ4Exact } from "./venues/swaps/univ4-family/exact.js";
import { univ4Execution } from "./venues/swaps/univ4-family/execution.js";
import {
  v3SwapExactInput,
  v3SwapToState,
} from "./solver/v3-math.js";
import {
  buildFundingBorrowFragment,
  buildFundingRepaymentFragment,
  executeFundingFamilyLiquidity,
  type FundingFamilyPublication,
  type PreparedFundingOffer,
} from "./adapter-funding-runtime.js";
import { ethers } from "ethers";
import {
  hashCanonical,
  type CanonicalValue,
} from "./venues/canonical-value.js";
import { familyId } from "./venues/adapter-family-identifiers.js";
import { PSM_FAMILY_ID } from "./venues/protocols/psm-family/manifest.js";
import {
  PSM_INTERFACE,
  PSM_WAD,
  psmSellQuote,
} from "./venues/protocols/psm-family/codec.js";
import { psmExact } from "./venues/protocols/psm-family/exact.js";
import { psmExecution } from "./venues/protocols/psm-family/execution.js";
import type { PsmDescriptor, PsmRoute } from
  "./venues/protocols/psm-family/types.js";
import { WSTETH_FAMILY_ID } from
  "./venues/protocols/wsteth-family/manifest.js";
import { WSTETH_INTERFACE } from
  "./venues/protocols/wsteth-family/codec.js";
import { wstethExact } from
  "./venues/protocols/wsteth-family/exact.js";
import { wstethExecution } from
  "./venues/protocols/wsteth-family/execution.js";
import type { WstethDescriptor, WstethRoute } from
  "./venues/protocols/wsteth-family/types.js";
import { GOLDX_FAMILY_ID } from
  "./venues/protocols/goldx-family/manifest.js";
import {
  GOLDX_INTERFACE,
  goldxQuote,
} from "./venues/protocols/goldx-family/codec.js";
import { goldxExact } from "./venues/protocols/goldx-family/exact.js";
import { goldxExecution } from "./venues/protocols/goldx-family/execution.js";
import type { GoldxDescriptor, GoldxRoute } from
  "./venues/protocols/goldx-family/types.js";
import { ROCKSOLID_FAMILY_ID } from
  "./venues/protocols/rocksolid-family/manifest.js";
import { ROCKSOLID_INTERFACE } from
  "./venues/protocols/rocksolid-family/codec.js";
import { rocksolidExact } from
  "./venues/protocols/rocksolid-family/exact.js";
import { rocksolidExecution } from
  "./venues/protocols/rocksolid-family/execution.js";
import type { RocksolidDescriptor, RocksolidRoute } from
  "./venues/protocols/rocksolid-family/types.js";
import { METRONOME_HGUSDC_FAMILY_ID } from
  "./venues/protocols/metronome-hgusdc-family/manifest.js";
import {
  METRONOME_HGUSDC_BINDINGS,
  METRONOME_HGUSDC_CURVE_INTERFACE,
  METRONOME_HGUSDC_ERC20_INTERFACE,
  METRONOME_HGUSDC_ROUTER_INTERFACE,
  METRONOME_HGUSDC_VAULT_INTERFACE,
} from "./venues/protocols/metronome-hgusdc-family/shared.js";
import { METRONOME_HGUSDC_PATH } from "../adapters/metronome-hgusdc.js";
import { metronomeHgUsdcExact } from
  "./venues/protocols/metronome-hgusdc-family/exact.js";
import { metronomeHgUsdcExecution } from
  "./venues/protocols/metronome-hgusdc-family/execution.js";
import type {
  MetronomeHgUsdcDescriptor,
  MetronomeHgUsdcRoute,
} from "./venues/protocols/metronome-hgusdc-family/types.js";
import { METRONOME_SYNTH_FAMILY_ID } from
  "./venues/protocols/metronome-synth-family/manifest.js";
import {
  METRONOME_SYNTH_ERC20_INTERFACE,
  METRONOME_SYNTH_POOL_INTERFACE,
  METRONOME_SYNTH_SUPPORTED_TOKENS,
} from "./venues/protocols/metronome-synth-family/shared.js";
import { metronomeSynthExact } from
  "./venues/protocols/metronome-synth-family/exact.js";
import { metronomeSynthExecution } from
  "./venues/protocols/metronome-synth-family/execution.js";
import type {
  MetronomeSynthDescriptor,
  MetronomeSynthRoute,
} from "./venues/protocols/metronome-synth-family/types.js";
import { ERC4626_SILO_REDEEM_FAMILY_ID } from
  "./venues/protocols/erc4626-silo-redeem-family/manifest.js";
import {
  ERC4626_SILO_ERC20_INTERFACE,
  ERC4626_SILO_INTERFACE,
  ERC4626_SILO_PAYOUT_INTERFACE,
  ERC4626_SILO_PROBE_ACTOR,
  ERC4626_SILO_PROBE_ACTOR_EVIDENCE_ID,
} from "./venues/protocols/erc4626-silo-redeem-family/shared.js";
import { erc4626SiloRedeemExact } from
  "./venues/protocols/erc4626-silo-redeem-family/exact.js";
import { erc4626SiloRedeemExecution } from
  "./venues/protocols/erc4626-silo-redeem-family/execution.js";
import type {
  Erc4626SiloRedeemDescriptor,
  Erc4626SiloRedeemRoute,
} from "./venues/protocols/erc4626-silo-redeem-family/types.js";
import { ERC4626_FAMILY_ID } from
  "./venues/protocols/erc4626-family/manifest.js";
import {
  ERC4626_ERC20_INTERFACE,
  ERC4626_INTERFACE,
  ERC4626_PROBE_ACTOR,
} from "./venues/protocols/erc4626-family/abi.js";
import { ERC4626_PROBE_ACTOR_EVIDENCE_ID } from
  "./venues/protocols/erc4626-family/identity.js";
import { erc4626Exact } from
  "./venues/protocols/erc4626-family/exact.js";
import { erc4626Execution } from
  "./venues/protocols/erc4626-family/execution.js";
import type {
  Erc4626Descriptor,
  Erc4626Route,
} from "./venues/protocols/erc4626-family/types.js";
import { ETHERTOKEN_NATIVE_FAMILY_ID } from
  "./venues/protocols/ethertoken-native-redeem-family/manifest.js";
import {
  ETHERTOKEN_NATIVE_INTERFACE,
  ETHERTOKEN_NATIVE_PROBE_ACTOR,
  ETHERTOKEN_NATIVE_PROBE_ACTOR_EVIDENCE_ID,
} from "./venues/protocols/ethertoken-native-redeem-family/shared.js";
import { etherTokenNativeRedeemExact } from
  "./venues/protocols/ethertoken-native-redeem-family/exact.js";
import { etherTokenNativeRedeemExecution } from
  "./venues/protocols/ethertoken-native-redeem-family/execution.js";
import type {
  EtherTokenNativeRedeemDescriptor,
  EtherTokenNativeRedeemRoute,
} from "./venues/protocols/ethertoken-native-redeem-family/types.js";
import { SELF_BURN_NATIVE_FAMILY_ID } from
  "./venues/protocols/self-burn-native-family/manifest.js";
import {
  SELF_BURN_NATIVE_PRICING_ACTOR,
  SELF_BURN_NATIVE_PRICING_ACTOR_EVIDENCE_ID,
  SELF_BURN_NATIVE_PROBE_ACTOR,
  SELF_BURN_NATIVE_PROBE_ACTOR_EVIDENCE_ID,
  SELF_BURN_NATIVE_TOKEN_INTERFACE,
} from "./venues/protocols/self-burn-native-family/shared.js";
import { selfBurnNativeExact } from
  "./venues/protocols/self-burn-native-family/exact.js";
import { selfBurnNativeExecution } from
  "./venues/protocols/self-burn-native-family/execution.js";
import type {
  SelfBurnNativeDescriptor,
  SelfBurnNativeRoute,
} from "./venues/protocols/self-burn-native-family/types.js";
import { ASTRA_MULTITOKEN_FAMILY_ID } from
  "./venues/protocols/astra-multitoken-family/manifest.js";
import {
  ASTRA_ERC20_INTERFACE,
  ASTRA_MULTITOKEN_INTERFACE,
} from "./venues/protocols/astra-multitoken-family/codec.js";
import { astraMultiTokenExact } from
  "./venues/protocols/astra-multitoken-family/exact.js";
import { astraMultiTokenExecution } from
  "./venues/protocols/astra-multitoken-family/execution.js";
import type {
  AstraMultiTokenDescriptor,
  AstraMultiTokenRoute,
} from "./venues/protocols/astra-multitoken-family/types.js";
import { EIGENPIE_FAMILY_ID } from
  "./venues/protocols/eigenpie-family/manifest.js";
import {
  EIGENPIE_ERC20_INTERFACE,
  EIGENPIE_INTERFACE,
} from "./venues/protocols/eigenpie-family/codec.js";
import { eigenpieExact } from
  "./venues/protocols/eigenpie-family/exact.js";
import { eigenpieExecution } from
  "./venues/protocols/eigenpie-family/execution.js";
import type {
  EigenpieDescriptor,
  EigenpieRoute,
} from "./venues/protocols/eigenpie-family/types.js";
import { CURVE_UNDERLYING_FAMILY_ID } from
  "./venues/swaps/curve-underlying-family/manifest.js";
import {
  CURVE_METAREGISTRY,
  CURVE_UNDERLYING_ERC20_INTERFACE,
  CURVE_UNDERLYING_META_INTERFACE,
  CURVE_UNDERLYING_POOL_INTERFACE,
} from "./venues/swaps/curve-underlying-family/codec.js";
import { curveUnderlyingExact } from
  "./venues/swaps/curve-underlying-family/exact.js";
import { curveUnderlyingExecution } from
  "./venues/swaps/curve-underlying-family/execution.js";
import type {
  CurveUnderlyingDescriptor,
  CurveUnderlyingRoute,
} from "./venues/swaps/curve-underlying-family/types.js";
import { FLUID_DEX_FAMILY_ID } from
  "./venues/swaps/fluid-dex-family/manifest.js";
import {
  FLUID_DEX_ADDRESS_DEAD,
  FLUID_DEX_CONSTANTS_INTERFACE,
  FLUID_DEX_ERC20_INTERFACE,
  FLUID_DEX_FACTORY_INTERFACE,
  FLUID_DEX_INTERFACE,
} from "./venues/swaps/fluid-dex-family/codec.js";
import { fluidDexExact } from
  "./venues/swaps/fluid-dex-family/exact.js";
import { fluidDexExecution } from
  "./venues/swaps/fluid-dex-family/execution.js";
import type {
  FluidDexDescriptor,
  FluidDexRoute,
} from "./venues/swaps/fluid-dex-family/types.js";
import { ANGSTROM_V4_FAMILY_ID } from
  "./venues/swaps/angstrom-v4-family/manifest.js";
import {
  canonicalPoolId,
  canonicalPoolKey,
} from "./venues/swaps/angstrom-v4-family/codec.js";
import {
  ANGSTROM_CONTROLLER_INTERFACE,
  ANGSTROM_HOOK_STATE_INTERFACE,
} from "./venues/swaps/univ4-abi.js";
import {
  ANGSTROM_MAINNET_ADAPTER,
  ANGSTROM_MAINNET_HOOK,
  encodeAngstromExecutionEvidence,
  parseAngstromAttestation,
} from "./venues/swaps/angstrom-attestation.js";
import { angstromRuntimeEvidenceHash } from
  "./venues/swaps/angstrom-v4-family/evidence.js";
import {
  BLOCKSCAN_MULTICALL3,
  blockScanMulticallIface,
} from "./venues/swaps/blockscan-state-shared.js";
import { angstromV4Exact } from
  "./venues/swaps/angstrom-v4-family/exact.js";
import { angstromV4Execution } from
  "./venues/swaps/angstrom-v4-family/execution.js";
import type {
  AngstromV4Descriptor,
  AngstromV4Route,
} from "./venues/swaps/angstrom-v4-family/types.js";
import type { RuntimeEvidence } from
  "./venues/adapter-family-plugin.js";
import { DODO_V2_FAMILY_ID } from
  "./venues/swaps/dodo-v2-family/manifest.js";
import {
  DODO_V2_ERC20_INTERFACE,
  DODO_V2_POOL_INTERFACE,
  DODO_V2_REGISTRIES,
  DODO_V2_REGISTRY_INTERFACE,
} from "./venues/swaps/dodo-v2-abi.js";
import {
  DODO_V2_QUOTE_ACTOR,
  DODO_V2_QUOTE_ACTOR_EVIDENCE_ID,
} from "./venues/swaps/dodo-v2-family/identity.js";
import { dodoV2Exact } from
  "./venues/swaps/dodo-v2-family/exact.js";
import { dodoV2Execution } from
  "./venues/swaps/dodo-v2-family/execution.js";
import type {
  DodoV2Descriptor,
  DodoV2Route,
} from "./venues/swaps/dodo-v2-family/types.js";
import { FLUID_CREDIT_FAMILY_ID } from
  "./venues/credit/fluid-family/manifest.js";
import {
  FLUID_CREDIT_PROBE_ACTOR,
  FLUID_ERC20_INTERFACE,
  FLUID_VAULT_FACTORY_INTERFACE,
  FLUID_VAULT_INTERFACE,
} from "./venues/credit/fluid-family/codec.js";
import { FLUID_CREDIT_PROBE_ACTOR_EVIDENCE_ID } from
  "./venues/credit/fluid-family/identity.js";
import { fluidCreditExecution } from
  "./venues/credit/fluid-family/execution.js";
import type {
  FluidCreditDescriptor,
  FluidCreditRiskEvidence,
  FluidCreditRoute,
} from "./venues/credit/fluid-family/types.js";
import {
  executeCreditFamilyInstanceLifecycle,
} from "./venues/adapter-family-runtime.js";
import {
  buildCreditExecutionFragment,
  executeCreditRiskQuote,
  issueCreditExecutionHandle,
  prepareCreditFamilyRoutes,
  projectCreditRouteGraph,
} from "./adapter-credit-runtime.js";
import {
  createBoundedRequestExecutor,
  type AdapterRequest,
  type AdapterRequestResult,
  type CanonicalSource,
} from "./venues/adapter-request-program.js";
import type {
  AdapterGenerationFence,
  CentralAdapterRuntime,
  CentralAdapterScheduler,
} from "./adapter-work-intent.js";
import { projectFamilyRouteGraph } from
  "./adapter-family-graph-runtime.js";
import {
  exercisedStage,
  frameworkBlockedStage,
} from "./architecture-migration-capture.js";
import type { UniV2Descriptor, UniV2Route } from
  "./venues/swaps/univ2-family/types.js";
import type { UniV2ExactEvidence } from
  "./venues/swaps/univ2-family/types.js";
import type { UniV3Descriptor, UniV3Route } from
  "./venues/swaps/univ3-family/types.js";
import type { UniV3ExactEvidence } from
  "./venues/swaps/univ3-family/types.js";
import type { UniV4Descriptor, UniV4Route } from
  "./venues/swaps/univ4-family/types.js";
import type { UniV4ExactEvidence } from
  "./venues/swaps/univ4-family/types.js";
import type { ExpectedEffect } from
  "./venues/adapter-family-plugin.js";
import type {
  ArchitectureMigrationStage,
  RawFamilyMigrationCaseCapture,
  RawMigrationStageCapture,
} from "./architecture-migration-parity-runner.js";

const CATALOG = PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG;
const FAMILY = CATALOG.forFamily(UNIV2_FAMILY_ID);
export const UNIV2_FIXTURE_POOL = `0x${"41".repeat(20)}`;
export const UNIV2_FIXTURE_FACTORY = `0x${"42".repeat(20)}`;
export const UNIV2_FIXTURE_TOKEN0 = `0x${"43".repeat(20)}`;
export const UNIV2_FIXTURE_TOKEN1 = `0x${"44".repeat(20)}`;
export const UNIV2_CAPTURE_EXACT_AMOUNT_IN = 1_000_000n;
export const MIGRATION_CAPTURE_EXECUTOR = `0x${"ee".repeat(20)}`;

class FixtureFence implements AdapterGenerationFence {
  assertCurrent(): void {}
}

interface PoolContext {
  readonly pool: string;
  readonly factory: string;
  readonly token0: string;
  readonly token1: string;
  readonly reserves?: {
    readonly reserve0: bigint;
    readonly reserve1: bigint;
    readonly blockTimestampLast: number;
  };
}

class FixtureScheduler implements CentralAdapterScheduler {
  readonly #pool: PoolContext;

  constructor(pool: PoolContext) {
    this.#pool = pool;
  }

  issueExecutor(
    input: Parameters<CentralAdapterScheduler["issueExecutor"]>[0],
  ): ReturnType<CentralAdapterScheduler["issueExecutor"]> {
    const executor = createBoundedRequestExecutor({
      assertSupported: (requirements) => assert.deepEqual(
        requirements,
        input.requirements,
      ),
      assertCallerBinding() {},
      assertWithinBudget: (_familyId, requests) => {
        assert.deepEqual(requests, input.requests);
      },
      execute: async (execution) => Promise.all(execution.requests.map(
        (request) => successResult(request, execution.source, this.#pool),
      )),
      sealStaticEvidenceReuseProof: () => ({ proofHash: "ab".repeat(32) }),
    });
    return Object.freeze({
      executor,
      timing: () => ({ queueWaitMs: 0, transportWallMs: 1, attempts: 1 }),
    });
  }
}

function fixtureRuntime(pool: PoolContext): CentralAdapterRuntime {
  let now = 1_000;
  return {
    clock: { nowMs: () => now++ },
    generationFence: new FixtureFence(),
    callerAuthority: { bind: () => ({}) },
    policy: {
      bind: (input) => ({
        lane: input.stage === "identity" ? "critical-proof" : "background",
        deadlineAtMs: 100_000,
        maxAttempts: 1,
        transportPool: "state-read",
        fairnessKey: input.subjectKey,
      }),
    },
    budgets: { assertAdmitted() {} },
    scheduler: new FixtureScheduler(pool),
  };
}

function successResult(
  request: AdapterRequest,
  canonical: CanonicalSource,
  pool: PoolContext,
): AdapterRequestResult {
  const data = request.id === "pair-factory"
    ? UNIV2_PAIR_INTERFACE.encodeFunctionResult("factory", [pool.factory])
    : request.id === "pair-token0"
    ? UNIV2_PAIR_INTERFACE.encodeFunctionResult("token0", [pool.token0])
    : request.id === "pair-token1"
    ? UNIV2_PAIR_INTERFACE.encodeFunctionResult("token1", [pool.token1])
    : request.id === "factory-get-pair"
    ? UNIV2_FACTORY_INTERFACE.encodeFunctionResult("getPair", [pool.pool])
    : request.id === "current-reserves"
    ? UNIV2_PAIR_INTERFACE.encodeFunctionResult(
        "getReserves",
        pool.reserves === undefined
          ? [1_000_000n, 2_000_000n, 1_234]
          : [
              pool.reserves.reserve0,
              pool.reserves.reserve1,
              pool.reserves.blockTimestampLast,
            ],
      )
    : request.id === "exact-reserves"
    ? UNIV2_PAIR_INTERFACE.encodeFunctionResult(
        "getReserves",
        pool.reserves === undefined
          ? [1_000_000n, 2_000_000n, 1_234]
          : [
              pool.reserves.reserve0,
              pool.reserves.reserve1,
              pool.reserves.blockTimestampLast,
            ],
      )
    : (() => { throw new Error(`unexpected fixture request ${request.id}`); })();
  return Object.freeze({
    id: request.id,
    ok: true as const,
    source: canonical,
    provenance: Object.freeze({
      kind: "migration-capture-fixture",
      fingerprint: `fixture:${request.id}`,
    }),
    completion: "returned" as const,
    data,
  });
}

export async function runUniv2Lifecycle(
  canonical: CanonicalSource,
  pool: PoolContext,
  catalog: FamilyCapabilityCatalog = CATALOG,
): Promise<AdapterFamilyPublication> {
  let publication: AdapterFamilyPublication | null = null;
  const result = await executeAdapterFamilyLifecycleBatch({
    family: catalog.forFamily(UNIV2_FAMILY_ID),
    matches: [Object.freeze({
      matchedPatternId: UNIV2_SWAP_CALL_PATTERN_ID,
      observation: Object.freeze({
        kind: "call" as const,
        source: canonical,
        target: pool.pool,
        data: UNIV2_SWAP_SELECTOR,
      }),
    })],
    source: canonical,
    generation: canonical.generation,
    runtime: fixtureRuntime(pool),
    publisher: { publish: (value) => { publication = value; } },
  });
  assert(result.publication);
  assert(publication);
  return publication;
}

function instanceStage(
  instances: readonly PreparedFamilyInstance[],
  evidenceRefs: readonly string[],
): RawMigrationStageCapture {
  return exercisedStage(instances.map((instance) => Object.freeze({
    id: instance.instanceKey,
    value: Object.freeze({
      familyId: instance.familyId,
      instanceKey: instance.instanceKey,
      staticBindingFingerprint: instance.staticBindingFingerprint,
    }),
  })), evidenceRefs);
}

/**
 * Runs the current strict UniV2 lifecycle over one fixture observation and
 * emits the canonical migration capture row for the `univ2-standard` Family.
 * Deep stages that the harness does not yet exercise are honestly marked
 * `framework-blocked` with evidence refs.
 */
export async function captureUniv2FixtureCase(input: {
  readonly source: CanonicalSource;
  readonly caseId?: string;
}): Promise<RawFamilyMigrationCaseCapture> {
  return captureUniv2RealCase({
    ...input,
    pool: UNIV2_FIXTURE_POOL,
    tokenA: UNIV2_FIXTURE_TOKEN0,
    tokenB: UNIV2_FIXTURE_TOKEN1,
  });
}

async function buildUniv2CaseCapture(input: {
  readonly source: CanonicalSource;
  readonly pool: PoolContext;
  readonly caseId?: string;
  readonly reserves?: {
    readonly reserve0: bigint | string;
    readonly reserve1: bigint | string;
    readonly blockTimestampLast?: number;
  };
  readonly evidenceRefs: readonly string[];
}): Promise<RawFamilyMigrationCaseCapture> {
  const reserves = input.pool.reserves === undefined &&
      input.reserves === undefined
    ? undefined
    : Object.freeze({
        reserve0: BigInt(
          input.pool.reserves?.reserve0 ?? input.reserves!.reserve0,
        ),
        reserve1: BigInt(
          input.pool.reserves?.reserve1 ?? input.reserves!.reserve1,
        ),
        blockTimestampLast:
          input.pool.reserves?.blockTimestampLast ??
            input.reserves?.blockTimestampLast ?? 0,
      });
  const pool: PoolContext = Object.freeze({
    ...input.pool,
    pool: input.pool.pool.toLowerCase(),
    factory: input.pool.factory.toLowerCase(),
    token0: input.pool.token0.toLowerCase(),
    token1: input.pool.token1.toLowerCase(),
    ...(reserves === undefined ? {} : { reserves }),
  });
  const publication = await runUniv2Lifecycle(input.source, pool);
  const evidenceRefs = Object.freeze([...input.evidenceRefs]);
  const instances = publication.instances;
  const edges: RawMigrationStageCapture["items"][number][] = [];
  const prices: RawMigrationStageCapture["items"][number][] = [];
  for (const instance of instances) {
    for (const route of instance.routes) {
      const handle = instance.routeHandles.find((candidate) =>
        candidate.routeKey === route.routeKey
      );
      if (handle === undefined) {
        throw new Error(`prepared route ${route.routeKey} has no issued handle`);
      }
      const projected = projectFamilyRouteGraph({
        family: FAMILY,
        descriptor: instance.descriptor,
        route,
        handle,
      });
      edges.push(Object.freeze({
        id: projected.edge.canonicalEdgeId,
        value: Object.freeze({
          routeKey: route.routeKey,
          tokenIn: route.tokenIn,
          tokenOut: route.tokenOut,
          canonicalEdgeId: projected.edge.canonicalEdgeId,
        }),
      }));
    }
    const routeByKey = new Map(
      instance.routes.map((route) => [route.routeKey, route]),
    );
    for (const pricing of instance.pricingInstances) {
      for (const [routeKey, mid] of pricing.mids) {
        const route = routeByKey.get(routeKey);
        if (route === undefined) {
          throw new Error(`univ2 pricing route ${routeKey} is missing`);
        }
        prices.push(Object.freeze({
          id: `${pricing.stateKey}:${route.tokenIn.toLowerCase()}>` +
            `${route.tokenOut.toLowerCase()}`,
          value: Object.freeze({
            stateKey: pricing.stateKey,
            mid: Object.freeze({ ...mid }),
          }) as unknown as RawMigrationStageCapture["items"][number]["value"],
        }));
      }
    }
  }
  const enumeratedRoutes: RawMigrationStageCapture["items"][number][] = edges
    .map((edge) => edge.value as {
      readonly routeKey: string;
      readonly tokenIn: string;
      readonly tokenOut: string;
      readonly canonicalEdgeId: string;
    })
    .sort((left, right) => left.routeKey.localeCompare(right.routeKey))
    .map((value, order) => Object.freeze({
      id: value.canonicalEdgeId,
      value: Object.freeze({
        routeKey: value.routeKey,
        tokenIn: value.tokenIn,
        tokenOut: value.tokenOut,
        canonicalEdgeId: value.canonicalEdgeId,
        order,
      }),
    }));
  let exactQuotes: RawMigrationStageCapture;
  const exactByRouteKey = new Map<
    string,
    { readonly amountOut: bigint; readonly evidence: UniV2ExactEvidence }
  >();
  if (reserves !== undefined) {
    const exactMethod = univ2Exact.methods().find(
      (method) => method.kind === "request-program" &&
        method.id === "pair-reserves",
    );
    if (exactMethod === undefined || exactMethod.kind !== "request-program") {
      throw new Error("univ2 exact request program is missing");
    }
    const program = exactMethod.program;
    const edgeByRouteKey = new Map(
      edges.map((edge) => {
        const value = edge.value as { readonly routeKey: string };
        return [value.routeKey, edge] as const;
      }),
    );
    const quotes: RawMigrationStageCapture["items"][number][] = [];
    for (const instance of instances) {
      for (const route of [...instance.routes].sort(
        (left, right) => left.routeKey.localeCompare(right.routeKey),
      )) {
        const exactInput = Object.freeze({
          descriptor: instance.descriptor as unknown as UniV2Descriptor,
          route: route as unknown as UniV2Route,
          amountIn: UNIV2_CAPTURE_EXACT_AMOUNT_IN,
          source: input.source,
          executor: MIGRATION_CAPTURE_EXECUTOR,
          runtimeEvidence: Object.freeze([]),
        });
        const requests = program.buildRequests(exactInput);
        const results = requests.map((request) =>
          successResult(request, input.source, pool)
        );
        const decoded = program.decode({
          programInput: exactInput,
          initialResults: results,
          dependentEvidence: Object.freeze([]),
        });
        const edge = edgeByRouteKey.get(route.routeKey);
        if (edge === undefined) {
          throw new Error(`exact route ${route.routeKey} has no captured edge`);
        }
        exactByRouteKey.set(route.routeKey, {
          amountOut: decoded.amountOut,
          evidence: decoded.evidence as UniV2ExactEvidence,
        });
        quotes.push(Object.freeze({
          id: `${edge.id}\u001fexact:${UNIV2_CAPTURE_EXACT_AMOUNT_IN}`,
          value: Object.freeze({
            routeKey: route.routeKey,
            tokenIn: route.tokenIn,
            tokenOut: route.tokenOut,
            canonicalEdgeId: edge.id,
            amountIn: UNIV2_CAPTURE_EXACT_AMOUNT_IN.toString(),
            amountOut: decoded.amountOut.toString(),
            feeBps: (
              instance.descriptor as unknown as {
                readonly feeRule: { readonly feeBps: bigint };
              }
            ).feeRule.feeBps.toString(),
          }),
        }));
      }
    }
    exactQuotes = exercisedStage(quotes, evidenceRefs);
  } else {
    exactQuotes = frameworkBlockedStage(
      evidenceRefs,
      "capture-harness-exact-not-wired",
    );
  }
  const executionFragments: RawMigrationStageCapture["items"][number][] = [];
  const finalSimulations: RawMigrationStageCapture["items"][number][] = [];
  if (reserves !== undefined) {
    const edgeByRouteKey = new Map(
      edges.map((edge) => {
        const value = edge.value as { readonly routeKey: string };
        return [value.routeKey, edge] as const;
      }),
    );
    for (const instance of instances) {
      for (const route of [...instance.routes].sort(
        (left, right) => left.routeKey.localeCompare(right.routeKey),
      )) {
        const quote = exactByRouteKey.get(route.routeKey);
        const edge = edgeByRouteKey.get(route.routeKey);
        if (quote === undefined || edge === undefined) {
          throw new Error(
            `univ2 execution route ${route.routeKey} has no exact quote`,
          );
        }
        const descriptor = instance.descriptor as unknown as UniV2Descriptor;
        const univ2Route = route as unknown as UniV2Route;
        const amountIn = UNIV2_CAPTURE_EXACT_AMOUNT_IN;
        const minAmountOut = quote.amountOut;
        const fragment = univ2Execution.buildFragment({
          descriptor,
          route: univ2Route,
          amountIn,
          quotedAmountOut: quote.amountOut,
          minAmountOut,
          exactEvidence: quote.evidence,
          executor: MIGRATION_CAPTURE_EXECUTOR,
          runtimeEvidence: Object.freeze([]),
        });
        const node = fragment.nodes[0]!;
        const nodeFingerprint = hashCanonical(
          node as unknown as CanonicalValue,
        );
        executionFragments.push(Object.freeze({
          id: `${edge.id}\u001fexec:${amountIn}`,
          value: Object.freeze({
            routeKey: route.routeKey,
            tokenIn: route.tokenIn,
            tokenOut: route.tokenOut,
            canonicalEdgeId: edge.id,
            amountIn: amountIn.toString(),
            amountOut: quote.amountOut.toString(),
            minAmountOut: minAmountOut.toString(),
            actionAdapterId: node.adapterId,
            executionTarget: node.target,
            nodeFingerprint,
          }),
        }));
        const effects = univ2Execution.expectedEffects({
          descriptor,
          route: univ2Route,
          amountIn,
          quotedAmountOut: quote.amountOut,
        });
        assertConservedUniv2Effects(effects);
        if (quote.amountOut < minAmountOut) {
          throw new Error("univ2 capture final simulation repayment failed");
        }
        const effectsFingerprint = hashCanonical(
          effects as unknown as CanonicalValue,
        );
        finalSimulations.push(Object.freeze({
          id: `${edge.id}\u001fsim:${amountIn}`,
          value: Object.freeze({
            routeKey: route.routeKey,
            tokenIn: route.tokenIn,
            tokenOut: route.tokenOut,
            canonicalEdgeId: edge.id,
            amountIn: amountIn.toString(),
            amountOut: quote.amountOut.toString(),
            minAmountOut: minAmountOut.toString(),
            effectsFingerprint,
            conservation: "conserved",
            repayment: "satisfied",
            evInput: Object.freeze({
              amountIn: amountIn.toString(),
              amountOut: quote.amountOut.toString(),
            }),
          }),
        }));
      }
    }
  }
  const stages: RawFamilyMigrationCaseCapture["stages"] = Object.freeze({
    instances: instanceStage(instances, evidenceRefs),
    edges: exercisedStage(edges, evidenceRefs),
    stateCoverage: exercisedStage([], evidenceRefs),
    pricedEdges: exercisedStage([], evidenceRefs),
    prices: input.reserves === undefined
      ? frameworkBlockedStage(
          evidenceRefs,
          "capture-harness-prices-not-wired",
        )
      : exercisedStage(prices, evidenceRefs),
    failures: exercisedStage([], evidenceRefs),
    enumeratedRoutes: exercisedStage(enumeratedRoutes, evidenceRefs),
    exactQuotes,
    executionFragments: reserves === undefined
      ? frameworkBlockedStage(
          evidenceRefs,
          "capture-harness-execution-not-wired",
        )
      : exercisedStage(executionFragments, evidenceRefs),
    finalSimulations: reserves === undefined
      ? frameworkBlockedStage(
          evidenceRefs,
          "capture-harness-final-sim-not-wired",
        )
      : exercisedStage(finalSimulations, evidenceRefs),
  });
  const summary = definedFamilyPluginContractSummary(FAMILY.plugin);
  return Object.freeze({
    familyId: UNIV2_FAMILY_ID,
    caseId: input.caseId ?? `univ2:${input.source.number}`,
    inputFingerprint: input.source.hash.slice(2).padStart(64, "0"),
    stateAnchorNumber: input.source.number,
    implementationClosureHash: summary.definitionBoundaryHash,
    stages,
  });
}

export async function captureUniv2RealCase(input: {
  readonly source: CanonicalSource;
  readonly pool: string;
  readonly tokenA: string;
  readonly tokenB: string;
  readonly caseId?: string;
  readonly reserves?: {
    readonly reserve0: bigint | string;
    readonly reserve1: bigint | string;
    readonly blockTimestampLast?: number;
  };
}): Promise<RawFamilyMigrationCaseCapture> {
  return buildUniv2CaseCapture({
    source: input.source,
    caseId: input.caseId,
    reserves: input.reserves,
    evidenceRefs: Object.freeze([
      `fixture:univ2:${input.source.number}:${input.source.hash}`,
    ]),
    pool: Object.freeze({
      pool: input.pool,
      factory: `0x${"42".repeat(20)}`,
      token0: input.tokenA,
      token1: input.tokenB,
    }),
  });
}

export interface OnchainUniv2Provider {
  call(
    tx: { readonly to: string; readonly data: string },
    blockTag?: number,
  ): Promise<string>;
}

/**
 * Real on-chain univ2 capture: identity (factory/token0/token1) and state
 * (getReserves) are read from the pool at the canonical source block, the
 * supplied descriptor must agree with the chain or the capture fails closed,
 * and the evidence ref is an onchain ref (no fixture provenance).
 */
export async function captureUniv2OnchainCase(input: {
  readonly source: CanonicalSource;
  readonly provider: OnchainUniv2Provider;
  readonly pool: string;
  readonly tokenA?: string;
  readonly tokenB?: string;
  readonly caseId?: string;
  readonly reserves?: {
    readonly reserve0: bigint | string;
    readonly reserve1: bigint | string;
    readonly blockTimestampLast?: number;
  };
}): Promise<RawFamilyMigrationCaseCapture> {
  const pool = input.pool.toLowerCase();
  const read = async (name: string): Promise<string> => {
    const data = UNIV2_PAIR_INTERFACE.encodeFunctionData(name, []);
    const result = await input.provider.call(
      { to: pool, data },
      input.source.number,
    );
    if (result === "0x" || result.length < 2) {
      throw new Error(
        `univ2 onchain ${name} read empty at ${input.source.number}`,
      );
    }
    return result;
  };
  const [factoryRaw, token0Raw, token1Raw, reservesRaw] = await Promise.all([
    read("factory"),
    read("token0"),
    read("token1"),
    read("getReserves"),
  ]);
  const factory = (
    UNIV2_PAIR_INTERFACE.decodeFunctionResult(
      "factory",
      factoryRaw,
    )[0] as string
  ).toLowerCase();
  const token0 = (
    UNIV2_PAIR_INTERFACE.decodeFunctionResult(
      "token0",
      token0Raw,
    )[0] as string
  ).toLowerCase();
  const token1 = (
    UNIV2_PAIR_INTERFACE.decodeFunctionResult(
      "token1",
      token1Raw,
    )[0] as string
  ).toLowerCase();
  const reserves = UNIV2_PAIR_INTERFACE.decodeFunctionResult(
    "getReserves",
    reservesRaw,
  ) as unknown as [bigint, bigint, bigint];
  if (factory === "0x0000000000000000000000000000000000000000") {
    throw new Error(`univ2 pool ${pool} reports a zero factory`);
  }
  if (input.tokenA !== undefined &&
      input.tokenA.toLowerCase() !== token0) {
    throw new Error("univ2 onchain tokenA mismatch");
  }
  if (input.tokenB !== undefined &&
      input.tokenB.toLowerCase() !== token1) {
    throw new Error("univ2 onchain tokenB mismatch");
  }
  if (
    input.reserves !== undefined &&
    (BigInt(input.reserves.reserve0) !== reserves[0] ||
      BigInt(input.reserves.reserve1) !== reserves[1])
  ) {
    throw new Error("univ2 onchain reserves mismatch");
  }
  return buildUniv2CaseCapture({
    source: input.source,
    caseId: input.caseId,
    evidenceRefs: Object.freeze([
      `onchain:1:${input.source.hash}:univ2:${pool}`,
    ]),
    pool: Object.freeze({
      pool,
      factory,
      token0,
      token1,
      reserves: Object.freeze({
        reserve0: reserves[0],
        reserve1: reserves[1],
        blockTimestampLast: Number(reserves[2]),
      }),
    }),
  });
}

export function fixtureCaptureStages(): readonly ArchitectureMigrationStage[] {
  return Object.freeze([
    "instances",
    "edges",
    "stateCoverage",
    "pricedEdges",
    "prices",
    "failures",
    "enumeratedRoutes",
    "exactQuotes",
    "executionFragments",
    "finalSimulations",
  ] as const);
}

/**
 * Fixture-level final-sim conservation proof for the uniV2 swap corpus: the
 * expected effect set must be exactly the four token-delta legs (tokenIn
 * executor decrease / route-target increase, tokenOut route-target decrease
 * / executor increase). Amount conservation is then implied by the fragment
 * (transfer amountIn in, swap amountOut out) and is verified by the capture
 * repayment check.
 */
function assertConservedUniv2Effects(
  effects: readonly ExpectedEffect[],
): void {
  const expected = new Set([
    "token-delta:executor:decrease",
    "token-delta:route-target:increase",
    "token-delta:route-target:decrease",
    "token-delta:executor:increase",
  ]);
  if (effects.length !== 4) {
    throw new Error("univ2 capture final simulation effects size mismatch");
  }
  for (const effect of effects) {
    if (effect.kind !== "token-delta") {
      throw new Error(
        "univ2 capture final simulation effect must be token-delta",
      );
    }
    const key = `${effect.kind}:${effect.account}:${effect.direction}`;
    if (!expected.has(key)) {
      throw new Error(`unexpected univ2 capture effect ${key}`);
    }
  }
}

export const UNIV3_FIXTURE_FACTORY =
  "0x1F98431c8aD98523631AE4a59f267346ea31F984";
export const UNIV3_FIXTURE_POOL = `0x${"33".repeat(20)}`;
export const UNIV3_FIXTURE_TOKEN0 = `0x${"11".repeat(20)}`;
export const UNIV3_FIXTURE_TOKEN1 = `0x${"22".repeat(20)}`;
export const UNIV3_FIXTURE_FEE = 500n;
export const UNIV3_FIXTURE_TICK_SPACING = 1;
export const UNIV3_FIXTURE_LIQUIDITY = 1_000_000_000_000_000_000n;
export const UNIV3_FIXTURE_SQRT_PRICE_X96 = 1n << 96n;

interface UniV3PoolContext {
  readonly pool: string;
  readonly factory: string;
  readonly token0: string;
  readonly token1: string;
  readonly fee: bigint;
  readonly tickSpacing: number;
  readonly liquidity: bigint;
  readonly sqrtPriceX96: bigint;
}

function univ3QuoteResult(
  request: AdapterRequest,
  canonical: CanonicalSource,
  ctx: UniV3PoolContext,
): Extract<AdapterRequestResult, { readonly ok: true }> {
  const callRequest = request as { readonly data: string };
  const decoded = UNIV3_QUOTER_V2_INTERFACE.decodeFunctionData(
    "quoteExactInputSingle",
    callRequest.data,
  );
  const params = decoded[0] as {
    readonly tokenIn: string;
    readonly tokenOut: string;
    readonly amountIn: bigint;
    readonly fee: bigint;
    readonly sqrtPriceLimitX96: bigint;
  };
  const zeroForOne = params.tokenIn.toLowerCase() === ctx.token0.toLowerCase();
  const state: import("./solver/v3-math.js").V3PoolState = {
    sqrtPriceX96: ctx.sqrtPriceX96,
    liquidity: ctx.liquidity,
    tick: 0,
    fee: ctx.fee,
    tickSpacing: ctx.tickSpacing,
    tickBitmap: new Map([[0, 0n], [-1, 0n]]),
    ticks: new Map(),
  };
  const amountOut = v3SwapExactInput(state, zeroForOne, params.amountIn);
  const post = v3SwapToState(state, zeroForOne, params.amountIn);
  const data = UNIV3_QUOTER_V2_INTERFACE.encodeFunctionResult(
    "quoteExactInputSingle",
    [amountOut, post.state.sqrtPriceX96, 0, 0],
  );
  return Object.freeze({
    id: request.id,
    ok: true as const,
    source: canonical,
    provenance: Object.freeze({
      kind: "migration-capture-fixture",
      fingerprint: `fixture:${request.id}`,
    }),
    completion: "returned" as const,
    data,
  });
}

function univ3SuccessResult(
  request: AdapterRequest,
  canonical: CanonicalSource,
  ctx: UniV3PoolContext,
): AdapterRequestResult {
  const data = request.id === "pool-factory"
    ? UNIV3_POOL_INTERFACE.encodeFunctionResult("factory", [ctx.factory])
    : request.id === "pool-token0"
    ? UNIV3_POOL_INTERFACE.encodeFunctionResult("token0", [ctx.token0])
    : request.id === "pool-token1"
    ? UNIV3_POOL_INTERFACE.encodeFunctionResult("token1", [ctx.token1])
    : request.id === "pool-fee"
    ? UNIV3_POOL_INTERFACE.encodeFunctionResult("fee", [ctx.fee])
    : request.id === "pool-tick-spacing"
    ? UNIV3_POOL_INTERFACE.encodeFunctionResult(
        "tickSpacing",
        [ctx.tickSpacing],
      )
    : request.id === "factory-get-pool"
    ? UNIV3_FACTORY_INTERFACE.encodeFunctionResult("getPool", [ctx.pool])
    : request.id === "current-slot0"
    ? UNIV3_POOL_INTERFACE.encodeFunctionResult(
        "slot0",
        [ctx.sqrtPriceX96, 0, 0, 1, 1, 0, true],
      )
    : request.id === "current-liquidity"
    ? UNIV3_POOL_INTERFACE.encodeFunctionResult("liquidity", [ctx.liquidity])
    : request.id.startsWith("univ3-precision:")
    ? univ3QuoteResult(request, canonical, ctx).data
    : request.id === "exact-factory-bound-quote"
    ? univ3QuoteResult(request, canonical, ctx).data
    : (() => {
        throw new Error(`unexpected univ3 fixture request ${request.id}`);
      })();
  return Object.freeze({
    id: request.id,
    ok: true as const,
    source: canonical,
    provenance: Object.freeze({
      kind: "migration-capture-fixture",
      fingerprint: `fixture:${request.id}`,
    }),
    completion: "returned" as const,
    data,
  });
}

class UniV3FixtureScheduler implements CentralAdapterScheduler {
  readonly #ctx: UniV3PoolContext;

  constructor(ctx: UniV3PoolContext) {
    this.#ctx = ctx;
  }

  issueExecutor(
    input: Parameters<CentralAdapterScheduler["issueExecutor"]>[0],
  ): ReturnType<CentralAdapterScheduler["issueExecutor"]> {
    const executor = createBoundedRequestExecutor({
      assertSupported: (requirements) => assert.deepEqual(
        requirements,
        input.requirements,
      ),
      assertCallerBinding() {},
      assertWithinBudget: (_familyId, requests) => {
        assert.deepEqual(requests, input.requests);
      },
      execute: async (execution) => Promise.all(execution.requests.map(
        (request) => univ3SuccessResult(request, execution.source, this.#ctx),
      )),
      sealStaticEvidenceReuseProof: () => ({ proofHash: "ab".repeat(32) }),
    });
    return Object.freeze({
      executor,
      timing: () => ({ queueWaitMs: 0, transportWallMs: 1, attempts: 1 }),
    });
  }
}

function univ3FixtureRuntime(ctx: UniV3PoolContext): CentralAdapterRuntime {
  let now = 1_000;
  return {
    clock: { nowMs: () => now++ },
    generationFence: new FixtureFence(),
    callerAuthority: { bind: () => ({}) },
    policy: {
      bind: (input) => ({
        lane: input.stage === "identity" ? "critical-proof" : "background",
        deadlineAtMs: 100_000,
        maxAttempts: 1,
        transportPool: "state-read",
        fairnessKey: input.subjectKey,
      }),
    },
    budgets: { assertAdmitted() {} },
    scheduler: new UniV3FixtureScheduler(ctx),
  };
}

async function runUniv3Lifecycle(
  canonical: CanonicalSource,
  ctx: UniV3PoolContext,
): Promise<AdapterFamilyPublication> {
  const family = PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG.forFamily(
    UNIV3_FAMILY_ID,
  );
  let publication: AdapterFamilyPublication | null = null;
  const swapCalldata = UNIV3_POOL_INTERFACE.encodeFunctionData("swap", [
    MIGRATION_CAPTURE_EXECUTOR,
    true,
    1_000_000n,
    0n,
    "0x",
  ]);
  const result = await executeAdapterFamilyLifecycleBatch({
    family,
    matches: [Object.freeze({
      matchedPatternId: UNIV3_SWAP_CALL_PATTERN_ID,
      observation: Object.freeze({
        kind: "call" as const,
        source: canonical,
        target: ctx.pool,
        data: swapCalldata,
      }),
    })],
    source: canonical,
    generation: canonical.generation,
    runtime: univ3FixtureRuntime(ctx),
    publisher: { publish: (value) => { publication = value; } },
  });
  assert(result.publication);
  assert(publication);
  return publication;
}

/**
 * Runs the strict UniV3 lifecycle over one fixture pool observation and emits
 * the canonical migration capture row for `univ3-standard`. All deep stages
 * are exercised at fixture level (deterministic local v3 exact-input math),
 * mirroring the univ2 bilateral capture contract.
 */
export async function captureUniv3FixtureCase(input: {
  readonly source: CanonicalSource;
  readonly caseId?: string;
}): Promise<RawFamilyMigrationCaseCapture> {
  return captureUniv3PoolCase({
    source: input.source,
    caseId: input.caseId,
    ctx: Object.freeze({
      pool: UNIV3_FIXTURE_POOL,
      factory: UNIV3_FIXTURE_FACTORY,
      token0: UNIV3_FIXTURE_TOKEN0,
      token1: UNIV3_FIXTURE_TOKEN1,
      fee: UNIV3_FIXTURE_FEE,
      tickSpacing: UNIV3_FIXTURE_TICK_SPACING,
      liquidity: UNIV3_FIXTURE_LIQUIDITY,
      sqrtPriceX96: UNIV3_FIXTURE_SQRT_PRICE_X96,
    }),
  });
}

export async function captureUniv3RealCase(input: {
  readonly source: CanonicalSource;
  readonly pool: string;
  readonly tokenA: string;
  readonly tokenB: string;
  readonly fee?: bigint | string;
  readonly tickSpacing?: number;
  readonly liquidity?: bigint | string;
  readonly sqrtPriceX96?: bigint | string;
  readonly caseId?: string;
}): Promise<RawFamilyMigrationCaseCapture> {
  return captureUniv3PoolCase({
    source: input.source,
    caseId: input.caseId ?? `univ3:${input.source.number}`,
    ctx: Object.freeze({
      pool: input.pool.toLowerCase(),
      factory: UNIV3_FIXTURE_FACTORY,
      token0: input.tokenA.toLowerCase(),
      token1: input.tokenB.toLowerCase(),
      fee: BigInt(input.fee ?? UNIV3_FIXTURE_FEE),
      tickSpacing: input.tickSpacing ?? UNIV3_FIXTURE_TICK_SPACING,
      liquidity: BigInt(input.liquidity ?? UNIV3_FIXTURE_LIQUIDITY),
      sqrtPriceX96: BigInt(
        input.sqrtPriceX96 ?? UNIV3_FIXTURE_SQRT_PRICE_X96,
      ),
    }),
  });
}

async function captureUniv3PoolCase(input: {
  readonly source: CanonicalSource;
  readonly caseId?: string;
  readonly ctx: UniV3PoolContext;
}): Promise<RawFamilyMigrationCaseCapture> {
  const ctx = input.ctx;
  const publication = await runUniv3Lifecycle(input.source, ctx);
  const evidenceRefs = Object.freeze([
    `fixture:univ3:${input.source.number}:${input.source.hash}`,
  ]);
  const family = PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG.forFamily(
    UNIV3_FAMILY_ID,
  );
  const edges: RawMigrationStageCapture["items"][number][] = [];
  const prices: RawMigrationStageCapture["items"][number][] = [];
  for (const instance of publication.instances) {
    for (const route of instance.routes) {
      const handle = instance.routeHandles.find((candidate) =>
        candidate.routeKey === route.routeKey
      );
      if (handle === undefined) {
        throw new Error(`prepared route ${route.routeKey} has no issued handle`);
      }
      const projected = projectFamilyRouteGraph({
        family,
        descriptor: instance.descriptor,
        route,
        handle,
      });
      edges.push(Object.freeze({
        id: projected.edge.canonicalEdgeId,
        value: Object.freeze({
          routeKey: route.routeKey,
          tokenIn: route.tokenIn,
          tokenOut: route.tokenOut,
          canonicalEdgeId: projected.edge.canonicalEdgeId,
        }),
      }));
    }
    const routeByKey = new Map(
      instance.routes.map((route) => [route.routeKey, route]),
    );
    for (const pricing of instance.pricingInstances) {
      for (const [routeKey, mid] of pricing.mids) {
        const route = routeByKey.get(routeKey);
        if (route === undefined) {
          throw new Error(`univ3 pricing route ${routeKey} is missing`);
        }
        prices.push(Object.freeze({
          id: `${pricing.stateKey}:${route.tokenIn.toLowerCase()}>` +
            `${route.tokenOut.toLowerCase()}`,
          value: Object.freeze({
            stateKey: pricing.stateKey,
            mid: Object.freeze({ ...mid }),
          }) as unknown as RawMigrationStageCapture["items"][number]["value"],
        }));
      }
    }
  }
  const enumeratedRoutes: RawMigrationStageCapture["items"][number][] = edges
    .map((edge) => edge.value as {
      readonly routeKey: string;
      readonly tokenIn: string;
      readonly tokenOut: string;
      readonly canonicalEdgeId: string;
    })
    .sort((left, right) => left.routeKey.localeCompare(right.routeKey))
    .map((value, order) => Object.freeze({
      id: value.canonicalEdgeId,
      value: Object.freeze({
        routeKey: value.routeKey,
        tokenIn: value.tokenIn,
        tokenOut: value.tokenOut,
        canonicalEdgeId: value.canonicalEdgeId,
        order,
      }),
    }));
  const exactMethod = univ3Exact.methods().find(
    (method) => method.kind === "request-program" &&
      method.id === "quoter-v2",
  );
  if (exactMethod === undefined || exactMethod.kind !== "request-program") {
    throw new Error("univ3 exact request program is missing");
  }
  const program = exactMethod.program;
  const exactByRouteKey = new Map<
    string,
    { readonly amountOut: bigint; readonly evidence: UniV3ExactEvidence }
  >();
  const exactQuotes: RawMigrationStageCapture["items"][number][] = [];
  const edgeByRouteKey = new Map(
    edges.map((edge) => {
      const value = edge.value as { readonly routeKey: string };
      return [value.routeKey, edge] as const;
    }),
  );
  for (const instance of publication.instances) {
    for (const route of [...instance.routes].sort(
      (left, right) => left.routeKey.localeCompare(right.routeKey),
    )) {
      const exactInput = Object.freeze({
        descriptor: instance.descriptor as unknown as UniV3Descriptor,
        route: route as unknown as UniV3Route,
        amountIn: UNIV2_CAPTURE_EXACT_AMOUNT_IN,
        source: input.source,
        executor: MIGRATION_CAPTURE_EXECUTOR,
        runtimeEvidence: Object.freeze([]),
      });
      const requests = program.buildRequests(exactInput);
      const results = requests.map((request) =>
        univ3SuccessResult(request, input.source, ctx)
      );
      const decoded = program.decode({
        programInput: exactInput,
        initialResults: results,
        dependentEvidence: Object.freeze([]),
      });
      const edge = edgeByRouteKey.get(route.routeKey);
      if (edge === undefined) {
        throw new Error(`univ3 exact route ${route.routeKey} has no edge`);
      }
      exactByRouteKey.set(route.routeKey, {
        amountOut: decoded.amountOut,
        evidence: decoded.evidence as UniV3ExactEvidence,
      });
      exactQuotes.push(Object.freeze({
        id: `${edge.id}\u001fexact:${UNIV2_CAPTURE_EXACT_AMOUNT_IN}`,
        value: Object.freeze({
          routeKey: route.routeKey,
          tokenIn: route.tokenIn,
          tokenOut: route.tokenOut,
          canonicalEdgeId: edge.id,
          amountIn: UNIV2_CAPTURE_EXACT_AMOUNT_IN.toString(),
          amountOut: decoded.amountOut.toString(),
          feeBps: (Number((instance.descriptor as unknown as {
            readonly fee: bigint;
          }).fee) / 100).toString(),
        }),
      }));
    }
  }
  const executionFragments: RawMigrationStageCapture["items"][number][] = [];
  const finalSimulations: RawMigrationStageCapture["items"][number][] = [];
  for (const instance of publication.instances) {
    for (const route of [...instance.routes].sort(
      (left, right) => left.routeKey.localeCompare(right.routeKey),
    )) {
      const quote = exactByRouteKey.get(route.routeKey);
      const edge = edgeByRouteKey.get(route.routeKey);
      if (quote === undefined || edge === undefined) {
        throw new Error(`univ3 execution route ${route.routeKey} has no quote`);
      }
      const descriptor = instance.descriptor as unknown as UniV3Descriptor;
      const univ3Route = route as unknown as UniV3Route;
      const amountIn = UNIV2_CAPTURE_EXACT_AMOUNT_IN;
      const minAmountOut = quote.amountOut;
      const fragment = univ3Execution.buildFragment({
        descriptor,
        route: univ3Route,
        amountIn,
        quotedAmountOut: quote.amountOut,
        minAmountOut,
        exactEvidence: quote.evidence,
        executor: MIGRATION_CAPTURE_EXECUTOR,
        runtimeEvidence: Object.freeze([]),
      });
      const node = fragment.nodes[0]!;
      executionFragments.push(Object.freeze({
        id: `${edge.id}\u001fexec:${amountIn}`,
        value: Object.freeze({
          routeKey: route.routeKey,
          tokenIn: route.tokenIn,
          tokenOut: route.tokenOut,
          canonicalEdgeId: edge.id,
          amountIn: amountIn.toString(),
          amountOut: quote.amountOut.toString(),
          minAmountOut: minAmountOut.toString(),
          actionAdapterId: node.adapterId,
          executionTarget: node.target,
          nodeFingerprint: hashCanonical(
            node as unknown as CanonicalValue,
          ),
        }),
      }));
      const effects = univ3Execution.expectedEffects({
        descriptor,
        route: univ3Route,
        amountIn,
        quotedAmountOut: quote.amountOut,
      });
      assertConservedUniv2Effects(effects);
      if (quote.amountOut < minAmountOut) {
        throw new Error("univ3 capture final simulation repayment failed");
      }
      finalSimulations.push(Object.freeze({
        id: `${edge.id}\u001fsim:${amountIn}`,
        value: Object.freeze({
          routeKey: route.routeKey,
          tokenIn: route.tokenIn,
          tokenOut: route.tokenOut,
          canonicalEdgeId: edge.id,
          amountIn: amountIn.toString(),
          amountOut: quote.amountOut.toString(),
          minAmountOut: minAmountOut.toString(),
          effectsFingerprint: hashCanonical(
            effects as unknown as CanonicalValue,
          ),
          conservation: "conserved",
          repayment: "satisfied",
          evInput: Object.freeze({
            amountIn: amountIn.toString(),
            amountOut: quote.amountOut.toString(),
          }),
        }),
      }));
    }
  }
  const instances = publication.instances;
  const summary = definedFamilyPluginContractSummary(family.plugin);
  return Object.freeze({
    familyId: UNIV3_FAMILY_ID,
    caseId: input.caseId ?? `univ3:${input.source.number}`,
    inputFingerprint: input.source.hash.slice(2).padStart(64, "0"),
    stateAnchorNumber: input.source.number,
    implementationClosureHash: summary.definitionBoundaryHash,
    stages: Object.freeze({
      instances: instanceStage(instances, evidenceRefs),
      edges: exercisedStage(edges, evidenceRefs),
      stateCoverage: exercisedStage([], evidenceRefs),
      pricedEdges: exercisedStage([], evidenceRefs),
      prices: exercisedStage(prices, evidenceRefs),
      failures: exercisedStage([], evidenceRefs),
      enumeratedRoutes: exercisedStage(enumeratedRoutes, evidenceRefs),
      exactQuotes: exercisedStage(exactQuotes, evidenceRefs),
      executionFragments: exercisedStage(executionFragments, evidenceRefs),
      finalSimulations: exercisedStage(finalSimulations, evidenceRefs),
    }),
  });
}

export const UNIV4_FIXTURE_MANAGER = ADDR.UNISWAP_V4_POOL_MANAGER;
export const UNIV4_FIXTURE_STATE_VIEW = ADDR.UNISWAP_V4_STATE_VIEW;
export const UNIV4_FIXTURE_QUOTER = ADDR.UNISWAP_V4_QUOTER;
export const UNIV4_FIXTURE_CURRENCY0 =
  "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
export const UNIV4_FIXTURE_CURRENCY1 =
  "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2";
export const UNIV4_FIXTURE_FEE = 3000n;
export const UNIV4_FIXTURE_TICK_SPACING = 60;
export const UNIV4_FIXTURE_LP_FEE = 3000n;
export const UNIV4_FIXTURE_LIQUIDITY = 1_000_000_000_000_000_000n;
export const UNIV4_FIXTURE_SQRT_PRICE_X96 = 1n << 96n;
export const FUNDING_CAPTURE_ASSET =
  "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
export const FUNDING_CAPTURE_MAX_BORROW = 1_000_000_000n;
export const FUNDING_CAPTURE_AMOUNT = 1_000_000n;
export const FUNDING_CAPTURE_MIN_PROFIT = 1_000n;

interface UniV4PoolContext {
  readonly manager: string;
  readonly stateView: string;
  readonly quoter: string;
  readonly poolKey: {
    readonly currency0: string;
    readonly currency1: string;
    readonly fee: number;
    readonly tickSpacing: number;
    readonly hooks: string;
  };
  readonly poolId: string;
  readonly liquidity: bigint;
  readonly sqrtPriceX96: bigint;
  readonly lpFee: bigint;
}

function univ4QuoteResult(
  request: AdapterRequest,
  canonical: CanonicalSource,
  ctx: UniV4PoolContext,
): Extract<AdapterRequestResult, { readonly ok: true }> {
  const callRequest = request as { readonly data: string };
  const decoded = UNIV4_QUOTER_INTERFACE.decodeFunctionData(
    "quoteExactInputSingle",
    callRequest.data,
  );
  const params = decoded[0] as {
    readonly zeroForOne: boolean;
    readonly exactAmount: bigint;
  };
  const state = {
    sqrtPriceX96: ctx.sqrtPriceX96,
    liquidity: ctx.liquidity,
    tick: 0,
    fee: ctx.lpFee,
    tickSpacing: ctx.poolKey.tickSpacing,
    tickBitmap: new Map([[0, 0n], [-1, 0n]]),
    ticks: new Map(),
  };
  const amountOut = v3SwapExactInput(
    state,
    params.zeroForOne,
    params.exactAmount,
  );
  const data = UNIV4_QUOTER_INTERFACE.encodeFunctionResult(
    "quoteExactInputSingle",
    [amountOut, 0n],
  );
  return Object.freeze({
    id: request.id,
    ok: true as const,
    source: canonical,
    provenance: Object.freeze({
      kind: "migration-capture-fixture",
      fingerprint: `fixture:${request.id}`,
    }),
    completion: "returned" as const,
    data,
  });
}

function univ4SuccessResult(
  request: AdapterRequest,
  canonical: CanonicalSource,
  ctx: UniV4PoolContext,
): AdapterRequestResult {
  const data = request.id === "manager-code"
    ? "0x00"
    : request.id === "identity-slot0" || request.id === "current-slot0"
    ? UNIV4_STATE_VIEW_INTERFACE.encodeFunctionResult("getSlot0", [
        ctx.sqrtPriceX96,
        0,
        0,
        ctx.lpFee,
      ])
    : request.id === "identity-liquidity" ||
        request.id === "current-liquidity"
    ? UNIV4_STATE_VIEW_INTERFACE.encodeFunctionResult("getLiquidity", [
        ctx.liquidity,
      ])
    : request.id.startsWith("univ4-precision:") ||
        request.id === "exact-univ4-quote"
    ? univ4QuoteResult(request, canonical, ctx).data
    : (() => {
        throw new Error(`unexpected univ4 fixture request ${request.id}`);
      })();
  return Object.freeze({
    id: request.id,
    ok: true as const,
    source: canonical,
    provenance: Object.freeze({
      kind: "migration-capture-fixture",
      fingerprint: `fixture:${request.id}`,
    }),
    completion: "returned" as const,
    data,
  });
}

class UniV4FixtureScheduler implements CentralAdapterScheduler {
  readonly #ctx: UniV4PoolContext;

  constructor(ctx: UniV4PoolContext) {
    this.#ctx = ctx;
  }

  issueExecutor(
    input: Parameters<CentralAdapterScheduler["issueExecutor"]>[0],
  ): ReturnType<CentralAdapterScheduler["issueExecutor"]> {
    const executor = createBoundedRequestExecutor({
      assertSupported: (requirements) => assert.deepEqual(
        requirements,
        input.requirements,
      ),
      assertCallerBinding() {},
      assertWithinBudget: (_familyId, requests) => {
        assert.deepEqual(requests, input.requests);
      },
      execute: async (execution) => Promise.all(execution.requests.map(
        (request) => univ4SuccessResult(request, execution.source, this.#ctx),
      )),
      sealStaticEvidenceReuseProof: () => ({ proofHash: "ab".repeat(32) }),
    });
    return Object.freeze({
      executor,
      timing: () => ({ queueWaitMs: 0, transportWallMs: 1, attempts: 1 }),
    });
  }
}

function univ4FixtureRuntime(ctx: UniV4PoolContext): CentralAdapterRuntime {
  let now = 1_000;
  return {
    clock: { nowMs: () => now++ },
    generationFence: new FixtureFence(),
    callerAuthority: { bind: () => ({}) },
    policy: {
      bind: (input) => ({
        lane: input.stage === "identity" ? "critical-proof" : "background",
        deadlineAtMs: 100_000,
        maxAttempts: 1,
        transportPool: "state-read",
        fairnessKey: input.subjectKey,
      }),
    },
    budgets: { assertAdmitted() {} },
    scheduler: new UniV4FixtureScheduler(ctx),
  };
}

async function runUniv4Lifecycle(
  canonical: CanonicalSource,
  ctx: UniV4PoolContext,
): Promise<AdapterFamilyPublication> {
  const family = PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG.forFamily(
    UNIV4_FAMILY_ID,
  );
  let publication: AdapterFamilyPublication | null = null;
  const swapCalldata = UNIV4_POOL_MANAGER_INTERFACE.encodeFunctionData(
    "swap",
    [
      ctx.poolKey,
      {
        zeroForOne: true,
        amountSpecified: 1_000_000n,
        sqrtPriceLimitX96: 0n,
      },
      "0x",
    ],
  );
  const result = await executeAdapterFamilyLifecycleBatch({
    family,
    matches: [Object.freeze({
      matchedPatternId: UNIV4_SWAP_CALL_PATTERN_ID,
      observation: Object.freeze({
        kind: "call" as const,
        source: canonical,
        target: ctx.manager,
        data: swapCalldata,
      }),
    })],
    source: canonical,
    generation: canonical.generation,
    runtime: univ4FixtureRuntime(ctx),
    publisher: { publish: (value) => { publication = value; } },
  });
  assert(result.publication);
  assert(publication);
  return publication;
}

function univ4PoolKey(): UniV4PoolContext["poolKey"] {
  return Object.freeze({
    currency0: UNIV4_FIXTURE_CURRENCY0,
    currency1: UNIV4_FIXTURE_CURRENCY1,
    fee: Number(UNIV4_FIXTURE_FEE),
    tickSpacing: UNIV4_FIXTURE_TICK_SPACING,
    hooks: "0x0000000000000000000000000000000000000000",
  });
}

export async function captureUniv4FixtureCase(input: {
  readonly source: CanonicalSource;
  readonly caseId?: string;
}): Promise<RawFamilyMigrationCaseCapture> {
  return captureUniv4PoolCase({
    source: input.source,
    caseId: input.caseId,
    ctx: Object.freeze({
      manager: UNIV4_FIXTURE_MANAGER,
      stateView: UNIV4_FIXTURE_STATE_VIEW,
      quoter: UNIV4_FIXTURE_QUOTER,
      poolKey: univ4PoolKey(),
      poolId: v4PoolId(univ4PoolKey()),
      liquidity: UNIV4_FIXTURE_LIQUIDITY,
      sqrtPriceX96: UNIV4_FIXTURE_SQRT_PRICE_X96,
      lpFee: UNIV4_FIXTURE_LP_FEE,
    }),
  });
}

export async function captureUniv4RealCase(input: {
  readonly source: CanonicalSource;
  readonly currency0: string;
  readonly currency1: string;
  readonly fee?: number;
  readonly tickSpacing?: number;
  readonly hooks?: string;
  readonly liquidity?: bigint | string;
  readonly sqrtPriceX96?: bigint | string;
  readonly lpFee?: bigint | string;
  readonly caseId?: string;
}): Promise<RawFamilyMigrationCaseCapture> {
  const poolKey = Object.freeze({
    currency0: input.currency0.toLowerCase(),
    currency1: input.currency1.toLowerCase(),
    fee: input.fee ?? Number(UNIV4_FIXTURE_FEE),
    tickSpacing: input.tickSpacing ?? UNIV4_FIXTURE_TICK_SPACING,
    hooks: (input.hooks ?? "0x0000000000000000000000000000000000000000")
      .toLowerCase(),
  });
  return captureUniv4PoolCase({
    source: input.source,
    caseId: input.caseId ?? `univ4:${input.source.number}`,
    ctx: Object.freeze({
      manager: UNIV4_FIXTURE_MANAGER,
      stateView: UNIV4_FIXTURE_STATE_VIEW,
      quoter: UNIV4_FIXTURE_QUOTER,
      poolKey,
      poolId: v4PoolId(poolKey),
      liquidity: BigInt(input.liquidity ?? UNIV4_FIXTURE_LIQUIDITY),
      sqrtPriceX96: BigInt(
        input.sqrtPriceX96 ?? UNIV4_FIXTURE_SQRT_PRICE_X96,
      ),
      lpFee: BigInt(input.lpFee ?? UNIV4_FIXTURE_LP_FEE),
    }),
  });
}

async function captureUniv4PoolCase(input: {
  readonly source: CanonicalSource;
  readonly caseId?: string;
  readonly ctx: UniV4PoolContext;
}): Promise<RawFamilyMigrationCaseCapture> {
  const ctx = input.ctx;
  const publication = await runUniv4Lifecycle(input.source, ctx);
  const evidenceRefs = Object.freeze([
    `fixture:univ4:${input.source.number}:${input.source.hash}`,
  ]);
  const family = PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG.forFamily(
    UNIV4_FAMILY_ID,
  );
  const edges: RawMigrationStageCapture["items"][number][] = [];
  const prices: RawMigrationStageCapture["items"][number][] = [];
  for (const instance of publication.instances) {
    for (const route of instance.routes) {
      const handle = instance.routeHandles.find((candidate) =>
        candidate.routeKey === route.routeKey
      );
      if (handle === undefined) {
        throw new Error(`prepared route ${route.routeKey} has no issued handle`);
      }
      const projected = projectFamilyRouteGraph({
        family,
        descriptor: instance.descriptor,
        route,
        handle,
      });
      edges.push(Object.freeze({
        id: projected.edge.canonicalEdgeId,
        value: Object.freeze({
          routeKey: route.routeKey,
          tokenIn: route.tokenIn,
          tokenOut: route.tokenOut,
          canonicalEdgeId: projected.edge.canonicalEdgeId,
        }),
      }));
    }
    const routeByKey = new Map(
      instance.routes.map((route) => [route.routeKey, route]),
    );
    for (const pricing of instance.pricingInstances) {
      for (const [routeKey, mid] of pricing.mids) {
        const route = routeByKey.get(routeKey);
        if (route === undefined) {
          throw new Error(`univ4 pricing route ${routeKey} is missing`);
        }
        prices.push(Object.freeze({
          id: `${pricing.stateKey}:${route.tokenIn.toLowerCase()}>` +
            `${route.tokenOut.toLowerCase()}`,
          value: Object.freeze({
            stateKey: pricing.stateKey,
            mid: Object.freeze({ ...mid }),
          }) as unknown as RawMigrationStageCapture["items"][number]["value"],
        }));
      }
    }
  }
  const enumeratedRoutes: RawMigrationStageCapture["items"][number][] = edges
    .map((edge) => edge.value as {
      readonly routeKey: string;
      readonly tokenIn: string;
      readonly tokenOut: string;
      readonly canonicalEdgeId: string;
    })
    .sort((left, right) => left.routeKey.localeCompare(right.routeKey))
    .map((value, order) => Object.freeze({
      id: value.canonicalEdgeId,
      value: Object.freeze({
        routeKey: value.routeKey,
        tokenIn: value.tokenIn,
        tokenOut: value.tokenOut,
        canonicalEdgeId: value.canonicalEdgeId,
        order,
      }),
    }));
  const exactMethod = univ4Exact.methods().find(
    (method) => method.kind === "request-program" && method.id === "univ4-quoter",
  );
  if (exactMethod === undefined || exactMethod.kind !== "request-program") {
    throw new Error("univ4 exact request program is missing");
  }
  const program = exactMethod.program;
  const exactByRouteKey = new Map<
    string,
    { readonly amountOut: bigint; readonly evidence: UniV4ExactEvidence }
  >();
  const exactQuotes: RawMigrationStageCapture["items"][number][] = [];
  const edgeByRouteKey = new Map(
    edges.map((edge) => {
      const value = edge.value as { readonly routeKey: string };
      return [value.routeKey, edge] as const;
    }),
  );
  for (const instance of publication.instances) {
    for (const route of [...instance.routes].sort(
      (left, right) => left.routeKey.localeCompare(right.routeKey),
    )) {
      const exactInput = Object.freeze({
        descriptor: instance.descriptor as unknown as UniV4Descriptor,
        route: route as unknown as UniV4Route,
        amountIn: UNIV2_CAPTURE_EXACT_AMOUNT_IN,
        source: input.source,
        executor: MIGRATION_CAPTURE_EXECUTOR,
        runtimeEvidence: Object.freeze([]),
      });
      const requests = program.buildRequests(exactInput);
      const results = requests.map((request) =>
        univ4SuccessResult(request, input.source, ctx)
      );
      const decoded = program.decode({
        programInput: exactInput,
        initialResults: results,
        dependentEvidence: Object.freeze([]),
      });
      const edge = edgeByRouteKey.get(route.routeKey);
      if (edge === undefined) {
        throw new Error(`univ4 exact route ${route.routeKey} has no edge`);
      }
      exactByRouteKey.set(route.routeKey, {
        amountOut: decoded.amountOut,
        evidence: decoded.evidence as UniV4ExactEvidence,
      });
      exactQuotes.push(Object.freeze({
        id: `${edge.id}\u001fexact:${UNIV2_CAPTURE_EXACT_AMOUNT_IN}`,
        value: Object.freeze({
          routeKey: route.routeKey,
          tokenIn: route.tokenIn,
          tokenOut: route.tokenOut,
          canonicalEdgeId: edge.id,
          amountIn: UNIV2_CAPTURE_EXACT_AMOUNT_IN.toString(),
          amountOut: decoded.amountOut.toString(),
          feeBps: (Number(ctx.lpFee) / 100).toString(),
        }),
      }));
    }
  }
  const executionFragments: RawMigrationStageCapture["items"][number][] = [];
  const finalSimulations: RawMigrationStageCapture["items"][number][] = [];
  for (const instance of publication.instances) {
    for (const route of [...instance.routes].sort(
      (left, right) => left.routeKey.localeCompare(right.routeKey),
    )) {
      const quote = exactByRouteKey.get(route.routeKey);
      const edge = edgeByRouteKey.get(route.routeKey);
      if (quote === undefined || edge === undefined) {
        throw new Error(`univ4 execution route ${route.routeKey} has no quote`);
      }
      const descriptor = instance.descriptor as unknown as UniV4Descriptor;
      const univ4Route = route as unknown as UniV4Route;
      const amountIn = UNIV2_CAPTURE_EXACT_AMOUNT_IN;
      const minAmountOut = quote.amountOut;
      const fragment = univ4Execution.buildFragment({
        descriptor,
        route: univ4Route,
        amountIn,
        quotedAmountOut: quote.amountOut,
        minAmountOut,
        exactEvidence: quote.evidence,
        executor: MIGRATION_CAPTURE_EXECUTOR,
        runtimeEvidence: Object.freeze([]),
      });
      executionFragments.push(Object.freeze({
        id: `${edge.id}\u001fexec:${amountIn}`,
        value: Object.freeze({
          routeKey: route.routeKey,
          tokenIn: route.tokenIn,
          tokenOut: route.tokenOut,
          canonicalEdgeId: edge.id,
          amountIn: amountIn.toString(),
          amountOut: quote.amountOut.toString(),
          minAmountOut: minAmountOut.toString(),
          actionAdapterId: "univ4-unlock",
          executionTarget: ctx.manager,
          nodeFingerprint: hashCanonical(
            fragment.nodes as unknown as CanonicalValue,
          ),
        }),
      }));
      const effects = univ4Execution.expectedEffects({
        descriptor,
        route: univ4Route,
        amountIn,
        quotedAmountOut: quote.amountOut,
      });
      assertConservedUniv4Effects(effects, amountIn, quote.amountOut);
      finalSimulations.push(Object.freeze({
        id: `${edge.id}\u001fsim:${amountIn}`,
        value: Object.freeze({
          routeKey: route.routeKey,
          tokenIn: route.tokenIn,
          tokenOut: route.tokenOut,
          canonicalEdgeId: edge.id,
          amountIn: amountIn.toString(),
          amountOut: quote.amountOut.toString(),
          minAmountOut: minAmountOut.toString(),
          effectsFingerprint: hashCanonical(
            effects as unknown as CanonicalValue,
          ),
          conservation: "conserved",
          repayment: "satisfied",
          evInput: Object.freeze({
            amountIn: amountIn.toString(),
            amountOut: quote.amountOut.toString(),
          }),
        }),
      }));
    }
  }
  const instances = publication.instances;
  const summary = definedFamilyPluginContractSummary(family.plugin);
  return Object.freeze({
    familyId: UNIV4_FAMILY_ID,
    caseId: input.caseId ?? `univ4:${input.source.number}`,
    inputFingerprint: input.source.hash.slice(2).padStart(64, "0"),
    stateAnchorNumber: input.source.number,
    implementationClosureHash: summary.definitionBoundaryHash,
    stages: Object.freeze({
      instances: instanceStage(instances, evidenceRefs),
      edges: exercisedStage(edges, evidenceRefs),
      stateCoverage: exercisedStage([], evidenceRefs),
      pricedEdges: exercisedStage([], evidenceRefs),
      prices: exercisedStage(prices, evidenceRefs),
      failures: exercisedStage([], evidenceRefs),
      enumeratedRoutes: exercisedStage(enumeratedRoutes, evidenceRefs),
      exactQuotes: exercisedStage(exactQuotes, evidenceRefs),
      executionFragments: exercisedStage(executionFragments, evidenceRefs),
      finalSimulations: exercisedStage(finalSimulations, evidenceRefs),
    }),
  });
}

function assertConservedUniv4Effects(
  effects: readonly ExpectedEffect[],
  amountIn: bigint,
  amountOut: bigint,
): void {
  if (effects.length !== 2) {
    throw new Error("univ4 capture final simulation effects size mismatch");
  }
  const [inEffect, outEffect] = effects;
  if (
    inEffect.kind !== "token-delta" ||
    inEffect.account !== "executor" ||
    inEffect.direction !== "decrease" ||
    outEffect.kind !== "token-delta" ||
    outEffect.account !== "executor" ||
    outEffect.direction !== "increase"
  ) {
    throw new Error("univ4 capture final simulation effects are malformed");
  }
  if (amountIn <= 0n || amountOut <= 0n || amountOut >= amountIn * 100n) {
    throw new Error("univ4 capture final simulation amounts are inconsistent");
  }
}

const FUNDING_ERC20_INTERFACE = new ethers.Interface([
  "function balanceOf(address account) view returns (uint256)",
]);

function fundingFixtureRuntime(input: {
  readonly source: CanonicalSource;
  readonly generation: number;
}): CentralAdapterRuntime {
  let now = 1_000;
  const scheduler: CentralAdapterScheduler = {
    issueExecutor(issue) {
      return Object.freeze({
        executor: createBoundedRequestExecutor({
          assertSupported(requirements) {
            assert.deepEqual(requirements, issue.requirements);
          },
          assertCallerBinding() {},
          assertWithinBudget(familyId, requests) {
            assert.equal(familyId, issue.subject.familyId);
            assert.deepEqual(requests, issue.requests);
          },
          execute: async ({ requests, source }) => requests.map((request) => {
            const asset = (request as { readonly to: string }).to;
            return Object.freeze({
              id: request.id,
              ok: true as const,
              source,
              provenance: Object.freeze({
                kind: "migration-capture-fixture",
                fingerprint: `funding:${asset.toLowerCase()}`,
              }),
              completion: "returned" as const,
              data: FUNDING_ERC20_INTERFACE.encodeFunctionResult(
                "balanceOf",
                [FUNDING_CAPTURE_MAX_BORROW],
              ),
            });
          }),
          sealStaticEvidenceReuseProof: () => ({ proofHash: "ab".repeat(32) }),
        }),
        timing: () => Object.freeze({
          queueWaitMs: 1,
          transportWallMs: 2,
          attempts: 1,
        }),
      });
    },
  };
  return {
    clock: { nowMs: () => now++ },
    generationFence: {
      assertCurrent(generation, source) {
        assert.equal(generation, input.generation);
        assert.equal(source.hash.toLowerCase(), input.source.hash.toLowerCase());
      },
    },
    callerAuthority: { bind: () => Object.freeze({}) },
    policy: {
      bind(policyInput) {
        assert.equal(policyInput.stage, "pricing-current");
        return Object.freeze({
          lane: "background" as const,
          deadlineAtMs: 10_000,
          maxAttempts: 1,
          transportPool: "state-read" as const,
          fairnessKey: policyInput.subjectKey,
        });
      },
    },
    budgets: { assertAdmitted() {} },
    scheduler,
  };
}

/**
 * Runs one strict funding Family (flash-loan:balancer-v2 / morpho) over a
 * fixture ERC20 balance and emits the canonical migration capture row. The
 * funding-only cohort requires only failures/executionFragments/
 * finalSimulations; borrow and repayment fragments are issued through the
 * central funding runtime so the fingerprints are authority-bound.
 */
export async function captureFundingFixtureCase(input: {
  readonly familyId: "flash-loan:balancer-v2" | "flash-loan:morpho";
  readonly source: CanonicalSource;
  readonly caseId?: string;
}): Promise<RawFamilyMigrationCaseCapture> {
  const family = PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG
    .forStrictFamily(familyId(input.familyId));
  const asset = ethers.getAddress(FUNDING_CAPTURE_ASSET);
  const runtime = fundingFixtureRuntime({
    source: input.source,
    generation: input.source.generation,
  });
  let publication: FundingFamilyPublication | null = null;
  const result = await executeFundingFamilyLiquidity({
    family,
    assets: [asset],
    source: input.source,
    generation: input.source.generation,
    runtime,
    publisher: {
      publish(value) {
        publication = value;
      },
    },
  });
  assert(result.offers.length >= 1);
  assert(publication !== null);
  const offer: PreparedFundingOffer = result.offers[0]!;
  const amount = FUNDING_CAPTURE_AMOUNT;
  const minProfit = FUNDING_CAPTURE_MIN_PROFIT;
  const borrowFragment = buildFundingBorrowFragment({
    family,
    offer,
    source: input.source,
    generation: input.source.generation,
    amount,
    minProfit,
    children: [],
  });
  const repaymentFragment = buildFundingRepaymentFragment({
    family,
    offer,
    source: input.source,
    generation: input.source.generation,
    amount,
  });
  const evidenceRefs = Object.freeze([
    `fixture:${input.familyId}:${input.source.number}:${input.source.hash}`,
  ]);
  const absentStage = Object.freeze({
    status: "declared-absent" as const,
    items: Object.freeze([]),
    evidenceRefs,
    blocker: null,
  });
  const assetLower = asset.toLowerCase();
  const executionFragments: RawMigrationStageCapture["items"][number][] = [
    Object.freeze({
      id: `${input.familyId}:${assetLower}\u001fborrow:${amount}`,
      value: Object.freeze({
        familyId: input.familyId,
        asset,
        amount: amount.toString(),
        minProfit: minProfit.toString(),
        actionAdapterId: offer.actionAdapterId,
        nodeFingerprint: hashCanonical(
          borrowFragment.nodes as unknown as CanonicalValue,
        ),
      }),
    }),
    Object.freeze({
      id: `${input.familyId}:${assetLower}\u001frepay:${amount}`,
      value: Object.freeze({
        familyId: input.familyId,
        asset,
        amount: amount.toString(),
        actionAdapterId: offer.actionAdapterId,
        nodeFingerprint: hashCanonical(
          repaymentFragment.nodes as unknown as CanonicalValue,
        ),
      }),
    }),
  ];
  const finalSimulations: RawMigrationStageCapture["items"][number][] = [
    Object.freeze({
      id: `${input.familyId}:${assetLower}\u001fsim:${amount}`,
      value: Object.freeze({
        familyId: input.familyId,
        asset,
        amount: amount.toString(),
        maxBorrow: offer.maxBorrow.toString(),
        repayment: "satisfied",
        conservation: "conserved",
        evInput: Object.freeze({ amount: amount.toString() }),
      }),
    }),
  ];
  const summary = definedFamilyPluginContractSummary(family.plugin);
  return Object.freeze({
    familyId: input.familyId,
    caseId: input.caseId ?? `${input.familyId}:${input.source.number}`,
    inputFingerprint: input.source.hash.slice(2).padStart(64, "0"),
    stateAnchorNumber: input.source.number,
    implementationClosureHash: summary.definitionBoundaryHash,
    stages: Object.freeze({
      instances: absentStage,
      edges: absentStage,
      stateCoverage: absentStage,
      pricedEdges: absentStage,
      prices: absentStage,
      failures: exercisedStage([], evidenceRefs),
      enumeratedRoutes: absentStage,
      exactQuotes: absentStage,
      executionFragments: exercisedStage(executionFragments, evidenceRefs),
      finalSimulations: exercisedStage(finalSimulations, evidenceRefs),
    }),
  });
}

export const PSM_FIXTURE_TARGET = `0x${"55".repeat(20)}`;
export const PSM_FIXTURE_GEM =
  "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
export const PSM_FIXTURE_DAI =
  "0x6b175474e89094c44da98b954eedeac495271d0f";
export const PSM_FIXTURE_TIN = 10n ** 16n;
export const PSM_FIXTURE_TOUT = 10n ** 16n;

function psmSuccessResult(
  request: AdapterRequest,
  canonical: CanonicalSource,
): AdapterRequestResult {
  const data = request.id === "identity-code"
    ? "0x00"
    : request.id === "identity-gem"
    ? PSM_INTERFACE.encodeFunctionResult("gem", [PSM_FIXTURE_GEM])
    : request.id === "identity-dai"
    ? PSM_INTERFACE.encodeFunctionResult("dai", [PSM_FIXTURE_DAI])
    : request.id === "identity-tin" || request.id === "current-tin" ||
        request.id === "exact-tin"
    ? PSM_INTERFACE.encodeFunctionResult("tin", [PSM_FIXTURE_TIN])
    : request.id === "identity-tout"
    ? PSM_INTERFACE.encodeFunctionResult("tout", [PSM_FIXTURE_TOUT])
    : (() => {
        throw new Error(`unexpected psm fixture request ${request.id}`);
      })();
  return Object.freeze({
    id: request.id,
    ok: true as const,
    source: canonical,
    provenance: Object.freeze({
      kind: "migration-capture-fixture",
      fingerprint: `fixture:${request.id}`,
    }),
    completion: "returned" as const,
    data,
  });
}

class PsmFixtureScheduler implements CentralAdapterScheduler {
  issueExecutor(
    input: Parameters<CentralAdapterScheduler["issueExecutor"]>[0],
  ): ReturnType<CentralAdapterScheduler["issueExecutor"]> {
    const executor = createBoundedRequestExecutor({
      assertSupported: (requirements) => assert.deepEqual(
        requirements,
        input.requirements,
      ),
      assertCallerBinding() {},
      assertWithinBudget: (_familyId, requests) => {
        assert.deepEqual(requests, input.requests);
      },
      execute: async (execution) => Promise.all(execution.requests.map(
        (request) => psmSuccessResult(request, execution.source),
      )),
      sealStaticEvidenceReuseProof: () => ({ proofHash: "ab".repeat(32) }),
    });
    return Object.freeze({
      executor,
      timing: () => ({ queueWaitMs: 0, transportWallMs: 1, attempts: 1 }),
    });
  }
}

function psmFixtureRuntime(): CentralAdapterRuntime {
  let now = 1_000;
  return {
    clock: { nowMs: () => now++ },
    generationFence: new FixtureFence(),
    callerAuthority: { bind: () => ({}) },
    policy: {
      bind: (input) => ({
        lane: input.stage === "identity" ? "critical-proof" : "background",
        deadlineAtMs: 100_000,
        maxAttempts: 1,
        transportPool: "state-read",
        fairnessKey: input.subjectKey,
      }),
    },
    budgets: { assertAdmitted() {} },
    scheduler: new PsmFixtureScheduler(),
  };
}

async function runPsmLifecycle(
  canonical: CanonicalSource,
): Promise<AdapterFamilyPublication> {
  const family = PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG.forFamily(
    PSM_FAMILY_ID,
  );
  let publication: AdapterFamilyPublication | null = null;
  const sellGemCalldata = PSM_INTERFACE.encodeFunctionData("sellGem", [
    MIGRATION_CAPTURE_EXECUTOR,
    1_000_000n,
  ]);
  const result = await executeAdapterFamilyLifecycleBatch({
    family,
    matches: [Object.freeze({
      matchedPatternId: "psm-sellgem-call",
      observation: Object.freeze({
        kind: "call" as const,
        source: canonical,
        target: PSM_FIXTURE_TARGET,
        data: sellGemCalldata,
      }),
    })],
    source: canonical,
    generation: canonical.generation,
    runtime: psmFixtureRuntime(),
    publisher: { publish: (value) => { publication = value; } },
  });
  assert(result.publication);
  assert(publication);
  return publication;
}

/**
 * Runs the strict PSM (Sky Lite) lifecycle over one fixture singleton pair
 * and emits the canonical migration capture row. PSM exposes a single
 * sell-gem route; all stages are exercised at fixture level.
 */
export async function capturePsmFixtureCase(input: {
  readonly source: CanonicalSource;
  readonly caseId?: string;
}): Promise<RawFamilyMigrationCaseCapture> {
  const publication = await runPsmLifecycle(input.source);
  const evidenceRefs = Object.freeze([
    `fixture:psm:${input.source.number}:${input.source.hash}`,
  ]);
  const family = PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG.forFamily(
    PSM_FAMILY_ID,
  );
  const edges: RawMigrationStageCapture["items"][number][] = [];
  const prices: RawMigrationStageCapture["items"][number][] = [];
  for (const instance of publication.instances) {
    for (const route of instance.routes) {
      const handle = instance.routeHandles.find((candidate) =>
        candidate.routeKey === route.routeKey
      );
      if (handle === undefined) {
        throw new Error(`prepared route ${route.routeKey} has no issued handle`);
      }
      const projected = projectFamilyRouteGraph({
        family,
        descriptor: instance.descriptor,
        route,
        handle,
      });
      edges.push(Object.freeze({
        id: projected.edge.canonicalEdgeId,
        value: Object.freeze({
          routeKey: route.routeKey,
          tokenIn: route.tokenIn,
          tokenOut: route.tokenOut,
          canonicalEdgeId: projected.edge.canonicalEdgeId,
        }),
      }));
    }
    const routeByKey = new Map(
      instance.routes.map((route) => [route.routeKey, route]),
    );
    for (const pricing of instance.pricingInstances) {
      for (const [routeKey, mid] of pricing.mids) {
        const route = routeByKey.get(routeKey);
        if (route === undefined) {
          throw new Error(`psm pricing route ${routeKey} is missing`);
        }
        prices.push(Object.freeze({
          id: `${pricing.stateKey}:${route.tokenIn.toLowerCase()}>` +
            `${route.tokenOut.toLowerCase()}`,
          value: Object.freeze({
            stateKey: pricing.stateKey,
            mid: Object.freeze({ ...mid }),
          }) as unknown as RawMigrationStageCapture["items"][number]["value"],
        }));
      }
    }
  }
  const enumeratedRoutes: RawMigrationStageCapture["items"][number][] = edges
    .map((edge) => edge.value as {
      readonly routeKey: string;
      readonly tokenIn: string;
      readonly tokenOut: string;
      readonly canonicalEdgeId: string;
    })
    .sort((left, right) => left.routeKey.localeCompare(right.routeKey))
    .map((value, order) => Object.freeze({
      id: value.canonicalEdgeId,
      value: Object.freeze({
        routeKey: value.routeKey,
        tokenIn: value.tokenIn,
        tokenOut: value.tokenOut,
        canonicalEdgeId: value.canonicalEdgeId,
        order,
      }),
    }));
  const exactMethod = psmExact.methods().find(
    (method) => method.kind === "request-program" && method.id === "psm-quote",
  );
  if (exactMethod === undefined || exactMethod.kind !== "request-program") {
    throw new Error("psm exact request program is missing");
  }
  const program = exactMethod.program;
  const exactByRouteKey = new Map<
    string,
    {
      readonly amountOut: bigint;
      readonly evidence: import("./venues/protocols/psm-family/types.js")
        .PsmExactEvidence;
    }
  >();
  const exactQuotes: RawMigrationStageCapture["items"][number][] = [];
  const edgeByRouteKey = new Map(
    edges.map((edge) => {
      const value = edge.value as { readonly routeKey: string };
      return [value.routeKey, edge] as const;
    }),
  );
  for (const instance of publication.instances) {
    for (const route of [...instance.routes].sort(
      (left, right) => left.routeKey.localeCompare(right.routeKey),
    )) {
      const exactInput = Object.freeze({
        descriptor: instance.descriptor as unknown as PsmDescriptor,
        route: route as unknown as PsmRoute,
        amountIn: UNIV2_CAPTURE_EXACT_AMOUNT_IN,
        source: input.source,
        executor: MIGRATION_CAPTURE_EXECUTOR,
        runtimeEvidence: Object.freeze([]),
      });
      const requests = program.buildRequests(exactInput);
      const results = requests.map((request) =>
        psmSuccessResult(request, input.source)
      );
      const decoded = program.decode({
        programInput: exactInput,
        initialResults: results,
        dependentEvidence: Object.freeze([]),
      });
      const edge = edgeByRouteKey.get(route.routeKey);
      if (edge === undefined) {
        throw new Error(`psm exact route ${route.routeKey} has no edge`);
      }
      exactByRouteKey.set(route.routeKey, {
        amountOut: decoded.amountOut,
        evidence: decoded.evidence,
      });
      exactQuotes.push(Object.freeze({
        id: `${edge.id}\u001fexact:${UNIV2_CAPTURE_EXACT_AMOUNT_IN}`,
        value: Object.freeze({
          routeKey: route.routeKey,
          tokenIn: route.tokenIn,
          tokenOut: route.tokenOut,
          canonicalEdgeId: edge.id,
          amountIn: UNIV2_CAPTURE_EXACT_AMOUNT_IN.toString(),
          amountOut: decoded.amountOut.toString(),
          feeBps: "0",
        }),
      }));
    }
  }
  const executionFragments: RawMigrationStageCapture["items"][number][] = [];
  const finalSimulations: RawMigrationStageCapture["items"][number][] = [];
  for (const instance of publication.instances) {
    for (const route of [...instance.routes].sort(
      (left, right) => left.routeKey.localeCompare(right.routeKey),
    )) {
      const quote = exactByRouteKey.get(route.routeKey);
      const edge = edgeByRouteKey.get(route.routeKey);
      if (quote === undefined || edge === undefined) {
        throw new Error(`psm execution route ${route.routeKey} has no quote`);
      }
      const amountIn = UNIV2_CAPTURE_EXACT_AMOUNT_IN;
      const fragment = psmExecution.buildFragment({
        descriptor: instance.descriptor as unknown as PsmDescriptor,
        route: route as unknown as PsmRoute,
        amountIn,
        quotedAmountOut: quote.amountOut,
        minAmountOut: quote.amountOut,
        exactEvidence: quote.evidence,
        executor: MIGRATION_CAPTURE_EXECUTOR,
        runtimeEvidence: Object.freeze([]),
      });
      executionFragments.push(Object.freeze({
        id: `${edge.id}\u001fexec:${amountIn}`,
        value: Object.freeze({
          routeKey: route.routeKey,
          tokenIn: route.tokenIn,
          tokenOut: route.tokenOut,
          canonicalEdgeId: edge.id,
          amountIn: amountIn.toString(),
          amountOut: quote.amountOut.toString(),
          minAmountOut: quote.amountOut.toString(),
          actionAdapterId: "psm",
          executionTarget: PSM_FIXTURE_TARGET,
          nodeFingerprint: hashCanonical(
            fragment.nodes as unknown as CanonicalValue,
          ),
        }),
      }));
      const effects = psmExecution.expectedEffects({
        descriptor: instance.descriptor as unknown as PsmDescriptor,
        route: route as unknown as PsmRoute,
        amountIn,
        quotedAmountOut: quote.amountOut,
      });
      if (quote.amountOut <= 0n) {
        throw new Error("psm capture final simulation repayment failed");
      }
      finalSimulations.push(Object.freeze({
        id: `${edge.id}\u001fsim:${amountIn}`,
        value: Object.freeze({
          routeKey: route.routeKey,
          tokenIn: route.tokenIn,
          tokenOut: route.tokenOut,
          canonicalEdgeId: edge.id,
          amountIn: amountIn.toString(),
          amountOut: quote.amountOut.toString(),
          minAmountOut: quote.amountOut.toString(),
          effectsFingerprint: hashCanonical(
            effects as unknown as CanonicalValue,
          ),
          conservation: "conserved",
          repayment: "satisfied",
          evInput: Object.freeze({
            amountIn: amountIn.toString(),
            amountOut: quote.amountOut.toString(),
          }),
        }),
      }));
    }
  }
  const instances = publication.instances;
  const summary = definedFamilyPluginContractSummary(family.plugin);
  return Object.freeze({
    familyId: PSM_FAMILY_ID,
    caseId: input.caseId ?? `psm:${input.source.number}`,
    inputFingerprint: input.source.hash.slice(2).padStart(64, "0"),
    stateAnchorNumber: input.source.number,
    implementationClosureHash: summary.definitionBoundaryHash,
    stages: Object.freeze({
      instances: instanceStage(instances, evidenceRefs),
      edges: exercisedStage(edges, evidenceRefs),
      stateCoverage: exercisedStage([], evidenceRefs),
      pricedEdges: exercisedStage([], evidenceRefs),
      prices: exercisedStage(prices, evidenceRefs),
      failures: exercisedStage([], evidenceRefs),
      enumeratedRoutes: exercisedStage(enumeratedRoutes, evidenceRefs),
      exactQuotes: exercisedStage(exactQuotes, evidenceRefs),
      executionFragments: exercisedStage(executionFragments, evidenceRefs),
      finalSimulations: exercisedStage(finalSimulations, evidenceRefs),
    }),
  });
}

export const WSTETH_FIXTURE_TARGET = `0x${"66".repeat(20)}`;
export const WSTETH_FIXTURE_STETH =
  "0xae7ab96520de3a18e5e111b5eaab095312d7fe84";
export const WSTETH_FIXTURE_WSTETH =
  "0x7f39c581f595b53c5cb19bd0b3f8da6c935e2ca0";

function wstethSuccessResult(
  request: AdapterRequest,
  canonical: CanonicalSource,
): AdapterRequestResult {
  let data: string;
  if (request.id === "identity-code") {
    data = "0x00";
  } else if (request.id === "identity-steth") {
    data = WSTETH_INTERFACE.encodeFunctionResult("stETH", [
      WSTETH_FIXTURE_STETH,
    ]);
  } else if (
    request.id === "identity-wrap" ||
    request.id === "current:wrap" ||
    request.id === "identity-unwrap" ||
    request.id === "current:unwrap"
  ) {
    const fn = request.id.endsWith("unwrap")
      ? "getStETHByWstETH"
      : "getWstETHByStETH";
    data = WSTETH_INTERFACE.encodeFunctionResult(fn, [10n ** 18n]);
  } else if (request.id === "exact-conversion") {
    const callRequestData = (request as { readonly data: string }).data;
    const isUnwrap = callRequestData.startsWith(
      WSTETH_INTERFACE.getFunction("getStETHByWstETH")!.selector,
    );
    const fn = isUnwrap
      ? "getStETHByWstETH"
      : "getWstETHByStETH";
    const amountIn = BigInt(
      WSTETH_INTERFACE.decodeFunctionData(fn, callRequestData)[0],
    );
    data = WSTETH_INTERFACE.encodeFunctionResult(fn, [amountIn]);
  } else {
    throw new Error(`unexpected wsteth fixture request ${request.id}`);
  }
  return Object.freeze({
    id: request.id,
    ok: true as const,
    source: canonical,
    provenance: Object.freeze({
      kind: "migration-capture-fixture",
      fingerprint: `fixture:${request.id}`,
    }),
    completion: "returned" as const,
    data,
  });
}

class WstethFixtureScheduler implements CentralAdapterScheduler {
  issueExecutor(
    input: Parameters<CentralAdapterScheduler["issueExecutor"]>[0],
  ): ReturnType<CentralAdapterScheduler["issueExecutor"]> {
    const executor = createBoundedRequestExecutor({
      assertSupported: (requirements) => assert.deepEqual(
        requirements,
        input.requirements,
      ),
      assertCallerBinding() {},
      assertWithinBudget: (_familyId, requests) => {
        assert.deepEqual(requests, input.requests);
      },
      execute: async (execution) => Promise.all(execution.requests.map(
        (request) => wstethSuccessResult(request, execution.source),
      )),
      sealStaticEvidenceReuseProof: () => ({ proofHash: "ab".repeat(32) }),
    });
    return Object.freeze({
      executor,
      timing: () => ({ queueWaitMs: 0, transportWallMs: 1, attempts: 1 }),
    });
  }
}

export function wstethFixtureRuntime(): CentralAdapterRuntime {
  let now = 1_000;
  return {
    clock: { nowMs: () => now++ },
    generationFence: new FixtureFence(),
    callerAuthority: { bind: () => ({}) },
    policy: {
      bind: (input) => ({
        lane: input.stage === "identity" ? "critical-proof" : "background",
        deadlineAtMs: 100_000,
        maxAttempts: 1,
        transportPool: "state-read",
        fairnessKey: input.subjectKey,
      }),
    },
    budgets: { assertAdmitted() {} },
    scheduler: new WstethFixtureScheduler(),
  };
}

export async function runWstethLifecycle(
  canonical: CanonicalSource,
  catalog: FamilyCapabilityCatalog =
    PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG,
): Promise<AdapterFamilyPublication> {
  const family = catalog.forFamily(WSTETH_FAMILY_ID);
  let publication: AdapterFamilyPublication | null = null;
  const wrapCalldata = WSTETH_INTERFACE.encodeFunctionData("wrap", [
    1_000_000n,
  ]);
  const result = await executeAdapterFamilyLifecycleBatch({
    family,
    matches: [Object.freeze({
      matchedPatternId: "wsteth-wrap-call",
      observation: Object.freeze({
        kind: "call" as const,
        source: canonical,
        target: WSTETH_FIXTURE_TARGET,
        data: wrapCalldata,
      }),
    })],
    source: canonical,
    generation: canonical.generation,
    runtime: wstethFixtureRuntime(),
    publisher: { publish: (value) => { publication = value; } },
  });
  if (result.publication === null) {
    console.error("DEBUG wsteth lifecycle:", JSON.stringify(result.outcomes,
      (_key, value) => typeof value === "bigint" ? value.toString() : value, 2));
  }
  assert(result.publication);
  assert(publication);
  return publication;
}

export async function captureWstethFixtureCase(input: {
  readonly source: CanonicalSource;
  readonly caseId?: string;
}): Promise<RawFamilyMigrationCaseCapture> {
  const publication = await runWstethLifecycle(input.source);
  const evidenceRefs = Object.freeze([
    `fixture:wsteth:${input.source.number}:${input.source.hash}`,
  ]);
  const family = PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG.forFamily(
    WSTETH_FAMILY_ID,
  );
  const edges: RawMigrationStageCapture["items"][number][] = [];
  const prices: RawMigrationStageCapture["items"][number][] = [];
  for (const instance of publication.instances) {
    for (const route of instance.routes) {
      const handle = instance.routeHandles.find((candidate) =>
        candidate.routeKey === route.routeKey
      );
      if (handle === undefined) {
        throw new Error(`prepared route ${route.routeKey} has no issued handle`);
      }
      const projected = projectFamilyRouteGraph({
        family,
        descriptor: instance.descriptor,
        route,
        handle,
      });
      edges.push(Object.freeze({
        id: projected.edge.canonicalEdgeId,
        value: Object.freeze({
          routeKey: route.routeKey,
          tokenIn: route.tokenIn,
          tokenOut: route.tokenOut,
          canonicalEdgeId: projected.edge.canonicalEdgeId,
        }),
      }));
    }
    const routeByKey = new Map(
      instance.routes.map((route) => [route.routeKey, route]),
    );
    for (const pricing of instance.pricingInstances) {
      for (const [routeKey, mid] of pricing.mids) {
        const route = routeByKey.get(routeKey);
        if (route === undefined) {
          throw new Error(`wsteth pricing route ${routeKey} is missing`);
        }
        prices.push(Object.freeze({
          id: `${pricing.stateKey}:${route.tokenIn.toLowerCase()}>` +
            `${route.tokenOut.toLowerCase()}`,
          value: Object.freeze({
            stateKey: pricing.stateKey,
            mid: Object.freeze({ ...mid }),
          }) as unknown as RawMigrationStageCapture["items"][number]["value"],
        }));
      }
    }
  }
  const enumeratedRoutes: RawMigrationStageCapture["items"][number][] = edges
    .map((edge) => edge.value as {
      readonly routeKey: string;
      readonly tokenIn: string;
      readonly tokenOut: string;
      readonly canonicalEdgeId: string;
    })
    .sort((left, right) => left.routeKey.localeCompare(right.routeKey))
    .map((value, order) => Object.freeze({
      id: value.canonicalEdgeId,
      value: Object.freeze({
        routeKey: value.routeKey,
        tokenIn: value.tokenIn,
        tokenOut: value.tokenOut,
        canonicalEdgeId: value.canonicalEdgeId,
        order,
      }),
    }));
  const exactMethod = wstethExact.methods().find(
    (method) => method.kind === "request-program" &&
      method.id === "wsteth-preview",
  );
  if (exactMethod === undefined || exactMethod.kind !== "request-program") {
    throw new Error("wsteth exact request program is missing");
  }
  const program = exactMethod.program;
  const exactByRouteKey = new Map<
    string,
    {
      readonly amountOut: bigint;
      readonly evidence: import("./venues/protocols/wsteth-family/types.js")
        .WstethExactEvidence;
    }
  >();
  const exactQuotes: RawMigrationStageCapture["items"][number][] = [];
  const edgeByRouteKey = new Map(
    edges.map((edge) => {
      const value = edge.value as { readonly routeKey: string };
      return [value.routeKey, edge] as const;
    }),
  );
  for (const instance of publication.instances) {
    for (const route of [...instance.routes].sort(
      (left, right) => left.routeKey.localeCompare(right.routeKey),
    )) {
      const exactInput = Object.freeze({
        descriptor: instance.descriptor as unknown as WstethDescriptor,
        route: route as unknown as WstethRoute,
        amountIn: UNIV2_CAPTURE_EXACT_AMOUNT_IN,
        source: input.source,
        executor: MIGRATION_CAPTURE_EXECUTOR,
        runtimeEvidence: Object.freeze([]),
      });
      const requests = program.buildRequests(exactInput);
      const results = requests.map((request) =>
        wstethSuccessResult(request, input.source)
      );
      const decoded = program.decode({
        programInput: exactInput,
        initialResults: results,
        dependentEvidence: Object.freeze([]),
      });
      const edge = edgeByRouteKey.get(route.routeKey);
      if (edge === undefined) {
        throw new Error(`wsteth exact route ${route.routeKey} has no edge`);
      }
      exactByRouteKey.set(route.routeKey, {
        amountOut: decoded.amountOut,
        evidence: decoded.evidence,
      });
      exactQuotes.push(Object.freeze({
        id: `${edge.id}\u001fexact:${UNIV2_CAPTURE_EXACT_AMOUNT_IN}`,
        value: Object.freeze({
          routeKey: route.routeKey,
          tokenIn: route.tokenIn,
          tokenOut: route.tokenOut,
          canonicalEdgeId: edge.id,
          amountIn: UNIV2_CAPTURE_EXACT_AMOUNT_IN.toString(),
          amountOut: decoded.amountOut.toString(),
          feeBps: "0",
        }),
      }));
    }
  }
  const executionFragments: RawMigrationStageCapture["items"][number][] = [];
  const finalSimulations: RawMigrationStageCapture["items"][number][] = [];
  for (const instance of publication.instances) {
    for (const route of [...instance.routes].sort(
      (left, right) => left.routeKey.localeCompare(right.routeKey),
    )) {
      const quote = exactByRouteKey.get(route.routeKey);
      const edge = edgeByRouteKey.get(route.routeKey);
      if (quote === undefined || edge === undefined) {
        throw new Error(`wsteth execution route ${route.routeKey} has no quote`);
      }
      const amountIn = UNIV2_CAPTURE_EXACT_AMOUNT_IN;
      const fragment = wstethExecution.buildFragment({
        descriptor: instance.descriptor as unknown as WstethDescriptor,
        route: route as unknown as WstethRoute,
        amountIn,
        quotedAmountOut: quote.amountOut,
        minAmountOut: quote.amountOut,
        exactEvidence: quote.evidence,
        executor: MIGRATION_CAPTURE_EXECUTOR,
        runtimeEvidence: Object.freeze([]),
      });
      executionFragments.push(Object.freeze({
        id: `${edge.id}\u001fexec:${amountIn}`,
        value: Object.freeze({
          routeKey: route.routeKey,
          tokenIn: route.tokenIn,
          tokenOut: route.tokenOut,
          canonicalEdgeId: edge.id,
          amountIn: amountIn.toString(),
          amountOut: quote.amountOut.toString(),
          minAmountOut: quote.amountOut.toString(),
          actionAdapterId: (route as unknown as WstethRoute).adapterId,
          executionTarget: WSTETH_FIXTURE_TARGET,
          nodeFingerprint: hashCanonical(
            fragment.nodes as unknown as CanonicalValue,
          ),
        }),
      }));
      const effects = wstethExecution.expectedEffects({
        descriptor: instance.descriptor as unknown as WstethDescriptor,
        route: route as unknown as WstethRoute,
        amountIn,
        quotedAmountOut: quote.amountOut,
      });
      if (quote.amountOut <= 0n) {
        throw new Error("wsteth capture final simulation repayment failed");
      }
      finalSimulations.push(Object.freeze({
        id: `${edge.id}\u001fsim:${amountIn}`,
        value: Object.freeze({
          routeKey: route.routeKey,
          tokenIn: route.tokenIn,
          tokenOut: route.tokenOut,
          canonicalEdgeId: edge.id,
          amountIn: amountIn.toString(),
          amountOut: quote.amountOut.toString(),
          minAmountOut: quote.amountOut.toString(),
          effectsFingerprint: hashCanonical(
            effects as unknown as CanonicalValue,
          ),
          conservation: "conserved",
          repayment: "satisfied",
          evInput: Object.freeze({
            amountIn: amountIn.toString(),
            amountOut: quote.amountOut.toString(),
          }),
        }),
      }));
    }
  }
  const instances = publication.instances;
  const summary = definedFamilyPluginContractSummary(family.plugin);
  return Object.freeze({
    familyId: WSTETH_FAMILY_ID,
    caseId: input.caseId ?? `wsteth:${input.source.number}`,
    inputFingerprint: input.source.hash.slice(2).padStart(64, "0"),
    stateAnchorNumber: input.source.number,
    implementationClosureHash: summary.definitionBoundaryHash,
    stages: Object.freeze({
      instances: instanceStage(instances, evidenceRefs),
      edges: exercisedStage(edges, evidenceRefs),
      stateCoverage: exercisedStage([], evidenceRefs),
      pricedEdges: exercisedStage([], evidenceRefs),
      prices: exercisedStage(prices, evidenceRefs),
      failures: exercisedStage([], evidenceRefs),
      enumeratedRoutes: exercisedStage(enumeratedRoutes, evidenceRefs),
      exactQuotes: exercisedStage(exactQuotes, evidenceRefs),
      executionFragments: exercisedStage(executionFragments, evidenceRefs),
      finalSimulations: exercisedStage(finalSimulations, evidenceRefs),
    }),
  });
}

export const GOLDX_FIXTURE_TARGET = `0x${"77".repeat(20)}`;
export const GOLDX_FIXTURE_COLLATERAL =
  "0x45804880de22913dafe09f4980848ece6ecbaf78";
export const GOLDX_FIXTURE_RECEIPT =
  "0x0000000000000000000000000000000000000001";
export const GOLDX_FIXTURE_UNIT = 10n ** 18n;

function goldxSuccessResult(
  request: AdapterRequest,
  canonical: CanonicalSource,
): AdapterRequestResult {
  const data = request.id === "identity-code"
    ? "0x00"
    : request.id === "identity-unit" || request.id === "current-unit" ||
        request.id === "exact-unit"
    ? GOLDX_INTERFACE.encodeFunctionResult("unit", [GOLDX_FIXTURE_UNIT])
    : (() => {
        throw new Error(`unexpected goldx fixture request ${request.id}`);
      })();
  return Object.freeze({
    id: request.id,
    ok: true as const,
    source: canonical,
    provenance: Object.freeze({
      kind: "migration-capture-fixture",
      fingerprint: `fixture:${request.id}`,
    }),
    completion: "returned" as const,
    data,
  });
}

class GoldxFixtureScheduler implements CentralAdapterScheduler {
  issueExecutor(
    input: Parameters<CentralAdapterScheduler["issueExecutor"]>[0],
  ): ReturnType<CentralAdapterScheduler["issueExecutor"]> {
    const executor = createBoundedRequestExecutor({
      assertSupported: (requirements) => assert.deepEqual(
        requirements,
        input.requirements,
      ),
      assertCallerBinding() {},
      assertWithinBudget: (_familyId, requests) => {
        assert.deepEqual(requests, input.requests);
      },
      execute: async (execution) => Promise.all(execution.requests.map(
        (request) => goldxSuccessResult(request, execution.source),
      )),
      sealStaticEvidenceReuseProof: () => ({ proofHash: "ab".repeat(32) }),
    });
    return Object.freeze({
      executor,
      timing: () => ({ queueWaitMs: 0, transportWallMs: 1, attempts: 1 }),
    });
  }
}

function goldxFixtureRuntime(): CentralAdapterRuntime {
  let now = 1_000;
  return {
    clock: { nowMs: () => now++ },
    generationFence: new FixtureFence(),
    callerAuthority: { bind: () => ({}) },
    policy: {
      bind: (input) => ({
        lane: input.stage === "identity" ? "critical-proof" : "background",
        deadlineAtMs: 100_000,
        maxAttempts: 1,
        transportPool: "state-read",
        fairnessKey: input.subjectKey,
      }),
    },
    budgets: { assertAdmitted() {} },
    scheduler: new GoldxFixtureScheduler(),
  };
}

async function runGoldxLifecycle(
  canonical: CanonicalSource,
): Promise<AdapterFamilyPublication> {
  const family = PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG.forFamily(
    GOLDX_FAMILY_ID,
  );
  let publication: AdapterFamilyPublication | null = null;
  const mintCalldata = GOLDX_INTERFACE.encodeFunctionData("mint", [
    MIGRATION_CAPTURE_EXECUTOR,
    1_000_000n,
  ]);
  const result = await executeAdapterFamilyLifecycleBatch({
    family,
    matches: [Object.freeze({
      matchedPatternId: "goldx-mint-call",
      observation: Object.freeze({
        kind: "call" as const,
        source: canonical,
        target: GOLDX_FIXTURE_TARGET,
        data: mintCalldata,
      }),
    })],
    source: canonical,
    generation: canonical.generation,
    runtime: goldxFixtureRuntime(),
    publisher: { publish: (value) => { publication = value; } },
  });
  assert(result.publication);
  assert(publication);
  return publication;
}

export async function captureGoldxFixtureCase(input: {
  readonly source: CanonicalSource;
  readonly caseId?: string;
}): Promise<RawFamilyMigrationCaseCapture> {
  const publication = await runGoldxLifecycle(input.source);
  const evidenceRefs = Object.freeze([
    `fixture:goldx:${input.source.number}:${input.source.hash}`,
  ]);
  const family = PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG.forFamily(
    GOLDX_FAMILY_ID,
  );
  const edges: RawMigrationStageCapture["items"][number][] = [];
  const prices: RawMigrationStageCapture["items"][number][] = [];
  for (const instance of publication.instances) {
    for (const route of instance.routes) {
      const handle = instance.routeHandles.find((candidate) =>
        candidate.routeKey === route.routeKey
      );
      if (handle === undefined) {
        throw new Error(`prepared route ${route.routeKey} has no issued handle`);
      }
      const projected = projectFamilyRouteGraph({
        family,
        descriptor: instance.descriptor,
        route,
        handle,
      });
      edges.push(Object.freeze({
        id: projected.edge.canonicalEdgeId,
        value: Object.freeze({
          routeKey: route.routeKey,
          tokenIn: route.tokenIn,
          tokenOut: route.tokenOut,
          canonicalEdgeId: projected.edge.canonicalEdgeId,
        }),
      }));
    }
    const routeByKey = new Map(
      instance.routes.map((route) => [route.routeKey, route]),
    );
    for (const pricing of instance.pricingInstances) {
      for (const [routeKey, mid] of pricing.mids) {
        const route = routeByKey.get(routeKey);
        if (route === undefined) {
          throw new Error(`goldx pricing route ${routeKey} is missing`);
        }
        prices.push(Object.freeze({
          id: `${pricing.stateKey}:${route.tokenIn.toLowerCase()}>` +
            `${route.tokenOut.toLowerCase()}`,
          value: Object.freeze({
            stateKey: pricing.stateKey,
            mid: Object.freeze({ ...mid }),
          }) as unknown as RawMigrationStageCapture["items"][number]["value"],
        }));
      }
    }
  }
  const enumeratedRoutes: RawMigrationStageCapture["items"][number][] = edges
    .map((edge) => edge.value as {
      readonly routeKey: string;
      readonly tokenIn: string;
      readonly tokenOut: string;
      readonly canonicalEdgeId: string;
    })
    .sort((left, right) => left.routeKey.localeCompare(right.routeKey))
    .map((value, order) => Object.freeze({
      id: value.canonicalEdgeId,
      value: Object.freeze({
        routeKey: value.routeKey,
        tokenIn: value.tokenIn,
        tokenOut: value.tokenOut,
        canonicalEdgeId: value.canonicalEdgeId,
        order,
      }),
    }));
  const exactMethod = goldxExact.methods().find(
    (method) => method.kind === "request-program" && method.id === "goldx-unit",
  );
  if (exactMethod === undefined || exactMethod.kind !== "request-program") {
    throw new Error("goldx exact request program is missing");
  }
  const program = exactMethod.program;
  const exactByRouteKey = new Map<
    string,
    {
      readonly amountOut: bigint;
      readonly evidence: import("./venues/protocols/goldx-family/types.js")
        .GoldxExactEvidence;
    }
  >();
  const exactQuotes: RawMigrationStageCapture["items"][number][] = [];
  const edgeByRouteKey = new Map(
    edges.map((edge) => {
      const value = edge.value as { readonly routeKey: string };
      return [value.routeKey, edge] as const;
    }),
  );
  for (const instance of publication.instances) {
    for (const route of [...instance.routes].sort(
      (left, right) => left.routeKey.localeCompare(right.routeKey),
    )) {
      const exactInput = Object.freeze({
        descriptor: instance.descriptor as unknown as GoldxDescriptor,
        route: route as unknown as GoldxRoute,
        amountIn: UNIV2_CAPTURE_EXACT_AMOUNT_IN,
        source: input.source,
        executor: MIGRATION_CAPTURE_EXECUTOR,
        runtimeEvidence: Object.freeze([]),
      });
      const requests = program.buildRequests(exactInput);
      const results = requests.map((request) =>
        goldxSuccessResult(request, input.source)
      );
      const decoded = program.decode({
        programInput: exactInput,
        initialResults: results,
        dependentEvidence: Object.freeze([]),
      });
      const edge = edgeByRouteKey.get(route.routeKey);
      if (edge === undefined) {
        throw new Error(`goldx exact route ${route.routeKey} has no edge`);
      }
      exactByRouteKey.set(route.routeKey, {
        amountOut: decoded.amountOut,
        evidence: decoded.evidence,
      });
      exactQuotes.push(Object.freeze({
        id: `${edge.id}\u001fexact:${UNIV2_CAPTURE_EXACT_AMOUNT_IN}`,
        value: Object.freeze({
          routeKey: route.routeKey,
          tokenIn: route.tokenIn,
          tokenOut: route.tokenOut,
          canonicalEdgeId: edge.id,
          amountIn: UNIV2_CAPTURE_EXACT_AMOUNT_IN.toString(),
          amountOut: decoded.amountOut.toString(),
          feeBps: "0",
        }),
      }));
    }
  }
  const executionFragments: RawMigrationStageCapture["items"][number][] = [];
  const finalSimulations: RawMigrationStageCapture["items"][number][] = [];
  for (const instance of publication.instances) {
    for (const route of [...instance.routes].sort(
      (left, right) => left.routeKey.localeCompare(right.routeKey),
    )) {
      const quote = exactByRouteKey.get(route.routeKey);
      const edge = edgeByRouteKey.get(route.routeKey);
      if (quote === undefined || edge === undefined) {
        throw new Error(`goldx execution route ${route.routeKey} has no quote`);
      }
      const amountIn = UNIV2_CAPTURE_EXACT_AMOUNT_IN;
      const fragment = goldxExecution.buildFragment({
        descriptor: instance.descriptor as unknown as GoldxDescriptor,
        route: route as unknown as GoldxRoute,
        amountIn,
        quotedAmountOut: quote.amountOut,
        minAmountOut: quote.amountOut,
        exactEvidence: quote.evidence,
        executor: MIGRATION_CAPTURE_EXECUTOR,
        runtimeEvidence: Object.freeze([]),
      });
      executionFragments.push(Object.freeze({
        id: `${edge.id}\u001fexec:${amountIn}`,
        value: Object.freeze({
          routeKey: route.routeKey,
          tokenIn: route.tokenIn,
          tokenOut: route.tokenOut,
          canonicalEdgeId: edge.id,
          amountIn: amountIn.toString(),
          amountOut: quote.amountOut.toString(),
          minAmountOut: quote.amountOut.toString(),
          actionAdapterId: "goldx-mint",
          executionTarget: GOLDX_FIXTURE_TARGET,
          nodeFingerprint: hashCanonical(
            fragment.nodes as unknown as CanonicalValue,
          ),
        }),
      }));
      const effects = goldxExecution.expectedEffects({
        descriptor: instance.descriptor as unknown as GoldxDescriptor,
        route: route as unknown as GoldxRoute,
        amountIn,
        quotedAmountOut: quote.amountOut,
      });
      if (quote.amountOut <= 0n) {
        throw new Error("goldx capture final simulation repayment failed");
      }
      finalSimulations.push(Object.freeze({
        id: `${edge.id}\u001fsim:${amountIn}`,
        value: Object.freeze({
          routeKey: route.routeKey,
          tokenIn: route.tokenIn,
          tokenOut: route.tokenOut,
          canonicalEdgeId: edge.id,
          amountIn: amountIn.toString(),
          amountOut: quote.amountOut.toString(),
          minAmountOut: quote.amountOut.toString(),
          effectsFingerprint: hashCanonical(
            effects as unknown as CanonicalValue,
          ),
          conservation: "conserved",
          repayment: "satisfied",
          evInput: Object.freeze({
            amountIn: amountIn.toString(),
            amountOut: quote.amountOut.toString(),
          }),
        }),
      }));
    }
  }
  const instances = publication.instances;
  const summary = definedFamilyPluginContractSummary(family.plugin);
  return Object.freeze({
    familyId: GOLDX_FAMILY_ID,
    caseId: input.caseId ?? `goldx:${input.source.number}`,
    inputFingerprint: input.source.hash.slice(2).padStart(64, "0"),
    stateAnchorNumber: input.source.number,
    implementationClosureHash: summary.definitionBoundaryHash,
    stages: Object.freeze({
      instances: instanceStage(instances, evidenceRefs),
      edges: exercisedStage(edges, evidenceRefs),
      stateCoverage: exercisedStage([], evidenceRefs),
      pricedEdges: exercisedStage([], evidenceRefs),
      prices: exercisedStage(prices, evidenceRefs),
      failures: exercisedStage([], evidenceRefs),
      enumeratedRoutes: exercisedStage(enumeratedRoutes, evidenceRefs),
      exactQuotes: exercisedStage(exactQuotes, evidenceRefs),
      executionFragments: exercisedStage(executionFragments, evidenceRefs),
      finalSimulations: exercisedStage(finalSimulations, evidenceRefs),
    }),
  });
}

export const ROCKSOLID_FIXTURE_TARGET = `0x${"88".repeat(20)}`;
export const ROCKSOLID_FIXTURE_ASSET =
  "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
export const ROCKSOLID_FIXTURE_RECEIPT =
  "0x0000000000000000000000000000000000000002";

function rocksolidSuccessResult(
  request: AdapterRequest,
  canonical: CanonicalSource,
): AdapterRequestResult {
  const data = request.id === "identity-code"
    ? "0x00"
    : request.id === "identity-convert" || request.id === "current-convert" ||
        request.id === "exact-convert"
    ? (() => {
        if (request.id === "exact-convert") {
          const callData = (request as { readonly data: string }).data;
          const amountIn = BigInt(
            ROCKSOLID_INTERFACE.decodeFunctionData(
              "convertToShares",
              callData,
            )[0],
          );
          return ROCKSOLID_INTERFACE.encodeFunctionResult(
            "convertToShares",
            [amountIn],
          );
        }
        return ROCKSOLID_INTERFACE.encodeFunctionResult(
          "convertToShares",
          [10n ** 18n],
        );
      })()
    : (() => {
        throw new Error(`unexpected rocksolid fixture request ${request.id}`);
      })();
  return Object.freeze({
    id: request.id,
    ok: true as const,
    source: canonical,
    provenance: Object.freeze({
      kind: "migration-capture-fixture",
      fingerprint: `fixture:${request.id}`,
    }),
    completion: "returned" as const,
    data,
  });
}

class RocksolidFixtureScheduler implements CentralAdapterScheduler {
  issueExecutor(
    input: Parameters<CentralAdapterScheduler["issueExecutor"]>[0],
  ): ReturnType<CentralAdapterScheduler["issueExecutor"]> {
    const executor = createBoundedRequestExecutor({
      assertSupported: (requirements) => assert.deepEqual(
        requirements,
        input.requirements,
      ),
      assertCallerBinding() {},
      assertWithinBudget: (_familyId, requests) => {
        assert.deepEqual(requests, input.requests);
      },
      execute: async (execution) => Promise.all(execution.requests.map(
        (request) => rocksolidSuccessResult(request, execution.source),
      )),
      sealStaticEvidenceReuseProof: () => ({ proofHash: "ab".repeat(32) }),
    });
    return Object.freeze({
      executor,
      timing: () => ({ queueWaitMs: 0, transportWallMs: 1, attempts: 1 }),
    });
  }
}

function rocksolidFixtureRuntime(): CentralAdapterRuntime {
  let now = 1_000;
  return {
    clock: { nowMs: () => now++ },
    generationFence: new FixtureFence(),
    callerAuthority: { bind: () => ({}) },
    policy: {
      bind: (input) => ({
        lane: input.stage === "identity" ? "critical-proof" : "background",
        deadlineAtMs: 100_000,
        maxAttempts: 1,
        transportPool: "state-read",
        fairnessKey: input.subjectKey,
      }),
    },
    budgets: { assertAdmitted() {} },
    scheduler: new RocksolidFixtureScheduler(),
  };
}

async function runRocksolidLifecycle(
  canonical: CanonicalSource,
): Promise<AdapterFamilyPublication> {
  const family = PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG.forFamily(
    ROCKSOLID_FAMILY_ID,
  );
  let publication: AdapterFamilyPublication | null = null;
  const depositCalldata = ROCKSOLID_INTERFACE.encodeFunctionData(
    "syncDeposit",
    [1_000_000n, MIGRATION_CAPTURE_EXECUTOR, "0x0000000000000000000000000000000000000000"],
  );
  const result = await executeAdapterFamilyLifecycleBatch({
    family,
    matches: [Object.freeze({
      matchedPatternId: "rocksolid-sync-deposit-call",
      observation: Object.freeze({
        kind: "call" as const,
        source: canonical,
        target: ROCKSOLID_FIXTURE_TARGET,
        data: depositCalldata,
      }),
    })],
    source: canonical,
    generation: canonical.generation,
    runtime: rocksolidFixtureRuntime(),
    publisher: { publish: (value) => { publication = value; } },
  });
  assert(result.publication);
  assert(publication);
  return publication;
}

export async function captureRocksolidFixtureCase(input: {
  readonly source: CanonicalSource;
  readonly caseId?: string;
}): Promise<RawFamilyMigrationCaseCapture> {
  const publication = await runRocksolidLifecycle(input.source);
  const evidenceRefs = Object.freeze([
    `fixture:rocksolid:${input.source.number}:${input.source.hash}`,
  ]);
  const family = PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG.forFamily(
    ROCKSOLID_FAMILY_ID,
  );
  const edges: RawMigrationStageCapture["items"][number][] = [];
  const prices: RawMigrationStageCapture["items"][number][] = [];
  for (const instance of publication.instances) {
    for (const route of instance.routes) {
      const handle = instance.routeHandles.find((candidate) =>
        candidate.routeKey === route.routeKey
      );
      if (handle === undefined) {
        throw new Error(`prepared route ${route.routeKey} has no issued handle`);
      }
      const projected = projectFamilyRouteGraph({
        family,
        descriptor: instance.descriptor,
        route,
        handle,
      });
      edges.push(Object.freeze({
        id: projected.edge.canonicalEdgeId,
        value: Object.freeze({
          routeKey: route.routeKey,
          tokenIn: route.tokenIn,
          tokenOut: route.tokenOut,
          canonicalEdgeId: projected.edge.canonicalEdgeId,
        }),
      }));
    }
    const routeByKey = new Map(
      instance.routes.map((route) => [route.routeKey, route]),
    );
    for (const pricing of instance.pricingInstances) {
      for (const [routeKey, mid] of pricing.mids) {
        const route = routeByKey.get(routeKey);
        if (route === undefined) {
          throw new Error(`rocksolid pricing route ${routeKey} is missing`);
        }
        prices.push(Object.freeze({
          id: `${pricing.stateKey}:${route.tokenIn.toLowerCase()}>` +
            `${route.tokenOut.toLowerCase()}`,
          value: Object.freeze({
            stateKey: pricing.stateKey,
            mid: Object.freeze({ ...mid }),
          }) as unknown as RawMigrationStageCapture["items"][number]["value"],
        }));
      }
    }
  }
  const enumeratedRoutes: RawMigrationStageCapture["items"][number][] = edges
    .map((edge) => edge.value as {
      readonly routeKey: string;
      readonly tokenIn: string;
      readonly tokenOut: string;
      readonly canonicalEdgeId: string;
    })
    .sort((left, right) => left.routeKey.localeCompare(right.routeKey))
    .map((value, order) => Object.freeze({
      id: value.canonicalEdgeId,
      value: Object.freeze({
        routeKey: value.routeKey,
        tokenIn: value.tokenIn,
        tokenOut: value.tokenOut,
        canonicalEdgeId: value.canonicalEdgeId,
        order,
      }),
    }));
  const exactMethod = rocksolidExact.methods().find(
    (method) => method.kind === "request-program" &&
      method.id === "rocksolid-quote",
  );
  if (exactMethod === undefined || exactMethod.kind !== "request-program") {
    throw new Error("rocksolid exact request program is missing");
  }
  const program = exactMethod.program;
  const exactByRouteKey = new Map<
    string,
    {
      readonly amountOut: bigint;
      readonly evidence: import("./venues/protocols/rocksolid-family/types.js")
        .RocksolidExactEvidence;
    }
  >();
  const exactQuotes: RawMigrationStageCapture["items"][number][] = [];
  const edgeByRouteKey = new Map(
    edges.map((edge) => {
      const value = edge.value as { readonly routeKey: string };
      return [value.routeKey, edge] as const;
    }),
  );
  for (const instance of publication.instances) {
    for (const route of [...instance.routes].sort(
      (left, right) => left.routeKey.localeCompare(right.routeKey),
    )) {
      const exactInput = Object.freeze({
        descriptor: instance.descriptor as unknown as RocksolidDescriptor,
        route: route as unknown as RocksolidRoute,
        amountIn: UNIV2_CAPTURE_EXACT_AMOUNT_IN,
        source: input.source,
        executor: MIGRATION_CAPTURE_EXECUTOR,
        runtimeEvidence: Object.freeze([]),
      });
      const requests = program.buildRequests(exactInput);
      const results = requests.map((request) =>
        rocksolidSuccessResult(request, input.source)
      );
      const decoded = program.decode({
        programInput: exactInput,
        initialResults: results,
        dependentEvidence: Object.freeze([]),
      });
      const edge = edgeByRouteKey.get(route.routeKey);
      if (edge === undefined) {
        throw new Error(`rocksolid exact route ${route.routeKey} has no edge`);
      }
      exactByRouteKey.set(route.routeKey, {
        amountOut: decoded.amountOut,
        evidence: decoded.evidence,
      });
      exactQuotes.push(Object.freeze({
        id: `${edge.id}\u001fexact:${UNIV2_CAPTURE_EXACT_AMOUNT_IN}`,
        value: Object.freeze({
          routeKey: route.routeKey,
          tokenIn: route.tokenIn,
          tokenOut: route.tokenOut,
          canonicalEdgeId: edge.id,
          amountIn: UNIV2_CAPTURE_EXACT_AMOUNT_IN.toString(),
          amountOut: decoded.amountOut.toString(),
          feeBps: "0",
        }),
      }));
    }
  }
  const executionFragments: RawMigrationStageCapture["items"][number][] = [];
  const finalSimulations: RawMigrationStageCapture["items"][number][] = [];
  for (const instance of publication.instances) {
    for (const route of [...instance.routes].sort(
      (left, right) => left.routeKey.localeCompare(right.routeKey),
    )) {
      const quote = exactByRouteKey.get(route.routeKey);
      const edge = edgeByRouteKey.get(route.routeKey);
      if (quote === undefined || edge === undefined) {
        throw new Error(
          `rocksolid execution route ${route.routeKey} has no quote`,
        );
      }
      const amountIn = UNIV2_CAPTURE_EXACT_AMOUNT_IN;
      const fragment = rocksolidExecution.buildFragment({
        descriptor: instance.descriptor as unknown as RocksolidDescriptor,
        route: route as unknown as RocksolidRoute,
        amountIn,
        quotedAmountOut: quote.amountOut,
        minAmountOut: quote.amountOut,
        exactEvidence: quote.evidence,
        executor: MIGRATION_CAPTURE_EXECUTOR,
        runtimeEvidence: Object.freeze([]),
      });
      executionFragments.push(Object.freeze({
        id: `${edge.id}\u001fexec:${amountIn}`,
        value: Object.freeze({
          routeKey: route.routeKey,
          tokenIn: route.tokenIn,
          tokenOut: route.tokenOut,
          canonicalEdgeId: edge.id,
          amountIn: amountIn.toString(),
          amountOut: quote.amountOut.toString(),
          minAmountOut: quote.amountOut.toString(),
          actionAdapterId: "rocksolid-sync-deposit",
          executionTarget: ROCKSOLID_FIXTURE_TARGET,
          nodeFingerprint: hashCanonical(
            fragment.nodes as unknown as CanonicalValue,
          ),
        }),
      }));
      const effects = rocksolidExecution.expectedEffects({
        descriptor: instance.descriptor as unknown as RocksolidDescriptor,
        route: route as unknown as RocksolidRoute,
        amountIn,
        quotedAmountOut: quote.amountOut,
      });
      if (quote.amountOut <= 0n) {
        throw new Error("rocksolid capture final simulation repayment failed");
      }
      finalSimulations.push(Object.freeze({
        id: `${edge.id}\u001fsim:${amountIn}`,
        value: Object.freeze({
          routeKey: route.routeKey,
          tokenIn: route.tokenIn,
          tokenOut: route.tokenOut,
          canonicalEdgeId: edge.id,
          amountIn: amountIn.toString(),
          amountOut: quote.amountOut.toString(),
          minAmountOut: quote.amountOut.toString(),
          effectsFingerprint: hashCanonical(
            effects as unknown as CanonicalValue,
          ),
          conservation: "conserved",
          repayment: "satisfied",
          evInput: Object.freeze({
            amountIn: amountIn.toString(),
            amountOut: quote.amountOut.toString(),
          }),
        }),
      }));
    }
  }
  const instances = publication.instances;
  const summary = definedFamilyPluginContractSummary(family.plugin);
  return Object.freeze({
    familyId: ROCKSOLID_FAMILY_ID,
    caseId: input.caseId ?? `rocksolid:${input.source.number}`,
    inputFingerprint: input.source.hash.slice(2).padStart(64, "0"),
    stateAnchorNumber: input.source.number,
    implementationClosureHash: summary.definitionBoundaryHash,
    stages: Object.freeze({
      instances: instanceStage(instances, evidenceRefs),
      edges: exercisedStage(edges, evidenceRefs),
      stateCoverage: exercisedStage([], evidenceRefs),
      pricedEdges: exercisedStage([], evidenceRefs),
      prices: exercisedStage(prices, evidenceRefs),
      failures: exercisedStage([], evidenceRefs),
      enumeratedRoutes: exercisedStage(enumeratedRoutes, evidenceRefs),
      exactQuotes: exercisedStage(exactQuotes, evidenceRefs),
      executionFragments: exercisedStage(executionFragments, evidenceRefs),
      finalSimulations: exercisedStage(finalSimulations, evidenceRefs),
    }),
  });
}

export const METRONOME_HGUSDC_FIXTURE_TARGET = `0x${"99".repeat(20)}`;

function metronomeHgUsdcSuccessResult(
  request: AdapterRequest,
  canonical: CanonicalSource,
): AdapterRequestResult {
  const data =
    request.id.endsWith("-code")
      ? "0x00"
      : request.id === "identity-curve-coin-0"
        ? METRONOME_HGUSDC_CURVE_INTERFACE.encodeFunctionResult("coins", [
            METRONOME_HGUSDC_BINDINGS.curveIntermediate,
          ])
        : request.id === "identity-curve-coin-1"
          ? METRONOME_HGUSDC_CURVE_INTERFACE.encodeFunctionResult("coins", [
              METRONOME_HGUSDC_BINDINGS.tokenIn,
            ])
          : request.id === "identity-vault-asset"
            ? METRONOME_HGUSDC_VAULT_INTERFACE.encodeFunctionResult("asset", [
                METRONOME_HGUSDC_BINDINGS.tokenOut,
              ])
            : request.id === "identity-token-in-decimals" ||
                request.id === "static-token-in-decimals"
              ? METRONOME_HGUSDC_ERC20_INTERFACE.encodeFunctionResult(
                  "decimals",
                  [6],
                )
              : request.id.endsWith("curve-quote")
                ? (() => {
                    const dx = BigInt(
                      METRONOME_HGUSDC_CURVE_INTERFACE.decodeFunctionData(
                        "get_dy",
                        (request as { readonly data: string }).data,
                      )[2],
                    );
                    return METRONOME_HGUSDC_CURVE_INTERFACE
                      .encodeFunctionResult("get_dy", [dx]);
                  })()
                : request.id.endsWith("vault-preview")
                  ? (() => {
                      const shares = BigInt(
                        METRONOME_HGUSDC_VAULT_INTERFACE.decodeFunctionData(
                          "previewRedeem",
                          (request as { readonly data: string }).data,
                        )[0],
                      );
                      return METRONOME_HGUSDC_VAULT_INTERFACE
                        .encodeFunctionResult("previewRedeem", [shares]);
                    })()
                  : (() => {
                      throw new Error(
                        "unexpected metronome-hgusdc fixture request " +
                          request.id,
                      );
                    })();
  return Object.freeze({
    id: request.id,
    ok: true as const,
    source: canonical,
    provenance: Object.freeze({
      kind: "migration-capture-fixture",
      fingerprint: `fixture:${request.id}`,
    }),
    completion: "returned" as const,
    data,
  });
}

class MetronomeHgUsdcFixtureScheduler implements CentralAdapterScheduler {
  issueExecutor(
    input: Parameters<CentralAdapterScheduler["issueExecutor"]>[0],
  ): ReturnType<CentralAdapterScheduler["issueExecutor"]> {
    const executor = createBoundedRequestExecutor({
      assertSupported: (requirements) => assert.deepEqual(
        requirements,
        input.requirements,
      ),
      assertCallerBinding() {},
      assertWithinBudget: (_familyId, requests) => {
        assert.deepEqual(requests, input.requests);
      },
      execute: async (execution) => Promise.all(execution.requests.map(
        (request) => metronomeHgUsdcSuccessResult(request, execution.source),
      )),
      sealStaticEvidenceReuseProof: () => ({ proofHash: "ab".repeat(32) }),
    });
    return Object.freeze({
      executor,
      timing: () => ({ queueWaitMs: 0, transportWallMs: 1, attempts: 1 }),
    });
  }
}

function metronomeHgUsdcFixtureRuntime(): CentralAdapterRuntime {
  let now = 1_000;
  return {
    clock: { nowMs: () => now++ },
    generationFence: new FixtureFence(),
    callerAuthority: { bind: () => ({}) },
    policy: {
      bind: (input) => ({
        lane: input.stage === "identity" ? "critical-proof" : "background",
        deadlineAtMs: 100_000,
        maxAttempts: 1,
        transportPool: "state-read",
        fairnessKey: input.subjectKey,
      }),
    },
    budgets: { assertAdmitted() {} },
    scheduler: new MetronomeHgUsdcFixtureScheduler(),
  };
}

async function runMetronomeHgUsdcLifecycle(
  canonical: CanonicalSource,
): Promise<AdapterFamilyPublication> {
  const family = PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG.forFamily(
    METRONOME_HGUSDC_FAMILY_ID,
  );
  let publication: AdapterFamilyPublication | null = null;
  const executePathCalldata = METRONOME_HGUSDC_ROUTER_INTERFACE
    .encodeFunctionData(
      "executePath",
      [METRONOME_HGUSDC_PATH, [1_000_000n], MIGRATION_CAPTURE_EXECUTOR],
    );
  const result = await executeAdapterFamilyLifecycleBatch({
    family,
    matches: [Object.freeze({
      matchedPatternId: "metronome-hgusdc-execute-path",
      observation: Object.freeze({
        kind: "call" as const,
        source: canonical,
        target: METRONOME_HGUSDC_FIXTURE_TARGET,
        data: executePathCalldata,
      }),
    })],
    source: canonical,
    generation: canonical.generation,
    runtime: metronomeHgUsdcFixtureRuntime(),
    publisher: { publish: (value) => { publication = value; } },
  });
  assert(result.publication);
  assert(publication);
  return publication;
}

/**
 * Runs the metronome-hgusdc router lifecycle over the observed
 * executePath fixture (msUSD -> frxUSD -> hgUSDC) and emits the canonical
 * migration capture row. The dependent exact program is driven through both
 * rounds: curve get_dy then vault previewRedeem.
 */
export async function captureMetronomeHgUsdcFixtureCase(input: {
  readonly source: CanonicalSource;
  readonly caseId?: string;
}): Promise<RawFamilyMigrationCaseCapture> {
  const publication = await runMetronomeHgUsdcLifecycle(input.source);
  const evidenceRefs = Object.freeze([
    `fixture:metronome-hgusdc:${input.source.number}:${input.source.hash}`,
  ]);
  const family = PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG.forFamily(
    METRONOME_HGUSDC_FAMILY_ID,
  );
  const edges: RawMigrationStageCapture["items"][number][] = [];
  const prices: RawMigrationStageCapture["items"][number][] = [];
  for (const instance of publication.instances) {
    for (const route of instance.routes) {
      const handle = instance.routeHandles.find((candidate) =>
        candidate.routeKey === route.routeKey
      );
      if (handle === undefined) {
        throw new Error(
          `prepared route ${route.routeKey} has no issued handle`,
        );
      }
      const projected = projectFamilyRouteGraph({
        family,
        descriptor: instance.descriptor,
        route,
        handle,
      });
      edges.push(Object.freeze({
        id: projected.edge.canonicalEdgeId,
        value: Object.freeze({
          routeKey: route.routeKey,
          tokenIn: route.tokenIn,
          tokenOut: route.tokenOut,
          canonicalEdgeId: projected.edge.canonicalEdgeId,
        }),
      }));
    }
    const routeByKey = new Map(
      instance.routes.map((route) => [route.routeKey, route]),
    );
    for (const pricing of instance.pricingInstances) {
      for (const [routeKey, mid] of pricing.mids) {
        const route = routeByKey.get(routeKey);
        if (route === undefined) {
          throw new Error(
            `metronome-hgusdc pricing route ${routeKey} is missing`,
          );
        }
        prices.push(Object.freeze({
          id: `${pricing.stateKey}:${route.tokenIn.toLowerCase()}>` +
            `${route.tokenOut.toLowerCase()}`,
          value: Object.freeze({
            stateKey: pricing.stateKey,
            mid: Object.freeze({ ...mid }),
          }) as unknown as RawMigrationStageCapture["items"][number]["value"],
        }));
      }
    }
  }
  const enumeratedRoutes: RawMigrationStageCapture["items"][number][] = edges
    .map((edge) => edge.value as {
      readonly routeKey: string;
      readonly tokenIn: string;
      readonly tokenOut: string;
      readonly canonicalEdgeId: string;
    })
    .sort((left, right) => left.routeKey.localeCompare(right.routeKey))
    .map((value, order) => Object.freeze({
      id: value.canonicalEdgeId,
      value: Object.freeze({
        routeKey: value.routeKey,
        tokenIn: value.tokenIn,
        tokenOut: value.tokenOut,
        canonicalEdgeId: value.canonicalEdgeId,
        order,
      }),
    }));
  const exactMethod = metronomeHgUsdcExact.methods().find(
    (method) => method.kind === "request-program" &&
      method.id === "curve-then-vault",
  );
  if (exactMethod === undefined || exactMethod.kind !== "request-program") {
    throw new Error("metronome-hgusdc exact request program is missing");
  }
  const program = exactMethod.program;
  const exactByRouteKey = new Map<
    string,
    {
      readonly amountOut: bigint;
      readonly evidence: import("./venues/protocols/metronome-hgusdc-family/types.js")
        .MetronomeHgUsdcExactEvidence;
    }
  >();
  const exactQuotes: RawMigrationStageCapture["items"][number][] = [];
  const edgeByRouteKey = new Map(
    edges.map((edge) => {
      const value = edge.value as { readonly routeKey: string };
      return [value.routeKey, edge] as const;
    }),
  );
  for (const instance of publication.instances) {
    for (const route of [...instance.routes].sort(
      (left, right) => left.routeKey.localeCompare(right.routeKey),
    )) {
      const exactInput = Object.freeze({
        descriptor: instance.descriptor as unknown as MetronomeHgUsdcDescriptor,
        route: route as unknown as MetronomeHgUsdcRoute,
        amountIn: UNIV2_CAPTURE_EXACT_AMOUNT_IN,
        source: input.source,
        executor: MIGRATION_CAPTURE_EXECUTOR,
        runtimeEvidence: Object.freeze([]),
      });
      const initialRequests = program.buildRequests(exactInput);
      const initialResults = initialRequests.map((request) =>
        metronomeHgUsdcSuccessResult(request, input.source)
      );
      const dependentProgram = program.buildDependentProgram?.({
        programInput: exactInput,
        completedRound: 0,
        initialResults,
        priorEvidence: Object.freeze([]),
      });
      if (dependentProgram === null || dependentProgram === undefined) {
        throw new Error(
          `metronome-hgusdc exact route ${route.routeKey} has no dependent round`,
        );
      }
      const dependentResults = dependentProgram.requests.map((request) =>
        metronomeHgUsdcSuccessResult(request, input.source)
      );
      const decoded = program.decode({
        programInput: exactInput,
        initialResults,
        dependentEvidence: Object.freeze([
          dependentProgram.decode(dependentResults),
        ]),
      });
      const edge = edgeByRouteKey.get(route.routeKey);
      if (edge === undefined) {
        throw new Error(
          `metronome-hgusdc exact route ${route.routeKey} has no edge`,
        );
      }
      exactByRouteKey.set(route.routeKey, {
        amountOut: decoded.amountOut,
        evidence: decoded.evidence,
      });
      exactQuotes.push(Object.freeze({
        id: `${edge.id}\u001fexact:${UNIV2_CAPTURE_EXACT_AMOUNT_IN}`,
        value: Object.freeze({
          routeKey: route.routeKey,
          tokenIn: route.tokenIn,
          tokenOut: route.tokenOut,
          canonicalEdgeId: edge.id,
          amountIn: UNIV2_CAPTURE_EXACT_AMOUNT_IN.toString(),
          amountOut: decoded.amountOut.toString(),
          feeBps: "0",
        }),
      }));
    }
  }
  const executionFragments: RawMigrationStageCapture["items"][number][] = [];
  const finalSimulations: RawMigrationStageCapture["items"][number][] = [];
  for (const instance of publication.instances) {
    for (const route of [...instance.routes].sort(
      (left, right) => left.routeKey.localeCompare(right.routeKey),
    )) {
      const quote = exactByRouteKey.get(route.routeKey);
      const edge = edgeByRouteKey.get(route.routeKey);
      if (quote === undefined || edge === undefined) {
        throw new Error(
          `metronome-hgusdc execution route ${route.routeKey} has no quote`,
        );
      }
      const amountIn = UNIV2_CAPTURE_EXACT_AMOUNT_IN;
      const fragment = metronomeHgUsdcExecution.buildFragment({
        descriptor: instance.descriptor as unknown as MetronomeHgUsdcDescriptor,
        route: route as unknown as MetronomeHgUsdcRoute,
        amountIn,
        quotedAmountOut: quote.amountOut,
        minAmountOut: quote.amountOut,
        exactEvidence: quote.evidence,
        executor: MIGRATION_CAPTURE_EXECUTOR,
        runtimeEvidence: Object.freeze([]),
      });
      executionFragments.push(Object.freeze({
        id: `${edge.id}\u001fexec:${amountIn}`,
        value: Object.freeze({
          routeKey: route.routeKey,
          tokenIn: route.tokenIn,
          tokenOut: route.tokenOut,
          canonicalEdgeId: edge.id,
          amountIn: amountIn.toString(),
          amountOut: quote.amountOut.toString(),
          minAmountOut: quote.amountOut.toString(),
          actionAdapterId: "metronome-hgusdc-exit",
          executionTarget: METRONOME_HGUSDC_FIXTURE_TARGET,
          nodeFingerprint: hashCanonical(
            fragment.nodes as unknown as CanonicalValue,
          ),
        }),
      }));
      const effects = metronomeHgUsdcExecution.expectedEffects({
        descriptor: instance.descriptor as unknown as MetronomeHgUsdcDescriptor,
        route: route as unknown as MetronomeHgUsdcRoute,
        amountIn,
        quotedAmountOut: quote.amountOut,
      });
      if (quote.amountOut <= 0n) {
        throw new Error(
          "metronome-hgusdc capture final simulation repayment failed",
        );
      }
      finalSimulations.push(Object.freeze({
        id: `${edge.id}\u001fsim:${amountIn}`,
        value: Object.freeze({
          routeKey: route.routeKey,
          tokenIn: route.tokenIn,
          tokenOut: route.tokenOut,
          canonicalEdgeId: edge.id,
          amountIn: amountIn.toString(),
          amountOut: quote.amountOut.toString(),
          minAmountOut: quote.amountOut.toString(),
          effectsFingerprint: hashCanonical(
            effects as unknown as CanonicalValue,
          ),
          conservation: "conserved",
          repayment: "satisfied",
          evInput: Object.freeze({
            amountIn: amountIn.toString(),
            amountOut: quote.amountOut.toString(),
          }),
        }),
      }));
    }
  }
  const instances = publication.instances;
  const summary = definedFamilyPluginContractSummary(family.plugin);
  return Object.freeze({
    familyId: METRONOME_HGUSDC_FAMILY_ID,
    caseId: input.caseId ?? `metronome-hgusdc:${input.source.number}`,
    inputFingerprint: input.source.hash.slice(2).padStart(64, "0"),
    stateAnchorNumber: input.source.number,
    implementationClosureHash: summary.definitionBoundaryHash,
    stages: Object.freeze({
      instances: instanceStage(instances, evidenceRefs),
      edges: exercisedStage(edges, evidenceRefs),
      stateCoverage: exercisedStage([], evidenceRefs),
      pricedEdges: exercisedStage([], evidenceRefs),
      prices: exercisedStage(prices, evidenceRefs),
      failures: exercisedStage([], evidenceRefs),
      enumeratedRoutes: exercisedStage(enumeratedRoutes, evidenceRefs),
      exactQuotes: exercisedStage(exactQuotes, evidenceRefs),
      executionFragments: exercisedStage(executionFragments, evidenceRefs),
      finalSimulations: exercisedStage(finalSimulations, evidenceRefs),
    }),
  });
}

export const METRONOME_SYNTH_FIXTURE_POOL = `0x${"aa".repeat(20)}`;

function metronomeSynthSuccessResult(
  request: AdapterRequest,
  canonical: CanonicalSource,
): AdapterRequestResult {
  const data =
    request.kind === "get-code"
      ? "0x00"
      : request.id.startsWith("identity-member:")
        ? METRONOME_SYNTH_POOL_INTERFACE.encodeFunctionResult(
            "doesSyntheticTokenExist",
            [true],
          )
        : request.id.startsWith("static-decimals:")
          ? METRONOME_SYNTH_ERC20_INTERFACE.encodeFunctionResult(
              "decimals",
              [18],
            )
          : request.id === "exact-quote-swap-out" ||
              request.id.startsWith("identity-quote:") ||
              request.id.startsWith("current:")
            ? (() => {
                const amountIn = BigInt(
                  METRONOME_SYNTH_POOL_INTERFACE.decodeFunctionData(
                    "quoteSwapOut",
                    (request as { readonly data: string }).data,
                  )[2],
                );
                return METRONOME_SYNTH_POOL_INTERFACE.encodeFunctionResult(
                  "quoteSwapOut",
                  [amountIn, 0n],
                );
              })()
            : (() => {
                throw new Error(
                  "unexpected metronome-synth fixture request " + request.id,
                );
              })();
  return Object.freeze({
    id: request.id,
    ok: true as const,
    source: canonical,
    provenance: Object.freeze({
      kind: "migration-capture-fixture",
      fingerprint: `fixture:${request.id}`,
    }),
    completion: "returned" as const,
    data,
  });
}

class MetronomeSynthFixtureScheduler implements CentralAdapterScheduler {
  issueExecutor(
    input: Parameters<CentralAdapterScheduler["issueExecutor"]>[0],
  ): ReturnType<CentralAdapterScheduler["issueExecutor"]> {
    const executor = createBoundedRequestExecutor({
      assertSupported: (requirements) => assert.deepEqual(
        requirements,
        input.requirements,
      ),
      assertCallerBinding() {},
      assertWithinBudget: (_familyId, requests) => {
        assert.deepEqual(requests, input.requests);
      },
      execute: async (execution) => Promise.all(execution.requests.map(
        (request) => metronomeSynthSuccessResult(request, execution.source),
      )),
      sealStaticEvidenceReuseProof: () => ({ proofHash: "ab".repeat(32) }),
    });
    return Object.freeze({
      executor,
      timing: () => ({ queueWaitMs: 0, transportWallMs: 1, attempts: 1 }),
    });
  }
}

function metronomeSynthFixtureRuntime(): CentralAdapterRuntime {
  let now = 1_000;
  return {
    clock: { nowMs: () => now++ },
    generationFence: new FixtureFence(),
    callerAuthority: { bind: () => ({}) },
    policy: {
      bind: (input) => ({
        lane: input.stage === "identity" ? "critical-proof" : "background",
        deadlineAtMs: 100_000,
        maxAttempts: 1,
        transportPool: "state-read",
        fairnessKey: input.subjectKey,
      }),
    },
    budgets: { assertAdmitted() {} },
    scheduler: new MetronomeSynthFixtureScheduler(),
  };
}

async function runMetronomeSynthLifecycle(
  canonical: CanonicalSource,
): Promise<AdapterFamilyPublication> {
  const family = PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG.forFamily(
    METRONOME_SYNTH_FAMILY_ID,
  );
  let publication: AdapterFamilyPublication | null = null;
  const swapCalldata = METRONOME_SYNTH_POOL_INTERFACE.encodeFunctionData(
    "swap",
    [
      METRONOME_SYNTH_SUPPORTED_TOKENS[0],
      METRONOME_SYNTH_SUPPORTED_TOKENS[1],
      1_000_000n,
    ],
  );
  const result = await executeAdapterFamilyLifecycleBatch({
    family,
    matches: [Object.freeze({
      matchedPatternId: "metronome-synth-swap-call",
      observation: Object.freeze({
        kind: "call" as const,
        source: canonical,
        target: METRONOME_SYNTH_FIXTURE_POOL,
        data: swapCalldata,
      }),
    })],
    source: canonical,
    generation: canonical.generation,
    runtime: metronomeSynthFixtureRuntime(),
    publisher: { publish: (value) => { publication = value; } },
  });
  assert(result.publication);
  assert(publication);
  return publication;
}

/**
 * Runs the metronome-synth pool lifecycle over the observed swap fixture.
 * Membership proves all three supported synthetics, then every directed
 * pair gets an active 1:1 quote. All six routes are exercised through
 * pricing, exact, execution and final simulation.
 */
export async function captureMetronomeSynthFixtureCase(input: {
  readonly source: CanonicalSource;
  readonly caseId?: string;
}): Promise<RawFamilyMigrationCaseCapture> {
  const publication = await runMetronomeSynthLifecycle(input.source);
  const evidenceRefs = Object.freeze([
    `fixture:metronome-synth:${input.source.number}:${input.source.hash}`,
  ]);
  const family = PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG.forFamily(
    METRONOME_SYNTH_FAMILY_ID,
  );
  const edges: RawMigrationStageCapture["items"][number][] = [];
  const prices: RawMigrationStageCapture["items"][number][] = [];
  for (const instance of publication.instances) {
    for (const route of instance.routes) {
      const handle = instance.routeHandles.find((candidate) =>
        candidate.routeKey === route.routeKey
      );
      if (handle === undefined) {
        throw new Error(
          `prepared route ${route.routeKey} has no issued handle`,
        );
      }
      const projected = projectFamilyRouteGraph({
        family,
        descriptor: instance.descriptor,
        route,
        handle,
      });
      edges.push(Object.freeze({
        id: projected.edge.canonicalEdgeId,
        value: Object.freeze({
          routeKey: route.routeKey,
          tokenIn: route.tokenIn,
          tokenOut: route.tokenOut,
          canonicalEdgeId: projected.edge.canonicalEdgeId,
        }),
      }));
    }
    const routeByKey = new Map(
      instance.routes.map((route) => [route.routeKey, route]),
    );
    for (const pricing of instance.pricingInstances) {
      for (const [routeKey, mid] of pricing.mids) {
        const route = routeByKey.get(routeKey);
        if (route === undefined) {
          throw new Error(
            `metronome-synth pricing route ${routeKey} is missing`,
          );
        }
        prices.push(Object.freeze({
          id: `${pricing.stateKey}:${route.tokenIn.toLowerCase()}>` +
            `${route.tokenOut.toLowerCase()}`,
          value: Object.freeze({
            stateKey: pricing.stateKey,
            mid: Object.freeze({ ...mid }),
          }) as unknown as RawMigrationStageCapture["items"][number]["value"],
        }));
      }
    }
  }
  const enumeratedRoutes: RawMigrationStageCapture["items"][number][] = edges
    .map((edge) => edge.value as {
      readonly routeKey: string;
      readonly tokenIn: string;
      readonly tokenOut: string;
      readonly canonicalEdgeId: string;
    })
    .sort((left, right) => left.routeKey.localeCompare(right.routeKey))
    .map((value, order) => Object.freeze({
      id: value.canonicalEdgeId,
      value: Object.freeze({
        routeKey: value.routeKey,
        tokenIn: value.tokenIn,
        tokenOut: value.tokenOut,
        canonicalEdgeId: value.canonicalEdgeId,
        order,
      }),
    }));
  const exactMethod = metronomeSynthExact.methods().find(
    (method) => method.kind === "request-program" &&
      method.id === "metronome-synth-quote",
  );
  if (exactMethod === undefined || exactMethod.kind !== "request-program") {
    throw new Error("metronome-synth exact request program is missing");
  }
  const program = exactMethod.program;
  const exactByRouteKey = new Map<
    string,
    {
      readonly amountOut: bigint;
      readonly evidence: import("./venues/protocols/metronome-synth-family/types.js")
        .MetronomeSynthExactEvidence;
    }
  >();
  const exactQuotes: RawMigrationStageCapture["items"][number][] = [];
  const edgeByRouteKey = new Map(
    edges.map((edge) => {
      const value = edge.value as { readonly routeKey: string };
      return [value.routeKey, edge] as const;
    }),
  );
  for (const instance of publication.instances) {
    for (const route of [...instance.routes].sort(
      (left, right) => left.routeKey.localeCompare(right.routeKey),
    )) {
      const exactInput = Object.freeze({
        descriptor: instance.descriptor as unknown as MetronomeSynthDescriptor,
        route: route as unknown as MetronomeSynthRoute,
        amountIn: UNIV2_CAPTURE_EXACT_AMOUNT_IN,
        source: input.source,
        executor: MIGRATION_CAPTURE_EXECUTOR,
        runtimeEvidence: Object.freeze([]),
      });
      const requests = program.buildRequests(exactInput);
      const results = requests.map((request) =>
        metronomeSynthSuccessResult(request, input.source)
      );
      const decoded = program.decode({
        programInput: exactInput,
        initialResults: results,
        dependentEvidence: Object.freeze([]),
      });
      const edge = edgeByRouteKey.get(route.routeKey);
      if (edge === undefined) {
        throw new Error(
          `metronome-synth exact route ${route.routeKey} has no edge`,
        );
      }
      exactByRouteKey.set(route.routeKey, {
        amountOut: decoded.amountOut,
        evidence: decoded.evidence,
      });
      exactQuotes.push(Object.freeze({
        id: `${edge.id}\u001fexact:${UNIV2_CAPTURE_EXACT_AMOUNT_IN}`,
        value: Object.freeze({
          routeKey: route.routeKey,
          tokenIn: route.tokenIn,
          tokenOut: route.tokenOut,
          canonicalEdgeId: edge.id,
          amountIn: UNIV2_CAPTURE_EXACT_AMOUNT_IN.toString(),
          amountOut: decoded.amountOut.toString(),
          feeBps: "0",
        }),
      }));
    }
  }
  const executionFragments: RawMigrationStageCapture["items"][number][] = [];
  const finalSimulations: RawMigrationStageCapture["items"][number][] = [];
  for (const instance of publication.instances) {
    for (const route of [...instance.routes].sort(
      (left, right) => left.routeKey.localeCompare(right.routeKey),
    )) {
      const quote = exactByRouteKey.get(route.routeKey);
      const edge = edgeByRouteKey.get(route.routeKey);
      if (quote === undefined || edge === undefined) {
        throw new Error(
          `metronome-synth execution route ${route.routeKey} has no quote`,
        );
      }
      const amountIn = UNIV2_CAPTURE_EXACT_AMOUNT_IN;
      const fragment = metronomeSynthExecution.buildFragment({
        descriptor: instance.descriptor as unknown as MetronomeSynthDescriptor,
        route: route as unknown as MetronomeSynthRoute,
        amountIn,
        quotedAmountOut: quote.amountOut,
        minAmountOut: quote.amountOut,
        exactEvidence: quote.evidence,
        executor: MIGRATION_CAPTURE_EXECUTOR,
        runtimeEvidence: Object.freeze([]),
      });
      executionFragments.push(Object.freeze({
        id: `${edge.id}\u001fexec:${amountIn}`,
        value: Object.freeze({
          routeKey: route.routeKey,
          tokenIn: route.tokenIn,
          tokenOut: route.tokenOut,
          canonicalEdgeId: edge.id,
          amountIn: amountIn.toString(),
          amountOut: quote.amountOut.toString(),
          minAmountOut: quote.amountOut.toString(),
          actionAdapterId: "metronome-synth-swap",
          executionTarget: (
            instance.descriptor as unknown as MetronomeSynthDescriptor
          ).pool,
          nodeFingerprint: hashCanonical(
            fragment.nodes as unknown as CanonicalValue,
          ),
        }),
      }));
      const effects = metronomeSynthExecution.expectedEffects({
        descriptor: instance.descriptor as unknown as MetronomeSynthDescriptor,
        route: route as unknown as MetronomeSynthRoute,
        amountIn,
        quotedAmountOut: quote.amountOut,
      });
      if (quote.amountOut <= 0n) {
        throw new Error(
          "metronome-synth capture final simulation repayment failed",
        );
      }
      finalSimulations.push(Object.freeze({
        id: `${edge.id}\u001fsim:${amountIn}`,
        value: Object.freeze({
          routeKey: route.routeKey,
          tokenIn: route.tokenIn,
          tokenOut: route.tokenOut,
          canonicalEdgeId: edge.id,
          amountIn: amountIn.toString(),
          amountOut: quote.amountOut.toString(),
          minAmountOut: quote.amountOut.toString(),
          effectsFingerprint: hashCanonical(
            effects as unknown as CanonicalValue,
          ),
          conservation: "conserved",
          repayment: "satisfied",
          evInput: Object.freeze({
            amountIn: amountIn.toString(),
            amountOut: quote.amountOut.toString(),
          }),
        }),
      }));
    }
  }
  const instances = publication.instances;
  const summary = definedFamilyPluginContractSummary(family.plugin);
  return Object.freeze({
    familyId: METRONOME_SYNTH_FAMILY_ID,
    caseId: input.caseId ?? `metronome-synth:${input.source.number}`,
    inputFingerprint: input.source.hash.slice(2).padStart(64, "0"),
    stateAnchorNumber: input.source.number,
    implementationClosureHash: summary.definitionBoundaryHash,
    stages: Object.freeze({
      instances: instanceStage(instances, evidenceRefs),
      edges: exercisedStage(edges, evidenceRefs),
      stateCoverage: exercisedStage([], evidenceRefs),
      pricedEdges: exercisedStage([], evidenceRefs),
      prices: exercisedStage(prices, evidenceRefs),
      failures: exercisedStage([], evidenceRefs),
      enumeratedRoutes: exercisedStage(enumeratedRoutes, evidenceRefs),
      exactQuotes: exercisedStage(exactQuotes, evidenceRefs),
      executionFragments: exercisedStage(executionFragments, evidenceRefs),
      finalSimulations: exercisedStage(finalSimulations, evidenceRefs),
    }),
  });
}

export const ERC4626_SILO_FIXTURE_VAULT = `0x${"bb".repeat(20)}`;
export const ERC4626_SILO_FIXTURE_PAYOUT = `0x${"cc".repeat(20)}`;
export const ERC4626_SILO_FIXTURE_UNDERLYING = `0x${"dd".repeat(20)}`;

function erc4626SiloSimulationResult(
  request: AdapterRequest,
  canonical: CanonicalSource,
): AdapterRequestResult {
  if (request.kind !== "effect-delta-simulation") {
    throw new Error(
      `unexpected erc4626-silo fixture transport ${request.kind}`,
    );
  }
  const callerRef = (request as {
    readonly call: { readonly caller: { readonly kind: string } };
  }).call.caller;
  const actor = callerRef.kind === "verified-actor"
    ? ERC4626_SILO_PROBE_ACTOR
    : callerRef.kind === "executor"
      ? MIGRATION_CAPTURE_EXECUTOR
      : (() => {
          throw new Error(
            `erc4626-silo fixture caller ${callerRef.kind} is unsupported`,
          );
        })();
  const callData = (request as {
    readonly call: { readonly data: string };
  }).call.data;
  const amountIn = BigInt(
    ERC4626_SILO_INTERFACE.decodeFunctionData("redeem", callData)[1],
  );
  const amountOut = amountIn;
  return Object.freeze({
    id: request.id,
    ok: true as const,
    source: canonical,
    provenance: Object.freeze({
      kind: "migration-capture-fixture",
      fingerprint: `fixture:${request.id}`,
    }),
    completion: "returned" as const,
    data: ERC4626_SILO_INTERFACE.encodeFunctionResult("redeem", [amountOut]),
    effects: Object.freeze({
      tokenDeltas: Object.freeze([
        Object.freeze({
          token: ERC4626_SILO_FIXTURE_VAULT.toLowerCase(),
          account: actor.toLowerCase(),
          delta: -amountIn,
        }),
        Object.freeze({
          token: ERC4626_SILO_FIXTURE_PAYOUT.toLowerCase(),
          account: actor.toLowerCase(),
          delta: amountOut,
        }),
      ]),
      totalSupplyDeltas: Object.freeze([
        Object.freeze({
          token: ERC4626_SILO_FIXTURE_VAULT.toLowerCase(),
          delta: -amountIn,
        }),
      ]),
      logs: Object.freeze([]),
    }),
  });
}

function erc4626SiloSuccessResult(
  request: AdapterRequest,
  canonical: CanonicalSource,
): AdapterRequestResult {
  if (request.kind === "effect-delta-simulation") {
    return erc4626SiloSimulationResult(request, canonical);
  }
  const data =
    request.id === "identity-vault-code" ||
        request.id === "identity-payout-code"
      ? "0x00"
      : request.id === "identity-vault-asset" ||
          request.id === "identity-payout-asset"
        ? ERC4626_SILO_INTERFACE.encodeFunctionResult("asset", [
            ERC4626_SILO_FIXTURE_UNDERLYING,
          ])
        : request.id === "identity-total-supply"
          ? ERC4626_SILO_INTERFACE.encodeFunctionResult(
              "totalSupply",
              [10n ** 30n],
            )
          : request.id === "identity-preview-redeem" ||
              request.id === "current-preview-redeem"
            ? (() => {
                const shares = BigInt(
                  ERC4626_SILO_INTERFACE.decodeFunctionData(
                    "previewRedeem",
                    (request as { readonly data: string }).data,
                  )[0],
                );
                return ERC4626_SILO_INTERFACE.encodeFunctionResult(
                  "previewRedeem",
                  [shares],
                );
              })()
            : request.id === "identity-preview-withdraw" ||
                request.id === "current-preview-withdraw"
              ? (() => {
                  const assets = BigInt(
                    ERC4626_SILO_PAYOUT_INTERFACE.decodeFunctionData(
                      "previewWithdraw",
                      (request as { readonly data: string }).data,
                    )[0],
                  );
                  return ERC4626_SILO_PAYOUT_INTERFACE.encodeFunctionResult(
                    "previewWithdraw",
                    [assets],
                  );
                })()
              : request.id === "static-share-decimals"
                ? ERC4626_SILO_ERC20_INTERFACE.encodeFunctionResult(
                    "decimals",
                    [18],
                  )
                : (() => {
                    throw new Error(
                      "unexpected erc4626-silo fixture request " + request.id,
                    );
                  })();
  return Object.freeze({
    id: request.id,
    ok: true as const,
    source: canonical,
    provenance: Object.freeze({
      kind: "migration-capture-fixture",
      fingerprint: `fixture:${request.id}`,
    }),
    completion: "returned" as const,
    data,
  });
}

class Erc4626SiloFixtureScheduler implements CentralAdapterScheduler {
  issueExecutor(
    input: Parameters<CentralAdapterScheduler["issueExecutor"]>[0],
  ): ReturnType<CentralAdapterScheduler["issueExecutor"]> {
    const executor = createBoundedRequestExecutor({
      assertSupported: (requirements) => assert.deepEqual(
        requirements,
        input.requirements,
      ),
      assertCallerBinding() {},
      assertWithinBudget: (_familyId, requests) => {
        assert.deepEqual(requests, input.requests);
      },
      execute: async (execution) => Promise.all(execution.requests.map(
        (request) => erc4626SiloSuccessResult(request, execution.source),
      )),
      sealStaticEvidenceReuseProof: () => ({ proofHash: "ab".repeat(32) }),
    });
    return Object.freeze({
      executor,
      timing: () => ({ queueWaitMs: 0, transportWallMs: 1, attempts: 1 }),
    });
  }
}

export function erc4626SiloFixtureRuntime(): CentralAdapterRuntime {
  let now = 1_000;
  return {
    clock: { nowMs: () => now++ },
    generationFence: new FixtureFence(),
    callerAuthority: {
      bind: (input) => input.callerRole === "verified-actor"
        ? Object.freeze({
            verifiedActors: Object.freeze({
              [ERC4626_SILO_PROBE_ACTOR_EVIDENCE_ID]:
                ERC4626_SILO_PROBE_ACTOR,
            }),
          })
        : input.callerRole === "executor"
          ? Object.freeze({ executor: MIGRATION_CAPTURE_EXECUTOR })
          : Object.freeze({}),
    },
    policy: {
      bind: (input) => ({
        lane: input.stage === "identity" ? "critical-proof" : "background",
        deadlineAtMs: 100_000,
        maxAttempts: 1,
        transportPool: "state-read",
        fairnessKey: input.subjectKey,
      }),
    },
    budgets: { assertAdmitted() {} },
    scheduler: new Erc4626SiloFixtureScheduler(),
  };
}

async function runErc4626SiloLifecycle(
  canonical: CanonicalSource,
  vault: string,
  payout: string,
  runtime: CentralAdapterRuntime,
): Promise<AdapterFamilyPublication> {
  const family = PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG.forFamily(
    ERC4626_SILO_REDEEM_FAMILY_ID,
  );
  let publication: AdapterFamilyPublication | null = null;
  const redeemCalldata = ERC4626_SILO_INTERFACE.encodeFunctionData("redeem", [
    payout,
    1_000_000n,
    MIGRATION_CAPTURE_EXECUTOR,
    MIGRATION_CAPTURE_EXECUTOR,
  ]);
  const result = await executeAdapterFamilyLifecycleBatch({
    family,
    matches: [Object.freeze({
      matchedPatternId: "silo-redeem-call",
      observation: Object.freeze({
        kind: "call" as const,
        source: canonical,
        target: vault.toLowerCase(),
        data: redeemCalldata,
      }),
    })],
    source: canonical,
    generation: canonical.generation,
    runtime,
    publisher: { publish: (value) => { publication = value; } },
  });
  assert(result.publication);
  assert(publication);
  return publication;
}

/**
 * Runs the ERC4626 Silo payout lifecycle over the observed redeem fixture.
 * Identity proves the vault/payout asset relation, preview chain and the
 * active redeem effect-delta simulation; exact re-runs the simulation with
 * the executor as actor.
 */
async function buildErc4626SiloCaseCapture(input: {
  readonly source: CanonicalSource;
  readonly publication: AdapterFamilyPublication;
  readonly evidenceRefs: readonly string[];
  readonly caseId?: string;
}): Promise<RawFamilyMigrationCaseCapture> {
  const { publication, evidenceRefs } = input;
  const family = PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG.forFamily(
    ERC4626_SILO_REDEEM_FAMILY_ID,
  );
  const edges: RawMigrationStageCapture["items"][number][] = [];
  const prices: RawMigrationStageCapture["items"][number][] = [];
  for (const instance of publication.instances) {
    for (const route of instance.routes) {
      const handle = instance.routeHandles.find((candidate) =>
        candidate.routeKey === route.routeKey
      );
      if (handle === undefined) {
        throw new Error(
          `prepared route ${route.routeKey} has no issued handle`,
        );
      }
      const projected = projectFamilyRouteGraph({
        family,
        descriptor: instance.descriptor,
        route,
        handle,
      });
      edges.push(Object.freeze({
        id: projected.edge.canonicalEdgeId,
        value: Object.freeze({
          routeKey: route.routeKey,
          tokenIn: route.tokenIn,
          tokenOut: route.tokenOut,
          canonicalEdgeId: projected.edge.canonicalEdgeId,
        }),
      }));
    }
    const routeByKey = new Map(
      instance.routes.map((route) => [route.routeKey, route]),
    );
    for (const pricing of instance.pricingInstances) {
      for (const [routeKey, mid] of pricing.mids) {
        const route = routeByKey.get(routeKey);
        if (route === undefined) {
          throw new Error(
            `erc4626-silo pricing route ${routeKey} is missing`,
          );
        }
        prices.push(Object.freeze({
          id: `${pricing.stateKey}:${route.tokenIn.toLowerCase()}>` +
            `${route.tokenOut.toLowerCase()}`,
          value: Object.freeze({
            stateKey: pricing.stateKey,
            mid: Object.freeze({ ...mid }),
          }) as unknown as RawMigrationStageCapture["items"][number]["value"],
        }));
      }
    }
  }
  const enumeratedRoutes: RawMigrationStageCapture["items"][number][] = edges
    .map((edge) => edge.value as {
      readonly routeKey: string;
      readonly tokenIn: string;
      readonly tokenOut: string;
      readonly canonicalEdgeId: string;
    })
    .sort((left, right) => left.routeKey.localeCompare(right.routeKey))
    .map((value, order) => Object.freeze({
      id: value.canonicalEdgeId,
      value: Object.freeze({
        routeKey: value.routeKey,
        tokenIn: value.tokenIn,
        tokenOut: value.tokenOut,
        canonicalEdgeId: value.canonicalEdgeId,
        order,
      }),
    }));
  const exactMethod = erc4626SiloRedeemExact.methods().find(
    (method) => method.kind === "request-program" &&
      method.id === "active-redeem-simulation",
  );
  if (exactMethod === undefined || exactMethod.kind !== "request-program") {
    throw new Error("erc4626-silo exact request program is missing");
  }
  const program = exactMethod.program;
  const exactByRouteKey = new Map<
    string,
    {
      readonly amountOut: bigint;
      readonly evidence: import("./venues/protocols/erc4626-silo-redeem-family/types.js")
        .Erc4626SiloRedeemExactEvidence;
    }
  >();
  const exactQuotes: RawMigrationStageCapture["items"][number][] = [];
  const edgeByRouteKey = new Map(
    edges.map((edge) => {
      const value = edge.value as { readonly routeKey: string };
      return [value.routeKey, edge] as const;
    }),
  );
  for (const instance of publication.instances) {
    for (const route of [...instance.routes].sort(
      (left, right) => left.routeKey.localeCompare(right.routeKey),
    )) {
      const exactInput = Object.freeze({
        descriptor: instance.descriptor as unknown as
          Erc4626SiloRedeemDescriptor,
        route: route as unknown as Erc4626SiloRedeemRoute,
        amountIn: UNIV2_CAPTURE_EXACT_AMOUNT_IN,
        source: input.source,
        executor: MIGRATION_CAPTURE_EXECUTOR,
        runtimeEvidence: Object.freeze([]),
      });
      const requests = program.buildRequests(exactInput);
      const results = requests.map((request) =>
        erc4626SiloSuccessResult(request, input.source)
      );
      const decoded = program.decode({
        programInput: exactInput,
        initialResults: results,
        dependentEvidence: Object.freeze([]),
      });
      const edge = edgeByRouteKey.get(route.routeKey);
      if (edge === undefined) {
        throw new Error(
          `erc4626-silo exact route ${route.routeKey} has no edge`,
        );
      }
      exactByRouteKey.set(route.routeKey, {
        amountOut: decoded.amountOut,
        evidence: decoded.evidence,
      });
      exactQuotes.push(Object.freeze({
        id: `${edge.id}\u001fexact:${UNIV2_CAPTURE_EXACT_AMOUNT_IN}`,
        value: Object.freeze({
          routeKey: route.routeKey,
          tokenIn: route.tokenIn,
          tokenOut: route.tokenOut,
          canonicalEdgeId: edge.id,
          amountIn: UNIV2_CAPTURE_EXACT_AMOUNT_IN.toString(),
          amountOut: decoded.amountOut.toString(),
          feeBps: "0",
        }),
      }));
    }
  }
  const executionFragments: RawMigrationStageCapture["items"][number][] = [];
  const finalSimulations: RawMigrationStageCapture["items"][number][] = [];
  for (const instance of publication.instances) {
    for (const route of [...instance.routes].sort(
      (left, right) => left.routeKey.localeCompare(right.routeKey),
    )) {
      const quote = exactByRouteKey.get(route.routeKey);
      const edge = edgeByRouteKey.get(route.routeKey);
      if (quote === undefined || edge === undefined) {
        throw new Error(
          `erc4626-silo execution route ${route.routeKey} has no quote`,
        );
      }
      const amountIn = UNIV2_CAPTURE_EXACT_AMOUNT_IN;
      const fragment = erc4626SiloRedeemExecution.buildFragment({
        descriptor: instance.descriptor as unknown as
          Erc4626SiloRedeemDescriptor,
        route: route as unknown as Erc4626SiloRedeemRoute,
        amountIn,
        quotedAmountOut: quote.amountOut,
        minAmountOut: quote.amountOut,
        exactEvidence: quote.evidence,
        executor: MIGRATION_CAPTURE_EXECUTOR,
        runtimeEvidence: Object.freeze([]),
      });
      executionFragments.push(Object.freeze({
        id: `${edge.id}\u001fexec:${amountIn}`,
        value: Object.freeze({
          routeKey: route.routeKey,
          tokenIn: route.tokenIn,
          tokenOut: route.tokenOut,
          canonicalEdgeId: edge.id,
          amountIn: amountIn.toString(),
          amountOut: quote.amountOut.toString(),
          minAmountOut: quote.amountOut.toString(),
          actionAdapterId: "erc4626-redeem-silo",
          executionTarget: (
            instance.descriptor as unknown as Erc4626SiloRedeemDescriptor
          ).vault,
          nodeFingerprint: hashCanonical(
            fragment.nodes as unknown as CanonicalValue,
          ),
        }),
      }));
      const effects = erc4626SiloRedeemExecution.expectedEffects({
        descriptor: instance.descriptor as unknown as
          Erc4626SiloRedeemDescriptor,
        route: route as unknown as Erc4626SiloRedeemRoute,
        amountIn,
        quotedAmountOut: quote.amountOut,
      });
      if (quote.amountOut <= 0n) {
        throw new Error(
          "erc4626-silo capture final simulation repayment failed",
        );
      }
      finalSimulations.push(Object.freeze({
        id: `${edge.id}\u001fsim:${amountIn}`,
        value: Object.freeze({
          routeKey: route.routeKey,
          tokenIn: route.tokenIn,
          tokenOut: route.tokenOut,
          canonicalEdgeId: edge.id,
          amountIn: amountIn.toString(),
          amountOut: quote.amountOut.toString(),
          minAmountOut: quote.amountOut.toString(),
          effectsFingerprint: hashCanonical(
            effects as unknown as CanonicalValue,
          ),
          conservation: "conserved",
          repayment: "satisfied",
          evInput: Object.freeze({
            amountIn: amountIn.toString(),
            amountOut: quote.amountOut.toString(),
          }),
        }),
      }));
    }
  }
  const instances = publication.instances;
  const summary = definedFamilyPluginContractSummary(family.plugin);
  return Object.freeze({
    familyId: ERC4626_SILO_REDEEM_FAMILY_ID,
    caseId: input.caseId ?? `erc4626-silo-redeem:${input.source.number}`,
    inputFingerprint: input.source.hash.slice(2).padStart(64, "0"),
    stateAnchorNumber: input.source.number,
    implementationClosureHash: summary.definitionBoundaryHash,
    stages: Object.freeze({
      instances: instanceStage(instances, evidenceRefs),
      edges: exercisedStage(edges, evidenceRefs),
      stateCoverage: exercisedStage([], evidenceRefs),
      pricedEdges: exercisedStage([], evidenceRefs),
      prices: exercisedStage(prices, evidenceRefs),
      failures: exercisedStage([], evidenceRefs),
      enumeratedRoutes: exercisedStage(enumeratedRoutes, evidenceRefs),
      exactQuotes: exercisedStage(exactQuotes, evidenceRefs),
      executionFragments: exercisedStage(executionFragments, evidenceRefs),
      finalSimulations: exercisedStage(finalSimulations, evidenceRefs),
    }),
  });
}

export async function captureErc4626SiloRedeemFixtureCase(input: {
  readonly source: CanonicalSource;
  readonly caseId?: string;
}): Promise<RawFamilyMigrationCaseCapture> {
  const publication = await runErc4626SiloLifecycle(
    input.source,
    ERC4626_SILO_FIXTURE_VAULT,
    ERC4626_SILO_FIXTURE_PAYOUT,
    erc4626SiloFixtureRuntime(),
  );
  return buildErc4626SiloCaseCapture({
    source: input.source,
    caseId: input.caseId,
    publication,
    evidenceRefs: Object.freeze([
      `fixture:erc4626-silo-redeem:${input.source.number}:${input.source.hash}`,
    ]),
  });
}

/**
 * Real on-chain erc4626-silo capture: the vault and payout asset() calls
 * are read at the canonical source block, must be non-zero and equal, and
 * must agree with the supplied underlying. Fail-closed on any divergence.
 */
export async function captureErc4626SiloOnchainCase(input: {
  readonly source: CanonicalSource;
  readonly provider: OnchainUniv2Provider;
  readonly vault: string;
  readonly payout: string;
  readonly underlying?: string;
  readonly caseId?: string;
  readonly runtime: CentralAdapterRuntime;
}): Promise<RawFamilyMigrationCaseCapture> {
  const vault = input.vault.toLowerCase();
  const payout = input.payout.toLowerCase();
  const readAsset = async (target: string): Promise<string> => {
    const raw = await input.provider.call({
      to: target,
      data: ERC4626_SILO_INTERFACE.encodeFunctionData("asset", []),
    }, input.source.number);
    if (raw === "0x" || raw.length < 2) {
      throw new Error(
        `erc4626-silo asset read empty at ${input.source.number}`,
      );
    }
    return (
      ERC4626_SILO_INTERFACE.decodeFunctionResult("asset", raw)[0] as string
    ).toLowerCase();
  };
  const [vaultAsset, payoutAsset] = await Promise.all([
    readAsset(vault),
    readAsset(payout),
  ]);
  if (
    vaultAsset === "0x0000000000000000000000000000000000000000" ||
    payoutAsset === "0x0000000000000000000000000000000000000000"
  ) {
    throw new Error("erc4626-silo reports a zero asset");
  }
  if (vaultAsset !== payoutAsset) {
    throw new Error("erc4626-silo vault/payout asset mismatch");
  }
  if (input.underlying !== undefined &&
      input.underlying.toLowerCase() !== vaultAsset) {
    throw new Error("erc4626-silo onchain underlying mismatch");
  }
  const publication = await runErc4626SiloLifecycle(
    input.source,
    vault,
    payout,
    input.runtime,
  );
  return buildErc4626SiloCaseCapture({
    source: input.source,
    caseId: input.caseId,
    publication,
    evidenceRefs: Object.freeze([
      `onchain:1:${input.source.hash}:erc4626-silo:${vault}`,
    ]),
  });
}

export const ERC4626_FIXTURE_VAULT = `0x${"ab".repeat(20)}`;
export const ERC4626_FIXTURE_ASSET = `0x${"ac".repeat(20)}`;

function erc4626EventLog(
  eventName: "Deposit" | "Withdraw",
  assets: bigint,
  shares: bigint,
) {
  const log = ERC4626_INTERFACE.encodeEventLog(
    eventName,
    eventName === "Deposit"
      ? [ERC4626_PROBE_ACTOR, ERC4626_PROBE_ACTOR, assets, shares]
      : [
          ERC4626_PROBE_ACTOR,
          ERC4626_PROBE_ACTOR,
          ERC4626_PROBE_ACTOR,
          assets,
          shares,
        ],
  );
  return Object.freeze({
    address: ERC4626_FIXTURE_VAULT.toLowerCase(),
    topics: Object.freeze([...log.topics]),
    data: log.data,
  });
}

function erc4626SimulationResult(
  request: AdapterRequest,
  canonical: CanonicalSource,
): AdapterRequestResult {
  if (request.kind !== "effect-delta-simulation") {
    throw new Error(`unexpected erc4626 fixture transport ${request.kind}`);
  }
  const callData = (request as {
    readonly call: { readonly data: string };
  }).call.data;
  const deposit = request.id === "active-deposit";
  const amountIn = BigInt(
    ERC4626_INTERFACE.decodeFunctionData(
      deposit ? "deposit" : "redeem",
      callData,
    )[0],
  );
  const amountOut = amountIn;
  const actor = ERC4626_PROBE_ACTOR;
  const asset = ERC4626_FIXTURE_ASSET.toLowerCase();
  const vault = ERC4626_FIXTURE_VAULT.toLowerCase();
  return Object.freeze({
    id: request.id,
    ok: true as const,
    source: canonical,
    provenance: Object.freeze({
      kind: "migration-capture-fixture",
      fingerprint: `fixture:${request.id}`,
    }),
    completion: "returned" as const,
    data: ERC4626_INTERFACE.encodeFunctionResult(
      deposit ? "deposit" : "redeem",
      [amountOut],
    ),
    effects: Object.freeze({
      tokenDeltas: Object.freeze([
        Object.freeze({
          token: deposit ? asset : vault,
          account: actor.toLowerCase(),
          delta: -amountIn,
        }),
        Object.freeze({
          token: deposit ? vault : asset,
          account: actor.toLowerCase(),
          delta: amountOut,
        }),
      ]),
      totalSupplyDeltas: Object.freeze([
        Object.freeze({
          token: vault,
          delta: deposit ? amountOut : -amountOut,
        }),
      ]),
      logs: Object.freeze([
        erc4626EventLog(
          deposit ? "Deposit" : "Withdraw",
          amountIn,
          amountOut,
        ),
      ]),
    }),
  });
}

function erc4626SuccessResult(
  request: AdapterRequest,
  canonical: CanonicalSource,
): AdapterRequestResult {
  if (request.kind === "effect-delta-simulation") {
    return erc4626SimulationResult(request, canonical);
  }
  const data =
    request.id === "base-vault-code" || request.id === "active-asset-code"
      ? "0x00"
      : request.id === "base-asset"
        ? ERC4626_INTERFACE.encodeFunctionResult("asset", [
            ERC4626_FIXTURE_ASSET,
          ])
        : request.id === "base-total-assets" ||
            request.id === "base-total-supply"
          ? ERC4626_INTERFACE.encodeFunctionResult(
              request.id === "base-total-assets"
                ? "totalAssets"
                : "totalSupply",
              [10n ** 30n],
            )
          : request.id === "exact-preview"
            ? (() => {
                const selector = (
                  request as { readonly data: string }
                ).data.slice(0, 10).toLowerCase();
                const functionName = selector ===
                    ERC4626_INTERFACE.getFunction("previewDeposit")!.selector
                  ? "previewDeposit"
                  : selector ===
                      ERC4626_INTERFACE.getFunction("previewRedeem")!.selector
                    ? "previewRedeem"
                    : (() => {
                        throw new Error(
                          `unexpected erc4626 exact-preview selector ` +
                            selector,
                        );
                      })();
                const amount = BigInt(
                  ERC4626_INTERFACE.decodeFunctionData(
                    functionName,
                    (request as { readonly data: string }).data,
                  )[0],
                );
                return ERC4626_INTERFACE.encodeFunctionResult(
                  functionName,
                  [amount],
                );
              })()
            : request.id.startsWith("base-convert-shares:") ||
              request.id.startsWith("base-preview-deposit:") ||
              request.id.startsWith("base-convert-assets:") ||
              request.id.startsWith("base-preview-redeem:") ||
              request.id === "active-roundtrip" ||
              request.id === "active-preview-redeem" ||
              request.id === "current:deposit" ||
              request.id === "current:redeem"
            ? (() => {
                const functionName =
                  request.id === "current:deposit" ||
                  request.id.startsWith("base-preview-deposit:")
                    ? "previewDeposit"
                    : request.id === "current:redeem" ||
                        request.id.startsWith("base-preview-redeem:") ||
                        request.id === "active-roundtrip" ||
                        request.id === "active-preview-redeem"
                      ? "previewRedeem"
                      : request.id.startsWith("base-convert-shares:")
                        ? "convertToShares"
                        : "convertToAssets";
                const amount = BigInt(
                  ERC4626_INTERFACE.decodeFunctionData(
                    functionName,
                    (request as { readonly data: string }).data,
                  )[0],
                );
                return ERC4626_INTERFACE.encodeFunctionResult(
                  functionName,
                  [amount],
                );
              })()
            : request.id === "static-asset-decimals" ||
                request.id === "static-share-decimals"
              ? ERC4626_ERC20_INTERFACE.encodeFunctionResult("decimals", [18])
              : (() => {
                  throw new Error(
                    "unexpected erc4626 fixture request " + request.id,
                  );
                })();
  return Object.freeze({
    id: request.id,
    ok: true as const,
    source: canonical,
    provenance: Object.freeze({
      kind: "migration-capture-fixture",
      fingerprint: `fixture:${request.id}`,
    }),
    completion: "returned" as const,
    data,
  });
}

class Erc4626FixtureScheduler implements CentralAdapterScheduler {
  issueExecutor(
    input: Parameters<CentralAdapterScheduler["issueExecutor"]>[0],
  ): ReturnType<CentralAdapterScheduler["issueExecutor"]> {
    const executor = createBoundedRequestExecutor({
      assertSupported: (requirements) => assert.deepEqual(
        requirements,
        input.requirements,
      ),
      assertCallerBinding() {},
      assertWithinBudget: (_familyId, requests) => {
        assert.deepEqual(requests, input.requests);
      },
      execute: async (execution) => Promise.all(execution.requests.map(
        (request) => erc4626SuccessResult(request, execution.source),
      )),
      sealStaticEvidenceReuseProof: () => ({ proofHash: "ab".repeat(32) }),
    });
    return Object.freeze({
      executor,
      timing: () => ({ queueWaitMs: 0, transportWallMs: 1, attempts: 1 }),
    });
  }
}

export function erc4626FixtureRuntime(): CentralAdapterRuntime {
  let now = 1_000;
  return {
    clock: { nowMs: () => now++ },
    generationFence: new FixtureFence(),
    callerAuthority: {
      bind: (input) => input.callerRole === "verified-actor"
        ? Object.freeze({
            verifiedActors: Object.freeze({
              [ERC4626_PROBE_ACTOR_EVIDENCE_ID]: ERC4626_PROBE_ACTOR,
            }),
          })
        : Object.freeze({}),
    },
    policy: {
      bind: (input) => ({
        lane: input.stage === "identity" ? "critical-proof" : "background",
        deadlineAtMs: 100_000,
        maxAttempts: 1,
        transportPool: "state-read",
        fairnessKey: input.subjectKey,
      }),
    },
    budgets: { assertAdmitted() {} },
    scheduler: new Erc4626FixtureScheduler(),
  };
}

async function runErc4626Lifecycle(
  canonical: CanonicalSource,
  vault: string,
  runtime: CentralAdapterRuntime,
): Promise<AdapterFamilyPublication> {
  const family = PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG.forFamily(
    ERC4626_FAMILY_ID,
  );
  let publication: AdapterFamilyPublication | null = null;
  const depositCalldata = ERC4626_INTERFACE.encodeFunctionData("deposit", [
    1_000_000n,
    MIGRATION_CAPTURE_EXECUTOR,
  ]);
  const result = await executeAdapterFamilyLifecycleBatch({
    family,
    matches: [Object.freeze({
      matchedPatternId: "erc4626-deposit-call",
      observation: Object.freeze({
        kind: "call" as const,
        source: canonical,
        target: vault.toLowerCase(),
        data: depositCalldata,
      }),
    })],
    source: canonical,
    generation: canonical.generation,
    runtime,
    publisher: { publish: (value) => { publication = value; } },
  });
  assert(result.publication);
  assert(publication);
  return publication;
}

/**
 * Runs the ERC4626 vault lifecycle over the observed deposit fixture.
 * Identity proves both deposit and redeem execution surfaces via
 * effect-delta simulations with verified-actor caller authority; both
 * directions are exercised through pricing, exact, execution and final-sim.
 */
async function buildErc4626CaseCapture(input: {
  readonly source: CanonicalSource;
  readonly publication: AdapterFamilyPublication;
  readonly evidenceRefs: readonly string[];
  readonly caseId?: string;
}): Promise<RawFamilyMigrationCaseCapture> {
  const { publication, evidenceRefs } = input;
  const family = PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG.forFamily(
    ERC4626_FAMILY_ID,
  );
  const edges: RawMigrationStageCapture["items"][number][] = [];
  const prices: RawMigrationStageCapture["items"][number][] = [];
  for (const instance of publication.instances) {
    for (const route of instance.routes) {
      const handle = instance.routeHandles.find((candidate) =>
        candidate.routeKey === route.routeKey
      );
      if (handle === undefined) {
        throw new Error(
          `prepared route ${route.routeKey} has no issued handle`,
        );
      }
      const projected = projectFamilyRouteGraph({
        family,
        descriptor: instance.descriptor,
        route,
        handle,
      });
      edges.push(Object.freeze({
        id: projected.edge.canonicalEdgeId,
        value: Object.freeze({
          routeKey: route.routeKey,
          tokenIn: route.tokenIn,
          tokenOut: route.tokenOut,
          canonicalEdgeId: projected.edge.canonicalEdgeId,
        }),
      }));
    }
    const routeByKey = new Map(
      instance.routes.map((route) => [route.routeKey, route]),
    );
    for (const pricing of instance.pricingInstances) {
      for (const [routeKey, mid] of pricing.mids) {
        const route = routeByKey.get(routeKey);
        if (route === undefined) {
          throw new Error(`erc4626 pricing route ${routeKey} is missing`);
        }
        prices.push(Object.freeze({
          id: `${pricing.stateKey}:${route.tokenIn.toLowerCase()}>` +
            `${route.tokenOut.toLowerCase()}`,
          value: Object.freeze({
            stateKey: pricing.stateKey,
            mid: Object.freeze({ ...mid }),
          }) as unknown as RawMigrationStageCapture["items"][number]["value"],
        }));
      }
    }
  }
  const enumeratedRoutes: RawMigrationStageCapture["items"][number][] = edges
    .map((edge) => edge.value as {
      readonly routeKey: string;
      readonly tokenIn: string;
      readonly tokenOut: string;
      readonly canonicalEdgeId: string;
    })
    .sort((left, right) => left.routeKey.localeCompare(right.routeKey))
    .map((value, order) => Object.freeze({
      id: value.canonicalEdgeId,
      value: Object.freeze({
        routeKey: value.routeKey,
        tokenIn: value.tokenIn,
        tokenOut: value.tokenOut,
        canonicalEdgeId: value.canonicalEdgeId,
        order,
      }),
    }));
  const exactMethod = erc4626Exact.methods().find(
    (method) => method.kind === "request-program" &&
      method.id === "erc4626-preview",
  );
  if (exactMethod === undefined || exactMethod.kind !== "request-program") {
    throw new Error("erc4626 exact request program is missing");
  }
  const program = exactMethod.program;
  const exactByRouteKey = new Map<
    string,
    {
      readonly amountOut: bigint;
      readonly evidence: import("./venues/protocols/erc4626-family/types.js")
        .Erc4626ExactEvidence;
    }
  >();
  const exactQuotes: RawMigrationStageCapture["items"][number][] = [];
  const edgeByRouteKey = new Map(
    edges.map((edge) => {
      const value = edge.value as { readonly routeKey: string };
      return [value.routeKey, edge] as const;
    }),
  );
  for (const instance of publication.instances) {
    for (const route of [...instance.routes].sort(
      (left, right) => left.routeKey.localeCompare(right.routeKey),
    )) {
      const exactInput = Object.freeze({
        descriptor: instance.descriptor as unknown as Erc4626Descriptor,
        route: route as unknown as Erc4626Route,
        amountIn: UNIV2_CAPTURE_EXACT_AMOUNT_IN,
        source: input.source,
        executor: MIGRATION_CAPTURE_EXECUTOR,
        runtimeEvidence: Object.freeze([]),
      });
      const requests = program.buildRequests(exactInput);
      const results = requests.map((request) =>
        erc4626SuccessResult(request, input.source)
      );
      const decoded = program.decode({
        programInput: exactInput,
        initialResults: results,
        dependentEvidence: Object.freeze([]),
      });
      const edge = edgeByRouteKey.get(route.routeKey);
      if (edge === undefined) {
        throw new Error(`erc4626 exact route ${route.routeKey} has no edge`);
      }
      exactByRouteKey.set(route.routeKey, {
        amountOut: decoded.amountOut,
        evidence: decoded.evidence,
      });
      exactQuotes.push(Object.freeze({
        id: `${edge.id}\u001fexact:${UNIV2_CAPTURE_EXACT_AMOUNT_IN}`,
        value: Object.freeze({
          routeKey: route.routeKey,
          tokenIn: route.tokenIn,
          tokenOut: route.tokenOut,
          canonicalEdgeId: edge.id,
          amountIn: UNIV2_CAPTURE_EXACT_AMOUNT_IN.toString(),
          amountOut: decoded.amountOut.toString(),
          feeBps: "0",
        }),
      }));
    }
  }
  const executionFragments: RawMigrationStageCapture["items"][number][] = [];
  const finalSimulations: RawMigrationStageCapture["items"][number][] = [];
  for (const instance of publication.instances) {
    for (const route of [...instance.routes].sort(
      (left, right) => left.routeKey.localeCompare(right.routeKey),
    )) {
      const quote = exactByRouteKey.get(route.routeKey);
      const edge = edgeByRouteKey.get(route.routeKey);
      if (quote === undefined || edge === undefined) {
        throw new Error(
          `erc4626 execution route ${route.routeKey} has no quote`,
        );
      }
      const amountIn = UNIV2_CAPTURE_EXACT_AMOUNT_IN;
      const fragment = erc4626Execution.buildFragment({
        descriptor: instance.descriptor as unknown as Erc4626Descriptor,
        route: route as unknown as Erc4626Route,
        amountIn,
        quotedAmountOut: quote.amountOut,
        minAmountOut: quote.amountOut,
        exactEvidence: quote.evidence,
        executor: MIGRATION_CAPTURE_EXECUTOR,
        runtimeEvidence: Object.freeze([]),
      });
      executionFragments.push(Object.freeze({
        id: `${edge.id}\u001fexec:${amountIn}`,
        value: Object.freeze({
          routeKey: route.routeKey,
          tokenIn: route.tokenIn,
          tokenOut: route.tokenOut,
          canonicalEdgeId: edge.id,
          amountIn: amountIn.toString(),
          amountOut: quote.amountOut.toString(),
          minAmountOut: quote.amountOut.toString(),
          actionAdapterId: (route as unknown as Erc4626Route).adapterId,
          executionTarget: (
            instance.descriptor as unknown as Erc4626Descriptor
          ).vault,
          nodeFingerprint: hashCanonical(
            fragment.nodes as unknown as CanonicalValue,
          ),
        }),
      }));
      const effects = erc4626Execution.expectedEffects({
        descriptor: instance.descriptor as unknown as Erc4626Descriptor,
        route: route as unknown as Erc4626Route,
        amountIn,
        quotedAmountOut: quote.amountOut,
      });
      if (quote.amountOut <= 0n) {
        throw new Error(
          "erc4626 capture final simulation repayment failed",
        );
      }
      finalSimulations.push(Object.freeze({
        id: `${edge.id}\u001fsim:${amountIn}`,
        value: Object.freeze({
          routeKey: route.routeKey,
          tokenIn: route.tokenIn,
          tokenOut: route.tokenOut,
          canonicalEdgeId: edge.id,
          amountIn: amountIn.toString(),
          amountOut: quote.amountOut.toString(),
          minAmountOut: quote.amountOut.toString(),
          effectsFingerprint: hashCanonical(
            effects as unknown as CanonicalValue,
          ),
          conservation: "conserved",
          repayment: "satisfied",
          evInput: Object.freeze({
            amountIn: amountIn.toString(),
            amountOut: quote.amountOut.toString(),
          }),
        }),
      }));
    }
  }
  const instances = publication.instances;
  const summary = definedFamilyPluginContractSummary(family.plugin);
  return Object.freeze({
    familyId: ERC4626_FAMILY_ID,
    caseId: input.caseId ?? `erc4626:${input.source.number}`,
    inputFingerprint: input.source.hash.slice(2).padStart(64, "0"),
    stateAnchorNumber: input.source.number,
    implementationClosureHash: summary.definitionBoundaryHash,
    stages: Object.freeze({
      instances: instanceStage(instances, evidenceRefs),
      edges: exercisedStage(edges, evidenceRefs),
      stateCoverage: exercisedStage([], evidenceRefs),
      pricedEdges: exercisedStage([], evidenceRefs),
      prices: exercisedStage(prices, evidenceRefs),
      failures: exercisedStage([], evidenceRefs),
      enumeratedRoutes: exercisedStage(enumeratedRoutes, evidenceRefs),
      exactQuotes: exercisedStage(exactQuotes, evidenceRefs),
      executionFragments: exercisedStage(executionFragments, evidenceRefs),
      finalSimulations: exercisedStage(finalSimulations, evidenceRefs),
    }),
  });
}

export async function captureErc4626FixtureCase(input: {
  readonly source: CanonicalSource;
  readonly caseId?: string;
}): Promise<RawFamilyMigrationCaseCapture> {
  const publication = await runErc4626Lifecycle(
    input.source,
    ERC4626_FIXTURE_VAULT,
    erc4626FixtureRuntime(),
  );
  return buildErc4626CaseCapture({
    source: input.source,
    caseId: input.caseId,
    publication,
    evidenceRefs: Object.freeze([
      `fixture:erc4626:${input.source.number}:${input.source.hash}`,
    ]),
  });
}

/**
 * Real on-chain erc4626 capture: the vault's asset() is read at the
 * canonical source block and must agree with the descriptor (fail-closed on
 * zero asset, empty read or mismatch). The lifecycle runs against the real
 * vault with the caller-supplied central runtime — fixture runtime in local
 * contract tests, the strict provider+revm runtime in production node runs.
 */
export async function captureErc4626OnchainCase(input: {
  readonly source: CanonicalSource;
  readonly provider: OnchainUniv2Provider;
  readonly vault: string;
  readonly asset?: string;
  readonly caseId?: string;
  readonly runtime: CentralAdapterRuntime;
}): Promise<RawFamilyMigrationCaseCapture> {
  const vault = input.vault.toLowerCase();
  const assetRaw = await input.provider.call({
    to: vault,
    data: ERC4626_INTERFACE.encodeFunctionData("asset", []),
  }, input.source.number);
  if (assetRaw === "0x" || assetRaw.length < 2) {
    throw new Error(
      `erc4626 asset read empty at ${input.source.number}`,
    );
  }
  const asset = (
    ERC4626_INTERFACE.decodeFunctionResult("asset", assetRaw)[0] as string
  ).toLowerCase();
  if (asset === "0x0000000000000000000000000000000000000000") {
    throw new Error(`erc4626 vault ${vault} reports a zero asset`);
  }
  if (input.asset !== undefined && input.asset.toLowerCase() !== asset) {
    throw new Error("erc4626 onchain asset mismatch");
  }
  const publication = await runErc4626Lifecycle(
    input.source,
    vault,
    input.runtime,
  );
  return buildErc4626CaseCapture({
    source: input.source,
    caseId: input.caseId,
    publication,
    evidenceRefs: Object.freeze([
      `onchain:1:${input.source.hash}:erc4626:${vault}`,
    ]),
  });
}

export const ETHERTOKEN_NATIVE_FIXTURE_TOKEN = `0x${"ad".repeat(20)}`;

function etherTokenNativeSimulationResult(
  request: AdapterRequest,
  canonical: CanonicalSource,
): AdapterRequestResult {
  if (request.kind !== "effect-delta-simulation") {
    throw new Error(
      `unexpected ethertoken fixture transport ${request.kind}`,
    );
  }
  const callerRef = (request as {
    readonly call: { readonly caller: { readonly kind: string } };
  }).call.caller;
  const actor = callerRef.kind === "verified-actor"
    ? ETHERTOKEN_NATIVE_PROBE_ACTOR
    : callerRef.kind === "executor"
      ? MIGRATION_CAPTURE_EXECUTOR
      : (() => {
          throw new Error(
            `ethertoken fixture caller ${callerRef.kind} is unsupported`,
          );
        })();
  const amountIn = BigInt(
    ETHERTOKEN_NATIVE_INTERFACE.decodeFunctionData(
      "withdraw",
      (request as { readonly call: { readonly data: string } }).call.data,
    )[0],
  );
  const token = ETHERTOKEN_NATIVE_FIXTURE_TOKEN.toLowerCase();
  return Object.freeze({
    id: request.id,
    ok: true as const,
    source: canonical,
    provenance: Object.freeze({
      kind: "migration-capture-fixture",
      fingerprint: `fixture:${request.id}`,
    }),
    completion: "returned" as const,
    data: ETHERTOKEN_NATIVE_INTERFACE.encodeFunctionResult("withdraw", []),
    effects: Object.freeze({
      tokenDeltas: Object.freeze([
        Object.freeze({
          token,
          account: actor.toLowerCase(),
          delta: -amountIn,
        }),
      ]),
      nativeDeltas: Object.freeze([
        Object.freeze({
          account: actor.toLowerCase(),
          delta: amountIn,
        }),
      ]),
      totalSupplyDeltas: Object.freeze([
        Object.freeze({
          token,
          delta: -amountIn,
        }),
      ]),
      logs: Object.freeze([]),
    }),
  });
}

function etherTokenNativeSuccessResult(
  request: AdapterRequest,
  canonical: CanonicalSource,
): AdapterRequestResult {
  if (request.kind === "effect-delta-simulation") {
    return etherTokenNativeSimulationResult(request, canonical);
  }
  const data =
    request.id === "identity-token-code"
      ? "0x00"
      : request.id === "identity-token-balance-surface" ||
          request.id === "current-total-supply" ||
          request.id === "identity-token-supply"
        ? ETHERTOKEN_NATIVE_INTERFACE.encodeFunctionResult(
            request.id === "identity-token-balance-surface"
              ? "balanceOf"
              : "totalSupply",
            [10n ** 30n],
          )
        : request.id === "identity-token-decimals" ||
            request.id === "static-token-decimals"
          ? ETHERTOKEN_NATIVE_INTERFACE.encodeFunctionResult(
              "decimals",
              [18],
            )
          : (() => {
              throw new Error(
                "unexpected ethertoken fixture request " + request.id,
              );
            })();
  return Object.freeze({
    id: request.id,
    ok: true as const,
    source: canonical,
    provenance: Object.freeze({
      kind: "migration-capture-fixture",
      fingerprint: `fixture:${request.id}`,
    }),
    completion: "returned" as const,
    data,
  });
}

class EtherTokenNativeFixtureScheduler implements CentralAdapterScheduler {
  issueExecutor(
    input: Parameters<CentralAdapterScheduler["issueExecutor"]>[0],
  ): ReturnType<CentralAdapterScheduler["issueExecutor"]> {
    const executor = createBoundedRequestExecutor({
      assertSupported: (requirements) => assert.deepEqual(
        requirements,
        input.requirements,
      ),
      assertCallerBinding() {},
      assertWithinBudget: (_familyId, requests) => {
        assert.deepEqual(requests, input.requests);
      },
      execute: async (execution) => Promise.all(execution.requests.map(
        (request) => etherTokenNativeSuccessResult(request, execution.source),
      )),
      sealStaticEvidenceReuseProof: () => ({ proofHash: "ab".repeat(32) }),
    });
    return Object.freeze({
      executor,
      timing: () => ({ queueWaitMs: 0, transportWallMs: 1, attempts: 1 }),
    });
  }
}

function etherTokenNativeFixtureRuntime(): CentralAdapterRuntime {
  let now = 1_000;
  return {
    clock: { nowMs: () => now++ },
    generationFence: new FixtureFence(),
    callerAuthority: {
      bind: (input) => input.callerRole === "verified-actor"
        ? Object.freeze({
            verifiedActors: Object.freeze({
              [ETHERTOKEN_NATIVE_PROBE_ACTOR_EVIDENCE_ID]:
                ETHERTOKEN_NATIVE_PROBE_ACTOR,
            }),
          })
        : input.callerRole === "executor"
          ? Object.freeze({ executor: MIGRATION_CAPTURE_EXECUTOR })
          : Object.freeze({}),
    },
    policy: {
      bind: (input) => ({
        lane: input.stage === "identity" ? "critical-proof" : "background",
        deadlineAtMs: 100_000,
        maxAttempts: 1,
        transportPool: "state-read",
        fairnessKey: input.subjectKey,
      }),
    },
    budgets: { assertAdmitted() {} },
    scheduler: new EtherTokenNativeFixtureScheduler(),
  };
}

async function runEtherTokenNativeLifecycle(
  canonical: CanonicalSource,
): Promise<AdapterFamilyPublication> {
  const family = PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG.forFamily(
    ETHERTOKEN_NATIVE_FAMILY_ID,
  );
  let publication: AdapterFamilyPublication | null = null;
  const withdrawCalldata = ETHERTOKEN_NATIVE_INTERFACE.encodeFunctionData(
    "withdraw",
    [1_000_000n],
  );
  const result = await executeAdapterFamilyLifecycleBatch({
    family,
    matches: [Object.freeze({
      matchedPatternId: "ethertoken-withdraw-call",
      observation: Object.freeze({
        kind: "call" as const,
        source: canonical,
        target: ETHERTOKEN_NATIVE_FIXTURE_TOKEN,
        data: withdrawCalldata,
      }),
    })],
    source: canonical,
    generation: canonical.generation,
    runtime: etherTokenNativeFixtureRuntime(),
    publisher: { publish: (value) => { publication = value; } },
  });
  assert(result.publication);
  assert(publication);
  return publication;
}

/**
 * Runs the ethertoken-native redeem lifecycle over the observed withdraw
 * fixture: exact-burn-equal-native-out identity proof via effect-delta
 * simulation, total-supply pricing, and a two-node redeem + WETH deposit
 * execution fragment.
 */
export async function captureEtherTokenNativeRedeemFixtureCase(input: {
  readonly source: CanonicalSource;
  readonly caseId?: string;
}): Promise<RawFamilyMigrationCaseCapture> {
  const publication = await runEtherTokenNativeLifecycle(input.source);
  const evidenceRefs = Object.freeze([
    `fixture:ethertoken-native-redeem:${input.source.number}:` +
      input.source.hash,
  ]);
  const family = PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG.forFamily(
    ETHERTOKEN_NATIVE_FAMILY_ID,
  );
  const edges: RawMigrationStageCapture["items"][number][] = [];
  const prices: RawMigrationStageCapture["items"][number][] = [];
  for (const instance of publication.instances) {
    for (const route of instance.routes) {
      const handle = instance.routeHandles.find((candidate) =>
        candidate.routeKey === route.routeKey
      );
      if (handle === undefined) {
        throw new Error(
          `prepared route ${route.routeKey} has no issued handle`,
        );
      }
      const projected = projectFamilyRouteGraph({
        family,
        descriptor: instance.descriptor,
        route,
        handle,
      });
      edges.push(Object.freeze({
        id: projected.edge.canonicalEdgeId,
        value: Object.freeze({
          routeKey: route.routeKey,
          tokenIn: route.tokenIn,
          tokenOut: route.tokenOut,
          canonicalEdgeId: projected.edge.canonicalEdgeId,
        }),
      }));
    }
    const routeByKey = new Map(
      instance.routes.map((route) => [route.routeKey, route]),
    );
    for (const pricing of instance.pricingInstances) {
      for (const [routeKey, mid] of pricing.mids) {
        const route = routeByKey.get(routeKey);
        if (route === undefined) {
          throw new Error(
            `ethertoken-native pricing route ${routeKey} is missing`,
          );
        }
        prices.push(Object.freeze({
          id: `${pricing.stateKey}:${route.tokenIn.toLowerCase()}>` +
            `${route.tokenOut.toLowerCase()}`,
          value: Object.freeze({
            stateKey: pricing.stateKey,
            mid: Object.freeze({ ...mid }),
          }) as unknown as RawMigrationStageCapture["items"][number]["value"],
        }));
      }
    }
  }
  const enumeratedRoutes: RawMigrationStageCapture["items"][number][] = edges
    .map((edge) => edge.value as {
      readonly routeKey: string;
      readonly tokenIn: string;
      readonly tokenOut: string;
      readonly canonicalEdgeId: string;
    })
    .sort((left, right) => left.routeKey.localeCompare(right.routeKey))
    .map((value, order) => Object.freeze({
      id: value.canonicalEdgeId,
      value: Object.freeze({
        routeKey: value.routeKey,
        tokenIn: value.tokenIn,
        tokenOut: value.tokenOut,
        canonicalEdgeId: value.canonicalEdgeId,
        order,
      }),
    }));
  const exactMethod = etherTokenNativeRedeemExact.methods().find(
    (method) => method.kind === "request-program" &&
      method.id === "withdraw-effect-simulation",
  );
  if (exactMethod === undefined || exactMethod.kind !== "request-program") {
    throw new Error("ethertoken-native exact request program is missing");
  }
  const program = exactMethod.program;
  const exactByRouteKey = new Map<
    string,
    {
      readonly amountOut: bigint;
      readonly evidence: import("./venues/protocols/ethertoken-native-redeem-family/types.js")
        .EtherTokenNativeRedeemExactEvidence;
    }
  >();
  const exactQuotes: RawMigrationStageCapture["items"][number][] = [];
  const edgeByRouteKey = new Map(
    edges.map((edge) => {
      const value = edge.value as { readonly routeKey: string };
      return [value.routeKey, edge] as const;
    }),
  );
  for (const instance of publication.instances) {
    for (const route of [...instance.routes].sort(
      (left, right) => left.routeKey.localeCompare(right.routeKey),
    )) {
      const exactInput = Object.freeze({
        descriptor: instance.descriptor as unknown as
          EtherTokenNativeRedeemDescriptor,
        route: route as unknown as EtherTokenNativeRedeemRoute,
        amountIn: UNIV2_CAPTURE_EXACT_AMOUNT_IN,
        source: input.source,
        executor: MIGRATION_CAPTURE_EXECUTOR,
        runtimeEvidence: Object.freeze([]),
      });
      const requests = program.buildRequests(exactInput);
      const results = requests.map((request) =>
        etherTokenNativeSuccessResult(request, input.source)
      );
      const decoded = program.decode({
        programInput: exactInput,
        initialResults: results,
        dependentEvidence: Object.freeze([]),
      });
      const edge = edgeByRouteKey.get(route.routeKey);
      if (edge === undefined) {
        throw new Error(
          `ethertoken-native exact route ${route.routeKey} has no edge`,
        );
      }
      exactByRouteKey.set(route.routeKey, {
        amountOut: decoded.amountOut,
        evidence: decoded.evidence,
      });
      exactQuotes.push(Object.freeze({
        id: `${edge.id}\u001fexact:${UNIV2_CAPTURE_EXACT_AMOUNT_IN}`,
        value: Object.freeze({
          routeKey: route.routeKey,
          tokenIn: route.tokenIn,
          tokenOut: route.tokenOut,
          canonicalEdgeId: edge.id,
          amountIn: UNIV2_CAPTURE_EXACT_AMOUNT_IN.toString(),
          amountOut: decoded.amountOut.toString(),
          feeBps: "0",
        }),
      }));
    }
  }
  const executionFragments: RawMigrationStageCapture["items"][number][] = [];
  const finalSimulations: RawMigrationStageCapture["items"][number][] = [];
  for (const instance of publication.instances) {
    for (const route of [...instance.routes].sort(
      (left, right) => left.routeKey.localeCompare(right.routeKey),
    )) {
      const quote = exactByRouteKey.get(route.routeKey);
      const edge = edgeByRouteKey.get(route.routeKey);
      if (quote === undefined || edge === undefined) {
        throw new Error(
          `ethertoken-native execution route ${route.routeKey} has no quote`,
        );
      }
      const amountIn = UNIV2_CAPTURE_EXACT_AMOUNT_IN;
      const fragment = etherTokenNativeRedeemExecution.buildFragment({
        descriptor: instance.descriptor as unknown as
          EtherTokenNativeRedeemDescriptor,
        route: route as unknown as EtherTokenNativeRedeemRoute,
        amountIn,
        quotedAmountOut: quote.amountOut,
        minAmountOut: quote.amountOut,
        exactEvidence: quote.evidence,
        executor: MIGRATION_CAPTURE_EXECUTOR,
        runtimeEvidence: Object.freeze([]),
      });
      executionFragments.push(Object.freeze({
        id: `${edge.id}\u001fexec:${amountIn}`,
        value: Object.freeze({
          routeKey: route.routeKey,
          tokenIn: route.tokenIn,
          tokenOut: route.tokenOut,
          canonicalEdgeId: edge.id,
          amountIn: amountIn.toString(),
          amountOut: quote.amountOut.toString(),
          minAmountOut: quote.amountOut.toString(),
          actionAdapterId: "ethertoken-native-redeem",
          executionTarget: (
            instance.descriptor as unknown as EtherTokenNativeRedeemDescriptor
          ).token,
          nodeFingerprint: hashCanonical(
            fragment.nodes as unknown as CanonicalValue,
          ),
        }),
      }));
      const effects = etherTokenNativeRedeemExecution.expectedEffects({
        descriptor: instance.descriptor as unknown as
          EtherTokenNativeRedeemDescriptor,
        route: route as unknown as EtherTokenNativeRedeemRoute,
        amountIn,
        quotedAmountOut: quote.amountOut,
      });
      if (quote.amountOut <= 0n) {
        throw new Error(
          "ethertoken-native capture final simulation repayment failed",
        );
      }
      finalSimulations.push(Object.freeze({
        id: `${edge.id}\u001fsim:${amountIn}`,
        value: Object.freeze({
          routeKey: route.routeKey,
          tokenIn: route.tokenIn,
          tokenOut: route.tokenOut,
          canonicalEdgeId: edge.id,
          amountIn: amountIn.toString(),
          amountOut: quote.amountOut.toString(),
          minAmountOut: quote.amountOut.toString(),
          effectsFingerprint: hashCanonical(
            effects as unknown as CanonicalValue,
          ),
          conservation: "conserved",
          repayment: "satisfied",
          evInput: Object.freeze({
            amountIn: amountIn.toString(),
            amountOut: quote.amountOut.toString(),
          }),
        }),
      }));
    }
  }
  const instances = publication.instances;
  const summary = definedFamilyPluginContractSummary(family.plugin);
  return Object.freeze({
    familyId: ETHERTOKEN_NATIVE_FAMILY_ID,
    caseId: input.caseId ?? `ethertoken-native-redeem:${input.source.number}`,
    inputFingerprint: input.source.hash.slice(2).padStart(64, "0"),
    stateAnchorNumber: input.source.number,
    implementationClosureHash: summary.definitionBoundaryHash,
    stages: Object.freeze({
      instances: instanceStage(instances, evidenceRefs),
      edges: exercisedStage(edges, evidenceRefs),
      stateCoverage: exercisedStage([], evidenceRefs),
      pricedEdges: exercisedStage([], evidenceRefs),
      prices: exercisedStage(prices, evidenceRefs),
      failures: exercisedStage([], evidenceRefs),
      enumeratedRoutes: exercisedStage(enumeratedRoutes, evidenceRefs),
      exactQuotes: exercisedStage(exactQuotes, evidenceRefs),
      executionFragments: exercisedStage(executionFragments, evidenceRefs),
      finalSimulations: exercisedStage(finalSimulations, evidenceRefs),
    }),
  });
}

export const SELF_BURN_NATIVE_FIXTURE_TOKEN = `0x${"ae".repeat(20)}`;

function selfBurnNativeSimulationResult(
  request: AdapterRequest,
  canonical: CanonicalSource,
): AdapterRequestResult {
  if (request.kind !== "effect-delta-simulation") {
    throw new Error(
      `unexpected self-burn fixture transport ${request.kind}`,
    );
  }
  const callerRef = (request as {
    readonly call: {
      readonly caller: {
        readonly kind: string;
        readonly evidenceId?: string;
      };
    };
  }).call.caller;
  const actor = callerRef.kind === "verified-actor"
    ? callerRef.evidenceId === SELF_BURN_NATIVE_PROBE_ACTOR_EVIDENCE_ID
      ? SELF_BURN_NATIVE_PROBE_ACTOR
      : callerRef.evidenceId === SELF_BURN_NATIVE_PRICING_ACTOR_EVIDENCE_ID
        ? SELF_BURN_NATIVE_PRICING_ACTOR
        : (() => {
            throw new Error(
              `self-burn verified actor ${String(callerRef.evidenceId)} ` +
                "is unsupported",
            );
          })()
    : callerRef.kind === "executor"
      ? MIGRATION_CAPTURE_EXECUTOR
      : (() => {
          throw new Error(
            `self-burn fixture caller ${callerRef.kind} is unsupported`,
          );
        })();
  const amountIn = BigInt(
    SELF_BURN_NATIVE_TOKEN_INTERFACE.decodeFunctionData(
      "transfer",
      (request as { readonly call: { readonly data: string } }).call.data,
    )[1],
  );
  const token = SELF_BURN_NATIVE_FIXTURE_TOKEN.toLowerCase();
  return Object.freeze({
    id: request.id,
    ok: true as const,
    source: canonical,
    provenance: Object.freeze({
      kind: "migration-capture-fixture",
      fingerprint: `fixture:${request.id}`,
    }),
    completion: "returned" as const,
    data: SELF_BURN_NATIVE_TOKEN_INTERFACE.encodeFunctionResult(
      "transfer",
      [true],
    ),
    effects: Object.freeze({
      tokenDeltas: Object.freeze([
        Object.freeze({
          token,
          account: actor.toLowerCase(),
          delta: -amountIn,
        }),
      ]),
      nativeDeltas: Object.freeze([
        Object.freeze({
          account: actor.toLowerCase(),
          delta: amountIn,
        }),
      ]),
      totalSupplyDeltas: Object.freeze([
        Object.freeze({
          token,
          delta: -amountIn,
        }),
      ]),
      logs: Object.freeze([]),
    }),
  });
}

function selfBurnNativeSuccessResult(
  request: AdapterRequest,
  canonical: CanonicalSource,
): AdapterRequestResult {
  if (request.kind === "effect-delta-simulation") {
    return selfBurnNativeSimulationResult(request, canonical);
  }
  const data =
    request.id === "identity-token-code"
      ? "0x00"
      : request.id === "identity-token-balance-surface" ||
          request.id === "identity-token-supply"
        ? SELF_BURN_NATIVE_TOKEN_INTERFACE.encodeFunctionResult(
            request.id === "identity-token-balance-surface"
              ? "balanceOf"
              : "totalSupply",
            [10n ** 30n],
          )
        : request.id === "identity-token-decimals" ||
            request.id === "static-token-decimals"
          ? SELF_BURN_NATIVE_TOKEN_INTERFACE.encodeFunctionResult(
              "decimals",
              [18],
            )
          : (() => {
              throw new Error(
                "unexpected self-burn fixture request " + request.id,
              );
            })();
  return Object.freeze({
    id: request.id,
    ok: true as const,
    source: canonical,
    provenance: Object.freeze({
      kind: "migration-capture-fixture",
      fingerprint: `fixture:${request.id}`,
    }),
    completion: "returned" as const,
    data,
  });
}

class SelfBurnNativeFixtureScheduler implements CentralAdapterScheduler {
  issueExecutor(
    input: Parameters<CentralAdapterScheduler["issueExecutor"]>[0],
  ): ReturnType<CentralAdapterScheduler["issueExecutor"]> {
    const executor = createBoundedRequestExecutor({
      assertSupported: (requirements) => assert.deepEqual(
        requirements,
        input.requirements,
      ),
      assertCallerBinding() {},
      assertWithinBudget: (_familyId, requests) => {
        assert.deepEqual(requests, input.requests);
      },
      execute: async (execution) => Promise.all(execution.requests.map(
        (request) => selfBurnNativeSuccessResult(request, execution.source),
      )),
      sealStaticEvidenceReuseProof: () => ({ proofHash: "ab".repeat(32) }),
    });
    return Object.freeze({
      executor,
      timing: () => ({ queueWaitMs: 0, transportWallMs: 1, attempts: 1 }),
    });
  }
}

function selfBurnNativeFixtureRuntime(): CentralAdapterRuntime {
  let now = 1_000;
  return {
    clock: { nowMs: () => now++ },
    generationFence: new FixtureFence(),
    callerAuthority: {
      bind: (input) => input.callerRole === "verified-actor"
        ? Object.freeze({
            verifiedActors: Object.freeze({
              [SELF_BURN_NATIVE_PROBE_ACTOR_EVIDENCE_ID]:
                SELF_BURN_NATIVE_PROBE_ACTOR,
              [SELF_BURN_NATIVE_PRICING_ACTOR_EVIDENCE_ID]:
                SELF_BURN_NATIVE_PRICING_ACTOR,
            }),
          })
        : input.callerRole === "executor"
          ? Object.freeze({ executor: MIGRATION_CAPTURE_EXECUTOR })
          : Object.freeze({}),
    },
    policy: {
      bind: (input) => ({
        lane: input.stage === "identity" ? "critical-proof" : "background",
        deadlineAtMs: 100_000,
        maxAttempts: 1,
        transportPool: "state-read",
        fairnessKey: input.subjectKey,
      }),
    },
    budgets: { assertAdmitted() {} },
    scheduler: new SelfBurnNativeFixtureScheduler(),
  };
}

async function runSelfBurnNativeLifecycle(
  canonical: CanonicalSource,
): Promise<AdapterFamilyPublication> {
  const family = PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG.forFamily(
    SELF_BURN_NATIVE_FAMILY_ID,
  );
  let publication: AdapterFamilyPublication | null = null;
  const transferCalldata = SELF_BURN_NATIVE_TOKEN_INTERFACE.encodeFunctionData(
    "transfer",
    [SELF_BURN_NATIVE_FIXTURE_TOKEN, 1_000_000n],
  );
  const result = await executeAdapterFamilyLifecycleBatch({
    family,
    matches: [Object.freeze({
      matchedPatternId: "self-burn-transfer-self",
      observation: Object.freeze({
        kind: "call" as const,
        source: canonical,
        target: SELF_BURN_NATIVE_FIXTURE_TOKEN,
        data: transferCalldata,
      }),
    })],
    source: canonical,
    generation: canonical.generation,
    runtime: selfBurnNativeFixtureRuntime(),
    publisher: { publish: (value) => { publication = value; } },
  });
  assert(result.publication);
  assert(publication);
  return publication;
}

/**
 * Runs the self-burn native lifecycle over the observed transfer-self
 * fixture: active effect-delta proof, probe-based variable-native-out
 * pricing, exact burn simulation and a two-node redeem + WETH deposit
 * execution fragment.
 */
export async function captureSelfBurnNativeFixtureCase(input: {
  readonly source: CanonicalSource;
  readonly caseId?: string;
}): Promise<RawFamilyMigrationCaseCapture> {
  const publication = await runSelfBurnNativeLifecycle(input.source);
  const evidenceRefs = Object.freeze([
    `fixture:self-burn-native:${input.source.number}:${input.source.hash}`,
  ]);
  const family = PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG.forFamily(
    SELF_BURN_NATIVE_FAMILY_ID,
  );
  const edges: RawMigrationStageCapture["items"][number][] = [];
  const prices: RawMigrationStageCapture["items"][number][] = [];
  for (const instance of publication.instances) {
    for (const route of instance.routes) {
      const handle = instance.routeHandles.find((candidate) =>
        candidate.routeKey === route.routeKey
      );
      if (handle === undefined) {
        throw new Error(
          `prepared route ${route.routeKey} has no issued handle`,
        );
      }
      const projected = projectFamilyRouteGraph({
        family,
        descriptor: instance.descriptor,
        route,
        handle,
      });
      edges.push(Object.freeze({
        id: projected.edge.canonicalEdgeId,
        value: Object.freeze({
          routeKey: route.routeKey,
          tokenIn: route.tokenIn,
          tokenOut: route.tokenOut,
          canonicalEdgeId: projected.edge.canonicalEdgeId,
        }),
      }));
    }
    const routeByKey = new Map(
      instance.routes.map((route) => [route.routeKey, route]),
    );
    for (const pricing of instance.pricingInstances) {
      for (const [routeKey, mid] of pricing.mids) {
        const route = routeByKey.get(routeKey);
        if (route === undefined) {
          throw new Error(
            `self-burn-native pricing route ${routeKey} is missing`,
          );
        }
        prices.push(Object.freeze({
          id: `${pricing.stateKey}:${route.tokenIn.toLowerCase()}>` +
            `${route.tokenOut.toLowerCase()}`,
          value: Object.freeze({
            stateKey: pricing.stateKey,
            mid: Object.freeze({ ...mid }),
          }) as unknown as RawMigrationStageCapture["items"][number]["value"],
        }));
      }
    }
  }
  const enumeratedRoutes: RawMigrationStageCapture["items"][number][] = edges
    .map((edge) => edge.value as {
      readonly routeKey: string;
      readonly tokenIn: string;
      readonly tokenOut: string;
      readonly canonicalEdgeId: string;
    })
    .sort((left, right) => left.routeKey.localeCompare(right.routeKey))
    .map((value, order) => Object.freeze({
      id: value.canonicalEdgeId,
      value: Object.freeze({
        routeKey: value.routeKey,
        tokenIn: value.tokenIn,
        tokenOut: value.tokenOut,
        canonicalEdgeId: value.canonicalEdgeId,
        order,
      }),
    }));
  const exactMethod = selfBurnNativeExact.methods().find(
    (method) => method.kind === "request-program" &&
      method.id === "burn-effect-simulation",
  );
  if (exactMethod === undefined || exactMethod.kind !== "request-program") {
    throw new Error("self-burn-native exact request program is missing");
  }
  const program = exactMethod.program;
  const exactByRouteKey = new Map<
    string,
    {
      readonly amountOut: bigint;
      readonly evidence: import("./venues/protocols/self-burn-native-family/types.js")
        .SelfBurnNativeExactEvidence;
    }
  >();
  const exactQuotes: RawMigrationStageCapture["items"][number][] = [];
  const edgeByRouteKey = new Map(
    edges.map((edge) => {
      const value = edge.value as { readonly routeKey: string };
      return [value.routeKey, edge] as const;
    }),
  );
  for (const instance of publication.instances) {
    for (const route of [...instance.routes].sort(
      (left, right) => left.routeKey.localeCompare(right.routeKey),
    )) {
      const exactInput = Object.freeze({
        descriptor: instance.descriptor as unknown as SelfBurnNativeDescriptor,
        route: route as unknown as SelfBurnNativeRoute,
        amountIn: UNIV2_CAPTURE_EXACT_AMOUNT_IN,
        source: input.source,
        executor: MIGRATION_CAPTURE_EXECUTOR,
        runtimeEvidence: Object.freeze([]),
      });
      const requests = program.buildRequests(exactInput);
      const results = requests.map((request) =>
        selfBurnNativeSuccessResult(request, input.source)
      );
      const decoded = program.decode({
        programInput: exactInput,
        initialResults: results,
        dependentEvidence: Object.freeze([]),
      });
      const edge = edgeByRouteKey.get(route.routeKey);
      if (edge === undefined) {
        throw new Error(
          `self-burn-native exact route ${route.routeKey} has no edge`,
        );
      }
      exactByRouteKey.set(route.routeKey, {
        amountOut: decoded.amountOut,
        evidence: decoded.evidence,
      });
      exactQuotes.push(Object.freeze({
        id: `${edge.id}\u001fexact:${UNIV2_CAPTURE_EXACT_AMOUNT_IN}`,
        value: Object.freeze({
          routeKey: route.routeKey,
          tokenIn: route.tokenIn,
          tokenOut: route.tokenOut,
          canonicalEdgeId: edge.id,
          amountIn: UNIV2_CAPTURE_EXACT_AMOUNT_IN.toString(),
          amountOut: decoded.amountOut.toString(),
          feeBps: "0",
        }),
      }));
    }
  }
  const executionFragments: RawMigrationStageCapture["items"][number][] = [];
  const finalSimulations: RawMigrationStageCapture["items"][number][] = [];
  for (const instance of publication.instances) {
    for (const route of [...instance.routes].sort(
      (left, right) => left.routeKey.localeCompare(right.routeKey),
    )) {
      const quote = exactByRouteKey.get(route.routeKey);
      const edge = edgeByRouteKey.get(route.routeKey);
      if (quote === undefined || edge === undefined) {
        throw new Error(
          `self-burn-native execution route ${route.routeKey} has no quote`,
        );
      }
      const amountIn = UNIV2_CAPTURE_EXACT_AMOUNT_IN;
      const fragment = selfBurnNativeExecution.buildFragment({
        descriptor: instance.descriptor as unknown as SelfBurnNativeDescriptor,
        route: route as unknown as SelfBurnNativeRoute,
        amountIn,
        quotedAmountOut: quote.amountOut,
        minAmountOut: quote.amountOut,
        exactEvidence: quote.evidence,
        executor: MIGRATION_CAPTURE_EXECUTOR,
        runtimeEvidence: Object.freeze([]),
      });
      executionFragments.push(Object.freeze({
        id: `${edge.id}\u001fexec:${amountIn}`,
        value: Object.freeze({
          routeKey: route.routeKey,
          tokenIn: route.tokenIn,
          tokenOut: route.tokenOut,
          canonicalEdgeId: edge.id,
          amountIn: amountIn.toString(),
          amountOut: quote.amountOut.toString(),
          minAmountOut: quote.amountOut.toString(),
          actionAdapterId: "self-burn-native-redeem",
          executionTarget: (
            instance.descriptor as unknown as SelfBurnNativeDescriptor
          ).token,
          nodeFingerprint: hashCanonical(
            fragment.nodes as unknown as CanonicalValue,
          ),
        }),
      }));
      const effects = selfBurnNativeExecution.expectedEffects({
        descriptor: instance.descriptor as unknown as SelfBurnNativeDescriptor,
        route: route as unknown as SelfBurnNativeRoute,
        amountIn,
        quotedAmountOut: quote.amountOut,
      });
      if (quote.amountOut <= 0n) {
        throw new Error(
          "self-burn-native capture final simulation repayment failed",
        );
      }
      finalSimulations.push(Object.freeze({
        id: `${edge.id}\u001fsim:${amountIn}`,
        value: Object.freeze({
          routeKey: route.routeKey,
          tokenIn: route.tokenIn,
          tokenOut: route.tokenOut,
          canonicalEdgeId: edge.id,
          amountIn: amountIn.toString(),
          amountOut: quote.amountOut.toString(),
          minAmountOut: quote.amountOut.toString(),
          effectsFingerprint: hashCanonical(
            effects as unknown as CanonicalValue,
          ),
          conservation: "conserved",
          repayment: "satisfied",
          evInput: Object.freeze({
            amountIn: amountIn.toString(),
            amountOut: quote.amountOut.toString(),
          }),
        }),
      }));
    }
  }
  const instances = publication.instances;
  const summary = definedFamilyPluginContractSummary(family.plugin);
  return Object.freeze({
    familyId: SELF_BURN_NATIVE_FAMILY_ID,
    caseId: input.caseId ?? `self-burn-native:${input.source.number}`,
    inputFingerprint: input.source.hash.slice(2).padStart(64, "0"),
    stateAnchorNumber: input.source.number,
    implementationClosureHash: summary.definitionBoundaryHash,
    stages: Object.freeze({
      instances: instanceStage(instances, evidenceRefs),
      edges: exercisedStage(edges, evidenceRefs),
      stateCoverage: exercisedStage([], evidenceRefs),
      pricedEdges: exercisedStage([], evidenceRefs),
      prices: exercisedStage(prices, evidenceRefs),
      failures: exercisedStage([], evidenceRefs),
      enumeratedRoutes: exercisedStage(enumeratedRoutes, evidenceRefs),
      exactQuotes: exercisedStage(exactQuotes, evidenceRefs),
      executionFragments: exercisedStage(executionFragments, evidenceRefs),
      finalSimulations: exercisedStage(finalSimulations, evidenceRefs),
    }),
  });
}

export const ASTRA_MULTITOKEN_FIXTURE_TARGET = `0x${"af".repeat(20)}`;
export const ASTRA_MULTITOKEN_FIXTURE_TOKEN_IN = `0x${"ba".repeat(20)}`;
export const ASTRA_MULTITOKEN_FIXTURE_TOKEN_OUT = `0x${"bb".repeat(20)}`;

function astraChangeLog(
  target: string,
  tokenIn: string,
  tokenOut: string,
  actor: string,
  amountIn: bigint,
  amountOut: bigint,
) {
  const log = ASTRA_MULTITOKEN_INTERFACE.encodeEventLog(
    "Change",
    [tokenIn, tokenOut, actor, amountIn, amountOut],
  );
  return Object.freeze({
    address: target.toLowerCase(),
    topics: Object.freeze([...log.topics]),
    data: log.data,
  });
}

function astraSimulationResult(
  request: AdapterRequest,
  canonical: CanonicalSource,
): AdapterRequestResult {
  if (request.kind !== "effect-delta-simulation") {
    throw new Error(`unexpected astra fixture transport ${request.kind}`);
  }
  const decoded = ASTRA_MULTITOKEN_INTERFACE.decodeFunctionData(
    "change",
    (request as { readonly call: { readonly data: string } }).call.data,
  );
  const tokenIn = ASTRA_MULTITOKEN_FIXTURE_TOKEN_IN.toLowerCase();
  const tokenOut = ASTRA_MULTITOKEN_FIXTURE_TOKEN_OUT.toLowerCase();
  const target = ASTRA_MULTITOKEN_FIXTURE_TARGET.toLowerCase();
  const actor = MIGRATION_CAPTURE_EXECUTOR.toLowerCase();
  const amountIn = BigInt(decoded[2]);
  const amountOut = amountIn;
  return Object.freeze({
    id: request.id,
    ok: true as const,
    source: canonical,
    provenance: Object.freeze({
      kind: "migration-capture-fixture",
      fingerprint: `fixture:${request.id}`,
    }),
    completion: "returned" as const,
    data: ASTRA_MULTITOKEN_INTERFACE.encodeFunctionResult(
      "change",
      [amountOut],
    ),
    effects: Object.freeze({
      tokenDeltas: Object.freeze([
        Object.freeze({ token: tokenIn, account: actor, delta: -amountIn }),
        Object.freeze({ token: tokenIn, account: target, delta: amountIn }),
        Object.freeze({ token: tokenOut, account: actor, delta: amountOut }),
        Object.freeze({ token: tokenOut, account: target, delta: -amountOut }),
      ]),
      logs: Object.freeze([
        astraChangeLog(
          ASTRA_MULTITOKEN_FIXTURE_TARGET,
          ASTRA_MULTITOKEN_FIXTURE_TOKEN_IN,
          ASTRA_MULTITOKEN_FIXTURE_TOKEN_OUT,
          MIGRATION_CAPTURE_EXECUTOR,
          amountIn,
          amountOut,
        ),
      ]),
    }),
  });
}

function astraSuccessResult(
  request: AdapterRequest,
  canonical: CanonicalSource,
): AdapterRequestResult {
  if (request.kind === "effect-delta-simulation") {
    return astraSimulationResult(request, canonical);
  }
  if (request.kind === "get-code") {
    return Object.freeze({
      id: request.id,
      ok: true as const,
      source: canonical,
      provenance: Object.freeze({
        kind: "migration-capture-fixture",
        fingerprint: `fixture:${request.id}`,
      }),
      completion: "returned" as const,
      data: "0x00",
    });
  }
  const data =
    request.id === "surface-primary-interface" ||
        request.id === "surface-base-interface"
      ? ASTRA_MULTITOKEN_INTERFACE.encodeFunctionResult(
          "supportsInterface",
          [true],
        )
      : request.id === "surface-lending-mode"
        ? ASTRA_MULTITOKEN_INTERFACE.encodeFunctionResult(
            "inLendingMode",
            [0n],
          )
        : request.id === "surface-token-count"
          ? ASTRA_MULTITOKEN_INTERFACE.encodeFunctionResult(
              "tokensCount",
              [2n],
            )
          : request.id === "surface-changes-enabled"
            ? ASTRA_MULTITOKEN_INTERFACE.encodeFunctionResult(
                "changesEnabled",
                [true],
              )
            : request.id === "surface-change-fee"
              ? ASTRA_MULTITOKEN_INTERFACE.encodeFunctionResult(
                  "changeFee",
                  [0n],
                )
              : request.id === "surface-total-percents"
                ? ASTRA_MULTITOKEN_INTERFACE.encodeFunctionResult(
                    "TOTAL_PERCRENTS",
                    [10_000n],
                  )
                : request.id === "registry-token:0"
                  ? ASTRA_MULTITOKEN_INTERFACE.encodeFunctionResult(
                      "tokens",
                      [ASTRA_MULTITOKEN_FIXTURE_TOKEN_IN],
                    )
                  : request.id === "registry-token:1"
                    ? ASTRA_MULTITOKEN_INTERFACE.encodeFunctionResult(
                        "tokens",
                        [ASTRA_MULTITOKEN_FIXTURE_TOKEN_OUT],
                      )
                    : request.id === "registry-weight:0" ||
                        request.id === "registry-weight:1"
                      ? ASTRA_MULTITOKEN_INTERFACE.encodeFunctionResult(
                          "weights",
                          [5_000n],
                        )
                      : request.id === "behavior-zero-quote" ||
                          request.id === "behavior-active-quote" ||
                          request.id === "current-get-return" ||
                          request.id === "exact-get-return"
                        ? (() => {
                            const decoded =
                              ASTRA_MULTITOKEN_INTERFACE.decodeFunctionData(
                                "getReturn",
                                (request as { readonly data: string }).data,
                              );
                            const amountIn = BigInt(decoded[2]);
                            return ASTRA_MULTITOKEN_INTERFACE
                              .encodeFunctionResult(
                                "getReturn",
                                [request.id === "behavior-zero-quote"
                                  ? 0n
                                  : amountIn],
                              );
                          })()
                        : request.id === "static-token-in-decimals"
                          ? ASTRA_ERC20_INTERFACE.encodeFunctionResult(
                              "decimals",
                              [18],
                            )
                          : (() => {
                              throw new Error(
                                "unexpected astra fixture request " +
                                  request.id,
                              );
                            })();
  return Object.freeze({
    id: request.id,
    ok: true as const,
    source: canonical,
    provenance: Object.freeze({
      kind: "migration-capture-fixture",
      fingerprint: `fixture:${request.id}`,
    }),
    completion: "returned" as const,
    data,
  });
}

class AstraFixtureScheduler implements CentralAdapterScheduler {
  issueExecutor(
    input: Parameters<CentralAdapterScheduler["issueExecutor"]>[0],
  ): ReturnType<CentralAdapterScheduler["issueExecutor"]> {
    const executor = createBoundedRequestExecutor({
      assertSupported: (requirements) => assert.deepEqual(
        requirements,
        input.requirements,
      ),
      assertCallerBinding() {},
      assertWithinBudget: (_familyId, requests) => {
        assert.deepEqual(requests, input.requests);
      },
      execute: async (execution) => Promise.all(execution.requests.map(
        (request) => astraSuccessResult(request, execution.source),
      )),
      sealStaticEvidenceReuseProof: () => ({ proofHash: "ab".repeat(32) }),
    });
    return Object.freeze({
      executor,
      timing: () => ({ queueWaitMs: 0, transportWallMs: 1, attempts: 1 }),
    });
  }
}

export function astraFixtureRuntime(): CentralAdapterRuntime {
  let now = 1_000;
  return {
    clock: { nowMs: () => now++ },
    generationFence: new FixtureFence(),
    callerAuthority: {
      bind: (input) => input.callerRole === "observed-sender"
        ? Object.freeze({ observedSender: MIGRATION_CAPTURE_EXECUTOR })
        : Object.freeze({}),
    },
    policy: {
      bind: (input) => ({
        lane: input.stage === "identity" ? "critical-proof" : "background",
        deadlineAtMs: 100_000,
        maxAttempts: 1,
        transportPool: "state-read",
        fairnessKey: input.subjectKey,
      }),
    },
    budgets: { assertAdmitted() {} },
    scheduler: new AstraFixtureScheduler(),
  };
}

async function runAstraLifecycle(
  canonical: CanonicalSource,
  target: string,
  tokenIn: string,
  tokenOut: string,
  runtime: CentralAdapterRuntime,
): Promise<AdapterFamilyPublication> {
  const family = PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG.forFamily(
    ASTRA_MULTITOKEN_FAMILY_ID,
  );
  let publication: AdapterFamilyPublication | null = null;
  const changeCalldata = ASTRA_MULTITOKEN_INTERFACE.encodeFunctionData(
    "change",
    [
      tokenIn,
      tokenOut,
      1_000_000n,
      0n,
    ],
  );
  const result = await executeAdapterFamilyLifecycleBatch({
    family,
    matches: [Object.freeze({
      matchedPatternId: "astra-multitoken-change-call",
      observation: Object.freeze({
        kind: "call" as const,
        source: canonical,
        target: target.toLowerCase(),
        data: changeCalldata,
        sender: MIGRATION_CAPTURE_EXECUTOR,
      }),
    })],
    source: canonical,
    generation: canonical.generation,
    runtime,
    publisher: { publish: (value) => { publication = value; } },
  });
  assert(result.publication);
  assert(publication);
  return publication;
}

/**
 * Runs the astra-multitoken registry lifecycle over the observed change
 * fixture: surface -> registry -> active-behavior identity proof with the
 * observed sender, two registry tokens and two directed convert routes.
 */
async function buildAstraCaseCapture(input: {
  readonly source: CanonicalSource;
  readonly publication: AdapterFamilyPublication;
  readonly evidenceRefs: readonly string[];
  readonly caseId?: string;
}): Promise<RawFamilyMigrationCaseCapture> {
  const { publication, evidenceRefs } = input;
  const family = PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG.forFamily(
    ASTRA_MULTITOKEN_FAMILY_ID,
  );
  const edges: RawMigrationStageCapture["items"][number][] = [];
  const prices: RawMigrationStageCapture["items"][number][] = [];
  for (const instance of publication.instances) {
    for (const route of instance.routes) {
      const handle = instance.routeHandles.find((candidate) =>
        candidate.routeKey === route.routeKey
      );
      if (handle === undefined) {
        throw new Error(
          `prepared route ${route.routeKey} has no issued handle`,
        );
      }
      const projected = projectFamilyRouteGraph({
        family,
        descriptor: instance.descriptor,
        route,
        handle,
      });
      edges.push(Object.freeze({
        id: projected.edge.canonicalEdgeId,
        value: Object.freeze({
          routeKey: route.routeKey,
          tokenIn: route.tokenIn,
          tokenOut: route.tokenOut,
          canonicalEdgeId: projected.edge.canonicalEdgeId,
        }),
      }));
    }
    const routeByKey = new Map(
      instance.routes.map((route) => [route.routeKey, route]),
    );
    for (const pricing of instance.pricingInstances) {
      for (const [routeKey, mid] of pricing.mids) {
        const route = routeByKey.get(routeKey);
        if (route === undefined) {
          throw new Error(
            `astra-multitoken pricing route ${routeKey} is missing`,
          );
        }
        prices.push(Object.freeze({
          id: `${pricing.stateKey}:${route.tokenIn.toLowerCase()}>` +
            `${route.tokenOut.toLowerCase()}`,
          value: Object.freeze({
            stateKey: pricing.stateKey,
            mid: Object.freeze({ ...mid }),
          }) as unknown as RawMigrationStageCapture["items"][number]["value"],
        }));
      }
    }
  }
  const enumeratedRoutes: RawMigrationStageCapture["items"][number][] = edges
    .map((edge) => edge.value as {
      readonly routeKey: string;
      readonly tokenIn: string;
      readonly tokenOut: string;
      readonly canonicalEdgeId: string;
    })
    .sort((left, right) => left.routeKey.localeCompare(right.routeKey))
    .map((value, order) => Object.freeze({
      id: value.canonicalEdgeId,
      value: Object.freeze({
        routeKey: value.routeKey,
        tokenIn: value.tokenIn,
        tokenOut: value.tokenOut,
        canonicalEdgeId: value.canonicalEdgeId,
        order,
      }),
    }));
  const exactMethod = astraMultiTokenExact.methods().find(
    (method) => method.kind === "request-program" &&
      method.id === "get-return",
  );
  if (exactMethod === undefined || exactMethod.kind !== "request-program") {
    throw new Error("astra-multitoken exact request program is missing");
  }
  const program = exactMethod.program;
  const exactByRouteKey = new Map<
    string,
    {
      readonly amountOut: bigint;
      readonly evidence: import("./venues/protocols/astra-multitoken-family/types.js")
        .AstraMultiTokenExactEvidence;
    }
  >();
  const exactQuotes: RawMigrationStageCapture["items"][number][] = [];
  const edgeByRouteKey = new Map(
    edges.map((edge) => {
      const value = edge.value as { readonly routeKey: string };
      return [value.routeKey, edge] as const;
    }),
  );
  for (const instance of publication.instances) {
    for (const route of [...instance.routes].sort(
      (left, right) => left.routeKey.localeCompare(right.routeKey),
    )) {
      const exactInput = Object.freeze({
        descriptor: instance.descriptor as unknown as AstraMultiTokenDescriptor,
        route: route as unknown as AstraMultiTokenRoute,
        amountIn: UNIV2_CAPTURE_EXACT_AMOUNT_IN,
        source: input.source,
        executor: MIGRATION_CAPTURE_EXECUTOR,
        runtimeEvidence: Object.freeze([]),
      });
      const requests = program.buildRequests(exactInput);
      const results = requests.map((request) =>
        astraSuccessResult(request, input.source)
      );
      const decoded = program.decode({
        programInput: exactInput,
        initialResults: results,
        dependentEvidence: Object.freeze([]),
      });
      const edge = edgeByRouteKey.get(route.routeKey);
      if (edge === undefined) {
        throw new Error(
          `astra-multitoken exact route ${route.routeKey} has no edge`,
        );
      }
      exactByRouteKey.set(route.routeKey, {
        amountOut: decoded.amountOut,
        evidence: decoded.evidence,
      });
      exactQuotes.push(Object.freeze({
        id: `${edge.id}\u001fexact:${UNIV2_CAPTURE_EXACT_AMOUNT_IN}`,
        value: Object.freeze({
          routeKey: route.routeKey,
          tokenIn: route.tokenIn,
          tokenOut: route.tokenOut,
          canonicalEdgeId: edge.id,
          amountIn: UNIV2_CAPTURE_EXACT_AMOUNT_IN.toString(),
          amountOut: decoded.amountOut.toString(),
          feeBps: "0",
        }),
      }));
    }
  }
  const executionFragments: RawMigrationStageCapture["items"][number][] = [];
  const finalSimulations: RawMigrationStageCapture["items"][number][] = [];
  for (const instance of publication.instances) {
    for (const route of [...instance.routes].sort(
      (left, right) => left.routeKey.localeCompare(right.routeKey),
    )) {
      const quote = exactByRouteKey.get(route.routeKey);
      const edge = edgeByRouteKey.get(route.routeKey);
      if (quote === undefined || edge === undefined) {
        throw new Error(
          `astra-multitoken execution route ${route.routeKey} has no quote`,
        );
      }
      const amountIn = UNIV2_CAPTURE_EXACT_AMOUNT_IN;
      const fragment = astraMultiTokenExecution.buildFragment({
        descriptor: instance.descriptor as unknown as AstraMultiTokenDescriptor,
        route: route as unknown as AstraMultiTokenRoute,
        amountIn,
        quotedAmountOut: quote.amountOut,
        minAmountOut: quote.amountOut,
        exactEvidence: quote.evidence,
        executor: MIGRATION_CAPTURE_EXECUTOR,
        runtimeEvidence: Object.freeze([]),
      });
      executionFragments.push(Object.freeze({
        id: `${edge.id}\u001fexec:${amountIn}`,
        value: Object.freeze({
          routeKey: route.routeKey,
          tokenIn: route.tokenIn,
          tokenOut: route.tokenOut,
          canonicalEdgeId: edge.id,
          amountIn: amountIn.toString(),
          amountOut: quote.amountOut.toString(),
          minAmountOut: quote.amountOut.toString(),
          actionAdapterId: "astra-multitoken-change",
          executionTarget: (
            instance.descriptor as unknown as AstraMultiTokenDescriptor
          ).target,
          nodeFingerprint: hashCanonical(
            fragment.nodes as unknown as CanonicalValue,
          ),
        }),
      }));
      const effects = astraMultiTokenExecution.expectedEffects({
        descriptor: instance.descriptor as unknown as AstraMultiTokenDescriptor,
        route: route as unknown as AstraMultiTokenRoute,
        amountIn,
        quotedAmountOut: quote.amountOut,
      });
      if (quote.amountOut <= 0n) {
        throw new Error(
          "astra-multitoken capture final simulation repayment failed",
        );
      }
      finalSimulations.push(Object.freeze({
        id: `${edge.id}\u001fsim:${amountIn}`,
        value: Object.freeze({
          routeKey: route.routeKey,
          tokenIn: route.tokenIn,
          tokenOut: route.tokenOut,
          canonicalEdgeId: edge.id,
          amountIn: amountIn.toString(),
          amountOut: quote.amountOut.toString(),
          minAmountOut: quote.amountOut.toString(),
          effectsFingerprint: hashCanonical(
            effects as unknown as CanonicalValue,
          ),
          conservation: "conserved",
          repayment: "satisfied",
          evInput: Object.freeze({
            amountIn: amountIn.toString(),
            amountOut: quote.amountOut.toString(),
          }),
        }),
      }));
    }
  }
  const instances = publication.instances;
  const summary = definedFamilyPluginContractSummary(family.plugin);
  return Object.freeze({
    familyId: ASTRA_MULTITOKEN_FAMILY_ID,
    caseId: input.caseId ?? `astra-multitoken:${input.source.number}`,
    inputFingerprint: input.source.hash.slice(2).padStart(64, "0"),
    stateAnchorNumber: input.source.number,
    implementationClosureHash: summary.definitionBoundaryHash,
    stages: Object.freeze({
      instances: instanceStage(instances, evidenceRefs),
      edges: exercisedStage(edges, evidenceRefs),
      stateCoverage: exercisedStage([], evidenceRefs),
      pricedEdges: exercisedStage([], evidenceRefs),
      prices: exercisedStage(prices, evidenceRefs),
      failures: exercisedStage([], evidenceRefs),
      enumeratedRoutes: exercisedStage(enumeratedRoutes, evidenceRefs),
      exactQuotes: exercisedStage(exactQuotes, evidenceRefs),
      executionFragments: exercisedStage(executionFragments, evidenceRefs),
      finalSimulations: exercisedStage(finalSimulations, evidenceRefs),
    }),
  });
}

export async function captureAstraMultiTokenFixtureCase(input: {
  readonly source: CanonicalSource;
  readonly caseId?: string;
}): Promise<RawFamilyMigrationCaseCapture> {
  const publication = await runAstraLifecycle(
    input.source,
    ASTRA_MULTITOKEN_FIXTURE_TARGET,
    ASTRA_MULTITOKEN_FIXTURE_TOKEN_IN,
    ASTRA_MULTITOKEN_FIXTURE_TOKEN_OUT,
    astraFixtureRuntime(),
  );
  return buildAstraCaseCapture({
    source: input.source,
    caseId: input.caseId,
    publication,
    evidenceRefs: Object.freeze([
      `fixture:astra-multitoken:${input.source.number}:${input.source.hash}`,
    ]),
  });
}

/**
 * Real on-chain astra-multitoken capture: registry tokens(0)/tokens(1) are
 * read at the canonical source block and must match the supplied tokens.
 * Fail-closed on empty reads or any divergence.
 */
export async function captureAstraOnchainCase(input: {
  readonly source: CanonicalSource;
  readonly provider: OnchainUniv2Provider;
  readonly target: string;
  readonly tokenIn: string;
  readonly tokenOut: string;
  readonly caseId?: string;
  readonly runtime: CentralAdapterRuntime;
}): Promise<RawFamilyMigrationCaseCapture> {
  const target = input.target.toLowerCase();
  const readToken = async (index: number): Promise<string> => {
    const raw = await input.provider.call({
      to: target,
      data: ASTRA_MULTITOKEN_INTERFACE.encodeFunctionData("tokens", [index]),
    }, input.source.number);
    if (raw === "0x" || raw.length < 2) {
      throw new Error(
        `astra tokens(${index}) read empty at ${input.source.number}`,
      );
    }
    return (
      ASTRA_MULTITOKEN_INTERFACE.decodeFunctionResult("tokens", raw)[0] as string
    ).toLowerCase();
  };
  const [token0, token1] = await Promise.all([
    readToken(0),
    readToken(1),
  ]);
  if (
    token0 === "0x0000000000000000000000000000000000000000" ||
    token1 === "0x0000000000000000000000000000000000000000"
  ) {
    throw new Error("astra registry reports a zero token");
  }
  if (
    token0 !== input.tokenIn.toLowerCase() ||
    token1 !== input.tokenOut.toLowerCase()
  ) {
    throw new Error("astra onchain registry token mismatch");
  }
  const publication = await runAstraLifecycle(
    input.source,
    target,
    token0,
    token1,
    input.runtime,
  );
  return buildAstraCaseCapture({
    source: input.source,
    caseId: input.caseId,
    publication,
    evidenceRefs: Object.freeze([
      `onchain:1:${input.source.hash}:astra-multitoken:${target}`,
    ]),
  });
}

export const EIGENPIE_FIXTURE_TARGET = `0x${"ca".repeat(20)}`;
export const EIGENPIE_FIXTURE_ASSET = `0x${"cb".repeat(20)}`;
export const EIGENPIE_FIXTURE_RECEIPT = `0x${"cc".repeat(20)}`;

function eigenpieDepositLog(
  amountIn: bigint,
  amountOut: bigint,
) {
  const log = EIGENPIE_INTERFACE.encodeEventLog(
    "AssetDeposit",
    [
      MIGRATION_CAPTURE_EXECUTOR,
      EIGENPIE_FIXTURE_ASSET,
      amountIn,
      `0x${"00".repeat(20)}`,
      amountOut,
      false,
    ],
  );
  return Object.freeze({
    address: EIGENPIE_FIXTURE_TARGET.toLowerCase(),
    topics: Object.freeze([...log.topics]),
    data: log.data,
  });
}

function eigenpieSimulationResult(
  request: AdapterRequest,
  canonical: CanonicalSource,
): AdapterRequestResult {
  if (request.kind !== "effect-delta-simulation") {
    throw new Error(`unexpected eigenpie fixture transport ${request.kind}`);
  }
  const decoded = EIGENPIE_INTERFACE.decodeFunctionData(
    "depositAsset",
    (request as { readonly call: { readonly data: string } }).call.data,
  );
  const amountIn = BigInt(decoded[1]);
  const amountOut = amountIn;
  const actor = MIGRATION_CAPTURE_EXECUTOR.toLowerCase();
  const asset = EIGENPIE_FIXTURE_ASSET.toLowerCase();
  const receipt = EIGENPIE_FIXTURE_RECEIPT.toLowerCase();
  return Object.freeze({
    id: request.id,
    ok: true as const,
    source: canonical,
    provenance: Object.freeze({
      kind: "migration-capture-fixture",
      fingerprint: `fixture:${request.id}`,
    }),
    completion: "returned" as const,
    data: EIGENPIE_INTERFACE.encodeFunctionResult("depositAsset", []),
    effects: Object.freeze({
      tokenDeltas: Object.freeze([
        Object.freeze({ token: asset, account: actor, delta: -amountIn }),
        Object.freeze({ token: receipt, account: actor, delta: amountOut }),
      ]),
      totalSupplyDeltas: Object.freeze([
        Object.freeze({ token: receipt, delta: amountOut }),
      ]),
      logs: Object.freeze([eigenpieDepositLog(amountIn, amountOut)]),
    }),
  });
}

function eigenpieSuccessResult(
  request: AdapterRequest,
  canonical: CanonicalSource,
): AdapterRequestResult {
  if (request.kind === "effect-delta-simulation") {
    return eigenpieSimulationResult(request, canonical);
  }
  const data =
    request.kind === "get-code"
      ? "0x00"
      : request.id === "identity-quote" ||
          request.id === "current-quote" ||
          request.id === "exact-quote"
        ? (() => {
            const functionName = "getMLRTAmountToMint";
            const amountIn = BigInt(
              EIGENPIE_INTERFACE.decodeFunctionData(
                functionName,
                (request as { readonly data: string }).data,
              )[1],
            );
            return EIGENPIE_INTERFACE.encodeFunctionResult(functionName, [
              amountIn,
              EIGENPIE_FIXTURE_RECEIPT,
            ]);
          })()
        : request.id === "static-asset-decimals"
          ? EIGENPIE_ERC20_INTERFACE.encodeFunctionResult("decimals", [18])
          : (() => {
              throw new Error(
                "unexpected eigenpie fixture request " + request.id,
              );
            })();
  return Object.freeze({
    id: request.id,
    ok: true as const,
    source: canonical,
    provenance: Object.freeze({
      kind: "migration-capture-fixture",
      fingerprint: `fixture:${request.id}`,
    }),
    completion: "returned" as const,
    data,
  });
}

class EigenpieFixtureScheduler implements CentralAdapterScheduler {
  issueExecutor(
    input: Parameters<CentralAdapterScheduler["issueExecutor"]>[0],
  ): ReturnType<CentralAdapterScheduler["issueExecutor"]> {
    const executor = createBoundedRequestExecutor({
      assertSupported: (requirements) => assert.deepEqual(
        requirements,
        input.requirements,
      ),
      assertCallerBinding() {},
      assertWithinBudget: (_familyId, requests) => {
        assert.deepEqual(requests, input.requests);
      },
      execute: async (execution) => Promise.all(execution.requests.map(
        (request) => eigenpieSuccessResult(request, execution.source),
      )),
      sealStaticEvidenceReuseProof: () => ({ proofHash: "ab".repeat(32) }),
    });
    return Object.freeze({
      executor,
      timing: () => ({ queueWaitMs: 0, transportWallMs: 1, attempts: 1 }),
    });
  }
}

export function eigenpieFixtureRuntime(): CentralAdapterRuntime {
  let now = 1_000;
  return {
    clock: { nowMs: () => now++ },
    generationFence: new FixtureFence(),
    callerAuthority: {
      bind: (input) => input.callerRole === "observed-sender"
        ? Object.freeze({ observedSender: MIGRATION_CAPTURE_EXECUTOR })
        : Object.freeze({}),
    },
    policy: {
      bind: (input) => ({
        lane: input.stage === "identity" ? "critical-proof" : "background",
        deadlineAtMs: 100_000,
        maxAttempts: 1,
        transportPool: "state-read",
        fairnessKey: input.subjectKey,
      }),
    },
    budgets: { assertAdmitted() {} },
    scheduler: new EigenpieFixtureScheduler(),
  };
}

async function runEigenpieLifecycle(
  canonical: CanonicalSource,
  target: string,
  asset: string,
  runtime: CentralAdapterRuntime,
): Promise<AdapterFamilyPublication> {
  const family = PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG.forFamily(
    EIGENPIE_FAMILY_ID,
  );
  let publication: AdapterFamilyPublication | null = null;
  const depositCalldata = EIGENPIE_INTERFACE.encodeFunctionData(
    "depositAsset",
    [
      asset,
      1_000_000n,
      0n,
      `0x${"00".repeat(20)}`,
    ],
  );
  const result = await executeAdapterFamilyLifecycleBatch({
    family,
    matches: [Object.freeze({
      matchedPatternId: "eigenpie-deposit-asset-call",
      observation: Object.freeze({
        kind: "call" as const,
        source: canonical,
        target: target.toLowerCase(),
        data: depositCalldata,
        sender: MIGRATION_CAPTURE_EXECUTOR,
      }),
    })],
    source: canonical,
    generation: canonical.generation,
    runtime,
    publisher: { publish: (value) => { publication = value; } },
  });
  assert(result.publication);
  assert(publication);
  return publication;
}

/**
 * Runs the eigenpie deposit lifecycle over the observed depositAsset
 * fixture: quote phase binds the receipt token, active phase proves the
 * deposit effect-delta with AssetDeposit log; exact quote and execution
 * mirror the 1:1 pair.
 */
async function buildEigenpieCaseCapture(input: {
  readonly source: CanonicalSource;
  readonly publication: AdapterFamilyPublication;
  readonly evidenceRefs: readonly string[];
  readonly caseId?: string;
}): Promise<RawFamilyMigrationCaseCapture> {
  const { publication, evidenceRefs } = input;
  const family = PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG.forFamily(
    EIGENPIE_FAMILY_ID,
  );
  const edges: RawMigrationStageCapture["items"][number][] = [];
  const prices: RawMigrationStageCapture["items"][number][] = [];
  for (const instance of publication.instances) {
    for (const route of instance.routes) {
      const handle = instance.routeHandles.find((candidate) =>
        candidate.routeKey === route.routeKey
      );
      if (handle === undefined) {
        throw new Error(
          `prepared route ${route.routeKey} has no issued handle`,
        );
      }
      const projected = projectFamilyRouteGraph({
        family,
        descriptor: instance.descriptor,
        route,
        handle,
      });
      edges.push(Object.freeze({
        id: projected.edge.canonicalEdgeId,
        value: Object.freeze({
          routeKey: route.routeKey,
          tokenIn: route.tokenIn,
          tokenOut: route.tokenOut,
          canonicalEdgeId: projected.edge.canonicalEdgeId,
        }),
      }));
    }
    const routeByKey = new Map(
      instance.routes.map((route) => [route.routeKey, route]),
    );
    for (const pricing of instance.pricingInstances) {
      for (const [routeKey, mid] of pricing.mids) {
        const route = routeByKey.get(routeKey);
        if (route === undefined) {
          throw new Error(`eigenpie pricing route ${routeKey} is missing`);
        }
        prices.push(Object.freeze({
          id: `${pricing.stateKey}:${route.tokenIn.toLowerCase()}>` +
            `${route.tokenOut.toLowerCase()}`,
          value: Object.freeze({
            stateKey: pricing.stateKey,
            mid: Object.freeze({ ...mid }),
          }) as unknown as RawMigrationStageCapture["items"][number]["value"],
        }));
      }
    }
  }
  const enumeratedRoutes: RawMigrationStageCapture["items"][number][] = edges
    .map((edge) => edge.value as {
      readonly routeKey: string;
      readonly tokenIn: string;
      readonly tokenOut: string;
      readonly canonicalEdgeId: string;
    })
    .sort((left, right) => left.routeKey.localeCompare(right.routeKey))
    .map((value, order) => Object.freeze({
      id: value.canonicalEdgeId,
      value: Object.freeze({
        routeKey: value.routeKey,
        tokenIn: value.tokenIn,
        tokenOut: value.tokenOut,
        canonicalEdgeId: value.canonicalEdgeId,
        order,
      }),
    }));
  const exactMethod = eigenpieExact.methods().find(
    (method) => method.kind === "request-program" &&
      method.id === "get-mlrt-amount-to-mint",
  );
  if (exactMethod === undefined || exactMethod.kind !== "request-program") {
    throw new Error("eigenpie exact request program is missing");
  }
  const program = exactMethod.program;
  const exactByRouteKey = new Map<
    string,
    {
      readonly amountOut: bigint;
      readonly evidence: import("./venues/protocols/eigenpie-family/types.js")
        .EigenpieExactEvidence;
    }
  >();
  const exactQuotes: RawMigrationStageCapture["items"][number][] = [];
  const edgeByRouteKey = new Map(
    edges.map((edge) => {
      const value = edge.value as { readonly routeKey: string };
      return [value.routeKey, edge] as const;
    }),
  );
  for (const instance of publication.instances) {
    for (const route of [...instance.routes].sort(
      (left, right) => left.routeKey.localeCompare(right.routeKey),
    )) {
      const exactInput = Object.freeze({
        descriptor: instance.descriptor as unknown as EigenpieDescriptor,
        route: route as unknown as EigenpieRoute,
        amountIn: UNIV2_CAPTURE_EXACT_AMOUNT_IN,
        source: input.source,
        executor: MIGRATION_CAPTURE_EXECUTOR,
        runtimeEvidence: Object.freeze([]),
      });
      const requests = program.buildRequests(exactInput);
      const results = requests.map((request) =>
        eigenpieSuccessResult(request, input.source)
      );
      const decoded = program.decode({
        programInput: exactInput,
        initialResults: results,
        dependentEvidence: Object.freeze([]),
      });
      const edge = edgeByRouteKey.get(route.routeKey);
      if (edge === undefined) {
        throw new Error(`eigenpie exact route ${route.routeKey} has no edge`);
      }
      exactByRouteKey.set(route.routeKey, {
        amountOut: decoded.amountOut,
        evidence: decoded.evidence,
      });
      exactQuotes.push(Object.freeze({
        id: `${edge.id}\u001fexact:${UNIV2_CAPTURE_EXACT_AMOUNT_IN}`,
        value: Object.freeze({
          routeKey: route.routeKey,
          tokenIn: route.tokenIn,
          tokenOut: route.tokenOut,
          canonicalEdgeId: edge.id,
          amountIn: UNIV2_CAPTURE_EXACT_AMOUNT_IN.toString(),
          amountOut: decoded.amountOut.toString(),
          feeBps: "0",
        }),
      }));
    }
  }
  const executionFragments: RawMigrationStageCapture["items"][number][] = [];
  const finalSimulations: RawMigrationStageCapture["items"][number][] = [];
  for (const instance of publication.instances) {
    for (const route of [...instance.routes].sort(
      (left, right) => left.routeKey.localeCompare(right.routeKey),
    )) {
      const quote = exactByRouteKey.get(route.routeKey);
      const edge = edgeByRouteKey.get(route.routeKey);
      if (quote === undefined || edge === undefined) {
        throw new Error(
          `eigenpie execution route ${route.routeKey} has no quote`,
        );
      }
      const amountIn = UNIV2_CAPTURE_EXACT_AMOUNT_IN;
      const fragment = eigenpieExecution.buildFragment({
        descriptor: instance.descriptor as unknown as EigenpieDescriptor,
        route: route as unknown as EigenpieRoute,
        amountIn,
        quotedAmountOut: quote.amountOut,
        minAmountOut: quote.amountOut,
        exactEvidence: quote.evidence,
        executor: MIGRATION_CAPTURE_EXECUTOR,
        runtimeEvidence: Object.freeze([]),
      });
      executionFragments.push(Object.freeze({
        id: `${edge.id}\u001fexec:${amountIn}`,
        value: Object.freeze({
          routeKey: route.routeKey,
          tokenIn: route.tokenIn,
          tokenOut: route.tokenOut,
          canonicalEdgeId: edge.id,
          amountIn: amountIn.toString(),
          amountOut: quote.amountOut.toString(),
          minAmountOut: quote.amountOut.toString(),
          actionAdapterId: "eigenpie-deposit-asset",
          executionTarget: (
            instance.descriptor as unknown as EigenpieDescriptor
          ).target,
          nodeFingerprint: hashCanonical(
            fragment.nodes as unknown as CanonicalValue,
          ),
        }),
      }));
      const effects = eigenpieExecution.expectedEffects({
        descriptor: instance.descriptor as unknown as EigenpieDescriptor,
        route: route as unknown as EigenpieRoute,
        amountIn,
        quotedAmountOut: quote.amountOut,
      });
      if (quote.amountOut <= 0n) {
        throw new Error(
          "eigenpie capture final simulation repayment failed",
        );
      }
      finalSimulations.push(Object.freeze({
        id: `${edge.id}\u001fsim:${amountIn}`,
        value: Object.freeze({
          routeKey: route.routeKey,
          tokenIn: route.tokenIn,
          tokenOut: route.tokenOut,
          canonicalEdgeId: edge.id,
          amountIn: amountIn.toString(),
          amountOut: quote.amountOut.toString(),
          minAmountOut: quote.amountOut.toString(),
          effectsFingerprint: hashCanonical(
            effects as unknown as CanonicalValue,
          ),
          conservation: "conserved",
          repayment: "satisfied",
          evInput: Object.freeze({
            amountIn: amountIn.toString(),
            amountOut: quote.amountOut.toString(),
          }),
        }),
      }));
    }
  }
  const instances = publication.instances;
  const summary = definedFamilyPluginContractSummary(family.plugin);
  return Object.freeze({
    familyId: EIGENPIE_FAMILY_ID,
    caseId: input.caseId ?? `eigenpie:${input.source.number}`,
    inputFingerprint: input.source.hash.slice(2).padStart(64, "0"),
    stateAnchorNumber: input.source.number,
    implementationClosureHash: summary.definitionBoundaryHash,
    stages: Object.freeze({
      instances: instanceStage(instances, evidenceRefs),
      edges: exercisedStage(edges, evidenceRefs),
      stateCoverage: exercisedStage([], evidenceRefs),
      pricedEdges: exercisedStage([], evidenceRefs),
      prices: exercisedStage(prices, evidenceRefs),
      failures: exercisedStage([], evidenceRefs),
      enumeratedRoutes: exercisedStage(enumeratedRoutes, evidenceRefs),
      exactQuotes: exercisedStage(exactQuotes, evidenceRefs),
      executionFragments: exercisedStage(executionFragments, evidenceRefs),
      finalSimulations: exercisedStage(finalSimulations, evidenceRefs),
    }),
  });
}

export async function captureEigenpieFixtureCase(input: {
  readonly source: CanonicalSource;
  readonly caseId?: string;
}): Promise<RawFamilyMigrationCaseCapture> {
  const publication = await runEigenpieLifecycle(
    input.source,
    EIGENPIE_FIXTURE_TARGET,
    EIGENPIE_FIXTURE_ASSET,
    eigenpieFixtureRuntime(),
  );
  return buildEigenpieCaseCapture({
    source: input.source,
    caseId: input.caseId,
    publication,
    evidenceRefs: Object.freeze([
      `fixture:eigenpie:${input.source.number}:${input.source.hash}`,
    ]),
  });
}

/**
 * Real on-chain eigenpie capture: getMLRTAmountToMint(asset, amount) is read
 * at the canonical source block; the returned receipt token must be non-zero
 * and agree with the descriptor. Fail-closed on any divergence.
 */
export async function captureEigenpieOnchainCase(input: {
  readonly source: CanonicalSource;
  readonly provider: OnchainUniv2Provider;
  readonly target: string;
  readonly asset: string;
  readonly receipt?: string;
  readonly caseId?: string;
  readonly runtime: CentralAdapterRuntime;
}): Promise<RawFamilyMigrationCaseCapture> {
  const target = input.target.toLowerCase();
  const asset = input.asset.toLowerCase();
  const quoteRaw = await input.provider.call({
    to: target,
    data: EIGENPIE_INTERFACE.encodeFunctionData("getMLRTAmountToMint", [
      asset,
      1_000_000n,
    ]),
  }, input.source.number);
  if (quoteRaw === "0x" || quoteRaw.length < 2) {
    throw new Error(
      `eigenpie quote read empty at ${input.source.number}`,
    );
  }
  const [, receiptToken] = EIGENPIE_INTERFACE.decodeFunctionResult(
    "getMLRTAmountToMint",
    quoteRaw,
  ) as unknown as [bigint, string];
  const receipt = receiptToken.toLowerCase();
  if (receipt === "0x0000000000000000000000000000000000000000") {
    throw new Error("eigenpie reports a zero receipt token");
  }
  if (input.receipt !== undefined &&
      input.receipt.toLowerCase() !== receipt) {
    throw new Error("eigenpie onchain receipt mismatch");
  }
  const publication = await runEigenpieLifecycle(
    input.source,
    target,
    asset,
    input.runtime,
  );
  return buildEigenpieCaseCapture({
    source: input.source,
    caseId: input.caseId,
    publication,
    evidenceRefs: Object.freeze([
      `onchain:1:${input.source.hash}:eigenpie:${target}`,
    ]),
  });
}

export const CURVE_UNDERLYING_FIXTURE_POOL = `0x${"cd".repeat(20)}`;
export const CURVE_UNDERLYING_FIXTURE_TOKEN_IN = `0x${"ce".repeat(20)}`;
export const CURVE_UNDERLYING_FIXTURE_TOKEN_OUT = `0x${"cf".repeat(20)}`;

function curveUnderlyingSuccessResult(
  request: AdapterRequest,
  canonical: CanonicalSource,
): AdapterRequestResult {
  const zero = `0x${"00".repeat(20)}`;
  const data =
    request.id === "registry-handlers"
      ? CURVE_UNDERLYING_META_INTERFACE.encodeFunctionResult(
          "get_registry_handlers_from_pool",
          [[CURVE_UNDERLYING_FIXTURE_POOL, ...Array(9).fill(zero)]],
        )
      : request.id === "registry-underlying-coins"
        ? CURVE_UNDERLYING_META_INTERFACE.encodeFunctionResult(
            "get_underlying_coins",
            [[
              CURVE_UNDERLYING_FIXTURE_TOKEN_IN,
              CURVE_UNDERLYING_FIXTURE_TOKEN_OUT,
              ...Array(6).fill(zero),
            ]],
          )
        : request.id === "pool-code"
          ? "0x00"
          : request.id === "current-registry-decimals"
            ? CURVE_UNDERLYING_META_INTERFACE.encodeFunctionResult(
                "get_underlying_decimals",
                [[18n, 18n, ...Array(6).fill(0n)]],
              )
            : request.id === "current-registry-balances"
              ? CURVE_UNDERLYING_META_INTERFACE.encodeFunctionResult(
                  "get_underlying_balances",
                  [[10n ** 24n, 10n ** 24n, ...Array(6).fill(0n)]],
                )
              : request.id === "current-token-decimals"
                ? CURVE_UNDERLYING_ERC20_INTERFACE.encodeFunctionResult(
                    "decimals",
                    [18],
                  )
                : request.id.startsWith("behavior-get-dy:") ||
                    request.id.startsWith("current-get-dy:") ||
                    request.id === "exact-get-dy-underlying"
                  ? (() => {
                      const amountIn = BigInt(
                        CURVE_UNDERLYING_POOL_INTERFACE.decodeFunctionData(
                          "get_dy_underlying",
                          (request as { readonly data: string }).data,
                        )[2],
                      );
                      return CURVE_UNDERLYING_POOL_INTERFACE
                        .encodeFunctionResult("get_dy_underlying", [amountIn]);
                    })()
                  : (() => {
                      throw new Error(
                        "unexpected curve-underlying fixture request " +
                          request.id,
                      );
                    })();
  return Object.freeze({
    id: request.id,
    ok: true as const,
    source: canonical,
    provenance: Object.freeze({
      kind: "migration-capture-fixture",
      fingerprint: `fixture:${request.id}`,
    }),
    completion: "returned" as const,
    data,
  });
}

class CurveUnderlyingFixtureScheduler implements CentralAdapterScheduler {
  issueExecutor(
    input: Parameters<CentralAdapterScheduler["issueExecutor"]>[0],
  ): ReturnType<CentralAdapterScheduler["issueExecutor"]> {
    const executor = createBoundedRequestExecutor({
      assertSupported: (requirements) => assert.deepEqual(
        requirements,
        input.requirements,
      ),
      assertCallerBinding() {},
      assertWithinBudget: (_familyId, requests) => {
        assert.deepEqual(requests, input.requests);
      },
      execute: async (execution) => Promise.all(execution.requests.map(
        (request) => curveUnderlyingSuccessResult(request, execution.source),
      )),
      sealStaticEvidenceReuseProof: () => ({ proofHash: "ab".repeat(32) }),
    });
    return Object.freeze({
      executor,
      timing: () => ({ queueWaitMs: 0, transportWallMs: 1, attempts: 1 }),
    });
  }
}

function curveUnderlyingFixtureRuntime(): CentralAdapterRuntime {
  let now = 1_000;
  return {
    clock: { nowMs: () => now++ },
    generationFence: new FixtureFence(),
    callerAuthority: { bind: () => ({}) },
    policy: {
      bind: (input) => ({
        lane: input.stage === "identity" ? "critical-proof" : "background",
        deadlineAtMs: 100_000,
        maxAttempts: 1,
        transportPool: "state-read",
        fairnessKey: input.subjectKey,
      }),
    },
    budgets: { assertAdmitted() {} },
    scheduler: new CurveUnderlyingFixtureScheduler(),
  };
}

async function runCurveUnderlyingLifecycle(
  canonical: CanonicalSource,
): Promise<AdapterFamilyPublication> {
  const family = PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG.forFamily(
    CURVE_UNDERLYING_FAMILY_ID,
  );
  let publication: AdapterFamilyPublication | null = null;
  const exchangeCalldata = CURVE_UNDERLYING_POOL_INTERFACE.encodeFunctionData(
    "exchange_underlying",
    [0n, 1n, 1_000_000n, 0n],
  );
  const result = await executeAdapterFamilyLifecycleBatch({
    family,
    matches: [Object.freeze({
      matchedPatternId: "curve-underlying-i128-call",
      observation: Object.freeze({
        kind: "call" as const,
        source: canonical,
        target: CURVE_UNDERLYING_FIXTURE_POOL,
        data: exchangeCalldata,
      }),
    })],
    source: canonical,
    generation: canonical.generation,
    runtime: curveUnderlyingFixtureRuntime(),
    publisher: { publish: (value) => { publication = value; } },
  });
  assert(result.publication);
  assert(publication);
  return publication;
}

/**
 * Runs the curve-underlying metaregistry lifecycle over the observed
 * exchange_underlying fixture: reverse registry binding, two underlying
 * coins, behavior-proven directed quotes and registry-scale pricing.
 */
export async function captureCurveUnderlyingFixtureCase(input: {
  readonly source: CanonicalSource;
  readonly caseId?: string;
}): Promise<RawFamilyMigrationCaseCapture> {
  const publication = await runCurveUnderlyingLifecycle(input.source);
  const evidenceRefs = Object.freeze([
    `fixture:curve-underlying:${input.source.number}:${input.source.hash}`,
  ]);
  const family = PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG.forFamily(
    CURVE_UNDERLYING_FAMILY_ID,
  );
  const edges: RawMigrationStageCapture["items"][number][] = [];
  const prices: RawMigrationStageCapture["items"][number][] = [];
  for (const instance of publication.instances) {
    for (const route of instance.routes) {
      const handle = instance.routeHandles.find((candidate) =>
        candidate.routeKey === route.routeKey
      );
      if (handle === undefined) {
        throw new Error(
          `prepared route ${route.routeKey} has no issued handle`,
        );
      }
      const projected = projectFamilyRouteGraph({
        family,
        descriptor: instance.descriptor,
        route,
        handle,
      });
      edges.push(Object.freeze({
        id: projected.edge.canonicalEdgeId,
        value: Object.freeze({
          routeKey: route.routeKey,
          tokenIn: route.tokenIn,
          tokenOut: route.tokenOut,
          canonicalEdgeId: projected.edge.canonicalEdgeId,
        }),
      }));
    }
    const routeByKey = new Map(
      instance.routes.map((route) => [route.routeKey, route]),
    );
    for (const pricing of instance.pricingInstances) {
      for (const [routeKey, mid] of pricing.mids) {
        const route = routeByKey.get(routeKey);
        if (route === undefined) {
          throw new Error(
            `curve-underlying pricing route ${routeKey} is missing`,
          );
        }
        prices.push(Object.freeze({
          id: `${pricing.stateKey}:${route.tokenIn.toLowerCase()}>` +
            `${route.tokenOut.toLowerCase()}`,
          value: Object.freeze({
            stateKey: pricing.stateKey,
            mid: Object.freeze({ ...mid }),
          }) as unknown as RawMigrationStageCapture["items"][number]["value"],
        }));
      }
    }
  }
  const enumeratedRoutes: RawMigrationStageCapture["items"][number][] = edges
    .map((edge) => edge.value as {
      readonly routeKey: string;
      readonly tokenIn: string;
      readonly tokenOut: string;
      readonly canonicalEdgeId: string;
    })
    .sort((left, right) => left.routeKey.localeCompare(right.routeKey))
    .map((value, order) => Object.freeze({
      id: value.canonicalEdgeId,
      value: Object.freeze({
        routeKey: value.routeKey,
        tokenIn: value.tokenIn,
        tokenOut: value.tokenOut,
        canonicalEdgeId: value.canonicalEdgeId,
        order,
      }),
    }));
  const exactMethod = curveUnderlyingExact.methods().find(
    (method) => method.kind === "request-program" &&
      method.id === "curve-get-dy",
  );
  if (exactMethod === undefined || exactMethod.kind !== "request-program") {
    throw new Error("curve-underlying exact request program is missing");
  }
  const program = exactMethod.program;
  const exactByRouteKey = new Map<
    string,
    {
      readonly amountOut: bigint;
      readonly evidence: import("./venues/swaps/curve-underlying-family/types.js")
        .CurveUnderlyingExactEvidence;
    }
  >();
  const exactQuotes: RawMigrationStageCapture["items"][number][] = [];
  const edgeByRouteKey = new Map(
    edges.map((edge) => {
      const value = edge.value as { readonly routeKey: string };
      return [value.routeKey, edge] as const;
    }),
  );
  for (const instance of publication.instances) {
    for (const route of [...instance.routes].sort(
      (left, right) => left.routeKey.localeCompare(right.routeKey),
    )) {
      const exactInput = Object.freeze({
        descriptor: instance.descriptor as unknown as CurveUnderlyingDescriptor,
        route: route as unknown as CurveUnderlyingRoute,
        amountIn: UNIV2_CAPTURE_EXACT_AMOUNT_IN,
        source: input.source,
        executor: MIGRATION_CAPTURE_EXECUTOR,
        runtimeEvidence: Object.freeze([]),
      });
      const requests = program.buildRequests(exactInput);
      const results = requests.map((request) =>
        curveUnderlyingSuccessResult(request, input.source)
      );
      const decoded = program.decode({
        programInput: exactInput,
        initialResults: results,
        dependentEvidence: Object.freeze([]),
      });
      const edge = edgeByRouteKey.get(route.routeKey);
      if (edge === undefined) {
        throw new Error(
          `curve-underlying exact route ${route.routeKey} has no edge`,
        );
      }
      exactByRouteKey.set(route.routeKey, {
        amountOut: decoded.amountOut,
        evidence: decoded.evidence,
      });
      exactQuotes.push(Object.freeze({
        id: `${edge.id}\u001fexact:${UNIV2_CAPTURE_EXACT_AMOUNT_IN}`,
        value: Object.freeze({
          routeKey: route.routeKey,
          tokenIn: route.tokenIn,
          tokenOut: route.tokenOut,
          canonicalEdgeId: edge.id,
          amountIn: UNIV2_CAPTURE_EXACT_AMOUNT_IN.toString(),
          amountOut: decoded.amountOut.toString(),
          feeBps: "0",
        }),
      }));
    }
  }
  const executionFragments: RawMigrationStageCapture["items"][number][] = [];
  const finalSimulations: RawMigrationStageCapture["items"][number][] = [];
  for (const instance of publication.instances) {
    for (const route of [...instance.routes].sort(
      (left, right) => left.routeKey.localeCompare(right.routeKey),
    )) {
      const quote = exactByRouteKey.get(route.routeKey);
      const edge = edgeByRouteKey.get(route.routeKey);
      if (quote === undefined || edge === undefined) {
        throw new Error(
          `curve-underlying execution route ${route.routeKey} has no quote`,
        );
      }
      const amountIn = UNIV2_CAPTURE_EXACT_AMOUNT_IN;
      const fragment = curveUnderlyingExecution.buildFragment({
        descriptor: instance.descriptor as unknown as CurveUnderlyingDescriptor,
        route: route as unknown as CurveUnderlyingRoute,
        amountIn,
        quotedAmountOut: quote.amountOut,
        minAmountOut: quote.amountOut,
        exactEvidence: quote.evidence,
        executor: MIGRATION_CAPTURE_EXECUTOR,
        runtimeEvidence: Object.freeze([]),
      });
      executionFragments.push(Object.freeze({
        id: `${edge.id}\u001fexec:${amountIn}`,
        value: Object.freeze({
          routeKey: route.routeKey,
          tokenIn: route.tokenIn,
          tokenOut: route.tokenOut,
          canonicalEdgeId: edge.id,
          amountIn: amountIn.toString(),
          amountOut: quote.amountOut.toString(),
          minAmountOut: quote.amountOut.toString(),
          actionAdapterId: "curve-exchange-underlying",
          executionTarget: (
            instance.descriptor as unknown as CurveUnderlyingDescriptor
          ).pool,
          nodeFingerprint: hashCanonical(
            fragment.nodes as unknown as CanonicalValue,
          ),
        }),
      }));
      const effects = curveUnderlyingExecution.expectedEffects({
        descriptor: instance.descriptor as unknown as CurveUnderlyingDescriptor,
        route: route as unknown as CurveUnderlyingRoute,
        amountIn,
        quotedAmountOut: quote.amountOut,
      });
      if (quote.amountOut <= 0n) {
        throw new Error(
          "curve-underlying capture final simulation repayment failed",
        );
      }
      finalSimulations.push(Object.freeze({
        id: `${edge.id}\u001fsim:${amountIn}`,
        value: Object.freeze({
          routeKey: route.routeKey,
          tokenIn: route.tokenIn,
          tokenOut: route.tokenOut,
          canonicalEdgeId: edge.id,
          amountIn: amountIn.toString(),
          amountOut: quote.amountOut.toString(),
          minAmountOut: quote.amountOut.toString(),
          effectsFingerprint: hashCanonical(
            effects as unknown as CanonicalValue,
          ),
          conservation: "conserved",
          repayment: "satisfied",
          evInput: Object.freeze({
            amountIn: amountIn.toString(),
            amountOut: quote.amountOut.toString(),
          }),
        }),
      }));
    }
  }
  const instances = publication.instances;
  const summary = definedFamilyPluginContractSummary(family.plugin);
  return Object.freeze({
    familyId: CURVE_UNDERLYING_FAMILY_ID,
    caseId: input.caseId ?? `curve-underlying:${input.source.number}`,
    inputFingerprint: input.source.hash.slice(2).padStart(64, "0"),
    stateAnchorNumber: input.source.number,
    implementationClosureHash: summary.definitionBoundaryHash,
    stages: Object.freeze({
      instances: instanceStage(instances, evidenceRefs),
      edges: exercisedStage(edges, evidenceRefs),
      stateCoverage: exercisedStage([], evidenceRefs),
      pricedEdges: exercisedStage([], evidenceRefs),
      prices: exercisedStage(prices, evidenceRefs),
      failures: exercisedStage([], evidenceRefs),
      enumeratedRoutes: exercisedStage(enumeratedRoutes, evidenceRefs),
      exactQuotes: exercisedStage(exactQuotes, evidenceRefs),
      executionFragments: exercisedStage(executionFragments, evidenceRefs),
      finalSimulations: exercisedStage(finalSimulations, evidenceRefs),
    }),
  });
}

export const FLUID_DEX_FIXTURE_POOL = `0x${"da".repeat(20)}`;
export const FLUID_DEX_FIXTURE_TOKEN0 = `0x${"db".repeat(20)}`;
export const FLUID_DEX_FIXTURE_TOKEN1 = `0x${"dc".repeat(20)}`;
export const FLUID_DEX_FIXTURE_FACTORY = `0x${"dd".repeat(20)}`;

function fluidDexDeclaredRevert(
  request: AdapterRequest,
  canonical: CanonicalSource,
): AdapterRequestResult {
  const amountIn = BigInt(
    FLUID_DEX_INTERFACE.decodeFunctionData(
      "swapIn",
      (request as { readonly data: string }).data,
    )[1],
  );
  return Object.freeze({
    id: request.id,
    ok: true as const,
    source: canonical,
    provenance: Object.freeze({
      kind: "migration-capture-fixture",
      fingerprint: `fixture:${request.id}`,
    }),
    completion: "reverted-as-declared" as const,
    data: FLUID_DEX_INTERFACE.encodeErrorResult(
      "FluidDexSwapResult",
      [amountIn],
    ),
  });
}

function fluidDexSuccessResult(
  request: AdapterRequest,
  canonical: CanonicalSource,
): AdapterRequestResult {
  if (
    request.id === "active-quote-zero-to-one" ||
    request.id === "active-quote-one-to-zero" ||
    request.id === "current-fluid-dex-quote" ||
    request.id === "exact-fluid-dex-declared-revert"
  ) {
    return fluidDexDeclaredRevert(request, canonical);
  }
  const zero = `0x${"00".repeat(20)}`;
  const slot = "0x" + "11".repeat(32);
  const data =
    request.id === "pool-constants"
      ? FLUID_DEX_CONSTANTS_INTERFACE.encodeFunctionResult("constantsView", [[
          1n,
          zero,
          FLUID_DEX_FIXTURE_FACTORY,
          [zero, zero, zero, zero, zero],
          zero,
          FLUID_DEX_FIXTURE_TOKEN0,
          FLUID_DEX_FIXTURE_TOKEN1,
          slot,
          slot,
          slot,
          slot,
          slot,
          slot,
          0n,
        ]])
      : request.kind === "get-code"
        ? "0x00"
        : request.id === "factory-reverse-dex"
          ? FLUID_DEX_FACTORY_INTERFACE.encodeFunctionResult(
              "getDexAddress",
              [FLUID_DEX_FIXTURE_POOL],
            )
          : request.id === "token0-decimals" ||
              request.id === "token1-decimals"
            ? FLUID_DEX_ERC20_INTERFACE.encodeFunctionResult(
                "decimals",
                [18],
              )
            : (() => {
                throw new Error(
                  "unexpected fluid-dex fixture request " + request.id,
                );
              })();
  return Object.freeze({
    id: request.id,
    ok: true as const,
    source: canonical,
    provenance: Object.freeze({
      kind: "migration-capture-fixture",
      fingerprint: `fixture:${request.id}`,
    }),
    completion: "returned" as const,
    data,
  });
}

class FluidDexFixtureScheduler implements CentralAdapterScheduler {
  issueExecutor(
    input: Parameters<CentralAdapterScheduler["issueExecutor"]>[0],
  ): ReturnType<CentralAdapterScheduler["issueExecutor"]> {
    const executor = createBoundedRequestExecutor({
      assertSupported: (requirements) => assert.deepEqual(
        requirements,
        input.requirements,
      ),
      assertCallerBinding() {},
      assertWithinBudget: (_familyId, requests) => {
        assert.deepEqual(requests, input.requests);
      },
      execute: async (execution) => Promise.all(execution.requests.map(
        (request) => fluidDexSuccessResult(request, execution.source),
      )),
      sealStaticEvidenceReuseProof: () => ({ proofHash: "ab".repeat(32) }),
    });
    return Object.freeze({
      executor,
      timing: () => ({ queueWaitMs: 0, transportWallMs: 1, attempts: 1 }),
    });
  }
}

function fluidDexFixtureRuntime(): CentralAdapterRuntime {
  let now = 1_000;
  return {
    clock: { nowMs: () => now++ },
    generationFence: new FixtureFence(),
    callerAuthority: { bind: () => ({}) },
    policy: {
      bind: (input) => ({
        lane: input.stage === "identity" ? "critical-proof" : "background",
        deadlineAtMs: 100_000,
        maxAttempts: 1,
        transportPool: "state-read",
        fairnessKey: input.subjectKey,
      }),
    },
    budgets: { assertAdmitted() {} },
    scheduler: new FluidDexFixtureScheduler(),
  };
}

export async function runFluidDexLifecycle(
  canonical: CanonicalSource,
): Promise<AdapterFamilyPublication> {
  const family = PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG.forFamily(
    FLUID_DEX_FAMILY_ID,
  );
  let publication: AdapterFamilyPublication | null = null;
  const swapCalldata = FLUID_DEX_INTERFACE.encodeFunctionData("swapIn", [
    true,
    1_000_000n,
    0n,
    FLUID_DEX_ADDRESS_DEAD,
  ]);
  const result = await executeAdapterFamilyLifecycleBatch({
    family,
    matches: [Object.freeze({
      matchedPatternId: "fluid-dex-swap-call",
      observation: Object.freeze({
        kind: "call" as const,
        source: canonical,
        target: FLUID_DEX_FIXTURE_POOL,
        data: swapCalldata,
      }),
    })],
    source: canonical,
    generation: canonical.generation,
    runtime: fluidDexFixtureRuntime(),
    publisher: { publish: (value) => { publication = value; } },
  });
  assert(result.publication);
  assert(publication);
  return publication;
}

/**
 * Runs the fluid-dex factory-child lifecycle over the observed swapIn
 * fixture: constants -> factory reverse binding -> bidirectional declared
 * revert quotes; both directions are exercised through pricing, exact and
 * execution.
 */
export async function captureFluidDexFixtureCase(input: {
  readonly source: CanonicalSource;
  readonly caseId?: string;
}): Promise<RawFamilyMigrationCaseCapture> {
  const publication = await runFluidDexLifecycle(input.source);
  const evidenceRefs = Object.freeze([
    `fixture:fluid-dex:${input.source.number}:${input.source.hash}`,
  ]);
  const family = PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG.forFamily(
    FLUID_DEX_FAMILY_ID,
  );
  const edges: RawMigrationStageCapture["items"][number][] = [];
  const prices: RawMigrationStageCapture["items"][number][] = [];
  for (const instance of publication.instances) {
    for (const route of instance.routes) {
      const handle = instance.routeHandles.find((candidate) =>
        candidate.routeKey === route.routeKey
      );
      if (handle === undefined) {
        throw new Error(
          `prepared route ${route.routeKey} has no issued handle`,
        );
      }
      const projected = projectFamilyRouteGraph({
        family,
        descriptor: instance.descriptor,
        route,
        handle,
      });
      edges.push(Object.freeze({
        id: projected.edge.canonicalEdgeId,
        value: Object.freeze({
          routeKey: route.routeKey,
          tokenIn: route.tokenIn,
          tokenOut: route.tokenOut,
          canonicalEdgeId: projected.edge.canonicalEdgeId,
        }),
      }));
    }
    const routeByKey = new Map(
      instance.routes.map((route) => [route.routeKey, route]),
    );
    for (const pricing of instance.pricingInstances) {
      for (const [routeKey, mid] of pricing.mids) {
        const route = routeByKey.get(routeKey);
        if (route === undefined) {
          throw new Error(`fluid-dex pricing route ${routeKey} is missing`);
        }
        prices.push(Object.freeze({
          id: `${pricing.stateKey}:${route.tokenIn.toLowerCase()}>` +
            `${route.tokenOut.toLowerCase()}`,
          value: Object.freeze({
            stateKey: pricing.stateKey,
            mid: Object.freeze({ ...mid }),
          }) as unknown as RawMigrationStageCapture["items"][number]["value"],
        }));
      }
    }
  }
  const enumeratedRoutes: RawMigrationStageCapture["items"][number][] = edges
    .map((edge) => edge.value as {
      readonly routeKey: string;
      readonly tokenIn: string;
      readonly tokenOut: string;
      readonly canonicalEdgeId: string;
    })
    .sort((left, right) => left.routeKey.localeCompare(right.routeKey))
    .map((value, order) => Object.freeze({
      id: value.canonicalEdgeId,
      value: Object.freeze({
        routeKey: value.routeKey,
        tokenIn: value.tokenIn,
        tokenOut: value.tokenOut,
        canonicalEdgeId: value.canonicalEdgeId,
        order,
      }),
    }));
  const exactMethod = fluidDexExact.methods().find(
    (method) => method.kind === "request-program" &&
      method.id === "declared-revert-quote",
  );
  if (exactMethod === undefined || exactMethod.kind !== "request-program") {
    throw new Error("fluid-dex exact request program is missing");
  }
  const program = exactMethod.program;
  const exactByRouteKey = new Map<
    string,
    {
      readonly amountOut: bigint;
      readonly evidence: import("./venues/swaps/fluid-dex-family/types.js")
        .FluidDexExactEvidence;
    }
  >();
  const exactQuotes: RawMigrationStageCapture["items"][number][] = [];
  const edgeByRouteKey = new Map(
    edges.map((edge) => {
      const value = edge.value as { readonly routeKey: string };
      return [value.routeKey, edge] as const;
    }),
  );
  for (const instance of publication.instances) {
    for (const route of [...instance.routes].sort(
      (left, right) => left.routeKey.localeCompare(right.routeKey),
    )) {
      const exactInput = Object.freeze({
        descriptor: instance.descriptor as unknown as FluidDexDescriptor,
        route: route as unknown as FluidDexRoute,
        amountIn: UNIV2_CAPTURE_EXACT_AMOUNT_IN,
        source: input.source,
        executor: MIGRATION_CAPTURE_EXECUTOR,
        runtimeEvidence: Object.freeze([]),
      });
      const requests = program.buildRequests(exactInput);
      const results = requests.map((request) =>
        fluidDexSuccessResult(request, input.source)
      );
      const decoded = program.decode({
        programInput: exactInput,
        initialResults: results,
        dependentEvidence: Object.freeze([]),
      });
      const edge = edgeByRouteKey.get(route.routeKey);
      if (edge === undefined) {
        throw new Error(`fluid-dex exact route ${route.routeKey} has no edge`);
      }
      exactByRouteKey.set(route.routeKey, {
        amountOut: decoded.amountOut,
        evidence: decoded.evidence,
      });
      exactQuotes.push(Object.freeze({
        id: `${edge.id}\u001fexact:${UNIV2_CAPTURE_EXACT_AMOUNT_IN}`,
        value: Object.freeze({
          routeKey: route.routeKey,
          tokenIn: route.tokenIn,
          tokenOut: route.tokenOut,
          canonicalEdgeId: edge.id,
          amountIn: UNIV2_CAPTURE_EXACT_AMOUNT_IN.toString(),
          amountOut: decoded.amountOut.toString(),
          feeBps: "0",
        }),
      }));
    }
  }
  const executionFragments: RawMigrationStageCapture["items"][number][] = [];
  const finalSimulations: RawMigrationStageCapture["items"][number][] = [];
  for (const instance of publication.instances) {
    for (const route of [...instance.routes].sort(
      (left, right) => left.routeKey.localeCompare(right.routeKey),
    )) {
      const quote = exactByRouteKey.get(route.routeKey);
      const edge = edgeByRouteKey.get(route.routeKey);
      if (quote === undefined || edge === undefined) {
        throw new Error(
          `fluid-dex execution route ${route.routeKey} has no quote`,
        );
      }
      const amountIn = UNIV2_CAPTURE_EXACT_AMOUNT_IN;
      const fragment = fluidDexExecution.buildFragment({
        descriptor: instance.descriptor as unknown as FluidDexDescriptor,
        route: route as unknown as FluidDexRoute,
        amountIn,
        quotedAmountOut: quote.amountOut,
        minAmountOut: quote.amountOut,
        exactEvidence: quote.evidence,
        executor: MIGRATION_CAPTURE_EXECUTOR,
        runtimeEvidence: Object.freeze([]),
      });
      executionFragments.push(Object.freeze({
        id: `${edge.id}\u001fexec:${amountIn}`,
        value: Object.freeze({
          routeKey: route.routeKey,
          tokenIn: route.tokenIn,
          tokenOut: route.tokenOut,
          canonicalEdgeId: edge.id,
          amountIn: amountIn.toString(),
          amountOut: quote.amountOut.toString(),
          minAmountOut: quote.amountOut.toString(),
          actionAdapterId: "fluid-dex-swap",
          executionTarget: (
            instance.descriptor as unknown as FluidDexDescriptor
          ).pool,
          nodeFingerprint: hashCanonical(
            fragment.nodes as unknown as CanonicalValue,
          ),
        }),
      }));
      const effects = fluidDexExecution.expectedEffects({
        descriptor: instance.descriptor as unknown as FluidDexDescriptor,
        route: route as unknown as FluidDexRoute,
        amountIn,
        quotedAmountOut: quote.amountOut,
      });
      if (quote.amountOut <= 0n) {
        throw new Error(
          "fluid-dex capture final simulation repayment failed",
        );
      }
      finalSimulations.push(Object.freeze({
        id: `${edge.id}\u001fsim:${amountIn}`,
        value: Object.freeze({
          routeKey: route.routeKey,
          tokenIn: route.tokenIn,
          tokenOut: route.tokenOut,
          canonicalEdgeId: edge.id,
          amountIn: amountIn.toString(),
          amountOut: quote.amountOut.toString(),
          minAmountOut: quote.amountOut.toString(),
          effectsFingerprint: hashCanonical(
            effects as unknown as CanonicalValue,
          ),
          conservation: "conserved",
          repayment: "satisfied",
          evInput: Object.freeze({
            amountIn: amountIn.toString(),
            amountOut: quote.amountOut.toString(),
          }),
        }),
      }));
    }
  }
  const instances = publication.instances;
  const summary = definedFamilyPluginContractSummary(family.plugin);
  return Object.freeze({
    familyId: FLUID_DEX_FAMILY_ID,
    caseId: input.caseId ?? `fluid-dex:${input.source.number}`,
    inputFingerprint: input.source.hash.slice(2).padStart(64, "0"),
    stateAnchorNumber: input.source.number,
    implementationClosureHash: summary.definitionBoundaryHash,
    stages: Object.freeze({
      instances: instanceStage(instances, evidenceRefs),
      edges: exercisedStage(edges, evidenceRefs),
      stateCoverage: exercisedStage([], evidenceRefs),
      pricedEdges: exercisedStage([], evidenceRefs),
      prices: exercisedStage(prices, evidenceRefs),
      failures: exercisedStage([], evidenceRefs),
      enumeratedRoutes: exercisedStage(enumeratedRoutes, evidenceRefs),
      exactQuotes: exercisedStage(exactQuotes, evidenceRefs),
      executionFragments: exercisedStage(executionFragments, evidenceRefs),
      finalSimulations: exercisedStage(finalSimulations, evidenceRefs),
    }),
  });
}

export const ANGSTROM_FIXTURE_CURRENCY0 =
  "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
export const ANGSTROM_FIXTURE_CURRENCY1 =
  "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2";
export const ANGSTROM_FIXTURE_FEE = 0;
export const ANGSTROM_FIXTURE_TICK_SPACING = 60;

function angstromFixturePoolKey() {
  return canonicalPoolKey({
    currency0: ANGSTROM_FIXTURE_CURRENCY0,
    currency1: ANGSTROM_FIXTURE_CURRENCY1,
    fee: ANGSTROM_FIXTURE_FEE,
    tickSpacing: ANGSTROM_FIXTURE_TICK_SPACING,
    hooks: ANGSTROM_MAINNET_HOOK,
  });
}

function angstromSuccessResult(
  request: AdapterRequest,
  canonical: CanonicalSource,
): AdapterRequestResult {
  const data =
    request.kind === "get-code"
      ? "0x00"
      : request.id === "identity-slot0" ||
          request.id === "current-slot0"
        ? UNIV4_STATE_VIEW_INTERFACE.encodeFunctionResult(
            "getSlot0",
            [1n << 96n, 0n, 0n, 3_000n],
          )
        : request.id === "identity-liquidity" ||
            request.id === "current-liquidity"
          ? UNIV4_STATE_VIEW_INTERFACE.encodeFunctionResult(
              "getLiquidity",
              [10n ** 18n],
            )
          : request.id === "hook-controller-slot"
            ? ANGSTROM_HOOK_STATE_INTERFACE.encodeFunctionResult(
                "extsload",
                [BigInt(ANGSTROM_FIXTURE_CONTROLLER)],
              )
            : request.id === "controller-canonical-hook"
              ? ANGSTROM_CONTROLLER_INTERFACE.encodeFunctionResult(
                  "ANGSTROM",
                  [ANGSTROM_MAINNET_HOOK],
                )
              : request.id === "exact-angstrom-v4-quotes"
                ? (() => {
                    const quote = UNIV4_QUOTER_INTERFACE.encodeFunctionResult(
                      "quoteExactInputSingle",
                      [1_000_000n, 0n],
                    );
                    return blockScanMulticallIface.encodeFunctionResult(
                      "aggregate3",
                      [[Object.freeze({
                        success: true,
                        returnData: quote,
                      })]],
                    );
                  })()
                : (() => {
                    throw new Error(
                      "unexpected angstrom-v4 fixture request " + request.id,
                    );
                  })();
  return Object.freeze({
    id: request.id,
    ok: true as const,
    source: canonical,
    provenance: Object.freeze({
      kind: "migration-capture-fixture",
      fingerprint: `fixture:${request.id}`,
    }),
    completion: "returned" as const,
    data,
  });
}

export const ANGSTROM_FIXTURE_CONTROLLER = `0x${"de".repeat(20)}`;

class AngstromFixtureScheduler implements CentralAdapterScheduler {
  issueExecutor(
    input: Parameters<CentralAdapterScheduler["issueExecutor"]>[0],
  ): ReturnType<CentralAdapterScheduler["issueExecutor"]> {
    const executor = createBoundedRequestExecutor({
      assertSupported: (requirements) => assert.deepEqual(
        requirements,
        input.requirements,
      ),
      assertCallerBinding() {},
      assertWithinBudget: (_familyId, requests) => {
        assert.deepEqual(requests, input.requests);
      },
      execute: async (execution) => Promise.all(execution.requests.map(
        (request) => angstromSuccessResult(request, execution.source),
      )),
      sealStaticEvidenceReuseProof: () => ({ proofHash: "ab".repeat(32) }),
    });
    return Object.freeze({
      executor,
      timing: () => ({ queueWaitMs: 0, transportWallMs: 1, attempts: 1 }),
    });
  }
}

function angstromFixtureRuntime(): CentralAdapterRuntime {
  let now = 1_000;
  return {
    clock: { nowMs: () => now++ },
    generationFence: new FixtureFence(),
    callerAuthority: { bind: () => ({}) },
    policy: {
      bind: (input) => ({
        lane: input.stage === "identity" ? "critical-proof" : "background",
        deadlineAtMs: 100_000,
        maxAttempts: 1,
        transportPool: "state-read",
        fairnessKey: input.subjectKey,
      }),
    },
    budgets: { assertAdmitted() {} },
    scheduler: new AngstromFixtureScheduler(),
  };
}

async function runAngstromLifecycle(
  canonical: CanonicalSource,
  poolKey: ReturnType<typeof angstromFixturePoolKey>,
): Promise<AdapterFamilyPublication> {
  const family = PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG.forFamily(
    ANGSTROM_V4_FAMILY_ID,
  );
  const poolId = canonicalPoolId(
    v4PoolId(poolKey),
  );
  let publication: AdapterFamilyPublication | null = null;
  const initializeLog = UNIV4_POOL_MANAGER_INTERFACE.encodeEventLog(
    "Initialize",
    [
      poolId,
      poolKey.currency0,
      poolKey.currency1,
      BigInt(poolKey.fee),
      BigInt(poolKey.tickSpacing),
      poolKey.hooks,
      1n << 96n,
      0n,
    ],
  );
  const result = await executeAdapterFamilyLifecycleBatch({
    family,
    matches: [Object.freeze({
      matchedPatternId: "angstrom-v4-pool-initialize",
      observation: Object.freeze({
        kind: "log" as const,
        source: canonical,
        address: ADDR.UNISWAP_V4_POOL_MANAGER,
        topics: Object.freeze([...initializeLog.topics]),
        data: initializeLog.data,
      }),
    })],
    source: canonical,
    generation: canonical.generation,
    runtime: angstromFixtureRuntime(),
    publisher: { publish: (value) => { publication = value; } },
  });
  assert(result.publication);
  assert(publication);
  return publication;
}

function angstromRuntimeEvidenceFor(
  source: CanonicalSource,
  instanceKey: string,
): RuntimeEvidence {
  const node = `0x${"11".repeat(20)}`;
  const signature = `0x${"22".repeat(65)}`;
  const unlockData = `${node}${signature.slice(2)}`;
  const attestation = Object.freeze({
    ...parseAngstromAttestation({
      blockNumber: BigInt(source.number),
      unlockData,
    }),
    verification: "evidence-bound" as const,
  });
  const payload = encodeAngstromExecutionEvidence([attestation]);
  const payloadHash = ethers.keccak256(payload);
  const txHash = `0x${"ab".repeat(32)}`;
  return Object.freeze({
    evidenceId: "fixture:angstrom-empty-block",
    familyId: ANGSTROM_V4_FAMILY_ID,
    instanceKey: instanceKey as RuntimeEvidence["instanceKey"],
    kind: "angstrom-empty-block-attestation",
    scope: "transaction" as const,
    source,
    txHash,
    evidenceHash: angstromRuntimeEvidenceHash({
      txHash,
      source,
      payloadHash,
    }),
    sealedPayloadRef: payload,
  });
}

/**
 * Runs the angstrom-v4 official-hook lifecycle over the initialize log
 * fixture: static pool-key/hook/controller proof, tx-bound attestation
 * exact quotes and v4-style current pricing.
 */
export async function captureAngstromV4FixtureCase(input: {
  readonly source: CanonicalSource;
  readonly caseId?: string;
}): Promise<RawFamilyMigrationCaseCapture> {
  const poolKey = angstromFixturePoolKey();
  const poolId = canonicalPoolId(
    v4PoolId(poolKey),
  );
  const publication = await runAngstromLifecycle(input.source, poolKey);
  const evidenceRefs = Object.freeze([
    `fixture:angstrom-v4:${input.source.number}:${input.source.hash}`,
  ]);
  const family = PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG.forFamily(
    ANGSTROM_V4_FAMILY_ID,
  );
  const edges: RawMigrationStageCapture["items"][number][] = [];
  const prices: RawMigrationStageCapture["items"][number][] = [];
  for (const instance of publication.instances) {
    for (const route of instance.routes) {
      const handle = instance.routeHandles.find((candidate) =>
        candidate.routeKey === route.routeKey
      );
      if (handle === undefined) {
        throw new Error(
          `prepared route ${route.routeKey} has no issued handle`,
        );
      }
      const projected = projectFamilyRouteGraph({
        family,
        descriptor: instance.descriptor,
        route,
        handle,
      });
      edges.push(Object.freeze({
        id: projected.edge.canonicalEdgeId,
        value: Object.freeze({
          routeKey: route.routeKey,
          tokenIn: route.tokenIn,
          tokenOut: route.tokenOut,
          canonicalEdgeId: projected.edge.canonicalEdgeId,
        }),
      }));
    }
    const routeByKey = new Map(
      instance.routes.map((route) => [route.routeKey, route]),
    );
    for (const pricing of instance.pricingInstances) {
      for (const [routeKey, mid] of pricing.mids) {
        const route = routeByKey.get(routeKey);
        if (route === undefined) {
          throw new Error(
            `angstrom-v4 pricing route ${routeKey} is missing`,
          );
        }
        prices.push(Object.freeze({
          id: `${pricing.stateKey}:${route.tokenIn.toLowerCase()}>` +
            `${route.tokenOut.toLowerCase()}`,
          value: Object.freeze({
            stateKey: pricing.stateKey,
            mid: Object.freeze({ ...mid }),
          }) as unknown as RawMigrationStageCapture["items"][number]["value"],
        }));
      }
    }
  }
  const enumeratedRoutes: RawMigrationStageCapture["items"][number][] = edges
    .map((edge) => edge.value as {
      readonly routeKey: string;
      readonly tokenIn: string;
      readonly tokenOut: string;
      readonly canonicalEdgeId: string;
    })
    .sort((left, right) => left.routeKey.localeCompare(right.routeKey))
    .map((value, order) => Object.freeze({
      id: value.canonicalEdgeId,
      value: Object.freeze({
        routeKey: value.routeKey,
        tokenIn: value.tokenIn,
        tokenOut: value.tokenOut,
        canonicalEdgeId: value.canonicalEdgeId,
        order,
      }),
    }));
  const exactMethod = angstromV4Exact.methods().find(
    (method) => method.kind === "request-program" &&
      method.id === "tx-bound-quoter",
  );
  if (exactMethod === undefined || exactMethod.kind !== "request-program") {
    throw new Error("angstrom-v4 exact request program is missing");
  }
  const program = exactMethod.program;
  const exactByRouteKey = new Map<
    string,
    {
      readonly amountOut: bigint;
      readonly evidence: import("./venues/swaps/angstrom-v4-family/types.js")
        .AngstromV4ExactEvidence;
    }
  >();
  const exactQuotes: RawMigrationStageCapture["items"][number][] = [];
  const edgeByRouteKey = new Map(
    edges.map((edge) => {
      const value = edge.value as { readonly routeKey: string };
      return [value.routeKey, edge] as const;
    }),
  );
  for (const instance of publication.instances) {
    const runtimeEvidence = Object.freeze([
      angstromRuntimeEvidenceFor(input.source, instance.instanceKey),
    ]);
    for (const route of [...instance.routes].sort(
      (left, right) => left.routeKey.localeCompare(right.routeKey),
    )) {
      const exactInput = Object.freeze({
        descriptor: instance.descriptor as unknown as AngstromV4Descriptor,
        route: route as unknown as AngstromV4Route,
        amountIn: UNIV2_CAPTURE_EXACT_AMOUNT_IN,
        source: input.source,
        executor: MIGRATION_CAPTURE_EXECUTOR,
        runtimeEvidence,
      });
      const requests = program.buildRequests(exactInput);
      const results = requests.map((request) =>
        angstromSuccessResult(request, input.source)
      );
      const decoded = program.decode({
        programInput: exactInput,
        initialResults: results,
        dependentEvidence: Object.freeze([]),
      });
      const edge = edgeByRouteKey.get(route.routeKey);
      if (edge === undefined) {
        throw new Error(
          `angstrom-v4 exact route ${route.routeKey} has no edge`,
        );
      }
      exactByRouteKey.set(route.routeKey, {
        amountOut: decoded.amountOut,
        evidence: decoded.evidence,
      });
      exactQuotes.push(Object.freeze({
        id: `${edge.id}\u001fexact:${UNIV2_CAPTURE_EXACT_AMOUNT_IN}`,
        value: Object.freeze({
          routeKey: route.routeKey,
          tokenIn: route.tokenIn,
          tokenOut: route.tokenOut,
          canonicalEdgeId: edge.id,
          amountIn: UNIV2_CAPTURE_EXACT_AMOUNT_IN.toString(),
          amountOut: decoded.amountOut.toString(),
          feeBps: "0",
        }),
      }));
    }
  }
  const executionFragments: RawMigrationStageCapture["items"][number][] = [];
  const finalSimulations: RawMigrationStageCapture["items"][number][] = [];
  for (const instance of publication.instances) {
    const runtimeEvidence = Object.freeze([
      angstromRuntimeEvidenceFor(input.source, instance.instanceKey),
    ]);
    for (const route of [...instance.routes].sort(
      (left, right) => left.routeKey.localeCompare(right.routeKey),
    )) {
      const quote = exactByRouteKey.get(route.routeKey);
      const edge = edgeByRouteKey.get(route.routeKey);
      if (quote === undefined || edge === undefined) {
        throw new Error(
          `angstrom-v4 execution route ${route.routeKey} has no quote`,
        );
      }
      const amountIn = UNIV2_CAPTURE_EXACT_AMOUNT_IN;
      const fragment = angstromV4Execution.buildFragment({
        descriptor: instance.descriptor as unknown as AngstromV4Descriptor,
        route: route as unknown as AngstromV4Route,
        amountIn,
        quotedAmountOut: quote.amountOut,
        minAmountOut: quote.amountOut,
        exactEvidence: quote.evidence,
        executor: MIGRATION_CAPTURE_EXECUTOR,
        runtimeEvidence,
      });
      executionFragments.push(Object.freeze({
        id: `${edge.id}\u001fexec:${amountIn}`,
        value: Object.freeze({
          routeKey: route.routeKey,
          tokenIn: route.tokenIn,
          tokenOut: route.tokenOut,
          canonicalEdgeId: edge.id,
          amountIn: amountIn.toString(),
          amountOut: quote.amountOut.toString(),
          minAmountOut: quote.amountOut.toString(),
          actionAdapterId: "angstrom-v4-swap",
          executionTarget: ANGSTROM_MAINNET_ADAPTER,
          nodeFingerprint: hashCanonical(
            fragment.nodes as unknown as CanonicalValue,
          ),
        }),
      }));
      const effects = angstromV4Execution.expectedEffects({
        descriptor: instance.descriptor as unknown as AngstromV4Descriptor,
        route: route as unknown as AngstromV4Route,
        amountIn,
        quotedAmountOut: quote.amountOut,
      });
      if (quote.amountOut <= 0n) {
        throw new Error(
          "angstrom-v4 capture final simulation repayment failed",
        );
      }
      finalSimulations.push(Object.freeze({
        id: `${edge.id}\u001fsim:${amountIn}`,
        value: Object.freeze({
          routeKey: route.routeKey,
          tokenIn: route.tokenIn,
          tokenOut: route.tokenOut,
          canonicalEdgeId: edge.id,
          amountIn: amountIn.toString(),
          amountOut: quote.amountOut.toString(),
          minAmountOut: quote.amountOut.toString(),
          effectsFingerprint: hashCanonical(
            effects as unknown as CanonicalValue,
          ),
          conservation: "conserved",
          repayment: "satisfied",
          evInput: Object.freeze({
            amountIn: amountIn.toString(),
            amountOut: quote.amountOut.toString(),
          }),
        }),
      }));
    }
  }
  const instances = publication.instances;
  const summary = definedFamilyPluginContractSummary(family.plugin);
  return Object.freeze({
    familyId: ANGSTROM_V4_FAMILY_ID,
    caseId: input.caseId ?? `angstrom-v4:${input.source.number}`,
    inputFingerprint: input.source.hash.slice(2).padStart(64, "0"),
    stateAnchorNumber: input.source.number,
    implementationClosureHash: summary.definitionBoundaryHash,
    stages: Object.freeze({
      instances: instanceStage(instances, evidenceRefs),
      edges: exercisedStage(edges, evidenceRefs),
      stateCoverage: exercisedStage([], evidenceRefs),
      pricedEdges: exercisedStage([], evidenceRefs),
      prices: exercisedStage(prices, evidenceRefs),
      failures: exercisedStage([], evidenceRefs),
      enumeratedRoutes: exercisedStage(enumeratedRoutes, evidenceRefs),
      exactQuotes: exercisedStage(exactQuotes, evidenceRefs),
      executionFragments: exercisedStage(executionFragments, evidenceRefs),
      finalSimulations: exercisedStage(finalSimulations, evidenceRefs),
    }),
  });
}

export const DODO_V2_FIXTURE_POOL = `0x${"e1".repeat(20)}`;
export const DODO_V2_FIXTURE_BASE_TOKEN = `0x${"e2".repeat(20)}`;
export const DODO_V2_FIXTURE_QUOTE_TOKEN = `0x${"e3".repeat(20)}`;

function dodoV2PmmResult(): string {
  return DODO_V2_POOL_INTERFACE.encodeFunctionResult(
    "getPMMStateForCall",
    [10n ** 18n, 0n, 10n ** 24n, 10n ** 24n, 10n ** 24n, 10n ** 24n, 2n],
  );
}

function dodoV2InputSemanticsResult(): string {
  const balance = DODO_V2_ERC20_INTERFACE.encodeFunctionResult(
    "balanceOf",
    [10n ** 24n],
  );
  const baseReserve = DODO_V2_POOL_INTERFACE.encodeFunctionResult(
    "_BASE_RESERVE_",
    [10n ** 24n],
  );
  const quoteReserve = DODO_V2_POOL_INTERFACE.encodeFunctionResult(
    "_QUOTE_RESERVE_",
    [10n ** 24n],
  );
  const zeroInput = DODO_V2_POOL_INTERFACE.encodeFunctionResult(
    "getBaseInput",
    [0n],
  );
  const quoteInput = DODO_V2_POOL_INTERFACE.encodeFunctionResult(
    "getQuoteInput",
    [0n],
  );
  const mtFees = DODO_V2_POOL_INTERFACE.encodeFunctionResult(
    "getMtFeeTotal",
    [0n, 0n],
  );
  const item = (returnData: string) => Object.freeze({
    success: true,
    returnData,
  });
  return blockScanMulticallIface.encodeFunctionResult(
    "aggregate3",
    [[
      item(balance),
      item(balance),
      item(baseReserve),
      item(quoteReserve),
      item(zeroInput),
      item(quoteInput),
      item(mtFees),
    ]],
  );
}

function dodoV2SuccessResult(
  request: AdapterRequest,
  canonical: CanonicalSource,
): AdapterRequestResult {
  const data =
    request.id === "pool-base-token" ||
        request.id === "current-base-token"
      ? DODO_V2_POOL_INTERFACE.encodeFunctionResult(
          "_BASE_TOKEN_",
          [DODO_V2_FIXTURE_BASE_TOKEN],
        )
      : request.id === "pool-quote-token" ||
          request.id === "current-quote-token"
        ? DODO_V2_POOL_INTERFACE.encodeFunctionResult(
            "_QUOTE_TOKEN_",
            [DODO_V2_FIXTURE_QUOTE_TOKEN],
          )
        : request.id === "pool-pmm-behavior" ||
            request.id === "current-pmm-state" ||
            request.id === "exact-pmm-state"
          ? dodoV2PmmResult()
          : request.id === "pool-actor-fee-behavior" ||
              request.id === "current-actor-fee" ||
              request.id === "exact-actor-fee"
            ? DODO_V2_POOL_INTERFACE.encodeFunctionResult(
                "getUserFeeRate",
                [0n, 0n],
              )
            : request.id === "registry-get-dodo-pool"
              ? DODO_V2_REGISTRY_INTERFACE.encodeFunctionResult(
                  "getDODOPool",
                  [[DODO_V2_FIXTURE_POOL]],
                )
              : request.id === "static-base-decimals" ||
                  request.id === "static-quote-decimals"
                ? DODO_V2_ERC20_INTERFACE.encodeFunctionResult(
                    "decimals",
                    [18],
                  )
                : request.id === "current-input-semantics" ||
                    request.id === "exact-input-semantics"
                  ? dodoV2InputSemanticsResult()
                  : request.id === "exact-actor-query"
                    ? (() => {
                        const data = (request as { readonly data: string }).data;
                        const selector = data.slice(0, 10).toLowerCase();
                        const sellBase = selector ===
                          DODO_V2_POOL_INTERFACE.getFunction("querySellBase")!
                            .selector;
                        const functionName = sellBase
                          ? "querySellBase"
                          : "querySellQuote";
                        const amountIn = BigInt(
                          DODO_V2_POOL_INTERFACE.decodeFunctionData(
                            functionName,
                            data,
                          )[1],
                        );
                        return DODO_V2_POOL_INTERFACE.encodeFunctionResult(
                          functionName,
                          [amountIn],
                        );
                      })()
                    : (() => {
                        throw new Error(
                          "unexpected dodo-v2 fixture request " + request.id,
                        );
                      })();
  return Object.freeze({
    id: request.id,
    ok: true as const,
    source: canonical,
    provenance: Object.freeze({
      kind: "migration-capture-fixture",
      fingerprint: `fixture:${request.id}`,
    }),
    completion: "returned" as const,
    data,
  });
}

class DodoV2FixtureScheduler implements CentralAdapterScheduler {
  issueExecutor(
    input: Parameters<CentralAdapterScheduler["issueExecutor"]>[0],
  ): ReturnType<CentralAdapterScheduler["issueExecutor"]> {
    const executor = createBoundedRequestExecutor({
      assertSupported: (requirements) => assert.deepEqual(
        requirements,
        input.requirements,
      ),
      assertCallerBinding() {},
      assertWithinBudget: (_familyId, requests) => {
        assert.deepEqual(requests, input.requests);
      },
      execute: async (execution) => Promise.all(execution.requests.map(
        (request) => dodoV2SuccessResult(request, execution.source),
      )),
      sealStaticEvidenceReuseProof: () => ({ proofHash: "ab".repeat(32) }),
    });
    return Object.freeze({
      executor,
      timing: () => ({ queueWaitMs: 0, transportWallMs: 1, attempts: 1 }),
    });
  }
}

function dodoV2FixtureRuntime(): CentralAdapterRuntime {
  let now = 1_000;
  return {
    clock: { nowMs: () => now++ },
    generationFence: new FixtureFence(),
    callerAuthority: {
      bind: (input) => input.callerRole === "verified-actor"
        ? Object.freeze({
            verifiedActors: Object.freeze({
              [DODO_V2_QUOTE_ACTOR_EVIDENCE_ID]: DODO_V2_QUOTE_ACTOR,
            }),
          })
        : Object.freeze({}),
    },
    policy: {
      bind: (input) => ({
        lane: input.stage === "identity" ? "critical-proof" : "background",
        deadlineAtMs: 100_000,
        maxAttempts: 1,
        transportPool: "state-read",
        fairnessKey: input.subjectKey,
      }),
    },
    budgets: { assertAdmitted() {} },
    scheduler: new DodoV2FixtureScheduler(),
  };
}

async function runDodoV2Lifecycle(
  canonical: CanonicalSource,
): Promise<AdapterFamilyPublication> {
  const family = PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG.forFamily(
    DODO_V2_FAMILY_ID,
  );
  let publication: AdapterFamilyPublication | null = null;
  const sellCalldata = DODO_V2_POOL_INTERFACE.encodeFunctionData(
    "sellBase",
    [MIGRATION_CAPTURE_EXECUTOR],
  );
  const result = await executeAdapterFamilyLifecycleBatch({
    family,
    matches: [Object.freeze({
      matchedPatternId: "dodo-v2-sell-base-call",
      observation: Object.freeze({
        kind: "call" as const,
        source: canonical,
        target: DODO_V2_FIXTURE_POOL,
        data: sellCalldata,
      }),
    })],
    source: canonical,
    generation: canonical.generation,
    runtime: dodoV2FixtureRuntime(),
    publisher: { publish: (value) => { publication = value; } },
  });
  assert(result.publication);
  assert(publication);
  return publication;
}

/**
 * Runs the dodo-v2 registry lifecycle over the observed sellBase fixture:
 * pool behavior + registry reverse binding identity, PMM K=0 1:1 pricing
 * (zero deficit/surplus keeps selection local), actor-bound exact query and
 * execution.
 */
export async function captureDodoV2FixtureCase(input: {
  readonly source: CanonicalSource;
  readonly caseId?: string;
}): Promise<RawFamilyMigrationCaseCapture> {
  const publication = await runDodoV2Lifecycle(input.source);
  const evidenceRefs = Object.freeze([
    `fixture:dodo-v2:${input.source.number}:${input.source.hash}`,
  ]);
  const family = PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG.forFamily(
    DODO_V2_FAMILY_ID,
  );
  const edges: RawMigrationStageCapture["items"][number][] = [];
  const prices: RawMigrationStageCapture["items"][number][] = [];
  for (const instance of publication.instances) {
    for (const route of instance.routes) {
      const handle = instance.routeHandles.find((candidate) =>
        candidate.routeKey === route.routeKey
      );
      if (handle === undefined) {
        throw new Error(
          `prepared route ${route.routeKey} has no issued handle`,
        );
      }
      const projected = projectFamilyRouteGraph({
        family,
        descriptor: instance.descriptor,
        route,
        handle,
      });
      edges.push(Object.freeze({
        id: projected.edge.canonicalEdgeId,
        value: Object.freeze({
          routeKey: route.routeKey,
          tokenIn: route.tokenIn,
          tokenOut: route.tokenOut,
          canonicalEdgeId: projected.edge.canonicalEdgeId,
        }),
      }));
    }
    const routeByKey = new Map(
      instance.routes.map((route) => [route.routeKey, route]),
    );
    for (const pricing of instance.pricingInstances) {
      for (const [routeKey, mid] of pricing.mids) {
        const route = routeByKey.get(routeKey);
        if (route === undefined) {
          throw new Error(`dodo-v2 pricing route ${routeKey} is missing`);
        }
        prices.push(Object.freeze({
          id: `${pricing.stateKey}:${route.tokenIn.toLowerCase()}>` +
            `${route.tokenOut.toLowerCase()}`,
          value: Object.freeze({
            stateKey: pricing.stateKey,
            mid: Object.freeze({ ...mid }),
          }) as unknown as RawMigrationStageCapture["items"][number]["value"],
        }));
      }
    }
  }
  const enumeratedRoutes: RawMigrationStageCapture["items"][number][] = edges
    .map((edge) => edge.value as {
      readonly routeKey: string;
      readonly tokenIn: string;
      readonly tokenOut: string;
      readonly canonicalEdgeId: string;
    })
    .sort((left, right) => left.routeKey.localeCompare(right.routeKey))
    .map((value, order) => Object.freeze({
      id: value.canonicalEdgeId,
      value: Object.freeze({
        routeKey: value.routeKey,
        tokenIn: value.tokenIn,
        tokenOut: value.tokenOut,
        canonicalEdgeId: value.canonicalEdgeId,
        order,
      }),
    }));
  const exactMethod = dodoV2Exact.methods().find(
    (method) => method.kind === "request-program" &&
      method.id === "actor-bound-query",
  );
  if (exactMethod === undefined || exactMethod.kind !== "request-program") {
    throw new Error("dodo-v2 exact request program is missing");
  }
  const program = exactMethod.program;
  const exactByRouteKey = new Map<
    string,
    {
      readonly amountOut: bigint;
      readonly evidence: import("./venues/swaps/dodo-v2-family/types.js")
        .DodoV2ExactEvidence;
    }
  >();
  const exactQuotes: RawMigrationStageCapture["items"][number][] = [];
  const edgeByRouteKey = new Map(
    edges.map((edge) => {
      const value = edge.value as { readonly routeKey: string };
      return [value.routeKey, edge] as const;
    }),
  );
  for (const instance of publication.instances) {
    for (const route of [...instance.routes].sort(
      (left, right) => left.routeKey.localeCompare(right.routeKey),
    )) {
      const exactInput = Object.freeze({
        descriptor: instance.descriptor as unknown as DodoV2Descriptor,
        route: route as unknown as DodoV2Route,
        amountIn: UNIV2_CAPTURE_EXACT_AMOUNT_IN,
        source: input.source,
        executor: DODO_V2_QUOTE_ACTOR,
        runtimeEvidence: Object.freeze([]),
      });
      const requests = program.buildRequests(exactInput);
      const results = requests.map((request) =>
        dodoV2SuccessResult(request, input.source)
      );
      const decoded = program.decode({
        programInput: exactInput,
        initialResults: results,
        dependentEvidence: Object.freeze([]),
      });
      const edge = edgeByRouteKey.get(route.routeKey);
      if (edge === undefined) {
        throw new Error(`dodo-v2 exact route ${route.routeKey} has no edge`);
      }
      exactByRouteKey.set(route.routeKey, {
        amountOut: decoded.amountOut,
        evidence: decoded.evidence,
      });
      exactQuotes.push(Object.freeze({
        id: `${edge.id}\u001fexact:${UNIV2_CAPTURE_EXACT_AMOUNT_IN}`,
        value: Object.freeze({
          routeKey: route.routeKey,
          tokenIn: route.tokenIn,
          tokenOut: route.tokenOut,
          canonicalEdgeId: edge.id,
          amountIn: UNIV2_CAPTURE_EXACT_AMOUNT_IN.toString(),
          amountOut: decoded.amountOut.toString(),
          feeBps: "0",
        }),
      }));
    }
  }
  const executionFragments: RawMigrationStageCapture["items"][number][] = [];
  const finalSimulations: RawMigrationStageCapture["items"][number][] = [];
  for (const instance of publication.instances) {
    for (const route of [...instance.routes].sort(
      (left, right) => left.routeKey.localeCompare(right.routeKey),
    )) {
      const quote = exactByRouteKey.get(route.routeKey);
      const edge = edgeByRouteKey.get(route.routeKey);
      if (quote === undefined || edge === undefined) {
        throw new Error(
          `dodo-v2 execution route ${route.routeKey} has no quote`,
        );
      }
      const amountIn = UNIV2_CAPTURE_EXACT_AMOUNT_IN;
      const fragment = dodoV2Execution.buildFragment({
        descriptor: instance.descriptor as unknown as DodoV2Descriptor,
        route: route as unknown as DodoV2Route,
        amountIn,
        quotedAmountOut: quote.amountOut,
        minAmountOut: quote.amountOut,
        exactEvidence: quote.evidence,
        executor: DODO_V2_QUOTE_ACTOR,
        runtimeEvidence: Object.freeze([]),
      });
      executionFragments.push(Object.freeze({
        id: `${edge.id}\u001fexec:${amountIn}`,
        value: Object.freeze({
          routeKey: route.routeKey,
          tokenIn: route.tokenIn,
          tokenOut: route.tokenOut,
          canonicalEdgeId: edge.id,
          amountIn: amountIn.toString(),
          amountOut: quote.amountOut.toString(),
          minAmountOut: quote.amountOut.toString(),
          actionAdapterId: "dodo-v2-swap",
          executionTarget: (
            instance.descriptor as unknown as DodoV2Descriptor
          ).pool,
          nodeFingerprint: hashCanonical(
            fragment.nodes as unknown as CanonicalValue,
          ),
        }),
      }));
      const effects = dodoV2Execution.expectedEffects({
        descriptor: instance.descriptor as unknown as DodoV2Descriptor,
        route: route as unknown as DodoV2Route,
        amountIn,
        quotedAmountOut: quote.amountOut,
      });
      if (quote.amountOut <= 0n) {
        throw new Error(
          "dodo-v2 capture final simulation repayment failed",
        );
      }
      finalSimulations.push(Object.freeze({
        id: `${edge.id}\u001fsim:${amountIn}`,
        value: Object.freeze({
          routeKey: route.routeKey,
          tokenIn: route.tokenIn,
          tokenOut: route.tokenOut,
          canonicalEdgeId: edge.id,
          amountIn: amountIn.toString(),
          amountOut: quote.amountOut.toString(),
          minAmountOut: quote.amountOut.toString(),
          effectsFingerprint: hashCanonical(
            effects as unknown as CanonicalValue,
          ),
          conservation: "conserved",
          repayment: "satisfied",
          evInput: Object.freeze({
            amountIn: amountIn.toString(),
            amountOut: quote.amountOut.toString(),
          }),
        }),
      }));
    }
  }
  const instances = publication.instances;
  const summary = definedFamilyPluginContractSummary(family.plugin);
  return Object.freeze({
    familyId: DODO_V2_FAMILY_ID,
    caseId: input.caseId ?? `dodo-v2:${input.source.number}`,
    inputFingerprint: input.source.hash.slice(2).padStart(64, "0"),
    stateAnchorNumber: input.source.number,
    implementationClosureHash: summary.definitionBoundaryHash,
    stages: Object.freeze({
      instances: instanceStage(instances, evidenceRefs),
      edges: exercisedStage(edges, evidenceRefs),
      stateCoverage: exercisedStage([], evidenceRefs),
      pricedEdges: exercisedStage([], evidenceRefs),
      prices: exercisedStage(prices, evidenceRefs),
      failures: exercisedStage([], evidenceRefs),
      enumeratedRoutes: exercisedStage(enumeratedRoutes, evidenceRefs),
      exactQuotes: exercisedStage(exactQuotes, evidenceRefs),
      executionFragments: exercisedStage(executionFragments, evidenceRefs),
      finalSimulations: exercisedStage(finalSimulations, evidenceRefs),
    }),
  });
}

export const FLUID_CREDIT_FIXTURE_VAULT = `0x${"f1".repeat(20)}`;
export const FLUID_CREDIT_FIXTURE_FACTORY = `0x${"f2".repeat(20)}`;
export const FLUID_CREDIT_FIXTURE_SUPPLY = `0x${"f3".repeat(20)}`;
export const FLUID_CREDIT_FIXTURE_BORROW = `0x${"f4".repeat(20)}`;
export const FLUID_CREDIT_FIXTURE_COLLATERAL = 1_000n * 10n ** 18n;
export const FLUID_CREDIT_FIXTURE_DEBT = 10n ** 18n;

function fluidCreditConstantsResult(): string {
  const zero = `0x${"00".repeat(20)}`;
  const slot = "0x" + "11".repeat(32);
  return FLUID_VAULT_INTERFACE.encodeFunctionResult("constantsView", [[
    zero,
    FLUID_CREDIT_FIXTURE_FACTORY,
    zero,
    zero,
    FLUID_CREDIT_FIXTURE_SUPPLY,
    FLUID_CREDIT_FIXTURE_BORROW,
    18,
    18,
    1n,
    slot,
    slot,
    slot,
    slot,
  ]]);
}

function fluidCreditSuccessResult(
  request: AdapterRequest,
  canonical: CanonicalSource,
): AdapterRequestResult {
  if (request.kind === "effect-delta-simulation") {
    const decoded = FLUID_VAULT_INTERFACE.decodeFunctionData(
      "operate",
      (request as { readonly call: { readonly data: string } }).call.data,
    );
    const collateralAmount = BigInt(decoded[1]);
    const debtAmount = BigInt(decoded[2]);
    const callerRef = (request as {
      readonly call: { readonly caller: { readonly kind: string } };
    }).call.caller;
    const actor = callerRef.kind === "verified-actor"
      ? FLUID_CREDIT_PROBE_ACTOR.toLowerCase()
      : callerRef.kind === "executor"
        ? MIGRATION_CAPTURE_EXECUTOR.toLowerCase()
        : (() => {
            throw new Error(
              `fluid-credit fixture caller ${callerRef.kind} is unsupported`,
            );
          })();
    return Object.freeze({
      id: request.id,
      ok: true as const,
      source: canonical,
      provenance: Object.freeze({
        kind: "migration-capture-fixture",
        fingerprint: `fixture:${request.id}`,
      }),
      completion: "returned" as const,
      data: FLUID_VAULT_INTERFACE.encodeFunctionResult("operate", [
        1n,
        collateralAmount,
        debtAmount,
      ]),
      effects: Object.freeze({
        tokenDeltas: Object.freeze([
          Object.freeze({
            token: FLUID_CREDIT_FIXTURE_SUPPLY.toLowerCase(),
            account: actor,
            delta: -collateralAmount,
          }),
          Object.freeze({
            token: FLUID_CREDIT_FIXTURE_BORROW.toLowerCase(),
            account: actor,
            delta: debtAmount,
          }),
        ]),
      }),
    });
  }
  const data =
    request.id === "vault-constants"
      ? fluidCreditConstantsResult()
      : request.kind === "get-code"
        ? "0x00"
        : request.id === "factory-reverse-vault"
          ? FLUID_VAULT_FACTORY_INTERFACE.encodeFunctionResult(
              "getVaultAddress",
              [FLUID_CREDIT_FIXTURE_VAULT],
            )
          : (() => {
              throw new Error(
                "unexpected fluid-credit fixture request " + request.id,
              );
            })();
  return Object.freeze({
    id: request.id,
    ok: true as const,
    source: canonical,
    provenance: Object.freeze({
      kind: "migration-capture-fixture",
      fingerprint: `fixture:${request.id}`,
    }),
    completion: "returned" as const,
    data,
  });
}

class FluidCreditFixtureScheduler implements CentralAdapterScheduler {
  issueExecutor(
    input: Parameters<CentralAdapterScheduler["issueExecutor"]>[0],
  ): ReturnType<CentralAdapterScheduler["issueExecutor"]> {
    const executor = createBoundedRequestExecutor({
      assertSupported: (requirements) => assert.deepEqual(
        requirements,
        input.requirements,
      ),
      assertCallerBinding() {},
      assertWithinBudget: (_familyId, requests) => {
        assert.deepEqual(requests, input.requests);
      },
      execute: async (execution) => Promise.all(execution.requests.map(
        (request) => fluidCreditSuccessResult(request, execution.source),
      )),
      sealStaticEvidenceReuseProof: () => ({ proofHash: "ab".repeat(32) }),
    });
    return Object.freeze({
      executor,
      timing: () => ({ queueWaitMs: 0, transportWallMs: 1, attempts: 1 }),
    });
  }
}

function fluidCreditFixtureRuntime(): CentralAdapterRuntime {
  let now = 1_000;
  return {
    clock: { nowMs: () => now++ },
    generationFence: new FixtureFence(),
    callerAuthority: {
      bind: (input) => input.callerRole === "verified-actor"
        ? Object.freeze({
            verifiedActors: Object.freeze({
              [FLUID_CREDIT_PROBE_ACTOR_EVIDENCE_ID]:
                FLUID_CREDIT_PROBE_ACTOR,
            }),
          })
        : input.callerRole === "executor"
          ? Object.freeze({ executor: MIGRATION_CAPTURE_EXECUTOR })
          : Object.freeze({}),
    },
    policy: {
      bind: (input) => ({
        lane: input.stage === "identity" ? "critical-proof" : "background",
        deadlineAtMs: 100_000,
        maxAttempts: 1,
        transportPool: "state-read",
        fairnessKey: input.subjectKey,
      }),
    },
    budgets: { assertAdmitted() {} },
    scheduler: new FluidCreditFixtureScheduler(),
  };
}

async function runFluidCreditLifecycle(
  canonical: CanonicalSource,
): Promise<PreparedFamilyInstance> {
  const family = PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG.forStrictFamily(
    FLUID_CREDIT_FAMILY_ID,
  );
  const operateCalldata = FLUID_VAULT_INTERFACE.encodeFunctionData("operate", [
    0n,
    FLUID_CREDIT_FIXTURE_COLLATERAL,
    FLUID_CREDIT_FIXTURE_DEBT,
    MIGRATION_CAPTURE_EXECUTOR,
  ]);
  const result = await executeCreditFamilyInstanceLifecycle({
    family,
    match: Object.freeze({
      matchedPatternId: "fluid-credit-operate-call",
      observation: Object.freeze({
        kind: "call" as const,
        source: canonical,
        target: FLUID_CREDIT_FIXTURE_VAULT,
        data: operateCalldata,
      }),
    }),
    source: canonical,
    generation: canonical.generation,
    runtime: fluidCreditFixtureRuntime(),
  });
  assert(result.instance !== null);
  return result.instance;
}

/**
 * Runs the fluid-credit vault lifecycle over the observed operate fixture:
 * factory-child constants/reverse-binding/active-operate identity proof,
 * standing-position execution fragment and credit risk final simulation.
 * Pricing and exact stages are honestly declared absent for the credit
 * domain.
 */
export async function captureFluidCreditFixtureCase(input: {
  readonly source: CanonicalSource;
  readonly caseId?: string;
}): Promise<RawFamilyMigrationCaseCapture> {
  const instance = await runFluidCreditLifecycle(input.source);
  const evidenceRefs = Object.freeze([
    `fixture:credit:fluid:${input.source.number}:${input.source.hash}`,
  ]);
  const absentStage: RawMigrationStageCapture = Object.freeze({
    status: "declared-absent" as const,
    items: Object.freeze([]),
    evidenceRefs,
    blocker: null,
  });
  const family = PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG.forStrictFamily(
    FLUID_CREDIT_FAMILY_ID,
  );
  const routePublication = prepareCreditFamilyRoutes({
    family,
    instance,
    source: input.source,
    generation: input.source.generation,
  });
  const edges: RawMigrationStageCapture["items"][number][] = [];
  const projectedRoutes = routePublication.routes.map((handle) => {
    const projected = projectCreditRouteGraph({
      family,
      route: handle,
    });
    const value = projected.edge;
    edges.push(Object.freeze({
      id: value.canonicalEdgeId,
      value: Object.freeze({
        routeKey: handle.routeKey,
        tokenIn: value.tokenIn,
        tokenOut: value.tokenOut,
        canonicalEdgeId: value.canonicalEdgeId,
      }),
    }));
    return Object.freeze({ handle, edge: value });
  });
  const enumeratedRoutes: RawMigrationStageCapture["items"][number][] = edges
    .map((edge) => edge.value as {
      readonly routeKey: string;
      readonly tokenIn: string;
      readonly tokenOut: string;
      readonly canonicalEdgeId: string;
    })
    .sort((left, right) => left.routeKey.localeCompare(right.routeKey))
    .map((value, order) => Object.freeze({
      id: value.canonicalEdgeId,
      value: Object.freeze({
        routeKey: value.routeKey,
        tokenIn: value.tokenIn,
        tokenOut: value.tokenOut,
        canonicalEdgeId: value.canonicalEdgeId,
        order,
      }),
    }));
  const edgeByRouteKey = new Map(
    edges.map((edge) => {
      const value = edge.value as { readonly routeKey: string };
      return [value.routeKey, edge] as const;
    }),
  );
  const executionFragments: RawMigrationStageCapture["items"][number][] = [];
  const finalSimulations: RawMigrationStageCapture["items"][number][] = [];
  for (const projected of [...projectedRoutes].sort(
    (left, right) => left.handle.routeKey.localeCompare(right.handle.routeKey),
  )) {
    const routeKey = projected.handle.routeKey;
    const edge = edgeByRouteKey.get(routeKey);
    if (edge === undefined) {
      throw new Error(`fluid-credit route ${routeKey} has no edge`);
    }
    const amountIn = UNIV2_CAPTURE_EXACT_AMOUNT_IN;
    const amountOut = amountIn;
    const risk = await executeCreditRiskQuote({
      family,
      route: projected.handle,
      collateralAmount: amountIn,
      debtBps: 10_000n,
      executor: MIGRATION_CAPTURE_EXECUTOR,
      runtimeEvidence: Object.freeze([]),
      source: input.source,
      generation: input.source.generation,
      runtime: fluidCreditFixtureRuntime(),
    });
    assert(risk.status === "resolved");
    const executionHandle = issueCreditExecutionHandle({
      family,
      route: projected.handle,
      risk,
      minAmountOut: amountOut,
      executor: MIGRATION_CAPTURE_EXECUTOR,
      runtimeEvidence: Object.freeze([]),
      source: input.source,
      generation: input.source.generation,
    });
    const outcome = buildCreditExecutionFragment({
      family,
      actionOwnership: PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG,
      handle: executionHandle,
    });
    assert(outcome.status === "resolved");
    executionFragments.push(Object.freeze({
      id: `${edge.id}\u001fexec:${amountIn}`,
      value: Object.freeze({
        routeKey,
        tokenIn: projected.edge.tokenIn,
        tokenOut: projected.edge.tokenOut,
        canonicalEdgeId: edge.id,
        amountIn: amountIn.toString(),
        amountOut: amountOut.toString(),
        minAmountOut: amountOut.toString(),
        actionAdapterId: "fluid-vault",
        executionTarget: projected.edge.target,
        nodeFingerprint: hashCanonical(
          outcome.fragment.nodes as unknown as CanonicalValue,
        ),
      }),
    }));
    finalSimulations.push(Object.freeze({
      id: `${edge.id}\u001fsim:${amountIn}`,
      value: Object.freeze({
        routeKey,
        tokenIn: projected.edge.tokenIn,
        tokenOut: projected.edge.tokenOut,
        canonicalEdgeId: edge.id,
        amountIn: amountIn.toString(),
        amountOut: amountOut.toString(),
        minAmountOut: amountOut.toString(),
        effectsFingerprint: hashCanonical(
          outcome.expectedEffects as unknown as CanonicalValue,
        ),
        conservation: "conserved",
        repayment: "standing-position",
        evInput: Object.freeze({
          amountIn: amountIn.toString(),
          amountOut: amountOut.toString(),
        }),
      }),
    }));
  }
  const instances = Object.freeze([instance]);
  const summary = definedFamilyPluginContractSummary(family.plugin);
  return Object.freeze({
    familyId: FLUID_CREDIT_FAMILY_ID,
    caseId: input.caseId ?? `credit:fluid:${input.source.number}`,
    inputFingerprint: input.source.hash.slice(2).padStart(64, "0"),
    stateAnchorNumber: input.source.number,
    implementationClosureHash: summary.definitionBoundaryHash,
    stages: Object.freeze({
      instances: instanceStage(instances, evidenceRefs),
      edges: exercisedStage(edges, evidenceRefs),
      stateCoverage: absentStage,
      pricedEdges: absentStage,
      prices: absentStage,
      failures: exercisedStage([], evidenceRefs),
      enumeratedRoutes: exercisedStage(enumeratedRoutes, evidenceRefs),
      exactQuotes: absentStage,
      executionFragments: exercisedStage(executionFragments, evidenceRefs),
      finalSimulations: exercisedStage(finalSimulations, evidenceRefs),
    }),
  });
}
