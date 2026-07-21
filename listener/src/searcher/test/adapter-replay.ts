/**
 * Execution-family adapter replay.
 *
 * This is the deterministic middle layer defined by HISTORICAL-GAP.md. A
 * fixture may pin the ordered route recovered independently from a landed
 * trace, but it may not provide an amount, quote, plan, calldata, verified
 * route, or admission result. Production family adapters emit the edges, the
 * production planner composes the plan, the solver chooses the amount, and the
 * production BotVM/EV path decides whether the replay is executable.
 *
 * This is NOT Production Replay: scanner/detector discovery is deliberately
 * outside this command and only the unchanged hunt harness may prove it.
 */

import { execFile } from "node:child_process";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ethers } from "ethers";
import "../../shared/adapters/index.js";
import { get as getActionAdapter } from "../../adapters/registry.js";
import { findFlashProviderDescriptor } from "../../adapters/flash-providers.js";
import { PROTOCOL_LEG_DESCRIPTORS } from "../../adapters/protocol-legs.js";
import { compilePlan } from "../../shared/compiler/compiler.js";
import { ADDR } from "../../shared/constants/addresses.js";
import { buildExecuteCalldata } from "../../shared/executor/botvm-executor.js";
import {
  DEFAULT_SEARCHER_EXECUTOR,
  DEFAULT_SEARCHER_OWNER,
  installForkBotVm,
} from "../../shared/executor/botvm-executor.js";
import { AnvilStateBackend } from "../../shared/state/state-backend.js";
import { canonicalTokenRing, cycleFingerprint } from "../detector/cycle-fingerprint.js";
import type { BlockScanOpportunity } from "../detector/detector.js";
import { evaluateEv } from "../ev-evaluator.js";
import { TemplatePlanner } from "../planner/planner.js";
import type { PoolEntry, TokenEdge } from "../planner/token-graph.js";
import { createProfitTokenValuation } from "../profit-token-valuation.js";
import { DEFAULT_BRIBE_BPS } from "../live-envelope.js";
import { AnvilSolver, type ResolvedPlan } from "../solver/solver.js";
import { BotVMSimulator } from "../simulator/botvm-simulator.js";
import { pathLeavesStandingPosition } from "../strategy-taxonomy.js";
import type { ProtocolAction } from "../strategy-taxonomy.js";
import { FLASH_SWAP_REPAY, type PathTemplate } from "../templates/path-template.js";
import { PRODUCTION_ROUTE_ADAPTERS } from "../venues/production-registry.js";
import type { ExecutionFamilyId, SwapAdapter } from "../venues/route-leg-adapter.js";

interface ParentBlockAnchor {
  kind: "parent-block";
  blockNumber: number;
}

interface AfterTransactionAnchor {
  kind: "after-transaction";
  blockNumber: number;
  triggerTxHash: string;
}

type StateAnchor = ParentBlockAnchor | AfterTransactionAnchor;

/** Strict fixture subset. In particular, verifiedRoutes/identity/score are impossible to inject. */
interface RoutePoolIdentity {
  adapter: PoolEntry["adapter"];
  address: string;
  poolId?: string;
  token0?: string;
  token1?: string;
  underlyingCoins?: string[];
  currency0?: string;
  currency1?: string;
  fee?: number;
  tickSpacing?: number;
  hooks?: string;
  fixedTokenIn?: string;
  fixedTokenOut?: string;
  fixedSlotKind?: "lend" | "swap" | "protocol";
  fixedProtocolAction?: ProtocolAction;
  nonStandardRedeem?: boolean;
  redeemTokenOut?: string;
  receiptEmitters?: string[];
}

interface AdapterReplayLeg {
  seq: number;
  pool: RoutePoolIdentity;
  /** Trace-proven edge alias; mandatory so another ABI cannot be selected. */
  edgeAdapterId: string;
  tokenIn: string;
  tokenOut: string;
}

interface AdapterReplayFixture {
  schemaVersion: 2;
  id: string;
  executionFamilyId: ExecutionFamilyId;
  referenceTx: string;
  lane: "block-scan" | "backrun";
  stateAnchor: StateAnchor;
  flash: {
    adapterId: string;
    token: string;
  };
  route: AdapterReplayLeg[];
  landedReference: {
    /** Independently computed classification evidence; never enters sizing. */
    canonicalNetProfitUsd: number;
    evidencePath: string;
    evidenceSha256: string;
  };
}

interface ConservationResult {
  calldataHash: string;
  grossProfit: string;
  gasUsed: string;
  lenderBalanceBefore: string;
  lenderBalanceAfter: string;
  executorDeltas: Record<string, string>;
}

interface AdapterReplayReport {
  schemaVersion: 2;
  fixtureId: string;
  fixturePath: string;
  fixtureSha256: string;
  referenceTx: string;
  landedEvidencePath: string;
  landedEvidenceSha256: string;
  /** Harness choice for reproducible liquidity; not claimed as the landed tx's provider. */
  replayFlash: { adapterId: string; token: string };
  executionFamilyId: ExecutionFamilyId;
  routeExecutionFamilies: ExecutionFamilyId[];
  routeHash: string;
  referenceRouteHash: string | null;
  stateAnchor: StateAnchor;
  anchorBlockHash: string | null;
  anchorStateRoot: string | null;
  baseCommit: string | null;
  adapterCommit: string | null;
  familySourceSha256: string;
  sharedApiSha256: string;
  runtimeSourceSha256: string;
  harnessSha256: string;
  botVmArtifactSha256: string;
  executorRuntimeCodeHash: string | null;
  replayCommand: string;
  maxFlashAmount: string | null;
  solverSelectedAmount: string | null;
  finalSim: {
    success: boolean;
    grossProfit: string;
    gasUsed: string;
    calldataHash: string;
    revertReason: string | null;
  } | null;
  conservation: ConservationResult | null;
  productionEv: {
    valuationAvailable: boolean;
    netEvWei: string;
    expectedProfitEth: string;
    gasCostEth: string;
    bidEth: string;
  } | null;
  evPolicy: {
    ethUsd: number;
    profitHaircutBps: number;
    gasBufferMultX10: number;
    bribeAllAboveGas: boolean;
    bribeBps: number;
    minNetEth: string;
  };
  stages: {
    chainAnchor: boolean;
    referenceRoute: boolean;
    familyEdges: boolean;
    planner: boolean;
    solver: boolean;
    finalSim: boolean;
    repaymentAndConservation: boolean;
    productionEvPositive: boolean;
  };
  /** A promotion gate still owns baseline flip and the stronger adapter_fixed verdict. */
  verdict: "adapter_replay_pass" | "implemented_not_validated";
  failure: string | null;
}

interface CliArgs {
  fixtures: string[];
  rpcUrl: string;
  outDir?: string;
  validateOnly: boolean;
}

const LISTENER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const REPO_ROOT = resolve(LISTENER_ROOT, "..");
const HARNESS_PATH = fileURLToPath(import.meta.url);
const BOTVM_ARTIFACT_PATH = resolve(REPO_ROOT, "out/BotVM.sol/BotVM.json");
const ADDRESS_FIELDS = [
  "address", "token0", "token1", "currency0", "currency1", "hooks",
  "fixedTokenIn", "fixedTokenOut", "redeemTokenOut",
] as const;

