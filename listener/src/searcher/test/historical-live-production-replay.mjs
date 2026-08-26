import { createHash, randomBytes } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createInterface } from "node:readline";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Wallet } from "ethers";

/**
 * Target-blind historical replay of the real production entry.
 *
 * This file never enumerates, quotes, plans or simulates a route itself. The
 * trusted outer process only materializes a canonical parent/source state (or
 * an ordered full block prefix), starts src/searcher/main.ts, and freezes the
 * production pass before any expected route is inspected by a verifier.
 */
const repo = realpathSync(
  process.env.HISTORICAL_REPLAY_LISTENER_ROOT ?? process.cwd(),
);
const baseNumber = Number(process.env.BLIND_BASE_NUMBER);
const sourceNumber = Number(process.env.BLIND_SOURCE_NUMBER);
const runDir = process.env.BLIND_RUN_DIR;
const checkpointSource = process.env.BLIND_CHECKPOINT_SOURCE;
const poolUniverseSource = process.env.BLIND_POOL_UNIVERSE_SOURCE;
const productionCommit = process.env.BLIND_PRODUCTION_COMMIT;
const checkpointRunId = process.env.BLIND_CHECKPOINT_RUN_ID ??
  `historical-live-${baseNumber}-${sourceNumber}`;
const upstreamRpc = process.env.BLIND_UPSTREAM_RPC ?? "http://127.0.0.1:8545";
const upstreamKind = process.env.BLIND_UPSTREAM_KIND ?? "local-reth";
const declaredUpstreamPid = Number(process.env.BLIND_UPSTREAM_PID ?? "0");
const prefixThroughIndex = process.env.BLIND_PREFIX_THROUGH_INDEX === undefined
  ? null
  : Number(process.env.BLIND_PREFIX_THROUGH_INDEX);
const prefixTriggerIndex = process.env.BLIND_PREFIX_TRIGGER_INDEX === undefined
  ? null
  : Number(process.env.BLIND_PREFIX_TRIGGER_INDEX);
const prefixAnvilPort = Number(process.env.BLIND_PREFIX_ANVIL_PORT ?? "8580");
const timeoutMs = Number(process.env.BLIND_TIMEOUT_MS ?? "3600000");
const prepareMaxAttempts = Number(
  process.env.BLIND_PREPARE_MAX_ATTEMPTS ?? "5",
);
const prepareBudgetMs = Number(
  process.env.BLIND_PREPARE_BUDGET_MS ?? "600000",
);
const issuerKeyPath = process.env.BLIND_BACKEND_ISSUER_KEY_PATH ??
  "/root/.mev-historical-gap-hmac-v1";
const anvilBin = process.env.BLIND_ANVIL_BIN ?? "/usr/local/bin/anvil";

if (
  !Number.isSafeInteger(baseNumber) ||
  baseNumber < 0 ||
  !Number.isSafeInteger(sourceNumber) ||
  sourceNumber !== baseNumber + 1 ||
  !runDir ||
  !isAbsolute(runDir) ||
  !/^[0-9a-f]{40}$/.test(productionCommit ?? "") ||
  !["local-reth", "local-snapshot"].includes(upstreamKind) ||
  !Number.isSafeInteger(timeoutMs) ||
  timeoutMs <= 0 ||
  !Number.isSafeInteger(prepareMaxAttempts) ||
  prepareMaxAttempts < 1 ||
  prepareMaxAttempts > 10 ||
  !Number.isSafeInteger(prepareBudgetMs) ||
  prepareBudgetMs < 1_000 ||
  prepareBudgetMs > timeoutMs ||
  (prefixThroughIndex !== null && (
    !Number.isSafeInteger(prefixThroughIndex) ||
    prefixThroughIndex < 0 ||
    !Number.isSafeInteger(prefixTriggerIndex) ||
    prefixTriggerIndex < 0 ||
    prefixThroughIndex < prefixTriggerIndex ||
    !Number.isSafeInteger(prefixAnvilPort) ||
    prefixAnvilPort <= 0 ||
    prefixAnvilPort > 65535
  ))
) {
  throw new Error("invalid historical live production replay environment");
}
if (process.env.BLIND_CHECKPOINT_CUTOFF !== undefined) {
  throw new Error(
    "BLIND_CHECKPOINT_CUTOFF is retired; discovery cutoff is always base",
  );
}
if (existsSync(runDir)) throw new Error(`run directory already exists: ${runDir}`);
if (checkpointSource !== undefined && !isAbsolute(checkpointSource)) {
  throw new Error("checkpoint source must be absolute");
}
if (poolUniverseSource !== undefined && !isAbsolute(poolUniverseSource)) {
  throw new Error("pool universe source must be absolute");
}
if (prefixThroughIndex === null && prefixTriggerIndex !== null) {
  throw new Error("prefix trigger requires a full-prefix source");
}
const checkedOutCommit = execFileSync(
  "git",
  ["rev-parse", "HEAD"],
  { cwd: resolve(repo, ".."), encoding: "utf8" },
).trim();
if (checkedOutCommit !== productionCommit) {
  throw new Error(
    `production commit mismatch expected=${productionCommit} actual=${checkedOutCommit}`,
  );
}
const trackedWorktreeChanges = execFileSync(
  "git",
  ["status", "--porcelain", "--untracked-files=no"],
  { cwd: resolve(repo, ".."), encoding: "utf8" },
).trim();
if (trackedWorktreeChanges !== "") {
  throw new Error("historical production replay requires a clean exact checkout");
}

