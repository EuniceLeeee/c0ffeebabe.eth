import assert from "node:assert/strict";
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AdapterFamilyDiscoveryCheckpointStore,
  FileAdapterFamilyDiscoveryCheckpointBackend,
  emptyCheckpointInventoryFamilies,
  type AdapterFamilyDiscoveryCheckpointCandidateIssuer,
  type AdapterFamilyDiscoveryCheckpointInventoryCandidateFamily,
  type AdapterFamilyDiscoveryCheckpointReceipt,
  type AdapterFamilyDiscoveryCheckpointWatermark,
} from "../adapter-family-discovery-checkpoint.js";
import type {
  AdapterFamilySnapshotInventoryObservation,
} from "../adapter-family-snapshot-inventory-closure.js";
import { familyId, type FamilyId } from
  "../venues/adapter-family-identifiers.js";
import type { CanonicalSource } from
  "../venues/adapter-request-program.js";
import type { FamilyCapabilityCatalog } from
  "../venues/family-capability-catalog.js";

const CATALOG_HASH = "1".repeat(64);
const REGISTRY = "strict-source-registry-v1";
const FAMILY_A = familyId("fixture-family-a");
const FAMILY_B = familyId("fixture-family-b");
const SOURCE_10 = source(10, "a", 1);
const SOURCE_11 = source(11, "b", 2);
const SOURCE_12 = source(12, "c", 3);
const RESTART_SOURCE_13 = source(13, "d", 1);

function source(
  number: number,
  hashDigit: string,
  generation: number,
): CanonicalSource {
  return Object.freeze({
    number,
    hash: `0x${hashDigit.repeat(64)}`,
    generation,
  });
}

function catalog(input: {
  readonly includeAddressSurface?: boolean;
} = {}): Pick<FamilyCapabilityCatalog, "catalogHash" | "listAll"> {
  const includeAddressSurface = input.includeAddressSurface ?? true;
  return {
    catalogHash: CATALOG_HASH,
    listAll: () => [
      {
        plugin: {
          manifest: { familyId: FAMILY_A },
          discovery: {
            sources: includeAddressSurface
              ? ["observed-call", "address-surface"]
              : ["observed-call"],
          },
        },
      },
      {
        plugin: {
          manifest: { familyId: FAMILY_B },
          discovery: { sources: ["factory-log"] },
        },
      },
    ],
  } as unknown as Pick<FamilyCapabilityCatalog, "catalogHash" | "listAll">;
}

function checkpoints(
  path: string,
  input: {
    readonly registry?: string;
    readonly matrixCatalog?: Pick<
      FamilyCapabilityCatalog,
      "catalogHash" | "listAll"
    >;
    readonly verifyCanonicalCheckpoint?: (
      source: CanonicalSource,
    ) => void | Promise<void>;
    readonly assertGenerationCurrent?: (source: CanonicalSource) => void;
  } = {},
): AdapterFamilyDiscoveryCheckpointStore {
  const store = new AdapterFamilyDiscoveryCheckpointStore({
    catalog: input.matrixCatalog ?? catalog(),
    chainId: "1",
    sourceRegistryFingerprint: input.registry ?? REGISTRY,
    backend: new FileAdapterFamilyDiscoveryCheckpointBackend({
      path,
      lockRetryMs: 1,
      lockAttempts: 500,
    }),
    verifyCanonicalCheckpoint: (snapshot) =>
      input.verifyCanonicalCheckpoint?.(snapshot.source),
    assertGenerationCurrent: (source) =>
      input.assertGenerationCurrent?.(source),
  });
  candidateIssuers.set(store, store.takeCandidateIssuer());
  return store;
}

const candidateIssuers = new WeakMap<
  AdapterFamilyDiscoveryCheckpointStore,
  AdapterFamilyDiscoveryCheckpointCandidateIssuer
>();

function candidateIssuer(
  store: AdapterFamilyDiscoveryCheckpointStore,
): AdapterFamilyDiscoveryCheckpointCandidateIssuer {
  const issuer = candidateIssuers.get(store);
  assert(issuer, "test harness must retain the checked-out candidate issuer");
  return issuer;
}

function matrix(
  canonical: CanonicalSource,
): readonly AdapterFamilyDiscoveryCheckpointWatermark[] {
  // Intentionally unordered: the issuer must canonicalize the full matrix.
  return Object.freeze([
    watermark(FAMILY_B, "factory-log", "contiguous-history", canonical),
    watermark(FAMILY_A, "address-surface", "append-only", null),
    watermark(FAMILY_A, "observed-call", "contiguous-history", canonical),
  ]);
}