const FAMILY_SOURCE_FILES: Readonly<Partial<Record<ExecutionFamilyId, readonly string[]>>> = {
  "univ2-standard": ["src/searcher/venues/swaps/univ2-standard.ts"],
  "univ3-standard": ["src/searcher/venues/swaps/univ3-standard.ts"],
  univ4: ["src/searcher/venues/swaps/univ4.ts", "src/searcher/venues/swaps/univ4-common.ts"],
  "curve-plain": ["src/searcher/venues/swaps/curve-plain.ts", "src/searcher/venues/swaps/curve-shared.ts"],
  "curve-underlying": ["src/searcher/venues/swaps/curve-underlying.ts", "src/searcher/venues/curve-underlying.ts"],
  "balancer-v3": ["src/searcher/venues/swaps/balancer-v3.ts"],
  "custom-swap:dodo-v2": ["src/searcher/venues/swaps/dodo-v2.ts"],
  "protocol:erc4626": ["src/searcher/venues/protocols/erc4626.ts", "src/searcher/venues/protocols/protocol-plan.ts", "src/searcher/venues/protocols/protocol-quote.ts"],
  "protocol:goldx": ["src/searcher/venues/protocols/goldx.ts", "src/searcher/venues/protocols/protocol-plan.ts", "src/searcher/venues/protocols/protocol-quote.ts"],
  "protocol:metronome-synth": ["src/searcher/venues/protocols/metronome.ts", "src/searcher/venues/protocols/protocol-plan.ts", "src/searcher/venues/protocols/protocol-quote.ts"],
  "protocol:metronome-hgusdc": ["src/searcher/venues/protocols/metronome.ts", "src/searcher/venues/protocols/protocol-plan.ts", "src/searcher/venues/protocols/protocol-quote.ts"],
  "protocol:psm": ["src/searcher/venues/protocols/psm.ts", "src/searcher/venues/protocols/protocol-plan.ts", "src/searcher/venues/protocols/protocol-quote.ts"],
  "protocol:rocksolid": ["src/searcher/venues/protocols/rocksolid.ts", "src/searcher/venues/protocols/protocol-plan.ts", "src/searcher/venues/protocols/protocol-quote.ts"],
  "protocol:wsteth": ["src/searcher/venues/protocols/wsteth.ts", "src/searcher/venues/protocols/protocol-plan.ts", "src/searcher/venues/protocols/protocol-quote.ts"],
  "compat:fluid-credit": ["src/searcher/venues/compat/fluid-credit.ts"],
};

const SHARED_API_FILES = [
  "src/searcher/venues/route-leg-adapter.ts",
  "src/searcher/venues/route-leg-registry.ts",
  "src/searcher/venues/route-adapter-registry.ts",
  "src/searcher/venues/production-registry.ts",
  "src/searcher/planner/planner.ts",
  "src/searcher/solver/solver.ts",
  "src/searcher/solver/quoter.ts",
  "src/searcher/solver/plan-builder.ts",
  "src/searcher/simulator/botvm-simulator.ts",
  "src/shared/compiler/compiler.ts",
];

const ADAPTER_REPLAY_EV_POLICY = Object.freeze({
  ethUsd: 3_500,
  profitHaircutBps: 2_000,
  defaultGasUsed: 12_000_000,
  gasBufferMultX10: 20,
  evGate: true,
  bribeAllAboveGas: false,
  bribeBps: DEFAULT_BRIBE_BPS,
  minNetEth: 0n,
});