const controllerModule = await import(pathToFileURL(resolve(
  repo,
  "src/searcher/test/adapter-family-blind-backend-controller.ts",
)).href);
const artifactModule = await import(pathToFileURL(resolve(
  repo,
  "src/searcher/test/adapter-family-blind-artifacts.ts",
)).href);
const rawModule = await import(pathToFileURL(resolve(
  repo,
  "src/searcher/test/adapter-family-blind-production-raw.ts",
)).href);
const runnerModule = await import(pathToFileURL(resolve(
  repo,
  "src/searcher/test/adapter-family-blind-runner.ts",
)).href);
const auditModule = await import(pathToFileURL(resolve(
  repo,
  "src/searcher/blind-production-audit.ts",
)).href);
const checkpointModule = await import(pathToFileURL(resolve(
  repo,
  "src/searcher/universe-rebuild-checkpoint.ts",
)).href);
const replayContractModule = await import(pathToFileURL(resolve(
  repo,
  "src/searcher/test/historical-live-production-replay-contract.ts",
)).href);
const botVmModule = await import(pathToFileURL(resolve(
  repo,
  "src/shared/executor/botvm-executor.ts",
)).href);

const {
  BlindBackendController,
  loadBackendAttestation,
} = controllerModule;
const {
  fileSha256,
  generateBlindBackendAttestation,
} = artifactModule;
const {
  validateBackendEvidence,
  validateBackendRevealReadyEvidence,
  validateProductionPassRecordForFreeze,
  validateProductionReadyRecord,
} = rawModule;
const { reserveBlindProducerRuntimePorts } = runnerModule;
const { UniverseRebuildCheckpointStore } = checkpointModule;
const {
  HISTORICAL_LIVE_PRODUCTION_ENTRY,
  assertTargetBlindReplayEnvironment,
  forwardedProductionEnvironment,
  historicalCheckpointEvidence,
  historicalPoolUniverseEvidence,
  runBoundedHistoricalPrepare,
} = replayContractModule;
const { forkBotVmRuntimeReceipt } = botVmModule;
const {
  BLIND_PRODUCTION_CONTROL_FAILURE_PREFIX,
  BLIND_PRODUCTION_CONTROL_PREFIX,
  BLIND_PRODUCTION_RAW_PREFIX,
  BLIND_PRODUCTION_RAW_PROFILE,
  BLIND_PRODUCTION_READY_PREFIX,
  blindProductionAuditHash,
  blindProductionCanonicalJson,
  validateBlindProductionControlFailureRecord,
} = auditModule;

assertTargetBlindReplayEnvironment(process.env);
mkdirSync(runDir, { recursive: false, mode: 0o700 });
chmodSync(runDir, 0o700);
const checkpointPath = resolve(runDir, "universe-checkpoint.json");
let checkpointEvidence = null;
if (checkpointSource !== undefined) {
  const sourceStore = new UniverseRebuildCheckpointStore({
    path: checkpointSource,
  });
  const sourceBefore = await sourceStore.load();
  if (sourceBefore === null) {
    throw new Error("checkpoint source is empty");
  }
  const beforeEvidence = historicalCheckpointEvidence(
    sourceBefore,
    baseNumber,
  );
  copyFileSync(checkpointSource, checkpointPath);
  chmodSync(checkpointPath, 0o600);
  const sourceJournal = `${checkpointSource}.attestation-journal`;
  const destinationJournal = `${checkpointPath}.attestation-journal`;
  const journalCopied = existsSync(sourceJournal);
  if (journalCopied) {
    copyFileSync(sourceJournal, destinationJournal);
    chmodSync(destinationJournal, 0o600);
  }
  const sourceAfter = await sourceStore.load();
  if (
    sourceAfter === null ||
    sourceAfter.checkpointFingerprint !== beforeEvidence.checkpointFingerprint
  ) {
    throw new Error("checkpoint source changed while it was copied");
  }
  const destinationStore = new UniverseRebuildCheckpointStore({
    path: checkpointPath,
  });
  const destination = await destinationStore.load();
  if (
    destination === null ||
    destination.checkpointFingerprint !== sourceAfter.checkpointFingerprint
  ) {
    throw new Error("copied checkpoint fingerprint mismatch");
  }
  checkpointEvidence = Object.freeze({
    ...historicalCheckpointEvidence(destination, baseNumber),
    sourceFingerprint: sourceAfter.checkpointFingerprint,
    destinationFingerprint: destination.checkpointFingerprint,
    journalCopied,
    journalBytes: journalCopied ? statSync(destinationJournal).size : 0,
  });
}

