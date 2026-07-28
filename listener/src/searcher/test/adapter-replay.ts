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
import { compilePlan } from "../../shared/compiler/compiler.js";
import { ADDR } from "../../shared/constants/addresses.js";
import {
  createSemanticSixStepEvidence,
  type SemanticJson,
  type SemanticSixStepEvidence,
  type SemanticSixStepStatus,
} from "../../shared/evidence/semantic-six-step.js";
import { buildExecuteCalldata } from "../../shared/executor/botvm-executor.js";
import {
  DEFAULT_SEARCHER_EXECUTOR,
  DEFAULT_SEARCHER_OWNER,
  installForkBotVm,
} from "../../shared/executor/botvm-executor.js";
import { AnvilStateBackend } from "../../shared/state/state-backend.js";
import { canonicalTokenRing, cycleFingerprint } from "../detector/cycle-fingerprint.js";
import type { BlockScanOpportunity } from "../detector/detector.js";
import {
  createVictimSourceGeneration,
  detectImpactTransitionFromLogs,
} from "../detector/pool-impact.js";
import {
  BlockScanFamilyAttributedError,
  blockScanAttributedFailureFamilyId,
} from "../detector/blockscan-family-budget.js";
import { evaluateEv } from "../ev-evaluator.js";
import { TemplatePlanner } from "../planner/planner.js";
import type { PoolEntry, TokenEdge } from "../planner/token-graph.js";
import { createProfitTokenValuation } from "../profit-token-valuation.js";
import { DEFAULT_BRIBE_BPS } from "../live-envelope.js";
import { PoolStateCache } from "../solver/pool-state-cache.js";
import { propagateAmountsWithRawOutputs } from "../solver/amount-propagation.js";
import { AnvilSolver, type ResolvedPlan } from "../solver/solver.js";
import { BotVMSimulator } from "../simulator/botvm-simulator.js";
import { pathLeavesStandingPosition } from "../strategy-taxonomy.js";
import type { ProtocolAction } from "../strategy-taxonomy.js";
import { FLASH_SWAP_REPAY, type PathTemplate } from "../templates/path-template.js";
import { PRODUCTION_ADAPTER_FAMILIES } from "../venues/production-registry.js";
import type { ExecutionFamilyId } from "../venues/route-leg-adapter.js";
import {
  anchorHistoricalSenderNoncePrefix,
  type HistoricalSenderNonceAnchorResult,
} from "./historical-replay-anchor.js";

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
  logicalInstanceId?: string;
}

interface AdapterReplayLeg {
  seq: number;
  pool: RoutePoolIdentity;
  /** Trace-proven edge alias; mandatory so another ABI cannot be selected. */
  edgeAdapterId: string;
  tokenIn: string;
  tokenOut: string;
  referenceWitness: ReferenceWitness;
}

type ReferenceWitnessRef =
  | "execution-target"
  | "token-in"
  | "token-out"
  | "zero"
  | `call:${string}:from`
  | `call:${string}:arg:${number}`;

type ReferenceArgRule =
  | { readonly index: number; readonly op: "positive" }
  | {
    readonly index: number;
    readonly op: "eq" | "gte";
    readonly ref: ReferenceWitnessRef;
  };

interface ReferenceCallRule {
  readonly id: string;
  readonly within?: string;
  readonly target: ReferenceWitnessRef;
  readonly signature: string;
  readonly args: readonly ReferenceArgRule[];
  readonly value: "positive" | null;
}

interface ReferenceTransferRule {
  readonly token: ReferenceWitnessRef;
  readonly from: ReferenceWitnessRef | "any";
  readonly to: ReferenceWitnessRef | "any";
  readonly amount:
    | "positive"
    | { readonly op: "eq"; readonly ref: ReferenceWitnessRef };
}

interface ReferenceWitness {
  readonly calls: readonly [ReferenceCallRule, ...ReferenceCallRule[]];
  readonly receiptTransfers: readonly ReferenceTransferRule[];
}

interface AdapterReplayFixture {
  schemaVersion: 3;
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
    classificationNetProfitUsd: number;
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
  anchorReconstruction:
    | ({
      kind: "canonical-parent-block";
      blockNumber: number;
      blockHash: string;
      stateRoot: string;
    })
    | HistoricalSenderNonceAnchorResult
    | null;
  baseCommit: string | null;
  adapterCommit: string | null;
  /**
   * Registry-derived execution contract fingerprint. Runtime source changes
   * are bound separately by runtimeSourceSha256, so file moves never require a
   * trusted harness allowlist update.
   */
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
    gasMeasurementAvailable: boolean;
    feeStateAvailable: boolean;
    sourceBlockHash: string | null;
    decisionParentBlock: number;
    targetBlock: number;
    ethUsd: number | null;
    ethUsdRoundId: string | null;
    ethUsdUpdatedAt: string | null;
    netEvWei: string;
    expectedProfitEth: string;
    maxBaseFeePerGas: string;
    gasCostEth: string;
    bidEth: string;
  } | null;
  evPolicy: {
    profitHaircutBps: number;
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
  sixStepEvidence: SemanticSixStepEvidence[];
  /** A promotion gate still owns baseline flip and the stronger adapter_fixed verdict. */
  verdict: "adapter_replay_pass" | "implemented_not_validated";
  /** Set only by a typed family-owned failure; null means shared/ambiguous. */
  failureOwnerFamilyId: string | null;
  failure: string | null;
}

interface CliArgs {
  fixtures: string[];
  rpcUrl: string;
  outDir?: string;
  artifactRoot?: string;
  probeFamily?: string;
  useExistingBotVmArtifact: boolean;
  validateOnly: boolean;
}

const LISTENER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const REPO_ROOT = resolve(LISTENER_ROOT, "..");
const BOTVM_ARTIFACT_PATH = resolve(REPO_ROOT, "out/BotVM.sol/BotVM.json");
const HARNESS_SOURCE_FILES = [
  "src/searcher/test/adapter-replay.ts",
  "src/searcher/test/historical-replay-anchor.ts",
];
const ADDRESS_FIELDS = [
  "address", "token0", "token1", "currency0", "currency1", "hooks",
  "fixedTokenIn", "fixedTokenOut", "redeemTokenOut",
] as const;

const SHARED_API_FILES = [
  "src/searcher/venues/route-leg-adapter.ts",
  "src/searcher/venues/route-leg-registry.ts",
  "src/searcher/venues/adapter-family-registry.ts",
  "src/searcher/venues/production-registry.ts",
  "src/searcher/planner/planner.ts",
  "src/searcher/solver/solver.ts",
  "src/searcher/solver/quoter.ts",
  "src/searcher/solver/plan-builder.ts",
  "src/searcher/simulator/botvm-simulator.ts",
  "src/shared/compiler/compiler.ts",
];