function watermark(
  owner: FamilyId,
  sourceId: AdapterFamilyDiscoveryCheckpointWatermark["sourceId"],
  coverageAuthority:
    AdapterFamilyDiscoveryCheckpointWatermark["coverageAuthority"],
  anchor: CanonicalSource | null,
): AdapterFamilyDiscoveryCheckpointWatermark {
  return Object.freeze({
    familyId: owner,
    sourceId,
    coverageAuthority,
    completeThroughBlock: anchor?.number ?? -1,
    completeThroughHash: anchor?.hash ?? null,
  });
}

function inventory(
  canonical: CanonicalSource,
): readonly AdapterFamilyDiscoveryCheckpointInventoryCandidateFamily[] {
  return emptyCheckpointInventoryFamilies([FAMILY_A, FAMILY_B]);
}

function populatedInventory(
  canonical: CanonicalSource,
): readonly AdapterFamilyDiscoveryCheckpointInventoryCandidateFamily[] {
  const surface: AdapterFamilySnapshotInventoryObservation = Object.freeze({
    kind: "address-surface",
    source: canonical,
    address: `0x${"ab".repeat(20)}`,
    codeHash: `0x${"1".repeat(64)}`,
    implementationWord: `0x${"0".repeat(64)}`,
    interfaceFingerprints: Object.freeze(["fixture-surface-v1"]),
  });
  return Object.freeze([
    ...inventory(canonical).filter((family) => family.familyId !== FAMILY_A),
    Object.freeze({
      familyId: FAMILY_A,
      incumbents: Object.freeze([Object.freeze({
        inventoryKey: "legacy:fixture-pool-a",
        address: `0x${"ab".repeat(20)}`,
        currentSurface: surface,
      })]),
    }),
  ]);
}

async function commit(
  store: AdapterFamilyDiscoveryCheckpointStore,
  expected: AdapterFamilyDiscoveryCheckpointReceipt | null,
  canonical: CanonicalSource,
): Promise<boolean> {
  const staged = candidateIssuer(store).prepare({
    source: canonical,
    watermarks: matrix(canonical),
    inventoryFamilies: inventory(canonical),
  });
  assert.deepEqual(Object.keys(staged), []);
  return store.compareAndCommit({
    expected,
    staged,
  });
}

const directory = await mkdtemp(join(tmpdir(), "adapter-family-checkpoint-"));
const path = join(directory, "checkpoint.json");

