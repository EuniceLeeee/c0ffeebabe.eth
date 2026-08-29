import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { sha256Hex } from "../../../packages/canonical-codec/src/index.ts";
import { atomicNoClobberPublishV1 } from "../src/atomic-file.ts";
import { buildPreReleaseRestartControllerBundleV1 } from "../src/bundle-builder.ts";
import { runPreReleaseRestartControllerV1 } from "../src/controller-owner.ts";
import {
  assertPreReleaseProcessPreDenominatorV1,
  publishPreReleaseADurableSnapshotsV1,
  snapshotFlatDirectoryForTestV1,
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
  PRE_RELEASE_RESTART_CONTROLLER_UNIT_V1,
  sealPreReleaseRestartControllerRoundLockV1,
} from "../src/spec.ts";

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
