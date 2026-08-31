import assert from "node:assert/strict";
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, statSync, truncateSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import {
  CANONICAL_LIMITS,
  decodeCanonicalJson,
  encodeCanonicalBytes,
  hashCanonicalPartition,
  hashDomain,
  sha256Hex,
  type Hash,
} from "../../../packages/canonical-codec/src/index.ts";
import { atomicNoClobberPublishV1 } from "../src/atomic-file.ts";
import { buildPreReleaseRestartControllerBundleV1 } from "../src/bundle-builder.ts";
import { readStableOwnedPhysicalFileV1 } from "../src/stable-owned-file.ts";
import { runPreReleaseRestartControllerV1 } from "../src/controller-owner.ts";
import {
  assertPreReleaseProcessPreDenominatorV1,
  publishPreReleaseADurableSnapshotsV1,
  readBoundedPhysicalFileForTestV1,
  snapshotFlatDirectoryForTestV1,
  snapshotSelectedSixStepBoundariesForTestV1,
  snapshotSqliteDatabaseForTestV1,
} from "../src/durable-owner.ts";
import {
  assertStableFileReadFenceV1,
  assertStableVirtualFileReadFenceV1,
  bindStablePreReleaseFrozenCgroupV1,
  parseFixedCgroupTasksV1,
  parseFixedFreezerStateV1,
  parseFixedSystemdShowV1,
  parseProcStartTicksV1,
} from "../src/linux-owner.ts";
import {
  decodePreReleaseRestartControllerReceiptV1,
  decodePreReleaseRestartControllerRoundLockV1,
  PRE_RELEASE_RESTART_CONTROLLER_LAYOUT_V1 as LAYOUT,
  PRE_RELEASE_SIX_STEP_BOUNDARY_SNAPSHOT_LIMITS_V1,
  PRE_RELEASE_RESTART_CONTROLLER_UNIT_V1,
  sealPreReleaseRestartControllerRoundLockV1,
  type PreReleaseControllerDirectorySnapshotV1,
} from "../src/spec.ts";

const BOUNDARY_KEY_SEQUENCE_DOMAIN = "aloha/production-terminal-phase-six-step-boundary-key-sequence/v1";

function terminalIndexBytes(keys: readonly Hash[], finalDurableWindowId: Hash): Uint8Array {
  const h = (field: string) => hashDomain("test/pre-release-terminal-index-field/v1", { finalDurableWindowId, field });
  const payload = {
    schemaVersion: 1,
    kind: "aloha.production-terminal-phase-locator-index-v1",
    finalDurableWindowId,
    locatorRoot: h("locatorRoot"),
    locatorContentSha256: h("locatorContentSha256"),
    locatorArtifactRefId: h("locatorArtifactRefId"),
    locatorArtifact: null,
    manifestRoot: h("manifestRoot"),
    manifestContentSha256: h("manifestContentSha256"),
    manifestArtifact: null,
    fullFamilyProjectionArtifact: null,
    fullFamilyTerminalBindingArtifact: null,
    fullGraphCoarseSweepArtifact: null,
    fullFamilyBundleArtifact: null,
    fullFamilyLocatorArtifact: null,
    sixStepTerminalBindingArtifact: null,
    sixStepPredicateArtifacts: [],
    sixStepPredicateArtifactPointerRoot: h("sixStepPredicateArtifactPointerRoot"),
    sixStepBoundaryKeys: keys,
    sixStepBoundaryKeyRoot: hashCanonicalPartition(BOUNDARY_KEY_SEQUENCE_DOMAIN, keys, 16),
    selectedProcessArtifact: null,
  } as const;
  return encodeCanonicalBytes({
    ...payload,
    indexRoot: hashDomain("aloha/production-terminal-phase-locator-index/v1", payload),
  });
}

function boundaryKeys(prefix: string, count: number): readonly Hash[] {
  return Object.freeze(Array.from({ length: count }, (_, index) => hashDomain(
    "test/pre-release-selected-six-step-boundary/v1",
    `${prefix}:${index}`,
  )).sort());
}

test("controller unit is one fixed root-owned no-restart owner", () => {
  assert.match(PRE_RELEASE_RESTART_CONTROLLER_UNIT_V1, /^Type=oneshot$/m);
  assert.match(PRE_RELEASE_RESTART_CONTROLLER_UNIT_V1, /^User=root$/m);
  assert.match(PRE_RELEASE_RESTART_CONTROLLER_UNIT_V1, new RegExp(`^ExecStart=${LAYOUT.targetNodePath.replaceAll("/", "\\/")} ${LAYOUT.controllerEntrypointPath.replaceAll("/", "\\/")}$`, "m"));
  assert.deepEqual(PRE_RELEASE_RESTART_CONTROLLER_UNIT_V1.match(/^Restart=.*$/gm), ["Restart=no"]);
  assert.match(PRE_RELEASE_RESTART_CONTROLLER_UNIT_V1, /^RuntimeMaxSec=10min$/m);
  assert.doesNotMatch(PRE_RELEASE_RESTART_CONTROLLER_UNIT_V1, /EnvironmentFile=|ExecStart=.*\$|ExecStart=.*%/);
  assert.equal(runPreReleaseRestartControllerV1.length, 0, "controller accepts no caller path/PID/signal/verdict input");
});