try {
  const order: string[] = [];
  let firstVerifyCalls = 0;
  const first = checkpoints(path, {
    verifyCanonicalCheckpoint(actual) {
      firstVerifyCalls += 1;
      order.push("verify");
      assert.equal(actual.hash, SOURCE_10.hash);
    },
    assertGenerationCurrent(actual) {
      order.push("fence");
      assert.equal(actual.generation, SOURCE_10.generation);
    },
  });
  assert.deepEqual(first.binding(), {
    chainId: "1",
    catalogHash: CATALOG_HASH,
    sourceRegistryFingerprint: REGISTRY,
  });
  assert(Object.isFrozen(first.binding()));
  assert.equal("candidateIssuer" in first, false);
  assert.throws(
    () => first.takeCandidateIssuer(),
    /already taken/,
  );
  const empty = await first.loadForRestart();
  assert.equal(firstVerifyCalls, 0);
  assert.equal(empty.status, "empty");
  const emptyState = first.restartState(empty.receipt);
  assert.equal(emptyState.authority, "append-only");
  assert.equal(emptyState.source, null);
  assert.equal(emptyState.watermarks.length, 3);
  assert(emptyState.watermarks.every((row) =>
    row.coverageAuthority === "append-only" &&
    row.completeThroughBlock === -1 &&
    row.completeThroughHash === null
  ));
  assert.equal(first.capture(), null);

  const firstStaged = candidateIssuer(first).prepare({
    source: SOURCE_10,
    watermarks: matrix(SOURCE_10),
    inventoryFamilies: inventory(SOURCE_10),
  });
  assert.equal(await first.compareAndCommit({
    expected: null,
    staged: firstStaged,
  }), true);
  assert.deepEqual(order, ["verify", "fence"]);
  const receipt1 = first.capture()!;
  assert.deepEqual(Object.keys(receipt1), []);
  const snapshot1 = first.checkpointSnapshot(receipt1)!;
  assert.equal(snapshot1.revision, 1);
  assert.equal(snapshot1.chainId, "1");
  assert.equal(snapshot1.catalogHash, CATALOG_HASH);
  assert.equal(snapshot1.sourceRegistryFingerprint, REGISTRY);
  assert.equal(snapshot1.watermarks.length, 3);
  assert.deepEqual(
    snapshot1.watermarks.map((row) => `${row.familyId}/${row.sourceId}`),
    [
      `${FAMILY_A}/address-surface`,
      `${FAMILY_A}/observed-call`,
      `${FAMILY_B}/factory-log`,
    ],
  );
  assert(Object.isFrozen(snapshot1));
  assert(Object.isFrozen(snapshot1.source));
  assert(Object.isFrozen(snapshot1.watermarks));
  assert(snapshot1.watermarks.every(Object.isFrozen));
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  const serialized1 = await readFile(path, "utf8");
  assert(serialized1.endsWith("\n"));
  await assert.rejects(
    () => first.compareAndCommit({
      expected: receipt1,
      staged: firstStaged,
    }),
    /forged or foreign/,
    "prepared checkpoint candidates are one-shot",
  );

  let restartVerifyCalls = 0;
  const restarted = checkpoints(path, {
    verifyCanonicalCheckpoint() {
      restartVerifyCalls += 1;
    },
  });
  const loaded = await restarted.loadForRestart();
  assert.equal(loaded.status, "trusted");
  assert.equal(restartVerifyCalls, 1);
  const restartState = restarted.restartState(loaded.receipt);
  assert.equal(restartState.authority, "trusted");
  assert.deepEqual(restartState.source, SOURCE_10);
  assert.equal(
    restartState.watermarks.find((row) => row.sourceId === "observed-call")
      ?.coverageAuthority,
    "contiguous-history",
  );
  assert.equal(
    restartState.watermarks.find((row) => row.sourceId === "address-surface")
      ?.coverageAuthority,
    "append-only",
  );
  assert.throws(
    () => restarted.restartState({ ...loaded.receipt }),
    /forged or foreign/,
    "spread receipts cannot recover durable authority",
  );
  assert.throws(
    () => first.restartState(loaded.receipt),
    /forged or foreign/,
    "receipts remain local to the loading store authority",
  );

  let canonicalFailureFence = 0;
  const canonicalFailureStore = checkpoints(path, {
    verifyCanonicalCheckpoint(actual) {
      if (actual.number === SOURCE_11.number) {
        throw new Error("fixture canonical rejection");
      }
    },
    assertGenerationCurrent() {
      canonicalFailureFence += 1;
    },
  });
  const canonicalFailureLoaded = await canonicalFailureStore.loadForRestart();
  assert.equal(canonicalFailureLoaded.status, "trusted");
  const canonicalFailure = candidateIssuer(canonicalFailureStore).prepare({
    source: SOURCE_11,
    watermarks: matrix(SOURCE_11),
    inventoryFamilies: inventory(SOURCE_11),
  });
  await assert.rejects(
    () => canonicalFailureStore.compareAndCommit({
      expected: canonicalFailureLoaded.receipt,
      staged: canonicalFailure,
    }),
    /fixture canonical rejection/,
  );
  assert.equal(canonicalFailureFence, 0);
  assert.equal(await readFile(path, "utf8"), serialized1);
  assert.equal(canonicalFailureStore.capture(), canonicalFailureLoaded.receipt);

  const fenceFailureStore = checkpoints(path, {
    assertGenerationCurrent(actual) {
      if (actual.generation === SOURCE_11.generation) {
        throw new Error("fixture stale generation");
      }
    },
  });
  const fenceFailureLoaded = await fenceFailureStore.loadForRestart();
  assert.equal(fenceFailureLoaded.status, "trusted");
  const fenceFailure = candidateIssuer(fenceFailureStore).prepare({
    source: SOURCE_11,
    watermarks: matrix(SOURCE_11),
    inventoryFamilies: inventory(SOURCE_11),
  });
  await assert.rejects(
    () => fenceFailureStore.compareAndCommit({
      expected: fenceFailureLoaded.receipt,
      staged: fenceFailure,
    }),
    /fixture stale generation/,
  );
  assert.equal(await readFile(path, "utf8"), serialized1);
  assert.equal(fenceFailureStore.capture(), fenceFailureLoaded.receipt);

  assert.equal(await commit(restarted, loaded.receipt, SOURCE_11), true);
  const receipt2 = restarted.capture()!;
  assert.equal(restarted.checkpointSnapshot(receipt2)?.revision, 2);
  const serialized2 = await readFile(path, "utf8");
  assert.notEqual(serialized2, serialized1);

  // Two independently loaded stores contend on the same durable file. The
  // sidecar lock + exact raw-byte predicate permits exactly one CAS winner.
  const contenderA = checkpoints(path);
  const contenderB = checkpoints(path);
  const [loadA, loadB] = await Promise.all([
    contenderA.loadForRestart(),
    contenderB.loadForRestart(),
  ]);
  assert.equal(loadA.status, "trusted");
  assert.equal(loadB.status, "trusted");
  const [wonA, wonB] = await Promise.all([
    commit(contenderA, loadA.receipt, SOURCE_12),
    commit(contenderB, loadB.receipt, SOURCE_12),
  ]);
  assert.equal(Number(wonA) + Number(wonB), 1);
  const loser = wonA ? contenderB : contenderA;
  const loserIncumbent = wonA ? loadB.receipt : loadA.receipt;
  assert.equal(loser.capture(), loserIncumbent);
  assert.equal(loser.checkpointSnapshot(loserIncumbent)?.revision, 2);
  const winnerFile = await readFile(path, "utf8");
  const finalLoader = checkpoints(path);
  const finalLoaded = await finalLoader.loadForRestart();
  assert.equal(finalLoaded.status, "trusted");
  assert.equal(finalLoaded.snapshot.revision, 3);

  // A writer may advance the file while another store asynchronously
  // verifies its first read. The degraded loader must retain that first read
  // as a failing CAS token; it cannot rebase expected:null onto the winner's
  // unverified bytes and replace revision 2 with a revision-1 checkpoint.
  const concurrentLoadPath = join(directory, "concurrent-load.json");
  const concurrentSeed = checkpoints(concurrentLoadPath);
  await concurrentSeed.loadForRestart();
  assert.equal(await commit(concurrentSeed, null, SOURCE_10), true);
  let signalConcurrentVerify: (() => void) | null = null;
  let releaseConcurrentVerify!: () => void;
  const concurrentVerifyStarted = new Promise<void>((resolve) => {
    signalConcurrentVerify = resolve;
  });
  const concurrentVerifyRelease = new Promise<void>((resolve) => {
    releaseConcurrentVerify = resolve;
  });
  const racingLoader = checkpoints(concurrentLoadPath, {
    async verifyCanonicalCheckpoint(actual) {
      if (actual.number !== SOURCE_10.number) return;
      signalConcurrentVerify?.();
      signalConcurrentVerify = null;
      await concurrentVerifyRelease;
    },
  });
  const racingLoad = racingLoader.loadForRestart();
  await concurrentVerifyStarted;
  const concurrentWinner = checkpoints(concurrentLoadPath);
  const concurrentWinnerLoad = await concurrentWinner.loadForRestart();
  assert.equal(concurrentWinnerLoad.status, "trusted");
  assert.equal(await commit(
    concurrentWinner,
    concurrentWinnerLoad.receipt,
    SOURCE_11,
  ), true);
  const concurrentWinnerRaw = await readFile(concurrentLoadPath, "utf8");
  releaseConcurrentVerify();
  const concurrentChanged = await racingLoad;
  assert.equal(concurrentChanged.status, "degraded-append-only");
  assert.equal(concurrentChanged.reason, "concurrent-storage-change");
  assert.equal(racingLoader.capture(), null);
  assert.equal(await commit(racingLoader, null, SOURCE_12), false);
  assert.equal(
    await readFile(concurrentLoadPath, "utf8"),
    concurrentWinnerRaw,
  );
  const concurrentReload = await racingLoader.loadForRestart();
  assert.equal(concurrentReload.status, "trusted");
  assert.equal(concurrentReload.snapshot.revision, 2);
  assert.deepEqual(concurrentReload.snapshot.source, SOURCE_11);

  // generation is process-local. A durable predecessor may have a much
  // larger old-process generation than the first generation after restart.
  const restartGenerationPath = join(directory, "restart-generation.json");
  const oldProcess = checkpoints(restartGenerationPath);
  await oldProcess.loadForRestart();
  const oldGenerationSource = source(12, "c", 100);
  assert.equal(await commit(oldProcess, null, oldGenerationSource), true);
  let restartFenceGeneration = -1;
  const newProcess = checkpoints(restartGenerationPath, {
    assertGenerationCurrent(actual) {
      restartFenceGeneration = actual.generation;
    },
  });
  const oldCheckpoint = await newProcess.loadForRestart();
  assert.equal(oldCheckpoint.status, "trusted");
  assert.equal(await commit(
    newProcess,
    oldCheckpoint.receipt,
    RESTART_SOURCE_13,
  ), true);
  assert.equal(restartFenceGeneration, 1);
  assert.equal(newProcess.checkpointSnapshot(newProcess.capture()!)?.revision, 2);

  // A candidate can become stale while the file backend waits for its lock.
  // The fixed fence and expected identity are rechecked after temp fsync, in
  // the synchronous beforeCommit -> renameSync linearization window.
  const linearizationPath = join(directory, "linearization.json");
  const linearizationLock = `${linearizationPath}.lock`;
  let currentGeneration = 1;
  let signalVerified: (() => void) | null = null;
  const linearizationStore = checkpoints(linearizationPath, {
    verifyCanonicalCheckpoint(actual) {
      if (actual.number === SOURCE_11.number) {
        signalVerified?.();
        signalVerified = null;
      }
    },
    assertGenerationCurrent(actual) {
      if (actual.generation !== currentGeneration) {
        throw new Error("fixture generation superseded while waiting for lock");
      }
    },
  });
  await linearizationStore.loadForRestart();
  assert.equal(await commit(linearizationStore, null, SOURCE_10), true);
  const linearizationExpected = linearizationStore.capture()!;
  const linearizationRaw = await readFile(linearizationPath, "utf8");

  await writeFile(linearizationLock, `${process.pid}\n`, { mode: 0o600 });
  currentGeneration = SOURCE_11.generation;
  const fenceWait = new Promise<void>((resolve) => { signalVerified = resolve; });
  const staleGenerationCommit = commit(
    linearizationStore,
    linearizationExpected,
    SOURCE_11,
  );
  await fenceWait;
  currentGeneration = SOURCE_12.generation;
  await unlink(linearizationLock);
  await assert.rejects(
    () => staleGenerationCommit,
    /generation superseded while waiting for lock/,
  );
  assert.equal(await readFile(linearizationPath, "utf8"), linearizationRaw);
  assert.equal(linearizationStore.capture(), linearizationExpected);

  await writeFile(linearizationLock, `${process.pid}\n`, { mode: 0o600 });
  currentGeneration = SOURCE_11.generation;
  const identityWait = new Promise<void>((resolve) => { signalVerified = resolve; });
  const staleIdentityCommit = commit(
    linearizationStore,
    linearizationExpected,
    SOURCE_11,
  );
  await identityWait;
  const reloadedDuringLock = await linearizationStore.loadForRestart();
  assert.equal(reloadedDuringLock.status, "trusted");
  assert.notEqual(reloadedDuringLock.receipt, linearizationExpected);
  await unlink(linearizationLock);
  assert.equal(await staleIdentityCommit, false);
  assert.equal(await readFile(linearizationPath, "utf8"), linearizationRaw);
  assert.equal(linearizationStore.capture(), reloadedDuringLock.receipt);
  assert.equal(
    (await readdir(directory)).some((name) =>
      name.startsWith("linearization.json.") && name.endsWith(".tmp")
    ),
    false,
  );

  // A changed registry, catalog matrix, canonical chain, or modified bytes
  // never preserve trusted coverage across restart.
  const wrongRegistry = checkpoints(path, { registry: "registry-v2" });
  const registryLoad = await wrongRegistry.loadForRestart();
  assert.equal(registryLoad.status, "degraded-append-only");
  assertAppendOnlyFallback(wrongRegistry, registryLoad.receipt, 3);

  const changedMatrix = checkpoints(path, {
    matrixCatalog: catalog({ includeAddressSurface: false }),
  });
  const matrixLoad = await changedMatrix.loadForRestart();
  assert.equal(matrixLoad.status, "degraded-append-only");
  assertAppendOnlyFallback(changedMatrix, matrixLoad.receipt, 2);

  const reorged = checkpoints(path, {
    verifyCanonicalCheckpoint: () => {
      throw new Error("checkpoint block is no longer canonical");
    },
  });
  const reorgLoad = await reorged.loadForRestart();
  assert.equal(reorgLoad.status, "degraded-append-only");
  assertAppendOnlyFallback(reorged, reorgLoad.receipt, 3);

  const tampered = JSON.parse(winnerFile) as Record<string, unknown>;
  tampered.sourceRegistryFingerprint = "tampered-registry";
  await writeFile(path, `${JSON.stringify(tampered, null, 2)}\n`, {
    mode: 0o600,
  });
  const tamperedStore = checkpoints(path, {
    verifyCanonicalCheckpoint: () => {
      throw new Error("invalid checkpoint must fail before verification");
    },
  });
  const tamperedLoad = await tamperedStore.loadForRestart();
  assert.equal(tamperedLoad.status, "degraded-append-only");
  assertAppendOnlyFallback(tamperedStore, tamperedLoad.receipt, 3);

  await writeFile(path, "{not-json\n", { mode: 0o600 });
  const malformed = checkpoints(path);
  const malformedLoad = await malformed.loadForRestart();
  assert.equal(malformedLoad.status, "degraded-append-only");
  assertAppendOnlyFallback(malformed, malformedLoad.receipt, 3);

  // Candidate matrices must be exact and cannot give point-in-time sources
  // durable contiguous-history authority.
  const validation = checkpoints(join(directory, "validation.json"));
  await validation.loadForRestart();
  const foreignCandidateStore = checkpoints(
    join(directory, "foreign-candidate.json"),
  );
  await foreignCandidateStore.loadForRestart();
  const foreignCandidate = candidateIssuer(foreignCandidateStore).prepare({
    source: SOURCE_10,
    watermarks: matrix(SOURCE_10),
    inventoryFamilies: inventory(SOURCE_10),
  });
  await assert.rejects(
    () => validation.compareAndCommit({
      expected: null,
      staged: foreignCandidate,
    }),
    /forged or foreign/,
  );
  await assert.rejects(
    () => validation.compareAndCommit({
      expected: null,
      staged: { ...foreignCandidate },
    }),
    /forged or foreign/,
  );
  assert.throws(
    () => candidateIssuer(validation).prepare({
      source: SOURCE_10,
      watermarks: matrix(SOURCE_10).slice(1),
      inventoryFamilies: inventory(SOURCE_10),
    }),
    /missing matrix rows/,
  );
  assert.throws(
    () => candidateIssuer(validation).prepare({
      source: SOURCE_10,
      watermarks: [...matrix(SOURCE_10), matrix(SOURCE_10)[0]!],
      inventoryFamilies: inventory(SOURCE_10),
    }),
    /duplicate discovery checkpoint matrix row/,
  );
  assert.throws(
    () => candidateIssuer(validation).prepare({
      source: SOURCE_10,
      watermarks: matrix(SOURCE_10).map((row) =>
        row.sourceId === "address-surface"
          ? { ...row, coverageAuthority: "contiguous-history" as const,
              completeThroughBlock: SOURCE_10.number,
              completeThroughHash: SOURCE_10.hash }
          : row
      ),
      inventoryFamilies: inventory(SOURCE_10),
    }),
    /cannot restore contiguous history/,
  );
  assert.throws(
    () => candidateIssuer(validation).prepare({
      source: SOURCE_10,
      watermarks: matrix(SOURCE_10).map((row) =>
        row.sourceId === "address-surface"
          ? { ...row, coverageAuthority: "snapshot" as const,
              completeThroughBlock: SOURCE_10.number,
              completeThroughHash: SOURCE_10.hash }
          : row
      ),
      inventoryFamilies: inventory(SOURCE_10),
    }),
    /invalid discovery checkpoint coverage authority/,
    "durable continuity cannot mint point-in-time inventory closure",
  );
  assert.throws(
    () => candidateIssuer(validation).prepare({
      source: SOURCE_10,
      watermarks: matrix(SOURCE_10).map((row) =>
        row.sourceId === "factory-log"
          ? { ...row, completeThroughHash: `0x${"f".repeat(64)}` }
          : row
      ),
      inventoryFamilies: inventory(SOURCE_10),
    }),
    /does not match checkpoint source|disagree at one block height/,
  );

  // Durable incumbent inventory (checkpoint v2) round-trips and stays
  // canonical across restart; missing/extra Family rows fail closed, and a
  // tampered inventory fingerprint degrades to append-only.
  const inventoryPath = join(directory, "inventory.json");
  const inventoryStore = checkpoints(inventoryPath);
  await inventoryStore.loadForRestart();
  const inventoryCandidate = candidateIssuer(inventoryStore).prepare({
    source: SOURCE_10,
    watermarks: matrix(SOURCE_10),
    inventoryFamilies: populatedInventory(SOURCE_10),
  });
  assert.equal(await inventoryStore.compareAndCommit({
    expected: null,
    staged: inventoryCandidate,
  }), true);
  const inventoryReceipt = inventoryStore.capture()!;
  const inventorySnapshot =
    inventoryStore.checkpointSnapshot(inventoryReceipt)!;
  assert.equal(inventorySnapshot.inventoryFamilies.length, 2);
  const inventoryFamilyA = inventorySnapshot.inventoryFamilies.find(
    (family) => family.familyId === FAMILY_A,
  )!;
  assert.deepEqual(inventoryFamilyA.inventoryKeys, ["legacy:fixture-pool-a"]);
  assert.equal(inventoryFamilyA.inventoryCount, 1);
  assert.equal(inventoryFamilyA.incumbents[0]?.address, `0x${"ab".repeat(20)}`);
  assert.equal(
    inventoryFamilyA.incumbents[0]?.currentSurface.kind,
    "address-surface",
  );
  const inventoryRestarted = checkpoints(inventoryPath);
  const inventoryReloaded = await inventoryRestarted.loadForRestart();
  assert.equal(inventoryReloaded.status, "trusted");
  assert.deepEqual(
    inventoryRestarted.checkpointSnapshot(inventoryReloaded.receipt)!
      .inventoryFamilies,
    inventorySnapshot.inventoryFamilies,
  );

  const missingRowInventory = inventory(SOURCE_10).filter(
    (family) => family.familyId !== FAMILY_B,
  );
  assert.throws(
    () => candidateIssuer(validation).prepare({
      source: SOURCE_10,
      watermarks: matrix(SOURCE_10),
      inventoryFamilies: missingRowInventory,
    }),
    /missing Family rows/,
  );
  const extraRowInventory = Object.freeze([
    ...inventory(SOURCE_10),
    Object.freeze({
      familyId: familyId("fixture-family-extra"),
      incumbents: Object.freeze([]),
    }),
  ]);
  assert.throws(
    () => candidateIssuer(validation).prepare({
      source: SOURCE_10,
      watermarks: matrix(SOURCE_10),
      inventoryFamilies: extraRowInventory,
    }),
    /unknown discovery checkpoint inventory Family/,
  );

  const tamperedInventory = await readFile(inventoryPath, "utf8");
  const parsedInventory = JSON.parse(tamperedInventory) as {
    inventoryFamilies: { inventoryHash: string }[];
  };
  parsedInventory.inventoryFamilies[0]!.inventoryHash = "0".repeat(64);
  const tamperedPath = join(directory, "inventory-tampered.json");
  await writeFile(
    tamperedPath,
    `${JSON.stringify(parsedInventory, null, 2)}\n`,
  );
  const tamperedInventoryStore = checkpoints(tamperedPath);
  const tamperedInventoryLoad = await tamperedInventoryStore.loadForRestart();
  assert.equal(tamperedInventoryLoad.status, "degraded-append-only");
  assert.equal(
    tamperedInventoryLoad.reason,
    "invalid-or-mismatched-checkpoint",
  );

  console.log("adapter-family-discovery-checkpoint PASS");
} finally {
  await rm(directory, { recursive: true, force: true });
}

function assertAppendOnlyFallback(
  store: AdapterFamilyDiscoveryCheckpointStore,
  receipt: AdapterFamilyDiscoveryCheckpointReceipt,
  expectedRows: number,
): void {
  const state = store.restartState(receipt);
  assert.equal(state.authority, "append-only");
  assert.equal(state.source, null);
  assert.equal(state.watermarks.length, expectedRows);
  assert(state.watermarks.every((row) =>
    row.coverageAuthority === "append-only" &&
    row.completeThroughBlock === -1 &&
    row.completeThroughHash === null
  ));
  assert.equal(store.checkpointSnapshot(receipt), null);
  assert.equal(store.capture(), null);
}