function loadRpcEnv(): void {
  const allowed = new Set(["SEARCHER_LIVE_RPC_URL", "MAINNET_RPC_URL"]);
  for (const candidate of [resolve(LISTENER_ROOT, ".env"), resolve(REPO_ROOT, ".env")]) {
    let text: string;
    try {
      text = readFileSync(candidate, "utf8");
    } catch {
      continue;
    }
    for (const line of text.split(/\r?\n/)) {
      const match = line.trim().match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
      if (!match || !allowed.has(match[1]) || process.env[match[1]]) continue;
      process.env[match[1]] = match[2].replace(/^["']|["']$/g, "");
    }
  }
}

function parseArgs(): CliArgs {
  loadRpcEnv();
  const argv = process.argv.slice(2);
  const fixtures: string[] = [];
  let outDir: string | undefined;
  let validateOnly = false;
  for (let i = 0; i < argv.length; i++) {
    const name = argv[i];
    if (name === "--fixture") {
      const value = argv[++i];
      if (!value) throw new Error("--fixture requires a path");
      fixtures.push(resolve(value));
    } else if (name === "--out-dir") {
      const value = argv[++i];
      if (!value) throw new Error("--out-dir requires a path");
      outDir = resolve(value);
    } else if (name === "--validate-only") {
      validateOnly = true;
    } else if (name === "--rpc") {
      throw new Error("--rpc is forbidden because argv may be logged; use MAINNET_RPC_URL in the environment");
    } else {
      throw new Error(`unknown adapter-family replay option ${name}`);
    }
  }
  if (fixtures.length === 0) throw new Error("at least one --fixture is required");
  const rpcUrl = process.env.SEARCHER_LIVE_RPC_URL ?? process.env.MAINNET_RPC_URL ?? "";
  if (!validateOnly && !rpcUrl) {
    throw new Error("SEARCHER_LIVE_RPC_URL or MAINNET_RPC_URL is required");
  }
  return { fixtures, rpcUrl, outDir, validateOnly };
}

function loadFixture(path: string): AdapterReplayFixture {
  const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
  const root = record(raw, path);
  exactKeys(root, [
    "schemaVersion", "id", "executionFamilyId", "referenceTx", "lane",
    "stateAnchor", "flash", "route", "landedReference",
  ], path);
  if (root.schemaVersion !== 2) throw new Error(`${path}: unsupported schemaVersion`);
  const id = fixtureId(root.id, `${path}.id`);
  const executionFamilyId = nonEmptyString(root.executionFamilyId, `${path}.executionFamilyId`) as ExecutionFamilyId;
  PRODUCTION_ROUTE_ADAPTERS.routeLegs.forFamily(executionFamilyId);
  const referenceTx = txHash(root.referenceTx, `${path}.referenceTx`);
  const lane = root.lane;
  if (lane !== "block-scan" && lane !== "backrun") throw new Error(`${path}.lane invalid`);
  const stateAnchor = parseAnchor(root.stateAnchor, `${path}.stateAnchor`);
  if (lane === "block-scan" && stateAnchor.kind !== "parent-block") {
    throw new Error(`${path}: block-scan fixture requires a parent-block anchor`);
  }
  if (lane === "backrun" && stateAnchor.kind !== "after-transaction") {
    throw new Error(`${path}: backrun fixture requires an after-transaction trigger anchor`);
  }
  const flashRaw = record(root.flash, `${path}.flash`);
  exactKeys(flashRaw, ["adapterId", "token"], `${path}.flash`);
  const flash = {
    adapterId: nonEmptyString(flashRaw.adapterId, `${path}.flash.adapterId`),
    token: address(flashRaw.token, `${path}.flash.token`),
  };
  if (!findFlashProviderDescriptor(flash.adapterId)) {
    throw new Error(`${path}: unknown flash adapter ${flash.adapterId}`);
  }
  if (!Array.isArray(root.route) || root.route.length < 2) throw new Error(`${path}.route must contain 2..8 legs`);
  if (root.route.length > 8) throw new Error(`${path}.route must contain 2..8 legs`);
  const route = root.route.map((item, index) => parseLeg(item, `${path}.route[${index}]`));
  route.sort((a, b) => a.seq - b.seq);
  route.forEach((leg, index) => {
    if (leg.seq !== index + 1) throw new Error(`${path}.route seq must be contiguous from 1`);
    if (index > 0 && route[index - 1].tokenOut.toLowerCase() !== leg.tokenIn.toLowerCase()) {
      throw new Error(`${path}.route discontinuity before leg ${leg.seq}`);
    }
  });
  if (route[0].tokenIn.toLowerCase() !== flash.token.toLowerCase() ||
      route.at(-1)!.tokenOut.toLowerCase() !== flash.token.toLowerCase()) {
    throw new Error(`${path}.route must close in the flash token`);
  }
  const familyIds = route.map((leg) => familyForLeg(leg, path));
  if (!familyIds.includes(executionFamilyId)) {
    throw new Error(`${path}: subject family ${executionFamilyId} is absent from the route`);
  }
  const landedRaw = record(root.landedReference, `${path}.landedReference`);
  exactKeys(
    landedRaw,
    ["canonicalNetProfitUsd", "evidencePath", "evidenceSha256"],
    `${path}.landedReference`,
  );
  if (typeof landedRaw.canonicalNetProfitUsd !== "number") {
    throw new Error(`${path}.landedReference.canonicalNetProfitUsd must be a number`);
  }
  const canonicalNetProfitUsd = landedRaw.canonicalNetProfitUsd;
  if (!Number.isFinite(canonicalNetProfitUsd) || canonicalNetProfitUsd <= 0) {
    throw new Error(`${path}.landedReference.canonicalNetProfitUsd must be positive`);
  }
  const evidencePath = safeRepoRelativePath(
    nonEmptyString(landedRaw.evidencePath, `${path}.landedReference.evidencePath`),
    `${path}.landedReference.evidencePath`,
  );
  const evidenceSha256 = sha256Hex(
    landedRaw.evidenceSha256,
    `${path}.landedReference.evidenceSha256`,
  );
  const evidence = readFileSync(resolve(REPO_ROOT, evidencePath), "utf8");
  if (sha256(evidence) !== evidenceSha256) throw new Error(`${path}: landed evidence hash mismatch`);
  if (!evidence.toLowerCase().includes(referenceTx)) throw new Error(`${path}: landed evidence omits reference tx`);
  if (stateAnchor.kind === "after-transaction" &&
      !evidence.toLowerCase().includes(stateAnchor.triggerTxHash)) {
    throw new Error(`${path}: landed evidence omits backrun trigger tx`);
  }
  if (!evidence.includes(String(canonicalNetProfitUsd))) {
    throw new Error(`${path}: landed evidence omits canonical net profit`);
  }
  return {
    schemaVersion: 2,
    id,
    executionFamilyId,
    referenceTx,
    lane,
    stateAnchor,
    flash,
    route,
    landedReference: { canonicalNetProfitUsd, evidencePath, evidenceSha256 },
  };
}

function parseAnchor(raw: unknown, field: string): StateAnchor {
  const value = record(raw, field);
  const kind = value.kind;
  if (kind === "parent-block") {
    exactKeys(value, ["kind", "blockNumber"], field);
    return { kind, blockNumber: positiveInt(value.blockNumber, `${field}.blockNumber`) };
  }
  if (kind === "after-transaction") {
    exactKeys(value, ["kind", "blockNumber", "triggerTxHash"], field);
    return {
      kind,
      blockNumber: positiveInt(value.blockNumber, `${field}.blockNumber`),
      triggerTxHash: txHash(value.triggerTxHash, `${field}.triggerTxHash`),
    };
  }
  throw new Error(`${field}.kind invalid`);
}

function parseLeg(raw: unknown, field: string): AdapterReplayLeg {
  const value = record(raw, field);
  exactKeys(value, ["seq", "pool", "edgeAdapterId", "tokenIn", "tokenOut"], field);
  return {
    seq: positiveInt(value.seq, `${field}.seq`),
    pool: parsePool(value.pool, `${field}.pool`),
    edgeAdapterId: nonEmptyString(value.edgeAdapterId, `${field}.edgeAdapterId`),
    tokenIn: address(value.tokenIn, `${field}.tokenIn`),
    tokenOut: address(value.tokenOut, `${field}.tokenOut`),
  };
}

function parsePool(raw: unknown, field: string): RoutePoolIdentity {
  const value = record(raw, field);
  exactKeys(value, [
    "adapter", "address", "poolId", "token0", "token1", "underlyingCoins",
    "currency0", "currency1", "fee", "tickSpacing", "hooks", "fixedTokenIn",
    "fixedTokenOut", "fixedSlotKind", "fixedProtocolAction", "nonStandardRedeem",
    "redeemTokenOut", "receiptEmitters",
  ], field, ["adapter", "address"]);
  const adapter = nonEmptyString(value.adapter, `${field}.adapter`) as PoolEntry["adapter"];
  PRODUCTION_ROUTE_ADAPTERS.routeLegs.forPool(adapter);
  const pool: RoutePoolIdentity = { adapter, address: address(value.address, `${field}.address`) };
  for (const name of ADDRESS_FIELDS) {
    if (name === "address" || value[name] === undefined) continue;
    pool[name] = address(value[name], `${field}.${name}`) as never;
  }
  if (value.poolId !== undefined) pool.poolId = bytes32(value.poolId, `${field}.poolId`);
  if (value.underlyingCoins !== undefined) pool.underlyingCoins = addressArray(value.underlyingCoins, `${field}.underlyingCoins`);
  if (value.receiptEmitters !== undefined) pool.receiptEmitters = addressArray(value.receiptEmitters, `${field}.receiptEmitters`);
  if (value.fee !== undefined) pool.fee = nonNegativeInt(value.fee, `${field}.fee`);
  if (value.tickSpacing !== undefined) pool.tickSpacing = positiveInt(value.tickSpacing, `${field}.tickSpacing`);
  if (value.fixedSlotKind !== undefined) {
    if (!["lend", "swap", "protocol"].includes(String(value.fixedSlotKind))) throw new Error(`${field}.fixedSlotKind invalid`);
    pool.fixedSlotKind = value.fixedSlotKind as RoutePoolIdentity["fixedSlotKind"];
  }
  if (value.fixedProtocolAction !== undefined) pool.fixedProtocolAction = protocolAction(value.fixedProtocolAction, `${field}.fixedProtocolAction`);
  if (value.nonStandardRedeem !== undefined) {
    if (typeof value.nonStandardRedeem !== "boolean") throw new Error(`${field}.nonStandardRedeem must be boolean`);
    pool.nonStandardRedeem = value.nonStandardRedeem;
  }
  return pool;
}

function familyForLeg(leg: AdapterReplayLeg, fixturePath: string): ExecutionFamilyId {
  const poolFamily = PRODUCTION_ROUTE_ADAPTERS.routeLegs.forPool(leg.pool.adapter);
  const edgeFamily = PRODUCTION_ROUTE_ADAPTERS.routeLegs.forEdge(leg.edgeAdapterId);
  if (poolFamily.id !== edgeFamily.id) {
    throw new Error(
      `${fixturePath}: leg ${leg.seq} pool family ${poolFamily.id} disagrees with edge family ${edgeFamily.id}`,
    );
  }
  return poolFamily.id;
}

async function anchorState(state: AnvilStateBackend, anchor: StateAnchor): Promise<void> {
  if (anchor.kind === "parent-block") await state.forkAt(anchor.blockNumber);
  else await state.forkAfterTx(anchor.triggerTxHash);
}

async function allocateLoopbackPort(): Promise<number> {
  return new Promise((done, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const bound = server.address();
      if (!bound || typeof bound === "string") {
        server.close();
        reject(new Error("failed to allocate an Anvil port"));
        return;
      }
      server.close((error) => error ? reject(error) : done(bound.port));
    });
  });
}

async function validateLocalStateAnchor(
  local: ethers.JsonRpcProvider,
  upstream: ethers.JsonRpcProvider,
  anchor: StateAnchor,
): Promise<{ hash: string; stateRoot: string }> {
  const tag = ethers.toQuantity(anchor.blockNumber);
  const [localBlock, canonicalBlock] = await Promise.all([
    local.send("eth_getBlockByNumber", ["latest", false]) as Promise<Record<string, unknown>>,
    upstream.send("eth_getBlockByNumber", [tag, false]) as Promise<Record<string, unknown>>,
  ]);
  if (!localBlock || !canonicalBlock) throw new Error(`state anchor block ${anchor.blockNumber} is unavailable`);
  const localNumber = typeof localBlock.number === "string" ? Number(BigInt(localBlock.number)) : NaN;
  const localHash = typeof localBlock.hash === "string" ? localBlock.hash.toLowerCase() : "";
  const canonicalHash = typeof canonicalBlock.hash === "string" ? canonicalBlock.hash.toLowerCase() : "";
  const localRoot = typeof localBlock.stateRoot === "string" ? localBlock.stateRoot.toLowerCase() : "";
  const canonicalRoot = typeof canonicalBlock.stateRoot === "string" ? canonicalBlock.stateRoot.toLowerCase() : "";
  if (localNumber !== anchor.blockNumber || !localHash || localHash !== canonicalHash) {
    throw new Error(`local fork is not anchored to canonical block ${anchor.blockNumber}`);
  }
  if (!localRoot || !canonicalRoot || localRoot !== canonicalRoot) {
    throw new Error(`local fork state-root header differs at block ${anchor.blockNumber}`);
  }
  return { hash: canonicalHash, stateRoot: canonicalRoot };
}