test("freeze boundary parsers require one anchored task and exact state transitions", () => {
  assert.equal(parseFixedFreezerStateV1("frozen\n", "frozen"), "frozen");
  assert.equal(parseFixedFreezerStateV1("running\n", "running"), "running");
  assert.deepEqual(parseFixedCgroupTasksV1("123\n", "123"), ["123"]);
  assert.deepEqual(parseFixedCgroupTasksV1("124\n123\n", "123"), ["123", "124"]);
  assert.throws(() => parseFixedFreezerStateV1("freezing\n", "frozen"), /not exactly frozen/);
  assert.throws(() => parseFixedFreezerStateV1("frozen\nrunning\n", "frozen"), /not exactly frozen/);
  assert.throws(() => parseFixedCgroupTasksV1("123\n123\n", "123"), /non-empty unique PID set/);
  assert.throws(() => parseFixedCgroupTasksV1("124\n", "123"), /does not contain the anchored main PID/);
  const snapshot = Object.freeze({
    systemdFreezerState: "frozen" as const,
    cgroupPath: "/sys/fs/cgroup/system.slice/aloha-searcher-pre-release.service",
    cgroupFreeze: "1" as const,
    tasks: Object.freeze([
      Object.freeze({ pid: "123", processStartTicks: "10", controlGroup: "/system.slice/aloha-searcher-pre-release.service" }),
      Object.freeze({ pid: "124", processStartTicks: "11", controlGroup: "/system.slice/aloha-searcher-pre-release.service" }),
    ]),
    taskSetRoot: `0x${"1".repeat(64)}` as const,
    observedAtUnixNs: "20",
    stableReobservedAtUnixNs: "20",
  });
  assert.equal(bindStablePreReleaseFrozenCgroupV1(snapshot, { ...snapshot, observedAtUnixNs: "21", stableReobservedAtUnixNs: "21" }).stableReobservedAtUnixNs, "21");
  assert.throws(() => bindStablePreReleaseFrozenCgroupV1(snapshot, {
    ...snapshot,
    tasks: snapshot.tasks.slice(0, 1),
    observedAtUnixNs: "21",
    stableReobservedAtUnixNs: "21",
  }), /task set changed/);
});

test("precreated observed, drained, or terminal facts invalidate the frozen pre-signal boundary", () => {
  assert.doesNotThrow(() => assertPreReleaseProcessPreDenominatorV1(["aloha.runtime-process-ready"], 0));
  assert.throws(() => assertPreReleaseProcessPreDenominatorV1([
    "aloha.runtime-process-ready",
    "aloha.runtime-sigterm-observed",
  ], 0), /exactly one valid ready event/);
  assert.throws(() => assertPreReleaseProcessPreDenominatorV1([
    "aloha.runtime-process-ready",
    "aloha.runtime-sigterm-observed",
    "aloha.runtime-sigterm-drained",
  ], 0), /exactly one valid ready event/);
  assert.throws(() => assertPreReleaseProcessPreDenominatorV1(["aloha.runtime-process-ready"], 1), /no durable restart terminal/);
});

test("systemd and proc parsers reject denominator and PID mutations", () => {
  const rows = [
    `Id=${LAYOUT.targetSystemdUnit}`,
    `FragmentPath=${LAYOUT.targetSystemdUnitPath}`,
    "LoadState=loaded",
    "ActiveState=active",
    "SubState=running",
    "MainPID=123",
    "InvocationID=0123456789abcdef0123456789abcdef",
    "ControlGroup=/system.slice/aloha-searcher-pre-release.service",
    "Result=success",
    "ExecMainCode=1",
    "ExecMainStatus=0",
    "Restart=no",
  ];
  assert.equal(parseFixedSystemdShowV1(`${rows.join("\n")}\n`).Restart, "no");
  assert.throws(() => parseFixedSystemdShowV1(`${rows.filter(row => row !== "Restart=no").join("\n")}\n`), /exact property denominator/);
  assert.throws(() => parseFixedSystemdShowV1(`${rows.join("\n")}\nRestart=no\n`), /duplicate property/);
  const suffix = Array.from({ length: 48 }, (_, index) => index === 0 ? "S" : String(index));
  suffix[19] = "4242";
  const stat = `123 (node worker) ${suffix.join(" ")}`;
  assert.equal(parseProcStartTicksV1(stat, "123"), "4242");
  assert.throws(() => parseProcStartTicksV1(stat, "124"), /prefix/);
  assert.throws(() => parseProcStartTicksV1(`123(node) ${suffix.join(" ")}`, "123"), /prefix/);
  assert.throws(() => parseProcStartTicksV1("123 (node) S 1", "123"), /start ticks/);
});