const poolUniversePath = resolve(runDir, "pool-universe.json");
let poolUniverseEvidence;
if (poolUniverseSource === undefined) {
  writeFileSync(
    poolUniversePath,
    `${JSON.stringify({
      schemaVersion: 2,
      fromBlock: Math.max(0, baseNumber - 14_399),
      toBlock: baseNumber,
      registry: { sourceFingerprints: [] },
      pools: [],
    })}\n`,
    { mode: 0o600 },
  );
  poolUniverseEvidence = Object.freeze({
    mode: "fresh-two-day-discovery",
    fromBlock: Math.max(0, baseNumber - 14_399),
    toBlock: baseNumber,
    manifestSha256: null,
    contentSha256: fileSha256(poolUniversePath),
  });
} else {
  const sourceEvidence = historicalPoolUniverseEvidence(
    poolUniverseSource,
    baseNumber,
  );
  copyFileSync(poolUniverseSource, poolUniversePath);
  chmodSync(poolUniversePath, 0o600);
  const sourceManifest = `${poolUniverseSource}.manifest.json`;
  const destinationManifest = `${poolUniversePath}.manifest.json`;
  copyFileSync(sourceManifest, destinationManifest);
  chmodSync(destinationManifest, 0o600);
  const destinationEvidence = historicalPoolUniverseEvidence(
    poolUniversePath,
    baseNumber,
  );
  if (
    sourceEvidence.contentSha256 !== destinationEvidence.contentSha256 ||
    sourceEvidence.manifestSha256 !== destinationEvidence.manifestSha256
  ) {
    throw new Error("copied pool universe fingerprint mismatch");
  }
  poolUniverseEvidence = Object.freeze({
    mode: "manifested-historical-snapshot",
    fromBlock: destinationEvidence.fromBlock,
    toBlock: destinationEvidence.toBlock,
    source: destinationEvidence.source,
    manifestSha256: destinationEvidence.manifestSha256,
    contentSha256: destinationEvidence.contentSha256,
  });
}
const emptyListPath = resolve(runDir, "empty-list.json");
writeFileSync(emptyListPath, "[]\n", { mode: 0o600 });
async function rpcOn(url, method, params) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`upstream RPC HTTP ${response.status}`);
  const body = await response.json();
  if (body.error || !body.result) {
    throw new Error(`upstream RPC ${method} failed: ${JSON.stringify(body.error)}`);
  }
  return body.result;
}

async function blockAnchor(url, number) {
  const block = await rpcOn(url, "eth_getBlockByNumber", [
    `0x${number.toString(16)}`,
    false,
  ]);
  const actual = Number.parseInt(block.number, 16);
  if (actual !== number || !block.hash || !block.stateRoot) {
    throw new Error(`invalid canonical block anchor ${number}`);
  }
  return Object.freeze({
    number,
    hash: String(block.hash).toLowerCase(),
    stateRoot: String(block.stateRoot).toLowerCase(),
  });
}

if (poolUniverseEvidence.mode === "manifested-historical-snapshot") {
  const manifestAnchor = await blockAnchor(
    upstreamRpc,
    poolUniverseEvidence.source.number,
  );
  if (
    manifestAnchor.hash !== poolUniverseEvidence.source.hash ||
    manifestAnchor.stateRoot !== poolUniverseEvidence.source.stateRoot
  ) {
    throw new Error("historical pool universe manifest anchor mismatch");
  }
}

async function post(url, value) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: blindProductionCanonicalJson(value),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`blind controller HTTP ${response.status}: ${text.slice(0, 1000)}`);
  }
  return JSON.parse(text);
}

function listenerPid(url) {
  return Number(execFileSync(
    "/usr/bin/lsof",
    ["-t", `-iTCP:${new URL(url).port || "80"}`, "-sTCP:LISTEN"],
    { encoding: "utf8" },
  ).trim().split(/\s+/)[0]);
}