async function validateChainAnchor(
  provider: ethers.JsonRpcProvider,
  fixture: AdapterReplayFixture,
): Promise<void> {
  const winner = await provider.getTransactionReceipt(fixture.referenceTx);
  if (!winner || winner.status !== 1) throw new Error(`reference tx missing or reverted: ${fixture.referenceTx}`);
  if (fixture.stateAnchor.kind === "parent-block") {
    if (winner.blockNumber !== fixture.stateAnchor.blockNumber + 1) {
      throw new Error(`parent anchor ${fixture.stateAnchor.blockNumber} does not precede winner block ${winner.blockNumber}`);
    }
    return;
  }
  const trigger = await provider.getTransactionReceipt(fixture.stateAnchor.triggerTxHash);
  if (!trigger || trigger.status !== 1) throw new Error(`trigger tx missing or reverted: ${fixture.stateAnchor.triggerTxHash}`);
  if (winner.blockNumber !== fixture.stateAnchor.blockNumber || trigger.blockNumber !== winner.blockNumber) {
    throw new Error("backrun trigger/winner are not in the declared block");
  }
  if (trigger.index >= winner.index) throw new Error("backrun trigger must precede the winner");
}

interface TraceCall {
  readonly to?: string;
  readonly input?: string;
  readonly error?: string;
  readonly calls?: readonly TraceCall[];
}

interface FlattenedTraceCall {
  readonly target: string;
  readonly selector: string;
  readonly input: string;
}

interface ReferenceObservedImpact {
  readonly familyId: ExecutionFamilyId;
  readonly logIndex: number;
  readonly matchedAdapterId: string;
  readonly pool: string;
  readonly tokenIn: string;
  readonly tokenOut: string;
  readonly poolId?: string;
}

const PROTOCOL_LEG_DESCRIPTOR_BY_ID = new Map(
  PROTOCOL_LEG_DESCRIPTORS.map((descriptor) => [descriptor.id, descriptor] as const),
);
const PSM_SELL_GEM_SELECTOR = ethers.id("sellGem(address,uint256)").slice(0, 10).toLowerCase();
const PSM_BUY_GEM_SELECTOR = ethers.id("buyGem(address,uint256)").slice(0, 10).toLowerCase();

function expectedReferenceTarget(leg: AdapterReplayLeg, familyId: ExecutionFamilyId): string {
  // Balancer V3 separates logical pool identity from its singleton execution
  // target. The receipt observation below proves the exact logical pool.
  return familyId === "balancer-v3"
    ? ADDR.BALANCER_V3_VAULT.toLowerCase()
    : leg.pool.address.toLowerCase();
}