test("same-size metadata and content mutations cannot reuse a file fence", () => {
  const bytes = new TextEncoder().encode("abcd");
  const fence = Object.freeze({ device: "1", inode: "2", size: "4", mtimeUnixNs: "3", ctimeUnixNs: "4" });
  assert.equal(assertStableFileReadFenceV1(fence, fence, bytes), sha256Hex(bytes));
  assert.throws(() => assertStableFileReadFenceV1(fence, { ...fence, mtimeUnixNs: "5" }, bytes), /changed/);
  assert.throws(() => assertStableFileReadFenceV1(fence, { ...fence, ctimeUnixNs: "5" }, bytes), /changed/);
  assert.notEqual(assertStableFileReadFenceV1(fence, fence, new TextEncoder().encode("abce")), sha256Hex(bytes));
});

test("kernfs cgroup controls permit size-zero metadata while retaining stable inode fences", () => {
  const bytes = new TextEncoder().encode("1\n");
  const sizeZero = Object.freeze({ device: "1", inode: "2", size: "0", mtimeUnixNs: "3", ctimeUnixNs: "4" });
  assert.equal(assertStableVirtualFileReadFenceV1(sizeZero, sizeZero, bytes), sha256Hex(bytes));
  assert.throws(
    () => assertStableVirtualFileReadFenceV1(sizeZero, { ...sizeZero, inode: "3" }, bytes),
    /virtual physical file changed/,
  );
});