const ADAPTER_REPLAY_EV_POLICY = Object.freeze({
  profitHaircutBps: 2_000,
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
  const fixtureValues: string[] = [];
  let outDir: string | undefined;
  let artifactRoot: string | undefined;
  let probeFamily: string | undefined;
  let useExistingBotVmArtifact = false;
  let validateOnly = false;
  for (let i = 0; i < argv.length; i++) {
    const name = argv[i];
    if (name === "--fixture") {
      const value = argv[++i];
      if (!value) throw new Error("--fixture requires a path");
      fixtureValues.push(value);
    } else if (name === "--out-dir") {
      const value = argv[++i];
      if (!value) throw new Error("--out-dir requires a path");
      outDir = resolve(value);
    } else if (name === "--artifact-root") {
      const value = argv[++i];
      if (!value) throw new Error("--artifact-root requires a path");
      if (artifactRoot !== undefined) {
        throw new Error("--artifact-root may appear only once");
      }
      artifactRoot = resolve(value);
    } else if (name === "--probe-family") {
      const value = argv[++i];
      if (!value) throw new Error("--probe-family requires an execution family id");
      if (probeFamily !== undefined) {
        throw new Error("--probe-family may appear only once");
      }
      probeFamily = value;
    } else if (name === "--validate-only") {
      validateOnly = true;
    } else if (name === "--use-existing-botvm-artifact") {
      if (useExistingBotVmArtifact) {
        throw new Error("--use-existing-botvm-artifact may appear only once");
      }
      useExistingBotVmArtifact = true;
    } else if (name === "--rpc") {
      throw new Error("--rpc is forbidden because argv may be logged; use MAINNET_RPC_URL in the environment");
    } else {
      throw new Error(`unknown adapter-family replay option ${name}`);
    }
  }
  if (probeFamily && (
    fixtureValues.length > 0 ||
    validateOnly ||
    outDir !== undefined ||
    artifactRoot !== undefined ||
    useExistingBotVmArtifact
  )) {
    throw new Error("--probe-family must be used alone");
  }
  if (!probeFamily && fixtureValues.length === 0) {
    throw new Error("at least one --fixture is required");
  }
  const fixtures = fixtureValues.map((value) => {
    if (!artifactRoot) return resolve(value);
    const relativePath = safeArtifactRelativePath(value, "--fixture");
    return resolve(artifactRoot, relativePath);
  });
  const rpcUrl = process.env.SEARCHER_LIVE_RPC_URL ?? process.env.MAINNET_RPC_URL ?? "";
  if (!validateOnly && !probeFamily && !rpcUrl) {
    throw new Error("SEARCHER_LIVE_RPC_URL or MAINNET_RPC_URL is required");
  }
  return {
    fixtures,
    rpcUrl,
    outDir,
    artifactRoot,
    probeFamily,
    useExistingBotVmArtifact,
    validateOnly,
  };
}

function loadFixture(path: string, artifactRoot?: string): AdapterReplayFixture {
  const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
  const root = record(raw, path);
  exactKeys(root, [
    "schemaVersion", "id", "executionFamilyId", "referenceTx", "lane",
    "stateAnchor", "flash", "route", "landedReference",
  ], path);
  if (root.schemaVersion !== 3) throw new Error(`${path}: unsupported schemaVersion`);
  const id = fixtureId(root.id, `${path}.id`);
  const executionFamilyId = nonEmptyString(root.executionFamilyId, `${path}.executionFamilyId`) as ExecutionFamilyId;
  PRODUCTION_ADAPTER_FAMILIES.routes().forFamily(executionFamilyId);
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
  if (!PRODUCTION_ADAPTER_FAMILIES.findFundingByAction(flash.adapterId)) {
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
    ["classificationNetProfitUsd", "evidencePath", "evidenceSha256"],
    `${path}.landedReference`,
  );
  if (typeof landedRaw.classificationNetProfitUsd !== "number") {
    throw new Error(`${path}.landedReference.classificationNetProfitUsd must be a number`);
  }
  const classificationNetProfitUsd = landedRaw.classificationNetProfitUsd;
  if (!Number.isFinite(classificationNetProfitUsd) || classificationNetProfitUsd <= 0) {
    throw new Error(`${path}.landedReference.classificationNetProfitUsd must be positive`);
  }
  const evidencePath = artifactRoot
    ? safeArtifactRelativePath(
      nonEmptyString(landedRaw.evidencePath, `${path}.landedReference.evidencePath`),
      `${path}.landedReference.evidencePath`,
    )
    : safeRepoRelativePath(
    nonEmptyString(landedRaw.evidencePath, `${path}.landedReference.evidencePath`),
    `${path}.landedReference.evidencePath`,
  );
  const evidenceSha256 = sha256Hex(
    landedRaw.evidenceSha256,
    `${path}.landedReference.evidenceSha256`,
  );
  const evidence = readFileSync(
    resolve(artifactRoot ?? REPO_ROOT, evidencePath),
    "utf8",
  );
  if (sha256(evidence) !== evidenceSha256) throw new Error(`${path}: landed evidence hash mismatch`);
  if (!evidence.toLowerCase().includes(referenceTx)) throw new Error(`${path}: landed evidence omits reference tx`);
  if (stateAnchor.kind === "after-transaction" &&
      !evidence.toLowerCase().includes(stateAnchor.triggerTxHash)) {
    throw new Error(`${path}: landed evidence omits backrun trigger tx`);
  }
  if (!evidence.includes(String(classificationNetProfitUsd))) {
    throw new Error(`${path}: landed evidence omits classification net profit`);
  }
  return {
    schemaVersion: 3,
    id,
    executionFamilyId,
    referenceTx,
    lane,
    stateAnchor,
    flash,
    route,
    landedReference: { classificationNetProfitUsd, evidencePath, evidenceSha256 },
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
  exactKeys(
    value,
    ["seq", "pool", "edgeAdapterId", "tokenIn", "tokenOut", "referenceWitness"],
    field,
  );
  return {
    seq: positiveInt(value.seq, `${field}.seq`),
    pool: parsePool(value.pool, `${field}.pool`),
    edgeAdapterId: nonEmptyString(value.edgeAdapterId, `${field}.edgeAdapterId`),
    tokenIn: address(value.tokenIn, `${field}.tokenIn`),
    tokenOut: address(value.tokenOut, `${field}.tokenOut`),
    referenceWitness: parseReferenceWitness(
      value.referenceWitness,
      `${field}.referenceWitness`,
    ),
  };
}

function parseReferenceWitness(raw: unknown, field: string): ReferenceWitness {
  const value = record(raw, field);
  exactKeys(value, ["calls", "receiptTransfers"], field, ["calls"]);
  if (!Array.isArray(value.calls) || value.calls.length === 0 || value.calls.length > 8) {
    throw new Error(`${field}.calls must contain 1..8 rules`);
  }
  const calls = value.calls.map((item, index) =>
    parseReferenceCallRule(item, `${field}.calls[${index}]`)
  );
  const ids = new Set<string>();
  calls.forEach((call, index) => {
    if (ids.has(call.id)) throw new Error(`${field}.calls has duplicate id ${call.id}`);
    if (index === 0) {
      if (
        call.id !== "root" ||
        call.within !== undefined ||
        call.target !== "execution-target"
      ) {
        throw new Error(
          `${field}.calls[0] must be root at execution-target without within`,
        );
      }
    } else if (call.within && !ids.has(call.within)) {
      throw new Error(`${field}.calls[${index}].within must name a prior call`);
    }
    validateReferenceRuleRefs(call, ids, `${field}.calls[${index}]`);
    ids.add(call.id);
  });
  const transfersRaw = value.receiptTransfers ?? [];
  if (!Array.isArray(transfersRaw) || transfersRaw.length > 8) {
    throw new Error(`${field}.receiptTransfers must contain at most 8 rules`);
  }
  const receiptTransfers = transfersRaw.map((item, index) =>
    parseReferenceTransferRule(item, `${field}.receiptTransfers[${index}]`)
  );
  for (let index = 0; index < receiptTransfers.length; index++) {
    const transfer = receiptTransfers[index];
    for (const ref of [transfer.token, transfer.from, transfer.to]) {
      if (ref !== "any") validateReferenceWitnessRef(ref, ids, `${field}.receiptTransfers[${index}]`);
    }
    if (transfer.amount !== "positive") {
      validateReferenceWitnessRef(
        transfer.amount.ref,
        ids,
        `${field}.receiptTransfers[${index}].amount.ref`,
      );
    }
  }
  return {
    calls: calls as [ReferenceCallRule, ...ReferenceCallRule[]],
    receiptTransfers,
  };
}

function parseReferenceCallRule(raw: unknown, field: string): ReferenceCallRule {
  const value = record(raw, field);
  exactKeys(value, ["id", "within", "target", "signature", "args", "value"], field, [
    "id", "target", "signature",
  ]);
  const id = fixtureId(value.id, `${field}.id`);
  const within = value.within === undefined
    ? undefined
    : fixtureId(value.within, `${field}.within`);
  const target = referenceWitnessRef(value.target, `${field}.target`);
  const signature = nonEmptyString(value.signature, `${field}.signature`);
  referenceCallInterface(signature, field);
  const argsRaw = value.args ?? [];
  if (!Array.isArray(argsRaw) || argsRaw.length > 16) {
    throw new Error(`${field}.args must contain at most 16 rules`);
  }
  const args = argsRaw.map((item, index) =>
    parseReferenceArgRule(item, `${field}.args[${index}]`)
  );
  const valueRule = value.value ?? null;
  if (valueRule !== null && valueRule !== "positive") {
    throw new Error(`${field}.value must be positive`);
  }
  return { id, within, target, signature, args, value: valueRule };
}

function parseReferenceArgRule(raw: unknown, field: string): ReferenceArgRule {
  const value = record(raw, field);
  const op = value.op;
  if (op === "positive") {
    exactKeys(value, ["index", "op"], field);
    return { index: nonNegativeInt(value.index, `${field}.index`), op };
  }
  if (op === "eq" || op === "gte") {
    exactKeys(value, ["index", "op", "ref"], field);
    return {
      index: nonNegativeInt(value.index, `${field}.index`),
      op,
      ref: referenceWitnessRef(value.ref, `${field}.ref`),
    };
  }
  throw new Error(`${field}.op invalid`);
}

function parseReferenceTransferRule(
  raw: unknown,
  field: string,
): ReferenceTransferRule {
  const value = record(raw, field);
  exactKeys(value, ["token", "from", "to", "amount"], field);
  let amount: ReferenceTransferRule["amount"];
  if (value.amount === "positive") {
    amount = "positive";
  } else {
    const amountRule = record(value.amount, `${field}.amount`);
    exactKeys(amountRule, ["op", "ref"], `${field}.amount`);
    if (amountRule.op !== "eq") throw new Error(`${field}.amount.op must be eq`);
    amount = {
      op: "eq",
      ref: referenceWitnessRef(amountRule.ref, `${field}.amount.ref`),
    };
  }
  const parseParty = (input: unknown, partyField: string) =>
    input === "any" ? "any" as const : referenceWitnessRef(input, partyField);
  return {
    token: referenceWitnessRef(value.token, `${field}.token`),
    from: parseParty(value.from, `${field}.from`),
    to: parseParty(value.to, `${field}.to`),
    amount,
  };
}

function referenceWitnessRef(value: unknown, field: string): ReferenceWitnessRef {
  const ref = nonEmptyString(value, field);
  if (
    ref === "execution-target" ||
    ref === "token-in" ||
    ref === "token-out" ||
    ref === "zero" ||
    /^call:[a-z0-9][a-z0-9-]{0,63}:from$/.test(ref) ||
    /^call:[a-z0-9][a-z0-9-]{0,63}:arg:[0-9]+$/.test(ref)
  ) {
    return ref as ReferenceWitnessRef;
  }
  throw new Error(`${field} invalid`);
}

function validateReferenceRuleRefs(
  call: ReferenceCallRule,
  priorIds: ReadonlySet<string>,
  field: string,
): void {
  validateReferenceWitnessRef(call.target, priorIds, `${field}.target`);
  call.args.forEach((rule, index) => {
    if (rule.op !== "positive") {
      validateReferenceWitnessRef(rule.ref, priorIds, `${field}.args[${index}].ref`);
    }
  });
}

function validateReferenceWitnessRef(
  ref: ReferenceWitnessRef,
  availableIds: ReadonlySet<string>,
  field: string,
): void {
  const match = ref.match(/^call:([^:]+):(from|arg:[0-9]+)$/);
  if (match && !availableIds.has(match[1])) {
    throw new Error(`${field} references unavailable call ${match[1]}`);
  }
}

function parsePool(raw: unknown, field: string): RoutePoolIdentity {
  const value = record(raw, field);
  exactKeys(value, [
    "adapter", "address", "poolId", "token0", "token1", "underlyingCoins",
    "currency0", "currency1", "fee", "tickSpacing", "hooks", "fixedTokenIn",
    "fixedTokenOut", "fixedSlotKind", "fixedProtocolAction", "nonStandardRedeem",
    "redeemTokenOut", "receiptEmitters", "logicalInstanceId",
  ], field, ["adapter", "address"]);
  const adapter = nonEmptyString(value.adapter, `${field}.adapter`) as PoolEntry["adapter"];
  PRODUCTION_ADAPTER_FAMILIES.routes().forPool(adapter);
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
  if (value.logicalInstanceId !== undefined) {
    pool.logicalInstanceId = nonEmptyString(
      value.logicalInstanceId,
      `${field}.logicalInstanceId`,
    );
  }
  if (value.nonStandardRedeem !== undefined) {
    if (typeof value.nonStandardRedeem !== "boolean") throw new Error(`${field}.nonStandardRedeem must be boolean`);
    pool.nonStandardRedeem = value.nonStandardRedeem;
  }
  return pool;
}

function familyForLeg(leg: AdapterReplayLeg, fixturePath: string): ExecutionFamilyId {
  const poolFamily = PRODUCTION_ADAPTER_FAMILIES.routes().forPool(leg.pool.adapter);
  const edgeFamily = PRODUCTION_ADAPTER_FAMILIES.routes().forEdge(leg.edgeAdapterId);
  if (poolFamily.id !== edgeFamily.id) {
    throw new Error(
      `${fixturePath}: leg ${leg.seq} pool family ${poolFamily.id} disagrees with edge family ${edgeFamily.id}`,
    );
  }
  return poolFamily.id;
}

async function anchorState(
  state: AnvilStateBackend,
  upstream: ethers.JsonRpcProvider,
  fixture: AdapterReplayFixture,
  winnerIndex: number,
): Promise<HistoricalSenderNonceAnchorResult | null> {
  const anchor = fixture.stateAnchor;
  if (anchor.kind === "parent-block") {
    await state.forkAt(anchor.blockNumber);
    return null;
  }
  return anchorHistoricalSenderNoncePrefix({
    state,
    archiveProvider: upstream,
    triggerTxHash: anchor.triggerTxHash,
    expectedBlockNumber: anchor.blockNumber,
    mustPrecedeIndex: winnerIndex,
    mineLabel: `${fixture.id}-sender-nonce-prefix`,
  });
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
  senderPrefix: HistoricalSenderNonceAnchorResult | null,
): Promise<AdapterReplayReport["anchorReconstruction"]> {
  if (anchor.kind === "after-transaction") {
    if (!senderPrefix) throw new Error("after-transaction anchor lacks sender nonce prefix evidence");
    const [localBlock, localTrigger, localNextNonce] = await Promise.all([
      local.getBlockNumber(),
      local.getTransactionReceipt(anchor.triggerTxHash),
      local.getTransactionCount(senderPrefix.sender, "latest"),
    ]);
    if (localBlock !== anchor.blockNumber) {
      throw new Error(`sender nonce prefix block ${localBlock} != expected ${anchor.blockNumber}`);
    }
    if (
      !localTrigger ||
      localTrigger.status !== 1 ||
      localTrigger.hash.toLowerCase() !== anchor.triggerTxHash.toLowerCase() ||
      localTrigger.blockNumber !== anchor.blockNumber
    ) {
      throw new Error("local sender nonce prefix lacks the successful trigger receipt");
    }
    if (localNextNonce !== senderPrefix.lastNonce + 1) {
      throw new Error(
        `local trigger sender nonce ${localNextNonce} != expected ${senderPrefix.lastNonce + 1}`,
      );
    }
    return senderPrefix;
  }

  if (senderPrefix) throw new Error("parent-block anchor unexpectedly has sender prefix evidence");
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
  return {
    kind: "canonical-parent-block",
    blockNumber: anchor.blockNumber,
    blockHash: canonicalHash,
    stateRoot: canonicalRoot,
  };
}

async function validateChainAnchor(
  provider: ethers.JsonRpcProvider,
  fixture: AdapterReplayFixture,
): Promise<ethers.TransactionReceipt> {
  const winner = await provider.getTransactionReceipt(fixture.referenceTx);
  if (!winner || winner.status !== 1) throw new Error(`reference tx missing or reverted: ${fixture.referenceTx}`);
  if (fixture.stateAnchor.kind === "parent-block") {
    if (winner.blockNumber !== fixture.stateAnchor.blockNumber + 1) {
      throw new Error(`parent anchor ${fixture.stateAnchor.blockNumber} does not precede winner block ${winner.blockNumber}`);
    }
    return winner;
  }
  const trigger = await provider.getTransactionReceipt(fixture.stateAnchor.triggerTxHash);
  if (!trigger || trigger.status !== 1) throw new Error(`trigger tx missing or reverted: ${fixture.stateAnchor.triggerTxHash}`);
  if (winner.blockNumber !== fixture.stateAnchor.blockNumber || trigger.blockNumber !== winner.blockNumber) {
    throw new Error("backrun trigger/winner are not in the declared block");
  }
  if (trigger.index >= winner.index) throw new Error("backrun trigger must precede the winner");
  return winner;
}

interface TraceCall {
  readonly from?: string;
  readonly to?: string;
  readonly input?: string;
  readonly value?: string;
  readonly error?: string;
  readonly calls?: readonly TraceCall[];
}

interface FlattenedTraceCall {
  readonly target: string;
  readonly selector: string;
  readonly input: string;
  readonly from?: string;
  readonly value: bigint;
  readonly depth?: number;
}

interface ReferenceTraceSemanticEvidence {
  readonly kind: string;
  readonly [key: string]: unknown;
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

interface MatchedReferenceCall {
  readonly call: FlattenedTraceCall;
  readonly index: number;
  readonly args: ethers.Result;
}

interface ReferenceExecutionSurface {
  readonly adapterId: string;
  readonly target: string;
  readonly selector: string;
}

const ERC20_TRANSFER_TOPIC = ethers.id(
  "Transfer(address,address,uint256)",
).toLowerCase();

function descendantCallIndexes(
  calls: readonly FlattenedTraceCall[],
  parentIndex: number,
): readonly number[] {
  const parentDepth = calls[parentIndex]?.depth;
  if (parentDepth === undefined) return [];
  let end = parentIndex + 1;
  while (end < calls.length && (calls[end].depth ?? 0) > parentDepth) end++;
  return Array.from({ length: end - parentIndex - 1 }, (_, index) =>
    parentIndex + index + 1
  );
}

async function validateReferenceRoute(
  provider: ethers.JsonRpcProvider,
  fixture: AdapterReplayFixture,
  executionSurfaces: readonly ReferenceExecutionSurface[],
): Promise<string> {
  const trace = await provider.send("debug_traceTransaction", [
    fixture.referenceTx,
    { tracer: "callTracer", tracerConfig: { onlyTopCall: false } },
  ]) as TraceCall;
  const receipt = await provider.getTransactionReceipt(fixture.referenceTx);
  if (!receipt) throw new Error(`reference receipt unavailable: ${fixture.referenceTx}`);
  const calls: FlattenedTraceCall[] = [];
  flattenSuccessfulCalls(trace, calls);
  const matched: ReferenceTraceSemanticEvidence[] = [];
  let cursor = 0;
  for (let legIndex = 0; legIndex < fixture.route.length; legIndex++) {
    const leg = fixture.route[legIndex];
    const familyId = familyForLeg(leg, fixture.id);
    const result = matchReferenceWitness({
      calls,
      receiptLogs: receipt.logs,
      cursor,
      leg,
      executionTarget: executionSurfaces[legIndex].target,
      expectedEncodedSelector: executionSurfaces[legIndex].selector,
      requireTokenCoverage:
        PRODUCTION_ADAPTER_FAMILIES.routes().forFamily(familyId).kind !== "swap",
    });
    cursor = result.nextCursor;
    matched.push(result.evidence);
  }
  return sha256(JSON.stringify(matched));
}

function matchReferenceWitness(input: {
  readonly calls: readonly FlattenedTraceCall[];
  readonly receiptLogs: readonly ethers.Log[];
  readonly cursor: number;
  readonly leg: AdapterReplayLeg;
  readonly executionTarget: string;
  readonly expectedEncodedSelector: string;
  readonly requireTokenCoverage: boolean;
}): { readonly nextCursor: number; readonly evidence: ReferenceTraceSemanticEvidence } {
  const matched = new Map<string, MatchedReferenceCall>();
  const callEvidence: Array<Record<string, unknown>> = [];
  let rootIndex = -1;
  let topLevelCursor = input.cursor;
  for (const rule of input.leg.referenceWitness.calls) {
    const candidateIndexes = rule.within
      ? descendantCallIndexes(input.calls, matched.get(rule.within)!.index)
      : Array.from(
        { length: input.calls.length - topLevelCursor },
        (_, index) => topLevelCursor + index,
      );
    let selected: MatchedReferenceCall | null = null;
    for (const index of candidateIndexes) {
      const candidate = matchReferenceCallRule(
        rule,
        input.calls[index],
        index,
        input.leg,
        input.executionTarget,
        matched,
      );
      if (candidate) {
        selected = candidate;
        break;
      }
    }
    if (!selected) {
      throw new Error(
        `reference trace witness ${rule.id} failed for leg ${input.leg.seq}`,
      );
    }
    if (rule.id === "root") {
      const action = getActionAdapter(input.leg.edgeAdapterId);
      if (selected.call.selector !== input.expectedEncodedSelector) {
        throw new Error(
          `reference root selector ${selected.call.selector} differs from encoded ` +
            `${input.leg.edgeAdapterId} selector ${input.expectedEncodedSelector}`,
        );
      }
      if (!action.matchTrace(selected.call.target, selected.call.selector)) {
        throw new Error(
          `reference root selector is not owned by ${input.leg.edgeAdapterId}`,
        );
      }
      rootIndex = selected.index;
    }
    if (!rule.within) topLevelCursor = selected.index + 1;
    matched.set(rule.id, selected);
    callEvidence.push({
      id: rule.id,
      target: selected.call.target,
      selector: selected.call.selector,
      ...(rule.id === "root"
        ? { encoded_selector: input.expectedEncodedSelector }
        : {}),
      input_sha256: sha256(selected.call.input),
    });
  }
  if (rootIndex < 0) throw new Error(`reference leg ${input.leg.seq} lacks root witness`);

  const tokenBindings = new Set<"token-in" | "token-out">();
  for (const entry of matched.values()) {
    markReferenceTokenBinding(tokenBindings, entry.call.target, input.leg);
  }
  for (const rule of input.leg.referenceWitness.calls) {
    for (const arg of rule.args) {
      if (arg.op === "positive") continue;
      const value = resolveReferenceWitnessRef(
        arg.ref,
        input.leg,
        input.executionTarget,
        matched,
      );
      markReferenceTokenBinding(tokenBindings, value, input.leg);
    }
  }

  const transferEvidence: Array<Record<string, unknown>> = [];
  for (const rule of input.leg.referenceWitness.receiptTransfers) {
    const evidence = matchReferenceTransfer(
      rule,
      input.receiptLogs,
      input.leg,
      input.executionTarget,
      matched,
    );
    if (!evidence) {
      throw new Error(
        `reference receipt transfer witness failed for leg ${input.leg.seq}`,
      );
    }
    markReferenceTokenBinding(tokenBindings, evidence.token, input.leg);
    transferEvidence.push(evidence);
  }
  if (
    input.requireTokenCoverage &&
    (!tokenBindings.has("token-in") || !tokenBindings.has("token-out"))
  ) {
    throw new Error(
      `reference witness for non-swap leg ${input.leg.seq} does not bind both tokens`,
    );
  }
  return {
    nextCursor: topLevelCursor,
    evidence: {
      kind: "declarative-reference-witness",
      seq: input.leg.seq,
      edgeAdapterId: input.leg.edgeAdapterId,
      tokenBindings: [...tokenBindings].sort(),
      calls: callEvidence,
      transfers: transferEvidence,
    },
  };
}

function matchReferenceCallRule(
  rule: ReferenceCallRule,
  call: FlattenedTraceCall,
  index: number,
  leg: AdapterReplayLeg,
  executionTarget: string,
  matched: ReadonlyMap<string, MatchedReferenceCall>,
): MatchedReferenceCall | null {
  try {
    const expectedTarget = String(resolveReferenceWitnessRef(
      rule.target,
      leg,
      executionTarget,
      matched,
    )).toLowerCase();
    const descriptor = referenceCallInterface(rule.signature, "reference witness");
    if (
      call.target !== expectedTarget ||
      call.selector !== descriptor.selector ||
      (rule.value === "positive" && call.value <= 0n)
    ) {
      return null;
    }
    const args = descriptor.iface.decodeFunctionData(
      descriptor.functionName,
      call.input,
    );
    for (const argRule of rule.args) {
      if (argRule.index >= args.length) return null;
      const actual = args[argRule.index];
      if (argRule.op === "positive") {
        if (BigInt(actual) <= 0n) return null;
        continue;
      }
      const expected = resolveReferenceWitnessRef(
        argRule.ref,
        leg,
        executionTarget,
        matched,
      );
      if (argRule.op === "eq" && !referenceValuesEqual(actual, expected)) {
        return null;
      }
      if (argRule.op === "gte" && BigInt(actual) < BigInt(expected)) {
        return null;
      }
    }
    return { call, index, args };
  } catch {
    return null;
  }
}

function matchReferenceTransfer(
  rule: ReferenceTransferRule,
  logs: readonly ethers.Log[],
  leg: AdapterReplayLeg,
  executionTarget: string,
  matched: ReadonlyMap<string, MatchedReferenceCall>,
): Record<string, string> | null {
  const token = String(resolveReferenceWitnessRef(
    rule.token,
    leg,
    executionTarget,
    matched,
  )).toLowerCase();
  const expectedFrom = rule.from === "any" ? null : String(
    resolveReferenceWitnessRef(rule.from, leg, executionTarget, matched),
  ).toLowerCase();
  const expectedTo = rule.to === "any" ? null : String(
    resolveReferenceWitnessRef(rule.to, leg, executionTarget, matched),
  ).toLowerCase();
  const expectedAmount = rule.amount === "positive"
    ? null
    : BigInt(resolveReferenceWitnessRef(
      rule.amount.ref,
      leg,
      executionTarget,
      matched,
    ));
  for (const log of logs) {
    if (
      log.address.toLowerCase() !== token ||
      log.topics.length !== 3 ||
      log.topics[0].toLowerCase() !== ERC20_TRANSFER_TOPIC
    ) {
      continue;
    }
    const from = `0x${log.topics[1].slice(-40)}`.toLowerCase();
    const to = `0x${log.topics[2].slice(-40)}`.toLowerCase();
    const amount = BigInt(log.data);
    if (
      amount > 0n &&
      (expectedAmount === null || amount === expectedAmount) &&
      (expectedFrom === null || from === expectedFrom) &&
      (expectedTo === null || to === expectedTo)
    ) {
      return { token, from, to, amount: amount.toString() };
    }
  }
  return null;
}

function resolveReferenceWitnessRef(
  ref: ReferenceWitnessRef,
  leg: AdapterReplayLeg,
  executionTarget: string,
  matched: ReadonlyMap<string, MatchedReferenceCall>,
): string | bigint {
  if (ref === "execution-target") return executionTarget.toLowerCase();
  if (ref === "token-in") return leg.tokenIn.toLowerCase();
  if (ref === "token-out") return leg.tokenOut.toLowerCase();
  if (ref === "zero") return ethers.ZeroAddress.toLowerCase();
  const from = ref.match(/^call:([^:]+):from$/);
  if (from) {
    const value = matched.get(from[1])?.call.from;
    if (!value) throw new Error(`reference call ${from[1]} has no caller`);
    return value.toLowerCase();
  }
  const arg = ref.match(/^call:([^:]+):arg:([0-9]+)$/);
  if (arg) {
    const value = matched.get(arg[1])?.args[Number(arg[2])];
    if (value === undefined) throw new Error(`reference call ${arg[1]} arg missing`);
    return typeof value === "bigint" ? value : String(value).toLowerCase();
  }
  throw new Error(`unsupported reference witness ref ${ref}`);
}

function referenceValuesEqual(left: unknown, right: string | bigint): boolean {
  if (typeof right === "bigint") return BigInt(left as bigint) === right;
  return String(left).toLowerCase() === right.toLowerCase();
}

function markReferenceTokenBinding(
  bindings: Set<"token-in" | "token-out">,
  value: unknown,
  leg: AdapterReplayLeg,
): void {
  const normalized = String(value).toLowerCase();
  if (normalized === leg.tokenIn.toLowerCase()) bindings.add("token-in");
  if (normalized === leg.tokenOut.toLowerCase()) bindings.add("token-out");
}

function normalizedFailureOwnerFamilyId(
  error: unknown,
  routeExecutionFamilies: readonly ExecutionFamilyId[],
): string | null {
  const attributed = blockScanAttributedFailureFamilyId(error);
  if (attributed === null) return null;
  const normalized = routeExecutionFamilies.includes(
    attributed as ExecutionFamilyId,
  )
    ? attributed
    : PRODUCTION_ADAPTER_FAMILIES.routes().findForEdge(attributed)?.id ?? null;
  return normalized !== null
    && routeExecutionFamilies.includes(normalized as ExecutionFamilyId)
    ? normalized
    : null;
}

function referenceCallInterface(
  signature: string,
  field: string,
): { iface: ethers.Interface; functionName: string; selector: string } {
  try {
    const iface = new ethers.Interface([`function ${signature}`]);
    const functionName = signature.slice(0, signature.indexOf("("));
    const fragment = iface.getFunction(functionName);
    if (!fragment) throw new Error("missing function");
    return {
      iface,
      functionName,
      selector: fragment.selector.toLowerCase(),
    };
  } catch {
    throw new Error(`${field}.signature invalid`);
  }
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
  const observed: ReferenceObservedImpact[] = [];
  const swapFamilies = [...new Set(fixture.route
    .map((leg) => PRODUCTION_ADAPTER_FAMILIES.routes().forFamily(familyForLeg(leg, fixture.id)))
    .filter((adapter) => adapter.kind === "swap")
    .map((adapter) => adapter.id))];
  const sourceGeneration = createVictimSourceGeneration({
    sourceBlock: Math.max(0, receipt.blockNumber - 1),
    sourceBlockHash: null,
    receiptId: fixture.referenceTx,
    logs,
    logsCompleteness: "complete-receipt",
  });
  const transition = await detectImpactTransitionFromLogs(
    logs,
    [...edges],
    sourceGeneration,
  );
  const swapFamilyById = new Map(
    swapFamilies.map((familyId) => [String(familyId), familyId] as const),
  );
  observed.push(...transition.steps
    .filter((step) => swapFamilyById.has(step.familyId))
    .map(({ familyId, logIndex, impact }) => ({
      familyId: swapFamilyById.get(familyId)!,
      logIndex: logIndex!,
      matchedAdapterId: impact.matchedAdapterId,
      pool: impact.pool,
      tokenIn: impact.tokenIn,
      tokenOut: impact.tokenOut,
      ...(impact.poolId ? { poolId: impact.poolId } : {}),
    })));

  const matched = matchReferenceSwapImpacts(fixture, edges, observed);
  return sha256(JSON.stringify(matched));
}

function matchReferenceSwapImpacts(
  fixture: AdapterReplayFixture,
  edges: readonly TokenEdge[],
  observed: readonly ReferenceObservedImpact[],
): Array<{ seq: number } & ReferenceObservedImpact> {
  const consumed = new Set<number>();
  let previousLogIndex = -1;
  return fixture.route.flatMap((leg, index) => {
    const family = PRODUCTION_ADAPTER_FAMILIES.routes().forFamily(familyForLeg(leg, fixture.id));
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
    consumed.add(observedIndex);
    previousLogIndex = impact.logIndex;
    return [{ seq: leg.seq, ...impact }];
  });
}

function flattenSuccessfulCalls(
  call: TraceCall,
  output: FlattenedTraceCall[],
  depth = 0,
): void {
  if (call.error) return;
  if (typeof call.to === "string" && typeof call.input === "string" && call.input.length >= 10) {
    output.push({
      target: call.to.toLowerCase(),
      selector: call.input.slice(0, 10).toLowerCase(),
      input: call.input.toLowerCase(),
      ...(typeof call.from === "string" ? { from: call.from.toLowerCase() } : {}),
      value: typeof call.value === "string" ? BigInt(call.value) : 0n,
      depth,
    });
  }
  for (const child of call.calls ?? []) flattenSuccessfulCalls(child, output, depth + 1);
}

function runReferenceMatcherSelfTests(): void {
  const tokenA = "0x0000000000000000000000000000000000000001";
  const tokenB = "0x0000000000000000000000000000000000000002";
  const tokenC = "0x0000000000000000000000000000000000000003";
  const target = "0x0000000000000000000000000000000000000010";
  const depositor = "0x0000000000000000000000000000000000000020";
  const depositIface = new ethers.Interface([
    "function depositAsset(address,uint256,uint256,address)",
  ]);
  const transferIface = new ethers.Interface([
    "function transferFrom(address,address,uint256)",
  ]);
  const mintIface = new ethers.Interface(["function mint(address,uint256)"]);
  const witness: ReferenceWitness = {
    calls: [
      {
        id: "root",
        target: "execution-target",
        signature: "depositAsset(address,uint256,uint256,address)",
        args: [
          { index: 0, op: "eq", ref: "token-in" },
          { index: 1, op: "positive" },
        ],
        value: null,
      },
      {
        id: "pull",
        within: "root",
        target: "token-in",
        signature: "transferFrom(address,address,uint256)",
        args: [
          { index: 0, op: "eq", ref: "call:root:from" },
          { index: 1, op: "eq", ref: "execution-target" },
          { index: 2, op: "eq", ref: "call:root:arg:1" },
        ],
        value: null,
      },
      {
        id: "mint",
        within: "root",
        target: "token-out",
        signature: "mint(address,uint256)",
        args: [
          { index: 0, op: "eq", ref: "call:root:from" },
          { index: 1, op: "gte", ref: "call:root:arg:2" },
        ],
        value: null,
      },
    ],
    receiptTransfers: [],
  };
  const leg: AdapterReplayLeg = {
    seq: 1,
    pool: {
      adapter: "eigenpie-deposit-router",
      address: target,
      fixedTokenIn: tokenA,
      fixedTokenOut: tokenB,
      fixedSlotKind: "protocol",
      fixedProtocolAction: "wrap",
    },
    edgeAdapterId: "eigenpie-deposit-asset",
    tokenIn: tokenA,
    tokenOut: tokenB,
    referenceWitness: witness,
  };
  const rootInput = depositIface.encodeFunctionData("depositAsset", [
    tokenA, 10n, 9n, ethers.ZeroAddress,
  ]);
  const pullInput = transferIface.encodeFunctionData("transferFrom", [
    depositor, target, 10n,
  ]);
  const mintInput = mintIface.encodeFunctionData("mint", [depositor, 9n]);
  const calls: FlattenedTraceCall[] = [
    {
      target,
      from: depositor,
      selector: rootInput.slice(0, 10).toLowerCase(),
      input: rootInput,
      value: 0n,
      depth: 1,
    },
    {
      target: tokenA,
      selector: pullInput.slice(0, 10).toLowerCase(),
      input: pullInput,
      value: 0n,
      depth: 2,
    },
    {
      target: tokenB,
      selector: mintInput.slice(0, 10).toLowerCase(),
      input: mintInput,
      value: 0n,
      depth: 2,
    },
  ];
  assert.doesNotThrow(() => matchReferenceWitness({
    calls,
    receiptLogs: [],
    cursor: 0,
    leg,
    executionTarget: target,
    expectedEncodedSelector: rootInput.slice(0, 10).toLowerCase(),
    requireTokenCoverage: true,
  }));
  assert.throws(() => matchReferenceWitness({
    calls,
    receiptLogs: [],
    cursor: 0,
    leg,
    executionTarget: target,
    expectedEncodedSelector: "0x12345678",
    requireTokenCoverage: true,
  }), /differs from encoded/);
  assert.throws(() => matchReferenceWitness({
    calls: [
      calls[0],
      calls[1],
      {
        target: tokenC,
        selector: "0x12345678",
        input: "0x12345678",
        value: 0n,
        depth: 1,
      },
      calls[2],
    ],
    receiptLogs: [],
    cursor: 0,
    leg,
    executionTarget: target,
    expectedEncodedSelector: rootInput.slice(0, 10).toLowerCase(),
    requireTokenCoverage: true,
  }), /witness mint failed/);

  const incompleteLeg: AdapterReplayLeg = {
    ...leg,
    referenceWitness: {
      calls: [witness.calls[0]],
      receiptTransfers: [],
    },
  };
  assert.throws(() => matchReferenceWitness({
    calls,
    receiptLogs: [],
    cursor: 0,
    leg: incompleteLeg,
    executionTarget: target,
    expectedEncodedSelector: rootInput.slice(0, 10).toLowerCase(),
    requireTokenCoverage: true,
  }), /does not bind both tokens/);

  const materializedPool = materializeReplayPool(leg);
  assert.deepEqual(materializedPool.verifiedRoutes, [{
    edgeAdapterId: "eigenpie-deposit-asset",
    tokenIn: ethers.getAddress(tokenA),
    tokenOut: ethers.getAddress(tokenB),
    slotKind: "protocol",
    protocolAction: "wrap",
  }]);

  const repeatedLeg: AdapterReplayLeg = {
    seq: 1,
    pool: { adapter: "univ2", address: target },
    edgeAdapterId: "univ2-swap",
    tokenIn: tokenA,
    tokenOut: tokenB,
    referenceWitness: {
      calls: [{
        id: "root",
        target: "execution-target",
        signature: "swap(uint256,uint256,address,bytes)",
        args: [],
        value: null,
      }],
      receiptTransfers: [],
    },
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
    () => matchReferenceSwapImpacts(repeatedFixture, [repeatedEdge, repeatedEdge], [oneImpact]),
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
  assert.equal(
    normalizedFailureOwnerFamilyId(
      new BlockScanFamilyAttributedError(
        "protocol:eigenpie",
        "self-test",
        new Error("owned"),
      ),
      ["protocol:eigenpie"],
    ),
    "protocol:eigenpie",
  );
  assert.equal(
    normalizedFailureOwnerFamilyId(
      new BlockScanFamilyAttributedError(
        "univ3-swap",
        "self-test",
        new Error("edge-owned"),
      ),
      ["univ3-standard"],
    ),
    "univ3-standard",
  );
  assert.equal(
    normalizedFailureOwnerFamilyId(
      new BlockScanFamilyAttributedError(
        "univ2-standard",
        "self-test",
        new Error("sibling"),
      ),
      ["univ3-standard"],
    ),
    null,
  );
  assert.equal(
    normalizedFailureOwnerFamilyId(
      new Error("unattributed"),
      ["protocol:eigenpie"],
    ),
    null,
  );
}

async function buildPinnedRoute(
  state: AnvilStateBackend,
  fixture: AdapterReplayFixture,
): Promise<TokenEdge[]> {
  const edges: TokenEdge[] = [];
  for (const leg of fixture.route) {
    const familyId = familyForLeg(leg, fixture.id);
    try {
      const pool = materializeReplayPool(leg);
      const emitted = await PRODUCTION_ADAPTER_FAMILIES.routes().buildEdges(pool, state);
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
    } catch (error) {
      if (error instanceof BlockScanFamilyAttributedError) throw error;
      throw new BlockScanFamilyAttributedError(
        familyId,
        "family edge build",
        error,
      );
    }
  }
  return edges;
}

async function referenceExecutionSurfaces(
  state: AnvilStateBackend,
  fixture: AdapterReplayFixture,
  edges: readonly TokenEdge[],
  amounts: readonly bigint[],
  rawOutputs: readonly bigint[],
): Promise<readonly ReferenceExecutionSurface[]> {
  const surfaces: ReferenceExecutionSurface[] = [];
  for (let index = 0; index < edges.length; index++) {
    const leg = fixture.route[index];
    const familyId = familyForLeg(leg, fixture.id);
    try {
      const family = PRODUCTION_ADAPTER_FAMILIES.routes().forFamily(familyId);
      const fragment = await family.buildPlanFragment({
        edge: edges[index],
        amountIn: amounts[index],
        amountOut: amounts[index + 1],
        rawOut: rawOutputs[index],
        executor: DEFAULT_SEARCHER_EXECUTOR,
        state,
      });
      const matchingNodes: Array<(typeof fragment.nodes)[number]> = [];
      const visit = (nodes: typeof fragment.nodes): void => {
        for (const node of nodes) {
          if (node.adapterId === leg.edgeAdapterId) {
            matchingNodes.push(node);
          }
          visit(node.children);
        }
      };
      visit(fragment.nodes);
      if (matchingNodes.length !== 1) {
        throw new Error(
          `route leg ${leg.seq} plan contains ${matchingNodes.length} execution roots`,
        );
      }
      const node = matchingNodes[0];
      const action = getActionAdapter(leg.edgeAdapterId);
      const encoded = action.encode(
        node,
        DEFAULT_SEARCHER_EXECUTOR,
        new Uint8Array(),
      );
      const call = firstEncodedExternalCall(encoded);
      if (call.target !== node.target.toLowerCase()) {
        throw new Error(
          `route leg ${leg.seq} encoded target ${call.target} != plan target ${node.target}`,
        );
      }
      surfaces.push({
        adapterId: leg.edgeAdapterId,
        target: call.target,
        selector: call.selector,
      });
    } catch (error) {
      if (error instanceof BlockScanFamilyAttributedError) throw error;
      throw new BlockScanFamilyAttributedError(
        familyId,
        "reference execution target",
        error,
      );
    }
  }
  return surfaces;
}

function firstEncodedExternalCall(
  encoded: Uint8Array,
): { readonly target: string; readonly selector: string } {
  let cursor = 0;
  const requireBytes = (count: number): void => {
    if (cursor + count > encoded.length) {
      throw new Error("encoded action is truncated");
    }
  };
  const uint24At = (offset: number): number =>
    encoded[offset] * 0x1_0000 + encoded[offset + 1] * 0x100 + encoded[offset + 2];
  while (cursor < encoded.length) {
    const opcode = encoded[cursor];
    if (opcode === 0x00 || opcode === 0x01) {
      const headerLength = opcode === 0x00 ? 24 : 36;
      requireBytes(headerLength);
      const lengthOffset = cursor + (opcode === 0x00 ? 21 : 33);
      const payloadOffset = cursor + headerLength;
      const payloadLength = uint24At(lengthOffset);
      if (payloadLength < 4 || payloadOffset + payloadLength > encoded.length) {
        throw new Error("encoded external call lacks complete calldata");
      }
      return {
        target: ethers.hexlify(encoded.slice(cursor + 1, cursor + 21)).toLowerCase(),
        selector: ethers.hexlify(
          encoded.slice(payloadOffset, payloadOffset + 4),
        ).toLowerCase(),
      };
    }
    if (opcode === 0x02 || opcode === 0x06) {
      requireBytes(4);
      cursor += 4;
      continue;
    }
    if (opcode === 0x03) {
      requireBytes(4);
      const payloadLength = uint24At(cursor + 1);
      requireBytes(4 + payloadLength);
      cursor += 4 + payloadLength;
      continue;
    }
    if (opcode === 0x04 || opcode === 0x05 || opcode === 0x07) {
      cursor += 1;
      continue;
    }
    if (opcode === 0x08) {
      requireBytes(53);
      cursor += 53;
      continue;
    }
    throw new Error(`encoded action has unknown BotVM opcode 0x${opcode.toString(16)}`);
  }
  throw new Error("encoded action contains no external call");
}

function materializeReplayPool(
  leg: AdapterReplayLeg,
): PoolEntry {
  const pool: PoolEntry = { ...leg.pool };
  if (
    pool.fixedTokenIn !== undefined &&
    pool.fixedTokenOut !== undefined &&
    pool.fixedSlotKind !== undefined
  ) {
    const tokenIn = ethers.getAddress(leg.tokenIn);
    const tokenOut = ethers.getAddress(leg.tokenOut);
    if (
      ethers.getAddress(pool.fixedTokenIn) !== tokenIn ||
      ethers.getAddress(pool.fixedTokenOut) !== tokenOut
    ) {
      throw new Error(
        `route leg ${leg.seq} fixed token identity disagrees with trace route`,
      );
    }
    pool.verifiedRoutes = [{
      edgeAdapterId: leg.edgeAdapterId,
      tokenIn,
      tokenOut,
      slotKind: pool.fixedSlotKind,
      protocolAction: pool.fixedProtocolAction,
    }];
    return pool;
  }
  return pool;
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

function appendAdapterReplayEvidence(
  report: AdapterReplayReport,
  step: 3 | 4 | 5 | 6,
  status: SemanticSixStepStatus,
  output: Readonly<Record<string, unknown>>,
  reasonCode: string | null = null,
  extensions: Readonly<Record<string, unknown>> = {},
): void {
  if (report.sixStepEvidence.length + 1 !== step) {
    throw new Error(
      `adapter replay six-step evidence is out of order at step ${step}`,
    );
  }
  const jsonObject = (
    value: Readonly<Record<string, unknown>>,
  ): Readonly<Record<string, SemanticJson>> =>
    JSON.parse(JSON.stringify(
      value,
      (_key, item) => typeof item === "bigint" ? item.toString() : item,
    )) as Record<string, SemanticJson>;
  report.sixStepEvidence.push(createSemanticSixStepEvidence({
    profile: "family_execution",
    step,
    status,
    output: jsonObject(output),
    reasonCode,
    extensions: jsonObject(extensions),
  }));
}

async function replayFixture(
  path: string,
  rpcUrl: string,
  adapterCommit: string | null,
  baseCommit: string | null,
  artifactRoot?: string,
): Promise<AdapterReplayReport> {
  const fixture = loadFixture(path, artifactRoot);
  const fixtureRelative = safeRelativeFixture(path, artifactRoot);
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
    anchorReconstruction: null,
    baseCommit,
    adapterCommit,
    familySourceSha256: familyContractSha256(fixture.executionFamilyId),
    sharedApiSha256: hashFiles(SHARED_API_FILES),
    runtimeSourceSha256: hashRuntimeSources(),
    harnessSha256: hashFiles(HARNESS_SOURCE_FILES),
    botVmArtifactSha256: sha256(readFileSync(BOTVM_ARTIFACT_PATH)),
    executorRuntimeCodeHash: null,
    replayCommand: `npm run searcher:adapter-family-replay -- --fixture ${fixtureRelative}`,
    maxFlashAmount: null,
    solverSelectedAmount: null,
    finalSim: null,
    conservation: null,
    productionEv: null,
    evPolicy: {
      profitHaircutBps: ADAPTER_REPLAY_EV_POLICY.profitHaircutBps,
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
    sixStepEvidence: [
      createSemanticSixStepEvidence({
        profile: "family_execution",
        step: 1,
        status: "bypassed",
        output: {
          mode: "route_pinned",
          execution_family_id: fixture.executionFamilyId,
          state_anchor: {
            kind: fixture.stateAnchor.kind,
            block_number: fixture.stateAnchor.blockNumber,
            trigger_tx_hash: fixture.stateAnchor.kind === "after-transaction"
              ? fixture.stateAnchor.triggerTxHash.toLowerCase()
              : null,
          },
        },
        reasonCode: "adapter_replay_bypasses_discovery",
      }),
      createSemanticSixStepEvidence({
        profile: "family_execution",
        step: 2,
        status: "bypassed",
        output: {
          mode: "route_pinned",
          fixture_route_sha256: sha256(JSON.stringify(fixture.route)),
          route_leg_count: fixture.route.length,
        },
        reasonCode: "adapter_replay_uses_trace_route",
      }),
    ],
    verdict: "implemented_not_validated",
    failureOwnerFamilyId: null,
    failure: null,
  };

  const upstream = new ethers.JsonRpcProvider(rpcUrl);
  try {
    const winner = await validateChainAnchor(upstream, fixture);
    const senderPrefix = await anchorState(
      state,
      upstream,
      fixture,
      Number(winner.index),
    );
    const verifiedAnchor = await validateLocalStateAnchor(
      state.provider,
      upstream,
      fixture.stateAnchor,
      senderPrefix,
    );
    report.anchorReconstruction = verifiedAnchor;
    if (verifiedAnchor?.kind === "canonical-parent-block") {
      report.anchorBlockHash = verifiedAnchor.blockHash;
      report.anchorStateRoot = verifiedAnchor.stateRoot;
    }
    report.stages.chainAnchor = true;

    const edges = await buildPinnedRoute(state, fixture);
    assertClosedRoute(edges, fixture.flash.token);
    report.routeHash = routeHash(edges);
    report.stages.familyEdges = true;
    const referenceSwapImpactHash = await validateReferenceSwapImpacts(upstream, fixture, edges);

    const flashFamily = PRODUCTION_ADAPTER_FAMILIES.findFundingByAction(
      fixture.flash.adapterId,
    )!;
    const maxInput = await state.getTokenBalance(
      fixture.flash.token,
      flashFamily.funding.liquidityHolder,
    );
    const sizing = fullDomainSearch(maxInput);
    report.maxFlashAmount = maxInput.toString();

    const probe = await propagateAmountsWithRawOutputs(
      { edges },
      sizing.searchCenter,
      state,
      {
        executor: DEFAULT_SEARCHER_EXECUTOR,
        safetyBps: 10_000n,
      },
    );
    const executionSurfaces = await referenceExecutionSurfaces(
      state,
      fixture,
      edges,
      probe.amounts,
      probe.rawOutputs,
    );
    const referenceTraceHash = await validateReferenceRoute(
      upstream,
      fixture,
      executionSurfaces,
    );
    report.referenceRouteHash = sha256(`${referenceTraceHash}:${referenceSwapImpactHash}`);
    report.stages.referenceRoute = true;
    appendAdapterReplayEvidence(report, 3, "pass", {
      source_block: fixture.stateAnchor.blockNumber,
      route_sha256: report.routeHash,
      quote_status: "available",
      probe_amount_in: sizing.searchCenter.toString(),
      quoted_amount_out: probe.amounts.at(-1)!.toString(),
      leg_quotes: edges.map((edge, index) => ({
        adapter_id: edge.adapterId,
        target: edge.target.toLowerCase(),
        token_in: edge.tokenIn.toLowerCase(),
        token_out: edge.tokenOut.toLowerCase(),
        amount_in: probe.amounts[index].toString(),
        raw_amount_out: probe.rawOutputs[index].toString(),
        amount_out: probe.amounts[index + 1].toString(),
      })),
    });

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
    // Use the production local-math path for UniV3-compatible pools such as
    // Pancake V3, whose execution semantics match but whose Quoter may not.
    const cache = new PoolStateCache(upstream);
    cache.setTickBlock(fixture.stateAnchor.blockNumber);
    const solved = await solver.solve(plans[0], state, simulator, {
      finalSimTopN: 5,
      gssMaxTries: 16,
      gridHalfWidth: sizing.gridHalfWidth,
      quoteProfitFloorBps: 0n,
      quoteSafetyBps: 9_999n,
      cache,
    });
    report.solverSelectedAmount = solved.flashAmount.toString();
    report.stages.solver = true;
    const solvedAmounts = await propagateAmountsWithRawOutputs(
      plans[0].tokenPath,
      solved.flashAmount,
      state,
      {
        executor: DEFAULT_SEARCHER_EXECUTOR,
        safetyBps: 10_000n,
      },
    );
    const resolvedCalldata = buildExecuteCalldata(
      compilePlan(solved.root, DEFAULT_SEARCHER_EXECUTOR),
    );
    appendAdapterReplayEvidence(report, 4, "pass", {
      route_sha256: report.routeHash,
      template_name: solved.templateName,
      solver_selected_amount: solved.flashAmount.toString(),
      resolved_plan_sha256: sha256(resolvedCalldata.toLowerCase()),
      selected_by_solve_policy: true,
      solve_succeeded: true,
      hop_amounts: edges.map((edge, index) => ({
        adapter_id: edge.adapterId,
        target: edge.target.toLowerCase(),
        token_in: edge.tokenIn.toLowerCase(),
        token_out: edge.tokenOut.toLowerCase(),
        amount_in: solvedAmounts.amounts[index].toString(),
        raw_amount_out: solvedAmounts.rawOutputs[index].toString(),
        amount_out: solvedAmounts.amounts[index + 1].toString(),
      })),
    });

    const sim = await simulator.simulate(solved);
    report.finalSim = {
      success: sim.success,
      grossProfit: sim.grossProfit.toString(),
      gasUsed: sim.gasUsed.toString(),
      calldataHash: sha256(sim.calldata.toLowerCase()),
      revertReason: sim.revertReason ?? null,
    };
    if (!sim.success || sim.grossProfit <= 0n) {
      appendAdapterReplayEvidence(report, 5, "fail", {
        success: sim.success,
        profit_token: sim.profitToken.toLowerCase(),
        gross_profit: sim.grossProfit.toString(),
        net_profit: sim.netProfit.toString(),
        gas_used: sim.gasUsed.toString(),
        calldata_sha256: sha256(sim.calldata.toLowerCase()),
      }, "final_sim_revert", {
        revert_reason: sim.revertReason ?? null,
      });
      throw new Error(`fork final sim failed: ${sim.revertReason ?? "non-positive gross profit"}`);
    }
    report.stages.finalSim = true;

    report.conservation = await proveConservation(
      state,
      solved,
      edges,
      flashFamily.funding.liquidityHolder,
      sim.calldata,
    );
    if (report.conservation.grossProfit !== sim.grossProfit.toString() ||
        report.conservation.gasUsed !== sim.gasUsed.toString()) {
      throw new Error("conservation replay differs from production final sim");
    }
    report.stages.repaymentAndConservation = true;
    appendAdapterReplayEvidence(report, 5, "pass", {
      success: true,
      profit_token: sim.profitToken.toLowerCase(),
      gross_profit: sim.grossProfit.toString(),
      net_profit: sim.netProfit.toString(),
      gas_used: sim.gasUsed.toString(),
      calldata_sha256: sha256(sim.calldata.toLowerCase()),
      repayment_and_conservation: "pass",
      leaves_standing_position: false,
    });

    const decisionParentBlock = fixture.lane === "backrun"
      ? fixture.stateAnchor.blockNumber - 1
      : fixture.stateAnchor.blockNumber;
    const ev = await evaluateEv(
      upstream,
      sim.profitToken,
      sim.netProfit,
      sim.gasUsed,
      ADAPTER_REPLAY_EV_POLICY,
      createProfitTokenValuation(),
      decisionParentBlock,
    );
    const targetHeader = await upstream.getBlock(Number(winner.blockNumber));
    if (
      ev.feeStateAvailable &&
      targetHeader?.baseFeePerGas !== ev.maxBaseFeePerGas
    ) {
      throw new Error(
        `production EV fee anchor mismatch parent=${decisionParentBlock} ` +
        `target=${winner.blockNumber} predicted=${ev.maxBaseFeePerGas} ` +
        `actual=${targetHeader?.baseFeePerGas ?? "missing"}`,
      );
    }
    report.productionEv = {
      valuationAvailable: ev.valuationAvailable,
      gasMeasurementAvailable: ev.gasMeasurementAvailable,
      feeStateAvailable: ev.feeStateAvailable,
      sourceBlockHash: ev.sourceBlockHash,
      decisionParentBlock,
      targetBlock: Number(winner.blockNumber),
      ethUsd: ev.ethUsd,
      ethUsdRoundId: ev.ethUsdRoundId?.toString() ?? null,
      ethUsdUpdatedAt: ev.ethUsdUpdatedAt?.toString() ?? null,
      netEvWei: ev.netEvWei.toString(),
      expectedProfitEth: ev.expectedProfitEth.toString(),
      maxBaseFeePerGas: ev.maxBaseFeePerGas.toString(),
      gasCostEth: ev.gasCostEth.toString(),
      bidEth: ev.bidEth.toString(),
    };
    const evPasses = ev.valuationAvailable &&
      ev.gasMeasurementAvailable &&
      ev.feeStateAvailable &&
      ev.netEvWei > ADAPTER_REPLAY_EV_POLICY.minNetEth;
    appendAdapterReplayEvidence(
      report,
      6,
      evPasses ? "pass" : "reject",
      {
        decision: evPasses ? "allow" : "reject",
        valuation_available: ev.valuationAvailable,
        gas_measurement_available: ev.gasMeasurementAvailable,
        fee_state_available: ev.feeStateAvailable,
        source_block_hash: ev.sourceBlockHash,
        decision_parent_block: decisionParentBlock,
        target_block: Number(winner.blockNumber),
        eth_usd: ev.ethUsd,
        eth_usd_round_id: ev.ethUsdRoundId?.toString() ?? null,
        eth_usd_updated_at: ev.ethUsdUpdatedAt?.toString() ?? null,
        net_ev_wei: ev.netEvWei.toString(),
        expected_profit_eth: ev.expectedProfitEth.toString(),
        max_base_fee_per_gas: ev.maxBaseFeePerGas.toString(),
        gas_cost_eth: ev.gasCostEth.toString(),
        bid_eth: ev.bidEth.toString(),
      },
      evPasses ? null : "production_ev_rejected",
    );
    if (!ev.valuationAvailable) throw new Error(`production EV cannot value ${sim.profitToken}`);
    if (!ev.gasMeasurementAvailable) throw new Error("production EV missing measured gas");
    if (!ev.feeStateAvailable) {
      throw new Error(`production EV missing fee state at ${fixture.stateAnchor.blockNumber}`);
    }
    if (ev.netEvWei <= ADAPTER_REPLAY_EV_POLICY.minNetEth) {
      throw new Error(
        `production EV decision rejected: net=${ev.netEvWei} min=${ADAPTER_REPLAY_EV_POLICY.minNetEth}`,
      );
    }
    report.stages.productionEvPositive = true;
    report.verdict = "adapter_replay_pass";
  } catch (error) {
    report.failureOwnerFamilyId = normalizedFailureOwnerFamilyId(
      error,
      report.routeExecutionFamilies,
    );
    report.failure = redactError(error, rpcUrl);
    const lastEvidence = report.sixStepEvidence.at(-1);
    if (
      report.sixStepEvidence.length < 6 &&
      (lastEvidence?.status === "pass" || lastEvidence?.status === "bypassed")
    ) {
      const nextStep = (report.sixStepEvidence.length + 1) as 3 | 4 | 5 | 6;
      appendAdapterReplayEvidence(
        report,
        nextStep,
        "fail",
        { completed: false },
        "adapter_replay_execution_error",
        { error: report.failure },
      );
    }
  } finally {
    state.stop();
    upstream.destroy();
  }
  return report;
}

async function main(): Promise<void> {
  const args = parseArgs();
  if (args.probeFamily) {
    const registered = PRODUCTION_ADAPTER_FAMILIES.routes().list()
      .some((adapter) => adapter.id === args.probeFamily);
    console.log(`ADAPTER_FAMILY_REGISTRY_PROBE=${JSON.stringify({
      schemaVersion: 1,
      executionFamilyId: args.probeFamily,
      registered,
    })}`);
    return;
  }
  const fixtures = args.fixtures.map((path) => ({
    path,
    fixture: loadFixture(path, args.artifactRoot),
  }));
  const duplicateIds = fixtures
    .map(({ fixture }) => fixture.id)
    .filter((id, index, all) => all.indexOf(id) !== index);
  if (duplicateIds.length > 0) throw new Error(`duplicate fixture id(s): ${[...new Set(duplicateIds)].join(",")}`);
  if (args.validateOnly) {
    runReferenceMatcherSelfTests();
    console.log("adapter-family reference matcher regressions: PASS");
    for (const { path, fixture } of fixtures) {
      console.log(
        `adapter-family-fixture PASS id=${fixture.id} family=${fixture.executionFamilyId} ` +
          `path=${safeRelativeFixture(path, args.artifactRoot)}`,
      );
    }
    printFamilyCoverage(fixtures.map(({ fixture }) => fixture));
    return;
  }
  if (args.useExistingBotVmArtifact) {
    if (!existsSync(BOTVM_ARTIFACT_PATH)) {
      throw new Error("--use-existing-botvm-artifact requires the trusted BotVM artifact");
    }
  } else {
    await ensureBotVmArtifact();
  }
  const [commit, baseCommit, worktreeStatus] = await Promise.all([
    gitRequired(["rev-parse", "HEAD"]),
    gitRequired(["merge-base", "origin/main", "HEAD"]),
    gitRequired(["status", "--porcelain=v1", "--untracked-files=all"]),
  ]);
  if (worktreeStatus) throw new Error("adapter-family replay requires a clean committed worktree");
  const reports: AdapterReplayReport[] = [];
  for (const { path } of fixtures) {
    const report = await replayFixture(
      path,
      args.rpcUrl,
      commit,
      baseCommit,
      args.artifactRoot,
    );
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
  const coverage = PRODUCTION_ADAPTER_FAMILIES.routes().list().map((adapter) => {
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

function familyContractSha256(executionFamilyId: ExecutionFamilyId): string {
  const family = PRODUCTION_ADAPTER_FAMILIES.forFamily(executionFamilyId);
  const route = "poolAdapters" in family
    ? {
        poolAdapters: [...family.poolAdapters].sort(),
        edgeAdapterIds: [...family.edgeAdapterIds].sort(),
        allowedTaxonomy: family.allowedTaxonomy
          .map((entry) => JSON.stringify([
            entry.slotKind,
            entry.protocolAction ?? null,
          ]))
          .sort(),
        identityPolicies: family.identityPolicies
          .map((entry) => JSON.stringify({
            poolAdapter: entry.poolAdapter,
            policy: entry.policy,
            registeredVenueIds: [...(entry.registeredVenueIds ?? [])].sort(),
            registeredIdentitySources: [
              ...(entry.registeredIdentitySources ?? []),
            ].sort(),
            canonicalAddress:
              "canonicalAddress" in entry
                ? entry.canonicalAddress?.toLowerCase() ?? null
                : null,
          }))
          .sort(),
        requiresProtocolEdgesFlag: family.requiresProtocolEdgesFlag,
        livePoolState: family.livePoolState?.kind ?? null,
        hasPreparedQuote: family.prepared?.quote !== null,
        hasDiscovery: family.discovery !== undefined,
        discovery: family.discovery
          ? {
              candidateSources: [...family.discovery.candidateSources].sort(),
              eventTopics: [...family.discovery.eventTopics]
                .map((topic) => topic.toLowerCase())
                .sort(),
              callSelectors: [...family.discovery.callSelectors]
                .map((selector) => selector.toLowerCase())
                .sort(),
              addressMatcherVersion:
                family.discovery.addressMatcherVersion ?? null,
              observedMatcherVersion:
                family.discovery.observedMatcherVersion ?? null,
            }
          : null,
        declaredVenues:
          "declaredVenues" in family
            ? family.declaredVenues
              .map((venue) => JSON.stringify([
                venue.adapter,
                venue.address.toLowerCase(),
                venue.poolId?.toLowerCase() ?? null,
                venue.logicalInstanceId ?? null,
                venue.fixedTokenIn?.toLowerCase() ?? null,
                venue.fixedTokenOut?.toLowerCase() ?? null,
              ]))
              .sort()
            : [],
        matureDexUniverseDiscovery:
          "matureDexUniverseDiscovery" in family
            ? family.matureDexUniverseDiscovery === true
            : false,
      }
    : null;
  const funding = "funding" in family
    ? {
        familyId: family.funding.familyId,
        actionAdapterId: family.funding.actionAdapterId,
        lineage: family.funding.lineage,
        target: family.funding.target.toLowerCase(),
        liquidityHolder: family.funding.liquidityHolder.toLowerCase(),
        repayment: family.funding.repayment,
        paramShape: family.funding.paramShape,
        planningPriority: family.funding.planningPriority,
        liquidityPriority: family.funding.liquidityPriority,
      }
    : null;
  return sha256(JSON.stringify({
    id: family.id,
    kind: family.kind,
    ownedActionAdapterIds: [...family.ownedActionAdapterIds].sort(),
    requiredInfraActionAdapterIds:
      [...family.requiredInfraActionAdapterIds].sort(),
    route,
    funding,
  }));
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

function safeRelativeFixture(path: string, artifactRoot?: string): string {
  if (artifactRoot) {
    const value = relative(artifactRoot, path).replaceAll("\\", "/");
    return safeArtifactRelativePath(value, "fixture");
  }
  const value = relative(LISTENER_ROOT, path).replaceAll("\\", "/");
  if (!value || value === ".." || value.startsWith("../")) {
    throw new Error("fixture must live under listener/");
  }
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

function safeArtifactRelativePath(value: string, field: string): string {
  const normalized = value.replaceAll("\\", "/");
  if (
    !normalized.startsWith("docs/research/reports/") ||
    normalized.startsWith("/") ||
    normalized.split("/").some((segment) =>
      !segment || segment === "." || segment === ".."
    )
  ) {
    throw new Error(`${field} must stay under docs/research/reports`);
  }
  return normalized;
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