function traceCallMatchesLegSemantics(
  leg: AdapterReplayLeg,
  call: FlattenedTraceCall,
): boolean {
  if (leg.edgeAdapterId === "psm") {
    const tokenIn = leg.tokenIn.toLowerCase();
    const tokenOut = leg.tokenOut.toLowerCase();
    const usdc = ADDR.USDC.toLowerCase();
    if (tokenIn === usdc) return call.selector === PSM_SELL_GEM_SELECTOR;
    if (tokenOut === usdc) return call.selector === PSM_BUY_GEM_SELECTOR;
    return false;
  }

  const descriptor = PROTOCOL_LEG_DESCRIPTOR_BY_ID.get(leg.edgeAdapterId);
  if (!descriptor || (descriptor.tokenInArg === undefined && descriptor.tokenOutArg === undefined)) {
    return true;
  }
  try {
    const iface = new ethers.Interface([`function ${descriptor.signature}`]);
    const fnName = descriptor.signature.slice(0, descriptor.signature.indexOf("("));
    const decoded = iface.decodeFunctionData(fnName, call.input);
    if (descriptor.tokenInArg !== undefined &&
        String(decoded[descriptor.tokenInArg]).toLowerCase() !== leg.tokenIn.toLowerCase()) {
      return false;
    }
    if (descriptor.tokenOutArg !== undefined &&
        String(decoded[descriptor.tokenOutArg]).toLowerCase() !== leg.tokenOut.toLowerCase()) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

async function validateReferenceRoute(
  provider: ethers.JsonRpcProvider,
  fixture: AdapterReplayFixture,
): Promise<string> {
  const trace = await provider.send("debug_traceTransaction", [
    fixture.referenceTx,
    { tracer: "callTracer", tracerConfig: { onlyTopCall: false } },
  ]) as TraceCall;
  const calls: FlattenedTraceCall[] = [];
  flattenSuccessfulCalls(trace, calls);
  const matched: Array<FlattenedTraceCall & { edgeAdapterId: string }> = [];
  let cursor = 0;
  for (const leg of fixture.route) {
    const familyId = familyForLeg(leg, fixture.id);
    const action = getActionAdapter(leg.edgeAdapterId);
    const expectedTarget = expectedReferenceTarget(leg, familyId);
    let found = -1;
    for (let index = cursor; index < calls.length; index++) {
      const call = calls[index];
      if (call.target !== expectedTarget) continue;
      if (!action.matchTrace(call.target, call.selector)) continue;
      if (!traceCallMatchesLegSemantics(leg, call)) continue;
      found = index;
      matched.push({ ...call, edgeAdapterId: leg.edgeAdapterId });
      break;
    }
    if (found < 0) {
      throw new Error(
        `reference trace does not contain ordered leg ${leg.seq} ` +
          `${leg.edgeAdapterId}@${leg.pool.address}`,
      );
    }
    cursor = found + 1;
  }
  return sha256(JSON.stringify(matched));
}

async function validateReferenceSwapImpacts(
  provider: ethers.JsonRpcProvider,
  fixture: AdapterReplayFixture,
  edges: readonly TokenEdge[],
): Promise<string> {
  const receipt = await provider.getTransactionReceipt(fixture.referenceTx);
  if (!receipt) throw new Error(`reference receipt unavailable: ${fixture.referenceTx}`);
  const logs = receipt.logs.map((log) => ({
    address: log.address,
    topics: [...log.topics],
    data: log.data,
  }));
  const edgesByTarget = new Map<string, TokenEdge[]>();
  for (const edge of edges) {
    const key = edge.target.toLowerCase();
    const current = edgesByTarget.get(key) ?? [];
    current.push(edge);
    edgesByTarget.set(key, current);
  }

  const observed: ReferenceObservedImpact[] = [];
  const swapFamilies = [...new Set(fixture.route
    .map((leg) => PRODUCTION_ROUTE_ADAPTERS.routeLegs.forFamily(familyForLeg(leg, fixture.id)))
    .filter((adapter) => adapter.kind === "swap")
    .map((adapter) => adapter.id))];
  for (const familyId of swapFamilies) {
    const adapter = PRODUCTION_ROUTE_ADAPTERS.routeLegs.forFamily(familyId) as SwapAdapter;
    const impacts = await adapter.observation.decodeSwapImpacts({
      logs,
      graph: edges,
      edgesByTarget,
      tokenQuery: null,
    });
    observed.push(...impacts.map(({ logIndex, impact }) => ({
      familyId,
      logIndex,
      matchedAdapterId: impact.matchedAdapterId,
      pool: impact.pool,
      tokenIn: impact.tokenIn,
      tokenOut: impact.tokenOut,
      ...(impact.poolId ? { poolId: impact.poolId } : {}),
    })));
  }

  const matched = matchReferenceSwapImpacts(fixture, edges, logs, observed);
  return sha256(JSON.stringify(matched));
}

function matchReferenceSwapImpacts(
  fixture: AdapterReplayFixture,
  edges: readonly TokenEdge[],
  logs: readonly { address: string; topics: readonly string[]; data: string }[],
  observed: readonly ReferenceObservedImpact[],
): Array<{ seq: number } & ReferenceObservedImpact> {
  const consumed = new Set<number>();
  let previousLogIndex = -1;
  return fixture.route.flatMap((leg, index) => {
    const family = PRODUCTION_ROUTE_ADAPTERS.routeLegs.forFamily(familyForLeg(leg, fixture.id));
    if (family.kind !== "swap") return [];
    const edge = edges[index];
    const observedIndex = observed.findIndex((candidate, candidateIndex) =>
      !consumed.has(candidateIndex) &&
      candidate.logIndex > previousLogIndex &&
      candidate.familyId === family.id &&
      candidate.matchedAdapterId === leg.edgeAdapterId &&
      candidate.pool.toLowerCase() === edge.target.toLowerCase() &&
      candidate.tokenIn.toLowerCase() === leg.tokenIn.toLowerCase() &&
      candidate.tokenOut.toLowerCase() === leg.tokenOut.toLowerCase() &&
      (!edge.poolId || candidate.poolId?.toLowerCase() === edge.poolId.toLowerCase())
    );
    if (observedIndex < 0) {
      throw new Error(
        `reference receipt has no exact swap impact for leg ${leg.seq} ` +
          `${leg.edgeAdapterId}:${leg.tokenIn}->${leg.tokenOut}`,
      );
    }
    const impact = observed[observedIndex];
    if (family.id === "curve-plain" || family.id === "curve-underlying") {
      validateExactCurveIds(logs, impact.logIndex, edge, leg.seq);
    }
    consumed.add(observedIndex);
    previousLogIndex = impact.logIndex;
    return [{ seq: leg.seq, ...impact }];
  });
}

function validateExactCurveIds(
  logs: readonly { address: string; topics: readonly string[]; data: string }[],
  logIndex: number,
  edge: TokenEdge,
  legSeq: number,
): void {
  const log = logs[logIndex];
  if (!log || edge.curveI === undefined || edge.curveJ === undefined) {
    throw new Error(`reference Curve leg ${legSeq} lacks exact coin-index evidence`);
  }
  try {
    const [soldId, , boughtId] = ethers.AbiCoder.defaultAbiCoder().decode(
      ["uint256", "uint256", "uint256", "uint256"],
      log.data,
    );
    if (BigInt(edge.curveI) !== BigInt(soldId) || BigInt(edge.curveJ) !== BigInt(boughtId)) {
      throw new Error(
        `reference Curve leg ${legSeq} coin ids do not match edge ` +
          `${edge.curveI}->${edge.curveJ}`,
      );
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("reference Curve leg")) throw error;
    throw new Error(`reference Curve leg ${legSeq} has undecodable coin ids`);
  }
}

function flattenSuccessfulCalls(
  call: TraceCall,
  output: FlattenedTraceCall[],
): void {
  if (call.error) return;
  if (typeof call.to === "string" && typeof call.input === "string" && call.input.length >= 10) {
    output.push({
      target: call.to.toLowerCase(),
      selector: call.input.slice(0, 10).toLowerCase(),
      input: call.input.toLowerCase(),
    });
  }
  for (const child of call.calls ?? []) flattenSuccessfulCalls(child, output);
}

function runReferenceMatcherSelfTests(): void {
  const tokenA = "0x0000000000000000000000000000000000000001";
  const tokenB = "0x0000000000000000000000000000000000000002";
  const tokenC = "0x0000000000000000000000000000000000000003";
  const target = "0x0000000000000000000000000000000000000010";

  const psmSellLeg: AdapterReplayLeg = {
    seq: 1,
    pool: { adapter: "psm", address: target },
    edgeAdapterId: "psm",
    tokenIn: ADDR.USDC,
    tokenOut: tokenB,
  };
  assert(traceCallMatchesLegSemantics(psmSellLeg, {
    target,
    selector: PSM_SELL_GEM_SELECTOR,
    input: PSM_SELL_GEM_SELECTOR,
  }));
  assert(!traceCallMatchesLegSemantics(psmSellLeg, {
    target,
    selector: PSM_BUY_GEM_SELECTOR,
    input: PSM_BUY_GEM_SELECTOR,
  }));

  const synthIface = new ethers.Interface(["function swap(address,address,uint256)"]);
  const synthLeg: AdapterReplayLeg = {
    seq: 1,
    pool: { adapter: "metronome-synth", address: target },
    edgeAdapterId: "metronome-synth-swap",
    tokenIn: tokenA,
    tokenOut: tokenB,
  };
  const synthSelector = synthIface.getFunction("swap")!.selector.toLowerCase();
  assert(traceCallMatchesLegSemantics(synthLeg, {
    target,
    selector: synthSelector,
    input: synthIface.encodeFunctionData("swap", [tokenA, tokenB, 1n]),
  }));
  assert(!traceCallMatchesLegSemantics(synthLeg, {
    target,
    selector: synthSelector,
    input: synthIface.encodeFunctionData("swap", [tokenA, tokenC, 1n]),
  }));

  const siloIface = new ethers.Interface(["function redeem(address,uint256,address,address)"]);
  const siloLeg: AdapterReplayLeg = {
    seq: 1,
    pool: { adapter: "erc4626", address: target },
    edgeAdapterId: "erc4626-redeem-silo",
    tokenIn: tokenA,
    tokenOut: tokenB,
  };
  const siloSelector = siloIface.getFunction("redeem")!.selector.toLowerCase();
  assert(traceCallMatchesLegSemantics(siloLeg, {
    target,
    selector: siloSelector,
    input: siloIface.encodeFunctionData("redeem", [tokenB, 1n, target, target]),
  }));
  assert(!traceCallMatchesLegSemantics(siloLeg, {
    target,
    selector: siloSelector,
    input: siloIface.encodeFunctionData("redeem", [tokenC, 1n, target, target]),
  }));

  const balancerLeg: AdapterReplayLeg = {
    seq: 1,
    pool: { adapter: "balancer-v3", address: target },
    edgeAdapterId: "balancer-v3-unlock",
    tokenIn: tokenA,
    tokenOut: tokenB,
  };
  assert.equal(expectedReferenceTarget(balancerLeg, "balancer-v3"), ADDR.BALANCER_V3_VAULT.toLowerCase());

  const curveEdge = {
    adapterId: "curve-exchange-underlying",
    target,
    tokenIn: tokenA,
    tokenOut: tokenB,
    curveI: 1,
    curveJ: 2,
  } as TokenEdge;
  const curveLog = (soldId: bigint, boughtId: bigint) => ({
    address: target,
    topics: [],
    data: ethers.AbiCoder.defaultAbiCoder().encode(
      ["uint256", "uint256", "uint256", "uint256"],
      [soldId, 10n, boughtId, 9n],
    ),
  });
  assert.doesNotThrow(() => validateExactCurveIds([curveLog(1n, 2n)], 0, curveEdge, 1));
  assert.throws(() => validateExactCurveIds([curveLog(0n, 1n)], 0, curveEdge, 1), /coin ids do not match/);

  const repeatedLeg: AdapterReplayLeg = {
    seq: 1,
    pool: { adapter: "univ2", address: target },
    edgeAdapterId: "univ2-swap",
    tokenIn: tokenA,
    tokenOut: tokenB,
  };
  const repeatedFixture = {
    id: "reference-matcher-self-test",
    route: [repeatedLeg, { ...repeatedLeg, seq: 2 }],
  } as AdapterReplayFixture;
  const repeatedEdge = {
    adapterId: "univ2-swap",
    target,
    tokenIn: tokenA,
    tokenOut: tokenB,
  } as TokenEdge;
  const oneImpact: ReferenceObservedImpact = {
    familyId: "univ2-standard",
    logIndex: 0,
    matchedAdapterId: "univ2-swap",
    pool: target,
    tokenIn: tokenA,
    tokenOut: tokenB,
  };
  assert.throws(
    () => matchReferenceSwapImpacts(repeatedFixture, [repeatedEdge, repeatedEdge], [], [oneImpact]),
    /leg 2/,
  );

  assert.doesNotThrow(() => assertIntermediateBalanceConserved(tokenA, tokenB, 1n));
  assert.throws(
    () => assertIntermediateBalanceConserved(tokenA, tokenB, -1n),
    /consumed pre-existing intermediate token balance/,
  );
  assert.doesNotThrow(() => assertNoPreexistingRouteInventory(new Map([[tokenA, 0n]])));
  assert.throws(
    () => assertNoPreexistingRouteInventory(new Map([[tokenA, 1n]])),
    /pre-existing route-token inventory/,
  );
}

async function buildPinnedRoute(
  state: AnvilStateBackend,
  fixture: AdapterReplayFixture,
): Promise<TokenEdge[]> {
  const edges: TokenEdge[] = [];
  for (const leg of fixture.route) {
    const pool: PoolEntry = { ...leg.pool };
    if (pool.adapter === "univ4") {
      pool.fixedTokenIn = leg.tokenIn;
      pool.fixedTokenOut = leg.tokenOut;
    }
    const emitted = await PRODUCTION_ROUTE_ADAPTERS.routeLegs.buildEdges(pool, state);
    const matches = emitted.filter((candidate) =>
      candidate.adapterId === leg.edgeAdapterId &&
      candidate.tokenIn.toLowerCase() === leg.tokenIn.toLowerCase() &&
      candidate.tokenOut.toLowerCase() === leg.tokenOut.toLowerCase() &&
      candidate.target.toLowerCase() === pool.address.toLowerCase() &&
      (!pool.poolId || candidate.poolId?.toLowerCase() === pool.poolId.toLowerCase())
    );
    if (matches.length !== 1) {
      throw new Error(`route leg ${leg.seq} emitted ${matches.length} exact family edges`);
    }
    edges.push(matches[0]);
  }
  return edges;
}

function assertClosedRoute(edges: TokenEdge[], flashToken: string): void {
  if (edges[0].tokenIn.toLowerCase() !== flashToken.toLowerCase() ||
      edges.at(-1)!.tokenOut.toLowerCase() !== flashToken.toLowerCase()) {
    throw new Error("route does not close in the flash token");
  }
  for (let i = 1; i < edges.length; i++) {
    if (edges[i - 1].tokenOut.toLowerCase() !== edges[i].tokenIn.toLowerCase()) {
      throw new Error(`route discontinuity between legs ${i} and ${i + 1}`);
    }
  }
  if (pathLeavesStandingPosition(edges)) throw new Error("route leaves a standing position");
}

function fullDomainSearch(maxInput: bigint): { searchCenter: bigint; gridHalfWidth: number } {
  if (maxInput <= 0n) throw new Error("flash provider has no borrowable balance for route token");
  const bits = maxInput.toString(2).length;
  const halfWidth = Math.max(1, Math.ceil(bits / 2));
  const center = 1n << BigInt(Math.floor(bits / 2));
  return { searchCenter: center > maxInput ? maxInput : center, gridHalfWidth: halfWidth };
}

function pinnedFlashTemplate(adapterId: string): PathTemplate {
  return {
    ...FLASH_SWAP_REPAY,
    slots: FLASH_SWAP_REPAY.slots.map((slot) =>
      slot.kind === "flash" ? { ...slot, adapters: [adapterId] } : { ...slot, adapters: [...slot.adapters] }
    ),
    constraints: [...FLASH_SWAP_REPAY.constraints],
  };
}

function routeHash(edges: TokenEdge[]): string {
  return sha256(JSON.stringify(edges.map((edge) => ({
    adapterId: edge.adapterId,
    target: edge.target.toLowerCase(),
    poolId: edge.poolId?.toLowerCase() ?? null,
    tokenIn: edge.tokenIn.toLowerCase(),
    tokenOut: edge.tokenOut.toLowerCase(),
  }))));
}

function assertIntermediateBalanceConserved(
  token: string,
  profitToken: string,
  delta: bigint,
): void {
  if (token.toLowerCase() !== profitToken.toLowerCase() && delta < 0n) {
    throw new Error(`conservation replay consumed pre-existing intermediate token balance ${token}: ${delta}`);
  }
}

function assertNoPreexistingRouteInventory(balances: ReadonlyMap<string, bigint>): void {
  for (const [token, balance] of balances) {
    if (balance !== 0n) {
      throw new Error(`conservation replay executor has pre-existing route-token inventory ${token}: ${balance}`);
    }
  }
}

function opportunity(
  fixture: AdapterReplayFixture,
  edges: TokenEdge[],
  maxInput: bigint,
  searchCenter: bigint,
): BlockScanOpportunity {
  const ring = [edges[0].tokenIn, ...edges.slice(0, -1).map((edge) => edge.tokenOut)];
  return {
    kind: "block-scan-arb",
    sourceBlock: fixture.stateAnchor.blockNumber,
    stateBlock: fixture.stateAnchor.blockNumber,
    cycleId: canonicalTokenRing(ring).join("|"),
    cycleFingerprint: cycleFingerprint(fixture.stateAnchor.blockNumber, ring),
    seedEdges: edges,
    flashToken: fixture.flash.token,
    searchSeed: { startToken: fixture.flash.token, searchCenter, maxInput },
    leavesStandingPosition: pathLeavesStandingPosition(edges),
    affectedPools: [...new Set(edges.map((edge) => edge.target.toLowerCase()))],
    affectedTokens: canonicalTokenRing(ring),
  };
}

async function proveConservation(
  state: AnvilStateBackend,
  solved: ResolvedPlan,
  edges: readonly TokenEdge[],
  lender: string,
  expectedCalldata: string,
): Promise<ConservationResult> {
  const tokens = [...new Set(edges.flatMap((edge) => [edge.tokenIn, edge.tokenOut]).map((item) => item.toLowerCase()))]
    .map(ethers.getAddress);
  const snapshot = await state.snapshot();
  try {
    const executorBefore = new Map<string, bigint>();
    for (const token of tokens) executorBefore.set(token, await state.getTokenBalance(token, DEFAULT_SEARCHER_EXECUTOR));
    assertNoPreexistingRouteInventory(executorBefore);
    const lenderBalanceBefore = await state.getTokenBalance(solved.profitToken, lender);
    const calldata = buildExecuteCalldata(compilePlan(solved.root, DEFAULT_SEARCHER_EXECUTOR));
    if (calldata.toLowerCase() !== expectedCalldata.toLowerCase()) {
      throw new Error("production simulator calldata changed between final sim and conservation replay");
    }
    const tx = await state.send({
      from: DEFAULT_SEARCHER_OWNER,
      to: DEFAULT_SEARCHER_EXECUTOR,
      data: calldata,
      gas: "0x1000000",
    });
    const gasUsed = await state.getGasUsed(tx);
    const executorDeltas: Record<string, string> = {};
    let grossProfit = 0n;
    for (const token of tokens) {
      const after = await state.getTokenBalance(token, DEFAULT_SEARCHER_EXECUTOR);
      const delta = after - executorBefore.get(token)!;
      executorDeltas[token] = delta.toString();
      if (token.toLowerCase() === solved.profitToken.toLowerCase()) grossProfit = delta;
      else assertIntermediateBalanceConserved(token, solved.profitToken, delta);
    }
    if (grossProfit <= 0n) throw new Error("conservation replay produced no positive profit-token delta");
    const lenderBalanceAfter = await state.getTokenBalance(solved.profitToken, lender);
    if (lenderBalanceAfter < lenderBalanceBefore) throw new Error("flash lender balance decreased after replay");
    return {
      calldataHash: sha256(calldata.toLowerCase()),
      grossProfit: grossProfit.toString(),
      gasUsed: gasUsed.toString(),
      lenderBalanceBefore: lenderBalanceBefore.toString(),
      lenderBalanceAfter: lenderBalanceAfter.toString(),
      executorDeltas,
    };
  } finally {
    await state.revert(snapshot);
  }
}

async function replayFixture(
  path: string,
  rpcUrl: string,
  adapterCommit: string | null,
  baseCommit: string | null,
): Promise<AdapterReplayReport> {
  const fixture = loadFixture(path);
  const familySources = FAMILY_SOURCE_FILES[fixture.executionFamilyId];
  if (!familySources || familySources.length === 0) throw new Error(`no source binding for ${fixture.executionFamilyId}`);
  const fixtureRelative = safeRelativeFixture(path);
  const anvilPort = await allocateLoopbackPort();
  const state = new AnvilStateBackend(rpcUrl, `http://127.0.0.1:${anvilPort}`, anvilPort);
  const report: AdapterReplayReport = {
    schemaVersion: 2,
    fixtureId: fixture.id,
    fixturePath: fixtureRelative,
    fixtureSha256: sha256(readFileSync(path)),
    referenceTx: fixture.referenceTx,
    landedEvidencePath: fixture.landedReference.evidencePath,
    landedEvidenceSha256: fixture.landedReference.evidenceSha256,
    replayFlash: { ...fixture.flash },
    executionFamilyId: fixture.executionFamilyId,
    routeExecutionFamilies: [...new Set(fixture.route.map((leg) => familyForLeg(leg, fixture.id)))],
    routeHash: "",
    referenceRouteHash: null,
    stateAnchor: fixture.stateAnchor,
    anchorBlockHash: null,
    anchorStateRoot: null,
    baseCommit,
    adapterCommit,
    familySourceSha256: hashFiles(familySources),
    sharedApiSha256: hashFiles(SHARED_API_FILES),
    runtimeSourceSha256: hashRuntimeSources(),
    harnessSha256: sha256(readFileSync(HARNESS_PATH)),
    botVmArtifactSha256: sha256(readFileSync(BOTVM_ARTIFACT_PATH)),
    executorRuntimeCodeHash: null,
    replayCommand: `npm run searcher:adapter-family-replay -- --fixture ${fixtureRelative}`,
    maxFlashAmount: null,
    solverSelectedAmount: null,
    finalSim: null,
    conservation: null,
    productionEv: null,
    evPolicy: {
      ethUsd: ADAPTER_REPLAY_EV_POLICY.ethUsd,
      profitHaircutBps: ADAPTER_REPLAY_EV_POLICY.profitHaircutBps,
      gasBufferMultX10: ADAPTER_REPLAY_EV_POLICY.gasBufferMultX10,
      bribeAllAboveGas: ADAPTER_REPLAY_EV_POLICY.bribeAllAboveGas,
      bribeBps: ADAPTER_REPLAY_EV_POLICY.bribeBps,
      minNetEth: ADAPTER_REPLAY_EV_POLICY.minNetEth.toString(),
    },
    stages: {
      chainAnchor: false,
      referenceRoute: false,
      familyEdges: false,
      planner: false,
      solver: false,
      finalSim: false,
      repaymentAndConservation: false,
      productionEvPositive: false,
    },
    verdict: "implemented_not_validated",
    failure: null,
  };

  const upstream = new ethers.JsonRpcProvider(rpcUrl);
  try {
    await validateChainAnchor(upstream, fixture);
    const referenceTraceHash = await validateReferenceRoute(upstream, fixture);
    await anchorState(state, fixture.stateAnchor);
    const verifiedAnchor = await validateLocalStateAnchor(state.provider, upstream, fixture.stateAnchor);
    report.anchorBlockHash = verifiedAnchor.hash;
    report.anchorStateRoot = verifiedAnchor.stateRoot;
    report.stages.chainAnchor = true;

    const edges = await buildPinnedRoute(state, fixture);
    assertClosedRoute(edges, fixture.flash.token);
    report.routeHash = routeHash(edges);
    report.stages.familyEdges = true;
    const referenceSwapImpactHash = await validateReferenceSwapImpacts(upstream, fixture, edges);
    report.referenceRouteHash = sha256(`${referenceTraceHash}:${referenceSwapImpactHash}`);
    report.stages.referenceRoute = true;

    const flashProvider = findFlashProviderDescriptor(fixture.flash.adapterId)!;
    const maxInput = await state.getTokenBalance(fixture.flash.token, flashProvider.liquidityHolder);
    const sizing = fullDomainSearch(maxInput);
    report.maxFlashAmount = maxInput.toString();

    await installForkBotVm(state.provider, DEFAULT_SEARCHER_OWNER, DEFAULT_SEARCHER_EXECUTOR);
    const executorRuntime = await state.provider.getCode(DEFAULT_SEARCHER_EXECUTOR);
    if (executorRuntime === "0x") throw new Error("BotVM executor runtime is absent after install");
    report.executorRuntimeCodeHash = ethers.keccak256(executorRuntime);
    const planner = new TemplatePlanner();
    planner.setGraph(edges);
    const plans = await planner.planBlockScanFromSeedEdges(
      opportunity(fixture, edges, maxInput, sizing.searchCenter),
      [pinnedFlashTemplate(fixture.flash.adapterId)],
    );
    if (plans.length === 0) throw new Error("production planner produced no candidate plan");
    report.stages.planner = true;

    const simulator = new BotVMSimulator(state, DEFAULT_SEARCHER_EXECUTOR, DEFAULT_SEARCHER_OWNER);
    const solver = new AnvilSolver();
    const solved = await solver.solve(plans[0], state, simulator, {
      finalSimTopN: 5,
      gssMaxTries: 16,
      gridHalfWidth: sizing.gridHalfWidth,
      quoteProfitFloorBps: 0n,
      quoteSafetyBps: 9_999n,
    });
    report.solverSelectedAmount = solved.flashAmount.toString();
    report.stages.solver = true;

    const sim = await simulator.simulate(solved);
    report.finalSim = {
      success: sim.success,
      grossProfit: sim.grossProfit.toString(),
      gasUsed: sim.gasUsed.toString(),
      calldataHash: sha256(sim.calldata.toLowerCase()),
      revertReason: sim.revertReason ?? null,
    };
    if (!sim.success || sim.grossProfit <= 0n) {
      throw new Error(`fork final sim failed: ${sim.revertReason ?? "non-positive gross profit"}`);
    }
    report.stages.finalSim = true;

    report.conservation = await proveConservation(
      state,
      solved,
      edges,
      flashProvider.liquidityHolder,
      sim.calldata,
    );
    if (report.conservation.grossProfit !== sim.grossProfit.toString() ||
        report.conservation.gasUsed !== sim.gasUsed.toString()) {
      throw new Error("conservation replay differs from production final sim");
    }
    report.stages.repaymentAndConservation = true;

    const ev = await evaluateEv(
      state.provider,
      sim.profitToken,
      sim.netProfit,
      sim.gasUsed,
      ADAPTER_REPLAY_EV_POLICY,
      createProfitTokenValuation(),
    );
    report.productionEv = {
      valuationAvailable: ev.valuationAvailable,
      netEvWei: ev.netEvWei.toString(),
      expectedProfitEth: ev.expectedProfitEth.toString(),
      gasCostEth: ev.gasCostEth.toString(),
      bidEth: ev.bidEth.toString(),
    };
    if (!ev.valuationAvailable) throw new Error(`production EV cannot value ${sim.profitToken}`);
    if (ev.netEvWei <= 0n || ev.netEvWei < ADAPTER_REPLAY_EV_POLICY.minNetEth) {
      throw new Error(
        `production EV decision rejected: net=${ev.netEvWei} min=${ADAPTER_REPLAY_EV_POLICY.minNetEth}`,
      );
    }
    report.stages.productionEvPositive = true;
    report.verdict = "adapter_replay_pass";
  } catch (error) {
    report.failure = redactError(error, rpcUrl);
  } finally {
    state.stop();
    upstream.destroy();
  }
  return report;
}

async function main(): Promise<void> {
  const args = parseArgs();
  assertFamilySourceCoverage();
  const fixtures = args.fixtures.map((path) => ({ path, fixture: loadFixture(path) }));
  const duplicateIds = fixtures
    .map(({ fixture }) => fixture.id)
    .filter((id, index, all) => all.indexOf(id) !== index);
  if (duplicateIds.length > 0) throw new Error(`duplicate fixture id(s): ${[...new Set(duplicateIds)].join(",")}`);
  if (args.validateOnly) {
    runReferenceMatcherSelfTests();
    console.log("adapter-family reference matcher regressions: PASS");
    for (const { path, fixture } of fixtures) {
      console.log(`adapter-family-fixture PASS id=${fixture.id} family=${fixture.executionFamilyId} path=${safeRelativeFixture(path)}`);
    }
    printFamilyCoverage(fixtures.map(({ fixture }) => fixture));
    return;
  }
  await ensureBotVmArtifact();
  const [commit, baseCommit, worktreeStatus] = await Promise.all([
    gitRequired(["rev-parse", "HEAD"]),
    gitRequired(["merge-base", "origin/main", "HEAD"]),
    gitRequired(["status", "--porcelain=v1", "--untracked-files=all"]),
  ]);
  if (worktreeStatus) throw new Error("adapter-family replay requires a clean committed worktree");
  const reports: AdapterReplayReport[] = [];
  for (const { path } of fixtures) {
    const report = await replayFixture(path, args.rpcUrl, commit, baseCommit);
    reports.push(report);
    console.log(`ADAPTER_FAMILY_REPLAY_RESULT=${JSON.stringify(report)}`);
    if (args.outDir) {
      const outRoot = resolve(args.outDir);
      const out = resolve(outRoot, `${report.fixtureId}.adapter-family-replay.json`);
      const fromRoot = relative(outRoot, out);
      if (!fromRoot || fromRoot === ".." || fromRoot.startsWith("../")) {
        throw new Error(`fixture ${report.fixtureId} resolves outside --out-dir`);
      }
      mkdirSync(dirname(out), { recursive: true });
      writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
    }
  }
  printFamilyCoverage(fixtures.map(({ fixture }) => fixture));
  if (reports.some((report) => report.verdict !== "adapter_replay_pass")) process.exitCode = 1;
}

function printFamilyCoverage(fixtures: readonly AdapterReplayFixture[]): void {
  const coverage = PRODUCTION_ROUTE_ADAPTERS.routeLegs.list().map((adapter) => {
    const familyFixtures = fixtures
      .filter((fixture) => fixture.executionFamilyId === adapter.id)
      .map((fixture) => fixture.id)
      .sort();
    return {
      executionFamilyId: adapter.id,
      fixtures: familyFixtures,
      status: familyFixtures.length > 0 ? "fixture_registered" : "implemented_not_validated",
      ...(familyFixtures.length > 0 ? {} : { reason: "no trace-bound +EV fixture registered" }),
    };
  });
  console.log(`ADAPTER_FAMILY_COVERAGE=${JSON.stringify(coverage)}`);
}

function assertFamilySourceCoverage(): void {
  const missing = PRODUCTION_ROUTE_ADAPTERS.routeLegs.list()
    .map((adapter) => adapter.id)
    .filter((family) => !FAMILY_SOURCE_FILES[family]?.length);
  if (missing.length > 0) throw new Error(`missing execution-family source binding(s): ${missing.join(",")}`);
}

async function ensureBotVmArtifact(): Promise<void> {
  await exec(["forge", "build", "--root", REPO_ROOT], REPO_ROOT);
  if (!existsSync(BOTVM_ARTIFACT_PATH)) throw new Error("forge build did not produce BotVM artifact");
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${field} must be an object`);
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  field: string,
  required: readonly string[] = allowed,
): void {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) throw new Error(`${field} contains forbidden field(s): ${unknown.join(",")}`);
  const missing = required.filter((key) => value[key] === undefined);
  if (missing.length > 0) throw new Error(`${field} missing field(s): ${missing.join(",")}`);
}

function nonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} must be a non-empty string`);
  return value.trim();
}

function fixtureId(value: unknown, field: string): string {
  const text = nonEmptyString(value, field);
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(text)) {
    throw new Error(`${field} must match ^[a-z0-9][a-z0-9._-]*$`);
  }
  return text;
}