function receiptSemantics(receipt) {
  return Object.freeze({
    transactionHash: String(receipt.transactionHash).toLowerCase(),
    transactionIndex: Number.parseInt(receipt.transactionIndex, 16),
    status: String(receipt.status).toLowerCase(),
    gasUsed: BigInt(receipt.gasUsed).toString(),
    cumulativeGasUsed: BigInt(receipt.cumulativeGasUsed).toString(),
    contractAddress: receipt.contractAddress === null
      ? null
      : String(receipt.contractAddress).toLowerCase(),
    logs: receipt.logs.map((log) => Object.freeze({
      address: String(log.address).toLowerCase(),
      topics: log.topics.map((topic) => String(topic).toLowerCase()),
      data: String(log.data).toLowerCase(),
      logIndex: Number.parseInt(log.logIndex, 16),
    })),
  });
}

let prefixState = null;
let prefixEvidence = null;
process.once("exit", () => prefixState?.stop());
let controllerUpstreamRpc = upstreamRpc;
let controllerUpstreamKind = upstreamKind;
let controllerUpstreamPid = declaredUpstreamPid > 0
  ? declaredUpstreamPid
  : listenerPid(upstreamRpc);
let base;
let source;
if (prefixThroughIndex === null) {
  [base, source] = await Promise.all([
    blockAnchor(upstreamRpc, baseNumber),
    blockAnchor(upstreamRpc, sourceNumber),
  ]);
} else {
  const canonicalBase = await blockAnchor(upstreamRpc, baseNumber);
  const canonicalBlock = await rpcOn(upstreamRpc, "eth_getBlockByNumber", [
    `0x${sourceNumber.toString(16)}`,
    true,
  ]);
  const transactions = Array.isArray(canonicalBlock.transactions)
    ? canonicalBlock.transactions
    : [];
  if (
    Number.parseInt(canonicalBlock.number, 16) !== sourceNumber ||
    prefixThroughIndex >= transactions.length
  ) {
    throw new Error("canonical prefix block is incomplete");
  }
  const stateModule = await import(pathToFileURL(resolve(
    repo,
    "src/shared/state/state-backend.ts",
  )).href);
  const snapshotRpc = `http://127.0.0.1:${prefixAnvilPort}`;
  prefixState = new stateModule.AnvilStateBackend(
    upstreamRpc,
    snapshotRpc,
    prefixAnvilPort,
  );
  const queued = await prefixState.queueHistoricalBlockPrefix(
    sourceNumber,
    prefixThroughIndex,
  );
  const optionalContextCalls = [
    ["anvil_setCoinbase", [canonicalBlock.miner]],
    ["anvil_setPrevRandao", [canonicalBlock.mixHash]],
    ["evm_setBlockGasLimit", [canonicalBlock.gasLimit]],
  ];
  const contextApplied = [];
  for (const [method, params] of optionalContextCalls) {
    try {
      await prefixState.provider.send(method, params);
      contextApplied.push(method);
    } catch {
      // Receipt equivalence below remains the fail-closed semantic check.
    }
  }
  await prefixState.provider.send("anvil_mine", ["0x1"]);
  const [canonicalReceipts, localReceipts] = await Promise.all([
    rpcOn(upstreamRpc, "eth_getBlockReceipts", [
      `0x${sourceNumber.toString(16)}`,
    ]),
    rpcOn(snapshotRpc, "eth_getBlockReceipts", [
      `0x${sourceNumber.toString(16)}`,
    ]),
  ]);
  if (
    !Array.isArray(canonicalReceipts) ||
    !Array.isArray(localReceipts) ||
    localReceipts.length !== prefixThroughIndex + 1
  ) {
    throw new Error("full-prefix replay receipt cardinality mismatch");
  }
  const expectedHashes = transactions
    .slice(0, prefixThroughIndex + 1)
    .map((transaction) => String(transaction.hash).toLowerCase());
  if (
    queued.length !== expectedHashes.length ||
    queued.some((hash, index) => hash.toLowerCase() !== expectedHashes[index])
  ) {
    throw new Error("full-prefix replay transaction ordering mismatch");
  }
  const receiptEvidence = expectedHashes.map((hash, index) => {
    const canonical = receiptSemantics(canonicalReceipts[index]);
    const local = receiptSemantics(localReceipts[index]);
    if (
      canonical.transactionHash !== hash ||
      local.transactionHash !== hash ||
      blindProductionCanonicalJson(canonical) !==
        blindProductionCanonicalJson(local)
    ) {
      throw new Error(`full-prefix receipt mismatch at index ${index}`);
    }
    return Object.freeze({
      index,
      hash,
      status: canonical.status,
      gasUsed: canonical.gasUsed,
      receiptSemanticsSha256: createHash("sha256")
        .update(blindProductionCanonicalJson(canonical))
        .digest("hex"),
    });
  });
  controllerUpstreamRpc = snapshotRpc;
  controllerUpstreamKind = "local-snapshot";
  controllerUpstreamPid = listenerPid(snapshotRpc);
  [base, source] = await Promise.all([
    blockAnchor(snapshotRpc, baseNumber),
    blockAnchor(snapshotRpc, sourceNumber),
  ]);
  if (
    base.hash !== canonicalBase.hash ||
    base.stateRoot !== canonicalBase.stateRoot
  ) {
    throw new Error("full-prefix replay base anchor is not canonical");
  }
  const triggerTxHash = expectedHashes[prefixTriggerIndex];
  prefixEvidence = Object.freeze({
    schemaVersion: 1,
    lane: "backrun",
    base,
    source,
    opportunityBlock: sourceNumber,
    targetTransactionIndex: prefixThroughIndex + 1,
    triggerTransactionIndex: prefixTriggerIndex,
    triggerTxHash,
    appliedPrefixTxHashes: expectedHashes,
    effectiveStateSha256: createHash("sha256").update(
      blindProductionCanonicalJson({
        baseBlockHash: base.hash,
        baseStateRoot: base.stateRoot,
        appliedPrefixTxHashes: expectedHashes,
        sourceStateRoot: source.stateRoot,
      }),
    ).digest("hex"),
    contextApplied,
    receipts: receiptEvidence,
  });
  writeFileSync(
    resolve(runDir, "full-prefix-state-anchor.json"),
    `${blindProductionCanonicalJson(prefixEvidence)}\n`,
    { mode: 0o600 },
  );
}
if (!Number.isSafeInteger(controllerUpstreamPid) || controllerUpstreamPid <= 0) {
  throw new Error("local upstream listener PID is unavailable");
}
const issuerKey = readFileSync(
  issuerKeyPath,
  "utf8",
).trim();
const endpointSha256 = createHash("sha256")
  .update(controllerUpstreamRpc)
  .digest("hex");