test("atomic publication never overwrites an existing target", () => {
  const directory = mkdtempSync(join(realpathSync(tmpdir()), "aloha-controller-publication-"));
  try {
    const target = join(directory, "receipt.json");
    writeFileSync(target, "existing", { mode: 0o600 });
    const before = readFileSync(target, "utf8");
    assert.throws(() => atomicNoClobberPublishV1({
      directory,
      path: target,
      bytes: new TextEncoder().encode("replacement"),
      uid: process.getuid!(),
      gid: process.getgid!(),
      mode: 0o600,
      tempDiscriminator: String(process.pid),
    }), /already exists/);
    assert.equal(readFileSync(target, "utf8"), before);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("atomic publication creates one fsynced no-clobber inode", () => {
  const directory = mkdtempSync(join(realpathSync(tmpdir()), "aloha-controller-publication-"));
  try {
    const target = join(directory, "evidence.json");
    const bytes = new TextEncoder().encode('{"fact":"physical"}');
    const publication = atomicNoClobberPublishV1({
      directory,
      path: target,
      bytes,
      uid: process.getuid!(),
      gid: process.getgid!(),
      mode: 0o600,
      tempDiscriminator: String(process.pid),
    });
    assert.equal(publication.contentSha256, sha256Hex(bytes));
    assert.deepEqual(new Uint8Array(readFileSync(target)), bytes);
    assert.throws(() => atomicNoClobberPublishV1({
      directory,
      path: target,
      bytes,
      uid: process.getuid!(),
      gid: process.getgid!(),
      mode: 0o600,
      tempDiscriminator: String(process.pid),
    }), /already exists/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("SQLite snapshot backup is immutable, no-clobber, and rejects foreign temp/final/schema paths", async () => {
  const directory = mkdtempSync(join(realpathSync(tmpdir()), "aloha-controller-snapshot-"));
  chmodSync(directory, 0o700);
  try {
    const source = join(directory, "source.sqlite");
    const snapshot = join(directory, "snapshot.sqlite");
    const database = new DatabaseSync(source);
    database.exec("CREATE TABLE facts (value TEXT NOT NULL); INSERT INTO facts VALUES ('before')");
    database.close();
    const publication = await snapshotSqliteDatabaseForTestV1(source, snapshot, directory);
    assert.equal(publication.contentSha256, sha256Hex(new Uint8Array(readFileSync(snapshot))));
    assert.equal(publication.byteLength, String(readFileSync(snapshot).byteLength));
    const sourceMutation = new DatabaseSync(source);
    sourceMutation.exec("UPDATE facts SET value='after'");
    sourceMutation.close();
    const frozen = new DatabaseSync(snapshot, { readOnly: true });
    assert.equal((frozen.prepare("SELECT value FROM facts").get() as { value: string }).value, "before");
    frozen.close();
    await assert.rejects(() => snapshotSqliteDatabaseForTestV1(source, snapshot, directory), /already exists/);

    const foreignFinal = join(directory, "foreign-final.sqlite");
    writeFileSync(foreignFinal, "foreign");
    await assert.rejects(() => snapshotSqliteDatabaseForTestV1(source, foreignFinal, directory), /already exists/);
    assert.equal(readFileSync(foreignFinal, "utf8"), "foreign");

    const tempTarget = join(directory, "temp-collision.sqlite");
    const foreignTemp = `${tempTarget}.tmp.${process.pid}`;
    writeFileSync(foreignTemp, "foreign-temp");
    await assert.rejects(() => snapshotSqliteDatabaseForTestV1(source, tempTarget, directory), /temporary path already exists/);
    assert.equal(readFileSync(foreignTemp, "utf8"), "foreign-temp");
    assert.equal(existsSync(tempTarget), false);

    const corrupt = join(directory, "corrupt.sqlite");
    writeFileSync(corrupt, "not-sqlite", { mode: 0o600 });
    await assert.rejects(
      () => snapshotSqliteDatabaseForTestV1(corrupt, join(directory, "corrupt-snapshot.sqlite"), directory),
      /database|malformed|file is not a database/i,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("production SQLite snapshot wrapper rejects a non-root caller before fixed-path access", async () => {
  if (process.geteuid?.() === 0) return;
  await assert.rejects(() => publishPreReleaseADurableSnapshotsV1(), /effective uid/);
});

test("root directory snapshot freezes the exact flat observer and locator denominators", () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "aloha-directory-snapshot-")));
  try {
    const content = join(directory, "content");
    const locators = join(directory, "locators");
    mkdirSync(content, { mode: 0o700 });
    mkdirSync(locators, { mode: 0o700 });
    const marker = `0x${"1".repeat(64)}\n`;
    writeFileSync(join(content, ".aloha-observer-store-identity-v1"), marker, { mode: 0o400 });
    const objectBytes = Buffer.from("durable-observer-object", "utf8");
    const objectHash = sha256Hex(objectBytes).slice(2);
    writeFileSync(join(content, objectHash), objectBytes, { mode: 0o400 });
    const locatorName = `${"a".repeat(64)}.json`;
    writeFileSync(join(locators, locatorName), "{}", { mode: 0o400 });
    const contentSnapshot = snapshotFlatDirectoryForTestV1(
      "observer-content", content, join(directory, "content-snapshot"), directory,
    ) as { readonly observerStoreIdentityHash: string | null; readonly entries: readonly { readonly name: string; readonly contentSha256: string }[] };
    const locatorSnapshot = snapshotFlatDirectoryForTestV1(
      "terminal-locator-index", locators, join(directory, "locator-snapshot"), directory,
    ) as { readonly observerStoreIdentityHash: string | null; readonly entries: readonly { readonly name: string }[] };
    assert.equal(contentSnapshot.observerStoreIdentityHash, marker.trim());
    assert.equal(locatorSnapshot.observerStoreIdentityHash, null);
    assert.deepEqual(contentSnapshot.entries.map(entry => entry.name), [".aloha-observer-store-identity-v1", objectHash]);
    assert.equal(contentSnapshot.entries[1]?.contentSha256, `0x${objectHash}`);
    assert.deepEqual(locatorSnapshot.entries.map(entry => entry.name), [locatorName]);
    assert.equal(readFileSync(join(directory, "content-snapshot", objectHash), "utf8"), "durable-observer-object");
    assert.throws(() => snapshotFlatDirectoryForTestV1(
      "observer-content", content, join(directory, "content-snapshot"), directory,
    ), /not fresh and fixed/);

    const badContent = join(directory, "bad-content");
    mkdirSync(badContent, { mode: 0o700 });
    writeFileSync(join(badContent, ".aloha-observer-store-identity-v1"), marker, { mode: 0o400 });
    writeFileSync(join(badContent, "b".repeat(64)), "wrong-hash", { mode: 0o400 });
    assert.throws(() => snapshotFlatDirectoryForTestV1(
      "observer-content", badContent, join(directory, "bad-snapshot"), directory,
    ), /name does not equal its content hash/);

    writeFileSync(join(locators, `${"b".repeat(64)}.json`), "{}", { mode: 0o400 });
    assert.throws(() => snapshotFlatDirectoryForTestV1(
      "terminal-locator-index", locators, join(directory, "extra-locator-snapshot"), directory,
    ), /denominator is not exact/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Six-Step snapshot copies only the A terminal-index closure despite 37 unrelated cache files", () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "aloha-selected-a-six-step-")));
  try {
    const locatorSource = join(directory, "locator-source");
    const boundarySource = join(directory, "boundary-source");
    mkdirSync(locatorSource, { mode: 0o700 });
    mkdirSync(boundarySource, { mode: 0o700 });
    const selectedKeys = boundaryKeys("a", 8);
    for (const key of selectedKeys) writeFileSync(join(boundarySource, `${key.slice(2)}.v8`), key, { mode: 0o400 });
    for (let index = 0; index < 37; index += 1) {
      const key = hashDomain("test/pre-release-unrelated-boundary/v1", `a:${index}`);
      writeFileSync(join(boundarySource, `${key.slice(2)}.v8`), "unrelated", { mode: 0o400 });
    }
    const locatorName = `${"a".repeat(64)}.json`;
    writeFileSync(join(locatorSource, locatorName), terminalIndexBytes(selectedKeys, `0x${"a".repeat(64)}`), { mode: 0o400 });
    const locatorSnapshot = snapshotFlatDirectoryForTestV1(
      "terminal-locator-index",
      locatorSource,
      join(directory, "locator-snapshot"),
      directory,
    ) as unknown as PreReleaseControllerDirectorySnapshotV1;
    const snapshot = snapshotSelectedSixStepBoundariesForTestV1(
      boundarySource,
      join(directory, "boundary-snapshot"),
      directory,
      locatorSnapshot,
    ) as { readonly entries: readonly { readonly name: string }[] };
    assert.deepEqual(snapshot.entries.map(entry => entry.name), selectedKeys.map(key => `${key.slice(2)}.v8`));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("non-observed terminal index freezes an empty Six-Step boundary closure", () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "aloha-empty-six-step-closure-")));
  try {
    const locatorSource = join(directory, "locator-source");
    const boundarySource = join(directory, "boundary-source");
    mkdirSync(locatorSource, { mode: 0o700 });
    mkdirSync(boundarySource, { mode: 0o700 });
    const finalDurableWindowId = `0x${"d".repeat(64)}` as Hash;
    writeFileSync(
      join(locatorSource, `${finalDurableWindowId.slice(2)}.json`),
      terminalIndexBytes([], finalDurableWindowId),
      { mode: 0o400 },
    );
    for (let index = 0; index < 37; index += 1) {
      const key = hashDomain("test/pre-release-unrelated-boundary/v1", `empty:${index}`);
      writeFileSync(join(boundarySource, `${key.slice(2)}.v8`), "unrelated", { mode: 0o400 });
    }
    const locatorSnapshot = snapshotFlatDirectoryForTestV1(
      "terminal-locator-index", locatorSource, join(directory, "locator-snapshot"), directory,
    ) as unknown as PreReleaseControllerDirectorySnapshotV1;
    const snapshot = snapshotSelectedSixStepBoundariesForTestV1(
      boundarySource,
      join(directory, "boundary-snapshot"),
      directory,
      locatorSnapshot,
    ) as { readonly entries: readonly unknown[] };
    assert.deepEqual(snapshot.entries, []);

    const oneLegLocatorSource = join(directory, "one-leg-locator-source");
    mkdirSync(oneLegLocatorSource, { mode: 0o700 });
    const oneLegWindowId = `0x${"e".repeat(64)}` as Hash;
    writeFileSync(
      join(oneLegLocatorSource, `${oneLegWindowId.slice(2)}.json`),
      terminalIndexBytes(boundaryKeys("one-leg", 6), oneLegWindowId),
      { mode: 0o400 },
    );
    const oneLegLocatorSnapshot = snapshotFlatDirectoryForTestV1(
      "terminal-locator-index",
      oneLegLocatorSource,
      join(directory, "one-leg-locator-snapshot"),
      directory,
    ) as unknown as PreReleaseControllerDirectorySnapshotV1;
    assert.throws(() => snapshotSelectedSixStepBoundariesForTestV1(
      boundarySource,
      join(directory, "one-leg-boundary-snapshot"),
      directory,
      oneLegLocatorSnapshot,
    ), /2L\+4/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Six-Step B snapshot selects the unique new terminal index and fails closed on missing or replaced selected files", () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "aloha-selected-b-six-step-")));
  try {
    const aLocatorSource = join(directory, "a-locator-source");
    const bLocatorSource = join(directory, "b-locator-source");
    const boundarySource = join(directory, "boundary-source");
    mkdirSync(aLocatorSource, { mode: 0o700 });
    mkdirSync(bLocatorSource, { mode: 0o700 });
    mkdirSync(boundarySource, { mode: 0o700 });
    const aKeys = boundaryKeys("a", 8);
    const bKeys = boundaryKeys("b", 8);
    const aName = `${"a".repeat(64)}.json`;
    const bName = `${"b".repeat(64)}.json`;
    writeFileSync(join(aLocatorSource, aName), terminalIndexBytes(aKeys, `0x${"a".repeat(64)}`), { mode: 0o400 });
    writeFileSync(join(bLocatorSource, aName), terminalIndexBytes(aKeys, `0x${"a".repeat(64)}`), { mode: 0o400 });
    writeFileSync(join(bLocatorSource, bName), terminalIndexBytes(bKeys, `0x${"b".repeat(64)}`), { mode: 0o400 });
    for (const key of bKeys) writeFileSync(join(boundarySource, `${key.slice(2)}.v8`), key, { mode: 0o400 });
    const aLocatorSnapshot = snapshotFlatDirectoryForTestV1(
      "terminal-locator-index", aLocatorSource, join(directory, "a-locator-snapshot"), directory,
    ) as unknown as PreReleaseControllerDirectorySnapshotV1;
    assert.equal(aLocatorSnapshot.entries.length, 1);
    const bLocatorSnapshot = snapshotFlatDirectoryForTestV1(
      "terminal-locator-index", bLocatorSource, join(directory, "b-locator-snapshot"), directory, 2,
    ) as unknown as PreReleaseControllerDirectorySnapshotV1;
    const replacedPredecessorSource = join(directory, "replaced-predecessor-locator-source");
    mkdirSync(replacedPredecessorSource, { mode: 0o700 });
    writeFileSync(
      join(replacedPredecessorSource, aName),
      terminalIndexBytes(boundaryKeys("self-consistent-replaced-a", 6), `0x${"a".repeat(64)}`),
      { mode: 0o400 },
    );
    writeFileSync(
      join(replacedPredecessorSource, bName),
      terminalIndexBytes(bKeys, `0x${"b".repeat(64)}`),
      { mode: 0o400 },
    );
    const replacedPredecessorSnapshot = snapshotFlatDirectoryForTestV1(
      "terminal-locator-index",
      replacedPredecessorSource,
      join(directory, "replaced-predecessor-locator-snapshot"),
      directory,
      2,
    ) as unknown as PreReleaseControllerDirectorySnapshotV1;
    assert.throws(() => snapshotSelectedSixStepBoundariesForTestV1(
      boundarySource,
      join(directory, "replaced-predecessor-boundary-snapshot"),
      directory,
      replacedPredecessorSnapshot,
      join(directory, "a-locator-snapshot"),
    ), /predecessor content does not equal/i);
    const selected = snapshotSelectedSixStepBoundariesForTestV1(
      boundarySource,
      join(directory, "b-boundary-snapshot"),
      directory,
      bLocatorSnapshot,
      join(directory, "a-locator-snapshot"),
    ) as { readonly entries: readonly { readonly name: string }[] };
    assert.deepEqual(selected.entries.map(entry => entry.name), bKeys.map(key => `${key.slice(2)}.v8`));

    const missingSource = join(directory, "missing-boundary-source");
    mkdirSync(missingSource, { mode: 0o700 });
    for (const key of bKeys.slice(1)) writeFileSync(join(missingSource, `${key.slice(2)}.v8`), key, { mode: 0o400 });
    assert.throws(() => snapshotSelectedSixStepBoundariesForTestV1(
      missingSource,
      join(directory, "missing-boundary-snapshot"),
      directory,
      bLocatorSnapshot,
      join(directory, "a-locator-snapshot"),
    ), /ENOENT|source entry/i);

    const replacedSource = join(directory, "replaced-boundary-source");
    mkdirSync(replacedSource, { mode: 0o700 });
    const replacement = join(directory, "replacement.v8");
    writeFileSync(replacement, "replacement", { mode: 0o400 });
    for (const key of bKeys) writeFileSync(join(replacedSource, `${key.slice(2)}.v8`), key, { mode: 0o400 });
    unlinkSync(join(replacedSource, `${bKeys[0]!.slice(2)}.v8`));
    linkSync(replacement, join(replacedSource, `${bKeys[0]!.slice(2)}.v8`));
    assert.throws(() => snapshotSelectedSixStepBoundariesForTestV1(
      replacedSource,
      join(directory, "replaced-boundary-snapshot"),
      directory,
      bLocatorSnapshot,
      join(directory, "a-locator-snapshot"),
    ), /byte policy|immutable/i);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Six-Step selector rejects jointly rewritten keys and key root under the old terminal index root", () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "aloha-six-step-index-root-mutation-")));
  try {
    const locatorSource = join(directory, "locator-source");
    const boundarySource = join(directory, "boundary-source");
    mkdirSync(locatorSource, { mode: 0o700 });
    mkdirSync(boundarySource, { mode: 0o700 });
    const finalDurableWindowId = `0x${"c".repeat(64)}` as Hash;
    const original = decodeCanonicalJson(terminalIndexBytes(boundaryKeys("original", 8), finalDurableWindowId));
    assert.equal(typeof original, "object");
    const replacementKeys = boundaryKeys("replacement", 8);
    const rewritten = {
      ...(original as Record<string, unknown>),
      sixStepBoundaryKeys: replacementKeys,
      sixStepBoundaryKeyRoot: hashCanonicalPartition(BOUNDARY_KEY_SEQUENCE_DOMAIN, replacementKeys, 16),
    };
    writeFileSync(
      join(locatorSource, `${finalDurableWindowId.slice(2)}.json`),
      encodeCanonicalBytes(rewritten as never),
      { mode: 0o400 },
    );
    const locatorSnapshot = snapshotFlatDirectoryForTestV1(
      "terminal-locator-index", locatorSource, join(directory, "locator-snapshot"), directory,
    ) as unknown as PreReleaseControllerDirectorySnapshotV1;
    assert.throws(() => snapshotSelectedSixStepBoundariesForTestV1(
      boundarySource,
      join(directory, "boundary-snapshot"),
      directory,
      locatorSnapshot,
    ), /index root mismatch/i);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Six-Step selected index, boundary files, aggregate, and ledger are rejected from metadata before content allocation", () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "aloha-six-step-pre-read-bounds-")));
  try {
    const locatorSource = join(directory, "locator-source");
    const boundarySource = join(directory, "boundary-source");
    mkdirSync(locatorSource, { mode: 0o700 });
    mkdirSync(boundarySource, { mode: 0o700 });
    const locatorPath = join(locatorSource, `${"a".repeat(64)}.json`);
    writeFileSync(locatorPath, "", { mode: 0o600 });
    truncateSync(locatorPath, CANONICAL_LIMITS.maxBytes + 1);
    chmodSync(locatorPath, 0o400);
    assert.throws(() => snapshotFlatDirectoryForTestV1(
      "terminal-locator-index", locatorSource, join(directory, "locator-snapshot"), directory,
    ), /byte policy/i);

    const selectedKeys = boundaryKeys("oversized", 8);
    const exactLocatorSource = join(directory, "exact-locator-source");
    mkdirSync(exactLocatorSource, { mode: 0o700 });
    writeFileSync(
      join(exactLocatorSource, `${"b".repeat(64)}.json`),
      terminalIndexBytes(selectedKeys, `0x${"b".repeat(64)}`),
      { mode: 0o400 },
    );
    const exactLocatorSnapshot = snapshotFlatDirectoryForTestV1(
      "terminal-locator-index", exactLocatorSource, join(directory, "exact-locator-snapshot"), directory,
    ) as unknown as PreReleaseControllerDirectorySnapshotV1;
    const oversizedBoundary = join(boundarySource, `${selectedKeys[0]!.slice(2)}.v8`);
    for (const key of selectedKeys.slice(1)) {
      writeFileSync(join(boundarySource, `${key.slice(2)}.v8`), key, { mode: 0o400 });
    }
    writeFileSync(oversizedBoundary, "", { mode: 0o600 });
    truncateSync(oversizedBoundary, PRE_RELEASE_SIX_STEP_BOUNDARY_SNAPSHOT_LIMITS_V1.maxEntryBytes + 1);
    chmodSync(oversizedBoundary, 0o400);
    assert.throws(() => snapshotSelectedSixStepBoundariesForTestV1(
      boundarySource,
      join(directory, "oversized-boundary-snapshot"),
      directory,
      exactLocatorSnapshot,
    ), /byte policy/i);

    const aggregateKeys = boundaryKeys("aggregate", 10);
    const aggregateLocatorSource = join(directory, "aggregate-locator-source");
    const aggregateBoundarySource = join(directory, "aggregate-boundary-source");
    mkdirSync(aggregateLocatorSource, { mode: 0o700 });
    mkdirSync(aggregateBoundarySource, { mode: 0o700 });
    writeFileSync(
      join(aggregateLocatorSource, `${"c".repeat(64)}.json`),
      terminalIndexBytes(aggregateKeys, `0x${"c".repeat(64)}`),
      { mode: 0o400 },
    );
    const aggregateLocatorSnapshot = snapshotFlatDirectoryForTestV1(
      "terminal-locator-index",
      aggregateLocatorSource,
      join(directory, "aggregate-locator-snapshot"),
      directory,
    ) as unknown as PreReleaseControllerDirectorySnapshotV1;
    for (const key of aggregateKeys) {
      const path = join(aggregateBoundarySource, `${key.slice(2)}.v8`);
      writeFileSync(path, "", { mode: 0o600 });
      truncateSync(path, PRE_RELEASE_SIX_STEP_BOUNDARY_SNAPSHOT_LIMITS_V1.maxEntryBytes);
      chmodSync(path, 0o400);
    }
    assert.throws(() => snapshotSelectedSixStepBoundariesForTestV1(
      aggregateBoundarySource,
      join(directory, "aggregate-boundary-snapshot"),
      directory,
      aggregateLocatorSnapshot,
    ), /aggregate exceeds policy/i);

    const ledger = join(directory, "oversized-evidence.jsonl");
    writeFileSync(ledger, "", { mode: 0o600 });
    truncateSync(ledger, PRE_RELEASE_SIX_STEP_BOUNDARY_SNAPSHOT_LIMITS_V1.maxLedgerBytes + 1);
    assert.throws(() => readBoundedPhysicalFileForTestV1(
      ledger,
      PRE_RELEASE_SIX_STEP_BOUNDARY_SNAPSHOT_LIMITS_V1.maxLedgerBytes,
    ), /byte length/i);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("receipt reopen uses one descriptor and rejects oversized or path-swapped ledgers before redirected content read", () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "aloha-ledger-reopen-fence-")));
  try {
    const uid = BigInt(process.getuid!());
    const gid = BigInt(process.getgid!());
    const policy = Object.freeze({ uid, gid, mode: 0o600n, maximumByteLength: 1024n });
    const oversized = join(directory, "oversized.jsonl");
    writeFileSync(oversized, "", { mode: 0o600 });
    truncateSync(oversized, 1025);
    let postPreflightCalled = false;
    assert.throws(() => readStableOwnedPhysicalFileV1(oversized, policy, () => {
      postPreflightCalled = true;
    }), /size mismatch/i);
    assert.equal(postPreflightCalled, false, "oversized file is rejected before any content-read hook");

    const swapped = join(directory, "swapped.jsonl");
    const original = join(directory, "original.jsonl");
    writeFileSync(swapped, "small", { mode: 0o600 });
    assert.throws(() => readStableOwnedPhysicalFileV1(swapped, policy, () => {
      renameSync(swapped, original);
      writeFileSync(swapped, "", { mode: 0o600 });
      truncateSync(swapped, 1025);
    }), /changed during read/i);
    assert.equal(readFileSync(original, "utf8"), "small");

    const grown = join(directory, "grown.jsonl");
    writeFileSync(grown, "small", { mode: 0o600 });
    const grownInode = statSync(grown, { bigint: true }).ino;
    assert.throws(() => readStableOwnedPhysicalFileV1(grown, policy, () => {
      writeFileSync(grown, "-same-inode-growth", { flag: "a" });
    }), /changed during read/i);
    assert.equal(statSync(grown, { bigint: true }).ino, grownInode);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("selected Six-Step aggregate keeps each preflight descriptor through the bounded content read", () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "aloha-six-step-retained-fd-")));
  try {
    const keys = boundaryKeys("retained-fd", 8);
    const locatorSource = join(directory, "locator-source");
    const boundarySource = join(directory, "boundary-source");
    mkdirSync(locatorSource, { mode: 0o700 });
    mkdirSync(boundarySource, { mode: 0o700 });
    writeFileSync(
      join(locatorSource, `${"d".repeat(64)}.json`),
      terminalIndexBytes(keys, `0x${"d".repeat(64)}`),
      { mode: 0o400 },
    );
    const locatorSnapshot = snapshotFlatDirectoryForTestV1(
      "terminal-locator-index",
      locatorSource,
      join(directory, "locator-snapshot"),
      directory,
    ) as unknown as PreReleaseControllerDirectorySnapshotV1;
    for (const key of keys) {
      writeFileSync(join(boundarySource, `${key.slice(2)}.v8`), key, { mode: 0o400 });
    }
    const grown = join(boundarySource, `${keys[0]!.slice(2)}.v8`);
    const grownInode = statSync(grown, { bigint: true }).ino;
    assert.throws(() => snapshotSelectedSixStepBoundariesForTestV1(
      boundarySource,
      join(directory, "boundary-snapshot"),
      directory,
      locatorSnapshot,
      null,
      () => {
        chmodSync(grown, 0o600);
        writeFileSync(grown, "-same-inode-growth", { flag: "a" });
        chmodSync(grown, 0o400);
      },
    ), /source entry changed/i);
    assert.equal(statSync(grown, { bigint: true }).ino, grownInode);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("structural counterfeits and non-owner host invocation fail closed", async () => {
  assert.throws(() => decodePreReleaseRestartControllerReceiptV1({
    schemaVersion: 1,
    kind: "aloha.pre-release-restart-controller-receipt",
    controller: {},
    target: {},
    pre: {},
    action: {},
    post: {},
    publication: {},
    receiptId: `0x${"1".repeat(64)}`,
  }), /exact keys|fixed|missing/i);
  await assert.rejects(runPreReleaseRestartControllerV1(), /entrypoint or argv is not fixed/);
});

test("round lock binds the exact controller implementation and invocation", () => {
  const lock = sealPreReleaseRestartControllerRoundLockV1({
    implementationIdentityHash: `0x${"1".repeat(64)}`,
    controllerPid: "123",
    acquiredAtUnixNs: "456",
  });
  assert.deepEqual(decodePreReleaseRestartControllerRoundLockV1(lock), lock);
  assert.throws(() => decodePreReleaseRestartControllerRoundLockV1({ ...lock, controllerPid: "124" }), /lock id mismatch/);
  assert.throws(() => decodePreReleaseRestartControllerRoundLockV1({ ...lock, implementationIdentityHash: `0x${"2".repeat(64)}` }), /lock id mismatch/);
  assert.throws(() => decodePreReleaseRestartControllerRoundLockV1({ ...lock, extra: true }), /unknown field|exact keys/);
});

test("controller build is one isolated deterministic closure (not release evidence)", () => {
  const repositoryRoot = realpathSync(fileURLToPath(new URL("../../..", import.meta.url)));
  const first = buildPreReleaseRestartControllerBundleV1(repositoryRoot);
  const second = buildPreReleaseRestartControllerBundleV1(repositoryRoot);
  assert.equal(first.sha256, second.sha256);
  assert.equal(first.sourceInputRoot, second.sourceInputRoot);
  assert.equal(first.metafileRoot, second.metafileRoot);
  assert.equal(first.implementationClosureDigest, second.implementationClosureDigest);
  assert.deepEqual(first.externalBuiltins, ["node:child_process", "node:crypto", "node:fs", "node:sqlite", "node:util"]);
  assert.ok(first.sourceInputs.length > 0);
  assert.ok(first.sourceInputs.every(input => !input.path.startsWith("apps/") && !input.path.startsWith("acceptance/") && !input.path.includes("generated/")));
  assert.equal(first.installContract.searcherRuntimeBundleMember, false);
  assert.equal(first.installContract.buildSource, "exact-pushed-commit-tree");
});