function address(value: unknown, field: string): string {
  try {
    return ethers.getAddress(nonEmptyString(value, field).toLowerCase());
  } catch {
    throw new Error(`${field} must be an address`);
  }
}

function addressArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error(`${field} must be a non-empty address array`);
  return value.map((item, index) => address(item, `${field}[${index}]`));
}

function txHash(value: unknown, field: string): string {
  const text = nonEmptyString(value, field).toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(text)) throw new Error(`${field} must be a transaction hash`);
  return text;
}

function bytes32(value: unknown, field: string): string {
  const text = nonEmptyString(value, field).toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(text)) throw new Error(`${field} must be bytes32`);
  return text;
}

function sha256Hex(value: unknown, field: string): string {
  const text = nonEmptyString(value, field).toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(text)) throw new Error(`${field} must be a SHA-256 hex digest`);
  return text;
}

function positiveInt(value: unknown, field: string): number {
  if (typeof value !== "number") throw new Error(`${field} must be a positive integer`);
  const parsed = value;
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${field} must be a positive integer`);
  return parsed;
}

function nonNegativeInt(value: unknown, field: string): number {
  if (typeof value !== "number") throw new Error(`${field} must be a non-negative integer`);
  const parsed = value;
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`${field} must be a non-negative integer`);
  return parsed;
}

function protocolAction(value: unknown, field: string): ProtocolAction {
  const text = nonEmptyString(value, field) as ProtocolAction;
  if (!["mint", "redeem", "wrap", "unwrap", "convert", "stake", "unstake"].includes(text)) {
    throw new Error(`${field} invalid`);
  }
  return text;
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function hashFiles(paths: readonly string[]): string {
  const hash = createHash("sha256");
  for (const path of [...paths].sort()) {
    hash.update(path);
    hash.update("\0");
    hash.update(readFileSync(resolve(LISTENER_ROOT, path)));
    hash.update("\0");
  }
  return hash.digest("hex");
}

function hashRuntimeSources(): string {
  const files = [
    ...walkFiles(resolve(LISTENER_ROOT, "src/adapters")),
    ...walkFiles(resolve(LISTENER_ROOT, "src/shared")),
    ...walkFiles(resolve(LISTENER_ROOT, "src/searcher"), (path) =>
      !path.includes("/test/") && !path.includes("/research/")),
    resolve(LISTENER_ROOT, "src/types.ts"),
    resolve(REPO_ROOT, "src/BotVM.sol"),
    resolve(REPO_ROOT, "foundry.toml"),
  ].filter((path) => existsSync(path)).sort();
  const hash = createHash("sha256");
  for (const path of files) {
    hash.update(relative(REPO_ROOT, path).replaceAll("\\", "/"));
    hash.update("\0");
    hash.update(readFileSync(path));
    hash.update("\0");
  }
  return hash.digest("hex");
}

function walkFiles(root: string, include: (path: string) => boolean = () => true): string[] {
  if (!existsSync(root)) return [];
  const output: string[] = [];
  for (const name of readdirSync(root)) {
    const path = resolve(root, name);
    if (!include(path)) continue;
    if (statSync(path).isDirectory()) output.push(...walkFiles(path, include));
    else if (/\.(?:ts|json)$/.test(name)) output.push(path);
  }
  return output;
}

function safeRelativeFixture(path: string): string {
  const value = relative(LISTENER_ROOT, path).replaceAll("\\", "/");
  if (!value || value === ".." || value.startsWith("../")) throw new Error("fixture must live under listener/");
  return value;
}

function safeRepoRelativePath(value: string, field: string): string {
  const absolute = resolve(REPO_ROOT, value);
  const fromRoot = relative(REPO_ROOT, absolute).replaceAll("\\", "/");
  if (!fromRoot || fromRoot === ".." || fromRoot.startsWith("../")) {
    throw new Error(`${field} must stay under the repository`);
  }
  return fromRoot;
}

function redactError(error: unknown, rpcUrl: string): string {
  let message = error instanceof Error ? error.message : String(error);
  if (rpcUrl) message = message.split(rpcUrl).join("<redacted-rpc>");
  return message.replace(/https?:\/\/[^\s)]+/g, "<redacted-url>");
}

async function git(args: string[]): Promise<string | null> {
  return new Promise((done) => {
    execFile("git", args, { cwd: REPO_ROOT, encoding: "utf8" }, (error, stdout) => {
      done(error ? null : stdout.trim());
    });
  });
}

async function gitRequired(args: string[]): Promise<string> {
  const result = await git(args);
  if (result === null) throw new Error(`git ${args[0] ?? "command"} failed`);
  return result;
}

async function exec(args: string[], cwd: string): Promise<void> {
  const [command, ...rest] = args;
  await new Promise<void>((done, reject) => {
    execFile(command, rest, { cwd, encoding: "utf8" }, (error) => {
      if (error) reject(error);
      else done();
    });
  });
}

main().catch((error) => {
  console.error(`adapter-family-replay FAIL: ${redactError(error, process.env.SEARCHER_LIVE_RPC_URL ?? process.env.MAINNET_RPC_URL ?? "")}`);
  process.exit(1);
});