const attestationPath = resolve(runDir, "backend-attestation.json");
generateBlindBackendAttestation(attestationPath, {
  upstreamKind: controllerUpstreamKind,
  endpointSha256,
  localProcessPid: controllerUpstreamPid,
}, issuerKey);
const loadedAttestation = loadBackendAttestation(
  attestationPath,
  controllerUpstreamRpc,
  issuerKey,
);
const backendIdentitySha256 = fileSha256(attestationPath);
const controller = new BlindBackendController(
  "127.0.0.1",
  0,
  controllerUpstreamRpc,
  loadedAttestation,
  anvilBin,
  120_000,
);
const controllerEndpoints = await controller.start();
const attemptNonce = randomBytes(32).toString("hex");
const prepareControl = Object.freeze({
  type: "prepare",
  profile: BLIND_PRODUCTION_RAW_PROFILE,
  attemptNonce,
  base,
});
const sourceControl = Object.freeze({
  type: "source_head",
  profile: BLIND_PRODUCTION_RAW_PROFILE,
  attemptNonce,
  source,
});

let child = null;
let portLease = null;
try {
  const prepared = await post(controllerEndpoints.controlUrl, {
    ...prepareControl,
    source,
    backendIdentitySha256,
  });

  const solveWorkers = Math.max(
    1,
    Math.min(64, Number(process.env.SEARCHER_BLOCKSCAN_SOLVE_CONCURRENCY ?? "4")),
  );
  portLease = await reserveBlindProducerRuntimePorts(solveWorkers);
  const forwardedEnvironment = forwardedProductionEnvironment(process.env);
  const dummyOwner = Wallet.createRandom();
  const dummyExecutor = Wallet.createRandom().address;
  const forkBotVmEvidence = forkBotVmRuntimeReceipt(
    dummyOwner.address,
    dummyExecutor,
  );
  const childEnv = {
    ...forwardedEnvironment,
    ...portLease.env,
    BLIND_SENTINEL_MODE: "1",
    SEARCHER_TEST_DISABLE_DOTENV: "1",
    SEARCHER_BLIND_RAW_AUDIT: "1",
    SEARCHER_BLIND_INSTALL_FORK_BOTVM: "1",
    SEARCHER_BLIND_USE_INCUMBENT_READY: "1",
    SEARCHER_BLIND_PREPARE_BUDGET_MS: String(prepareBudgetMs),
    SEARCHER_BLIND_BASE_PRICING_RPC_URL: controllerUpstreamRpc,
    SEARCHER_DRY_RUN: "1",
    SEARCHER_ENABLE_BLOCK_SCAN: "1",
    SEARCHER_BLOCKSCAN_SUBMIT: "1",
    SEARCHER_ENABLE_BACKRUN: "0",
    SEARCHER_ENABLE_MEMPOOL: "0",
    SEARCHER_ENABLE_MEV_SHARE: "0",
    SEARCHER_EAGER_STATE_BACKEND: "0",
    SEARCHER_LIVE_RPC_URL: controllerEndpoints.rpcUrl,
    MAINNET_RPC_URL: controllerEndpoints.rpcUrl,
    SEARCHER_DISCOVERY_TO_BLOCK: String(baseNumber),
    SEARCHER_UNIVERSE_REBUILD_CHECKPOINT_PATH: checkpointPath,
    SEARCHER_UNIVERSE_REBUILD_RUN_ID: checkpointRunId,
    SEARCHER_POOL_UNIVERSE_PATH: poolUniversePath,
    SEARCHER_PINNED_WARM_POOLS: emptyListPath,
    SEARCHER_FORCE_INCLUDE_POOLIDS_PATH: emptyListPath,
    SEARCHER_POOL_UNIVERSE_FORCE_INCLUDE: "",
    SEARCHER_RECORD_LIVE_FIXTURES: "0",
    SEARCHER_RUNTIME_COMMIT: productionCommit,
    SEARCHER_EVENTS_PATH: resolve(runDir, "events.jsonl"),
    SEARCHER_BLOCKSCAN_ROUTE_EVENTS_PATH: resolve(runDir, "routes.jsonl"),
    SEARCHER_EV_GATE: "1",
  };
  childEnv.OWNER_PRIVATE_KEY = dummyOwner.privateKey.slice(2);
  childEnv.BOTVM_ADDRESS = dummyExecutor;
  childEnv.BOTVM_OWNER = dummyOwner.address;
  delete childEnv.BLIND_BACKEND_ATTESTATION_KEY;
  delete childEnv.BLIND_PREFIX_THROUGH_INDEX;
  delete childEnv.BLIND_PREFIX_TRIGGER_INDEX;
  delete childEnv.BLIND_PREFIX_ANVIL_PORT;
  const stdoutPath = resolve(runDir, "production.stdout.log");
  const stderrPath = resolve(runDir, "production.stderr.log");
  const stdoutFile = createWriteStream(stdoutPath, { flags: "a", mode: 0o600 });
  const stderrFile = createWriteStream(stderrPath, { flags: "a", mode: 0o600 });
  child = spawn(
    process.execPath,
    ["--import", "tsx", HISTORICAL_LIVE_PRODUCTION_ENTRY],
    { cwd: repo, env: childEnv, stdio: ["pipe", "pipe", "pipe"] },
  );
  await portLease.release();
  portLease = null;

  const queues = new Map();
  const waiters = new Map();
  const stderrTail = [];
  function accept(prefix, raw) {
    const waiter = waiters.get(prefix);
    if (waiter) {
      waiters.delete(prefix);
      clearTimeout(waiter.timer);
      waiter.resolve(JSON.parse(raw));
    } else {
      const queue = queues.get(prefix) ?? [];
      queue.push(raw);
      queues.set(prefix, queue);
    }
  }
  function next(prefix) {
    const queue = queues.get(prefix);
    if (queue?.length) return Promise.resolve(JSON.parse(queue.shift()));
    if (waiters.has(prefix)) throw new Error(`duplicate waiter ${prefix}`);
    return new Promise((resolveValue, rejectValue) => {
      const timer = setTimeout(() => {
        waiters.delete(prefix);
        rejectValue(new Error(
          `production timeout waiting for ${prefix}; stderr=${stderrTail.join(" | ").slice(-2000)}`,
        ));
      }, timeoutMs);
      waiters.set(prefix, { resolve: resolveValue, reject: rejectValue, timer });
    });
  }
  function cancel(prefix) {
    const waiter = waiters.get(prefix);
    if (!waiter) return;
    waiters.delete(prefix);
    clearTimeout(waiter.timer);
  }
  createInterface({ input: child.stdout }).on("line", (line) => {
    stdoutFile.write(`${line}\n`);
    if (line.startsWith(BLIND_PRODUCTION_READY_PREFIX)) {
      accept(BLIND_PRODUCTION_READY_PREFIX, line.slice(BLIND_PRODUCTION_READY_PREFIX.length));
    } else if (line.startsWith(BLIND_PRODUCTION_CONTROL_FAILURE_PREFIX)) {
      accept(
        BLIND_PRODUCTION_CONTROL_FAILURE_PREFIX,
        line.slice(BLIND_PRODUCTION_CONTROL_FAILURE_PREFIX.length),
      );
    } else if (line.startsWith(BLIND_PRODUCTION_RAW_PREFIX)) {
      accept(BLIND_PRODUCTION_RAW_PREFIX, line.slice(BLIND_PRODUCTION_RAW_PREFIX.length));
    }
  });
  createInterface({ input: child.stderr }).on("line", (line) => {
    stderrFile.write(`${line}\n`);
    stderrTail.push(line);
    if (stderrTail.length > 30) stderrTail.shift();
  });
  const childExit = new Promise((_, rejectExit) => {
    child.once("error", rejectExit);
    child.once("exit", (code, signal) => rejectExit(new Error(
      `production exited before replay completion code=${code} signal=${signal}; ` +
        `stderr=${stderrTail.join(" | ").slice(-2000)}`,
    )));
  });

  const ready = await runBoundedHistoricalPrepare({
    maxAttempts: prepareMaxAttempts,
    async attempt(attemptNumber) {
      const readyPromise = next(BLIND_PRODUCTION_READY_PREFIX);
      const failurePromise = next(BLIND_PRODUCTION_CONTROL_FAILURE_PREFIX);
      child.stdin.write(
        `${BLIND_PRODUCTION_CONTROL_PREFIX}` +
          `${blindProductionCanonicalJson(prepareControl)}\n`,
      );
      try {
        return await Promise.race([
          readyPromise.then((value) => ({ status: "ready", value })),
          failurePromise.then((value) => {
            const failure = validateBlindProductionControlFailureRecord(
              value,
              prepareControl,
            );
            return { status: "failed", message: failure.message };
          }),
          childExit,
        ]);
      } finally {
        cancel(BLIND_PRODUCTION_READY_PREFIX);
        cancel(BLIND_PRODUCTION_CONTROL_FAILURE_PREFIX);
        process.stdout.write(
          `[historical-live] prepare attempt=${attemptNumber}/${prepareMaxAttempts} completed\n`,
        );
      }
    },
    async beforeRetry(attemptNumber, message) {
      process.stdout.write(
        `[historical-live] prepare retry after attempt=${attemptNumber} ` +
          `reason=${JSON.stringify(message)}\n`,
      );
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 1_000));
    },
  });
  validateProductionReadyRecord(ready, prepareControl);
  const effectiveForkBotVm = ready.artifactDocuments.resolvedConfig.payload
    .effectiveConfig?.forkBotVmInstallation;
  if (
    blindProductionCanonicalJson(effectiveForkBotVm) !==
      blindProductionCanonicalJson(forkBotVmEvidence)
  ) {
    throw new Error("production did not bind the installed fork BotVM bytes");
  }

  const revealReady = await post(controllerEndpoints.controlUrl, {
    type: "reveal_request",
    profile: BLIND_PRODUCTION_RAW_PROFILE,
    attemptNonce,
    source,
    cleanForkId: prepared.cleanForkId,
  });
  validateBackendRevealReadyEvidence(revealReady, attemptNonce, prepared);
  const revealed = await post(controllerEndpoints.controlUrl, {
    type: "release",
    profile: BLIND_PRODUCTION_RAW_PROFILE,
    attemptNonce,
    cleanForkId: prepared.cleanForkId,
    revealToken: revealReady.revealToken,
  });

  const rawPromise = next(BLIND_PRODUCTION_RAW_PREFIX);
  const sourceFailurePromise = next(BLIND_PRODUCTION_CONTROL_FAILURE_PREFIX);
  child.stdin.write(
    `${BLIND_PRODUCTION_CONTROL_PREFIX}${blindProductionCanonicalJson(sourceControl)}\n`,
  );
  let raw;
  try {
    raw = await Promise.race([
      rawPromise,
      sourceFailurePromise.then((value) => {
        const failure = validateBlindProductionControlFailureRecord(
          value,
          sourceControl,
        );
        throw new Error(`production source-head failed: ${failure.message}`);
      }),
      childExit,
    ]);
  } finally {
    cancel(BLIND_PRODUCTION_RAW_PREFIX);
    cancel(BLIND_PRODUCTION_CONTROL_FAILURE_PREFIX);
  }
  const finished = await post(controllerEndpoints.controlUrl, {
    type: "finish",
    profile: BLIND_PRODUCTION_RAW_PROFILE,
    attemptNonce,
    cleanForkId: prepared.cleanForkId,
  });
  validateBackendEvidence(
    { backendIdentitySha256, base, source },
    attemptNonce,
    prepared,
    revealed,
    finished,
  );
  validateProductionPassRecordForFreeze(raw, ready, sourceControl);
  if (raw.selectionMode !== "production" || raw.forcedSelectionCount !== 0) {
    throw new Error("blind replay used a non-production or forced selection path");
  }
  const completedStore = new UniverseRebuildCheckpointStore({
    path: checkpointPath,
  });
  const completedEnvelope = await completedStore.load();
  const completedReady = completedEnvelope?.readyGeneration ?? null;
  if (
    completedEnvelope === null ||
    completedReady === null ||
    completedReady.cutoff.number > baseNumber
  ) {
    throw new Error("historical Funding Ready table used future authority");
  }
  const activeFundingKeys = new Set(completedReady.activeInstanceKeys);
  const fundingTokens = [...new Set(Object.values(
    completedEnvelope.verifiedMemos,
  ).flatMap((memo) => {
    if (!activeFundingKeys.has(memo.familyInstanceKey)) return [];
    const descriptor = memo.compiledDescriptor;
    if (
      descriptor === null ||
      typeof descriptor !== "object" ||
      descriptor.domain !== "funding" ||
      typeof descriptor.asset !== "string" ||
      !/^0x[0-9a-fA-F]{40}$/.test(descriptor.asset)
    ) return [];
    return [descriptor.asset.toLowerCase()];
  }))].sort();
  if (fundingTokens.length === 0) {
    throw new Error("historical rebuild produced no Funding Ready tokens");
  }
  const fundingTokenEvidence = Object.freeze({
    enumeratedAtBlock: completedReady.cutoff.number,
    tokenCount: fundingTokens.length,
    tokenSetSha256: blindProductionAuditHash(
      fundingTokens,
    ),
    checkpointFingerprint: completedEnvelope.checkpointFingerprint,
  });
  const effectiveFunding = ready.artifactDocuments.resolvedConfig.payload
    .effectiveConfig?.fundingTokenUniverse;
  if (
    blindProductionCanonicalJson(effectiveFunding) !==
      blindProductionCanonicalJson({
        enumeratedAtBlock: fundingTokenEvidence.enumeratedAtBlock,
        tokenCount: fundingTokenEvidence.tokenCount,
        tokenSetSha256: fundingTokenEvidence.tokenSetSha256,
      })
  ) {
    throw new Error("production did not bind the historical funding surface");
  }
  const rawPath = resolve(runDir, "blind-production-raw.json");
  writeFileSync(rawPath, `${blindProductionCanonicalJson(raw)}\n`, { mode: 0o600 });
  chmodSync(rawPath, 0o600);

  const stages = Object.fromEntries(raw.stages.map((stage) => [
    stage.name,
    {
      status: stage.status,
      opportunities: stage.artifact.opportunities?.length ?? null,
      stageMs: stage.stageMs,
    },
  ]));
  const positiveSim = raw.opportunities.filter((opportunity) =>
    opportunity.simulation.executed &&
    opportunity.simulation.success &&
    BigInt(opportunity.simulation.profitRaw) > 0n
  );
  const summary = Object.freeze({
    profile: raw.profile,
    productionCommit,
    base,
    source,
    graphEdges: raw.graph.orderedEdgeIds.length,
    expectedPricedEdges: raw.pricingCoverage.expectedPricedEdgeIds.length,
    resolvedPricedEdges: raw.pricingCoverage.resolvedPricedEdgeIds.length,
    selectionMode: raw.selectionMode,
    forcedSelectionCount: raw.forcedSelectionCount,
    opportunityCount: raw.opportunities.length,
    positiveSimCount: positiveSim.length,
    evAllowCount: raw.opportunities.filter((entry) => entry.ev.decision === "allow").length,
    maxPositiveProfitRaw: positiveSim.reduce(
      (best, entry) => BigInt(entry.simulation.profitRaw) > best
        ? BigInt(entry.simulation.profitRaw)
        : best,
      0n,
    ).toString(),
    stages,
    rawPath,
    resolvedConfigReceiptSha256: ready.artifacts.resolvedConfig.sha256,
    forkBotVm: forkBotVmEvidence,
    checkpoint: checkpointEvidence,
    poolUniverse: poolUniverseEvidence,
    fundingTokenUniverse: fundingTokenEvidence,
    backend: {
      upstreamKind: prepared.upstreamKind,
      loopbackRpcCalls: finished.loopbackRpcCalls,
      nonLoopbackUpstreamRpcCalls: finished.nonLoopbackUpstreamRpcCalls,
    },
    ...(prefixEvidence === null
      ? {}
      : {
          stateAnchorLane: prefixEvidence.lane,
          appliedPrefixCount: prefixEvidence.appliedPrefixTxHashes.length,
          triggerTxHash: prefixEvidence.triggerTxHash,
          effectiveStateSha256: prefixEvidence.effectiveStateSha256,
        }),
  });
  const summaryPath = resolve(runDir, "summary.json");
  writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, { mode: 0o600 });
  chmodSync(summaryPath, 0o600);
  process.stdout.write(`HISTORICAL_LIVE_REPLAY_SUMMARY=${JSON.stringify(summary)}\n`);
} finally {
  if (portLease) await portLease.release().catch(() => undefined);
  if (child && child.exitCode === null) {
    child.stdin.end();
    child.kill("SIGTERM");
    await Promise.race([
      new Promise((resolveExit) => child.once("exit", resolveExit)),
      new Promise((resolveTimeout) => setTimeout(resolveTimeout, 5000)),
    ]);
    if (child.exitCode === null) child.kill("SIGKILL");
  }
  await controller.close();
  if (prefixState) await prefixState.stopAndWait();
}
