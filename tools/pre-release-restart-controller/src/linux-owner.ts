import {
  constants as fsConstants,
  lstatSync,
  openSync,
  closeSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  statSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import {
  encodeCanonicalBytes,
  hashDomain,
  sha256Hex,
  type Hash,
} from "../../../packages/canonical-codec/src/index.ts";
import {
  PRE_RELEASE_RESTART_CONTROLLER_LAYOUT_V1 as LAYOUT,
  PRE_RELEASE_RESTART_CONTROLLER_UNIT_V1,
  PRE_RELEASE_RESTART_TARGET_UNIT_V1,
  type PreReleaseControllerProcessObservationV1,
  type PreReleaseControllerCommandFactV1,
  type PreReleaseControllerFrozenStateProofV1,
  type PreReleaseControllerSystemdObservationV1,
  type PreReleaseControllerThawedStateProofV1,
  type PreReleaseRestartControllerOwnerProcessObservationV1,
} from "./spec.ts";

const SYSTEMD_PROPERTIES = Object.freeze([
  "Id",
  "FragmentPath",
  "LoadState",
  "ActiveState",
  "SubState",
  "MainPID",
  "InvocationID",
  "ControlGroup",
  "Result",
  "ExecMainCode",
  "ExecMainStatus",
  "Restart",
] as const);

const SYSTEMD_KEYS = new Set<string>(SYSTEMD_PROPERTIES);
const DECIMAL = /^(0|[1-9][0-9]*)$/;
const INVOCATION_ID = /^[0-9a-f]{32}$/;
const BOOT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function unixNs(): string {
  return (BigInt(Date.now()) * 1_000_000n).toString();
}

const SYSTEMCTL_ENV = Object.freeze({ PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" });

export interface StableFileFenceV1 {
  readonly device: string;
  readonly inode: string;
  readonly size: string;
  readonly mtimeUnixNs: string;
  readonly ctimeUnixNs: string;
}

function fence(stat: ReturnType<typeof statSync>): StableFileFenceV1 {
  const value = stat as unknown as { readonly dev: bigint; readonly ino: bigint; readonly size: bigint; readonly mtimeNs: bigint; readonly ctimeNs: bigint };
  return Object.freeze({ device: String(value.dev), inode: String(value.ino), size: String(value.size), mtimeUnixNs: String(value.mtimeNs), ctimeUnixNs: String(value.ctimeNs) });
}

export function assertStableFileReadFenceV1(before: StableFileFenceV1, after: StableFileFenceV1, bytes: Uint8Array): Hash {
  if (!Buffer.from(encodeCanonicalBytes(before)).equals(Buffer.from(encodeCanonicalBytes(after))) || before.size !== String(bytes.byteLength)) {
    throw new TypeError("physical file changed during observation");
  }
  return sha256Hex(bytes);
}

export function assertStableVirtualFileReadFenceV1(before: StableFileFenceV1, after: StableFileFenceV1, bytes: Uint8Array): Hash {
  if (before.device !== after.device || before.inode !== after.inode
    || before.mtimeUnixNs !== after.mtimeUnixNs || before.ctimeUnixNs !== after.ctimeUnixNs) {
    throw new TypeError("virtual physical file changed during observation");
  }
  return sha256Hex(bytes);
}

function readConcrete(path: string): Uint8Array {
  const before = statSync(path, { bigint: true });
  const bytes = new Uint8Array(readFileSync(path));
  const after = statSync(path, { bigint: true });
  if (!before.isFile() || !after.isFile()) throw new TypeError(`physical path is not a file: ${path}`);
  assertStableFileReadFenceV1(fence(before), fence(after), bytes);
  return bytes;
}

function exactPhysicalFile(path: string, expectedUid: bigint | null = null): Readonly<{ readonly path: string; readonly device: string; readonly inode: string }> {
  if (!path.startsWith("/") || realpathSync(path) !== path || !lstatSync(path).isFile()) throw new TypeError(`path is not a canonical regular file: ${path}`);
  const before = statSync(path, { bigint: true });
  const after = statSync(path, { bigint: true });
  if (before.dev !== after.dev || before.ino !== after.ino || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) throw new TypeError(`physical file identity changed: ${path}`);
  if (expectedUid !== null && after.uid !== expectedUid) throw new TypeError(`physical file is not owned by uid ${expectedUid}: ${path}`);
  if ((after.mode & 0o022n) !== 0n) throw new TypeError(`physical file is group/world writable: ${path}`);
  return Object.freeze({ path, device: String(after.dev), inode: String(after.ino) });
}

export function parseFixedSystemdShowV1(output: string): Readonly<Record<string, string>> {
  const values = new Map<string, string>();
  for (const line of output.split("\n")) {
    if (line.length === 0) continue;
    const separator = line.indexOf("=");
    if (separator <= 0) throw new TypeError("systemctl show returned a malformed property");
    const key = line.slice(0, separator);
    if (!SYSTEMD_KEYS.has(key) || values.has(key)) throw new TypeError(`systemctl show returned an unexpected or duplicate property: ${key}`);
    values.set(key, line.slice(separator + 1));
  }
  if (values.size !== SYSTEMD_PROPERTIES.length) throw new TypeError("systemctl show did not return the exact property denominator");
  return Object.freeze(Object.fromEntries(values));
}

function readFixedSystemdProperties(unit: string): Readonly<Record<string, string>> {
  exactPhysicalFile(LAYOUT.systemctlPath, 0n);
  const output = execFileSync(LAYOUT.systemctlPath, [
    "show",
    unit,
    "--no-pager",
    ...SYSTEMD_PROPERTIES.map(property => `--property=${property}`),
  ], {
    encoding: "utf8",
    env: SYSTEMCTL_ENV,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 10_000,
    maxBuffer: 64 * 1024,
  });
  return parseFixedSystemdShowV1(output);
}

export function parseFixedCgroupTasksV1(output: string, expectedMainPid: string): readonly string[] {
  if (!/^[1-9][0-9]*$/.test(expectedMainPid)) throw new TypeError("expected cgroup main PID must be positive decimal");
  const rows = output.trimEnd().split("\n");
  if (rows.length === 0 || rows.some(row => !/^[1-9][0-9]*$/.test(row)) || new Set(rows).size !== rows.length) {
    throw new TypeError("frozen cgroup task denominator is not a non-empty unique PID set");
  }
  const tasks = [...rows].sort((left, right) => BigInt(left) < BigInt(right) ? -1 : BigInt(left) > BigInt(right) ? 1 : 0);
  if (!tasks.includes(expectedMainPid)) throw new TypeError("frozen cgroup task denominator does not contain the anchored main PID");
  return Object.freeze(tasks);
}

export function parseFixedFreezerStateV1<const T extends "frozen" | "running">(output: string, expected: T): T {
  if (output !== `${expected}\n`) throw new TypeError(`systemd freezer state is not exactly ${expected}`);
  return expected;
}

export function observeFixedPreReleaseUnitV1(): PreReleaseControllerSystemdObservationV1 {
  const values = readFixedSystemdProperties(LAYOUT.targetSystemdUnit);
  if (values.Id !== LAYOUT.targetSystemdUnit || values.FragmentPath !== LAYOUT.targetSystemdUnitPath) throw new TypeError("systemd target unit identity mismatch");
  if (values.LoadState !== "loaded") throw new TypeError("systemd target unit is not loaded");
  if (!DECIMAL.test(values.MainPID ?? "")) throw new TypeError("systemd MainPID is not decimal");
  if (!DECIMAL.test(values.ExecMainCode ?? "") || !DECIMAL.test(values.ExecMainStatus ?? "")) throw new TypeError("systemd exec result is not the raw waitid decimal contract");
  if ((values.InvocationID ?? "") !== "" && !INVOCATION_ID.test(values.InvocationID!)) throw new TypeError("systemd InvocationID is malformed");
  if ((values.ControlGroup ?? "") !== "" && !values.ControlGroup!.startsWith("/")) throw new TypeError("systemd ControlGroup is malformed");
  return Object.freeze({
    id: LAYOUT.targetSystemdUnit,
    fragmentPath: LAYOUT.targetSystemdUnitPath,
    loadState: values.LoadState!,
    activeState: values.ActiveState!,
    subState: values.SubState!,
    mainPid: values.MainPID!,
    invocationId: values.InvocationID!,
    controlGroup: values.ControlGroup!,
    result: values.Result!,
    execMainCode: values.ExecMainCode!,
    execMainStatus: values.ExecMainStatus!,
    restart: values.Restart! as "no",
    observedAtUnixNs: unixNs(),
  });
}

function procPath(pid: string, leaf: string): string {
  if (!/^[1-9][0-9]*$/.test(pid)) throw new TypeError("process PID must be positive decimal");
  return `${LAYOUT.procRoot}/${pid}/${leaf}`;
}

export function parseProcStartTicksV1(stat: string, expectedPid: string): string {
  const close = stat.lastIndexOf(")");
  if (!stat.startsWith(`${expectedPid} (`)) throw new TypeError("/proc stat prefix is invalid");
  if (close < 2) throw new TypeError("/proc stat command is invalid");
  const fields = stat.slice(close + 1).trim().split(/ +/);
  const startTicks = fields[19];
  if (startTicks === undefined || !DECIMAL.test(startTicks)) throw new TypeError("/proc stat start ticks are invalid");
  return startTicks;
}

function parseStatusUid(status: string): string {
  const lines = status.split("\n").filter(line => line.startsWith("Uid:"));
  if (lines.length !== 1) throw new TypeError("/proc status has no exact Uid row");
  const values = lines[0]!.slice(4).trim().split(/\s+/);
  if (values.length !== 4 || values.some(value => !DECIMAL.test(value)) || new Set(values).size !== 1) throw new TypeError("pre-release process changes uid across real/effective/saved/fs identities");
  return values[0]!;
}

function parseInvocationId(environ: Uint8Array): string {
  const entries = Buffer.from(environ).toString("utf8").split("\0").filter(Boolean);
  const values = entries.filter(entry => entry.startsWith("INVOCATION_ID=")).map(entry => entry.slice("INVOCATION_ID=".length));
  if (values.length !== 1 || !INVOCATION_ID.test(values[0]!)) throw new TypeError("/proc environment has no exact systemd InvocationID");
  return values[0]!;
}

function parseCgroup(value: string): string {
  const lines = value.trimEnd().split("\n");
  if (lines.length !== 1 || !lines[0]!.startsWith("0::/")) throw new TypeError("pre-release process must have one cgroup-v2 identity");
  return lines[0]!.slice(3);
}

function parseArgv<const T extends string>(value: Uint8Array, expectedEntrypoint: T): readonly [typeof LAYOUT.targetNodePath, T] {
  const args = Buffer.from(value).toString("utf8").split("\0");
  if (args.at(-1) !== "") throw new TypeError("/proc cmdline is not NUL terminated");
  args.pop();
  if (args.length !== 2 || args[0] !== LAYOUT.targetNodePath || args[1] !== expectedEntrypoint) throw new TypeError("pre-release process argv is not the fixed owner command");
  return Object.freeze([LAYOUT.targetNodePath, expectedEntrypoint]);
}

function observeProcessIdentity<const T extends string>(
  pid: string,
  invocationIdExpected: string,
  controlGroupExpected: string,
  expectedEntrypoint: T,
) {
  const statBefore = readFileSync(procPath(pid, "stat"), "utf8");
  const processStartTicks = parseProcStartTicksV1(statBefore, pid);
  const bootId = readFileSync(`${LAYOUT.procRoot}/sys/kernel/random/boot_id`, "utf8").trim();
  if (!BOOT_ID.test(bootId)) throw new TypeError("kernel boot id is malformed");
  const invocationId = parseInvocationId(new Uint8Array(readFileSync(procPath(pid, "environ"))));
  const controlGroup = parseCgroup(readFileSync(procPath(pid, "cgroup"), "utf8"));
  const executableLink = readlinkSync(procPath(pid, "exe"));
  const executablePath = realpathSync(procPath(pid, "exe"));
  if (executableLink.endsWith(" (deleted)") || executablePath !== LAYOUT.targetNodePath) throw new TypeError("pre-release process executable is not the fixed physical node binary");
  const executableIdentity = exactPhysicalFile(executablePath, 0n);
  const executableSha256 = sha256Hex(readConcrete(executablePath));
  const argv = parseArgv(new Uint8Array(readFileSync(procPath(pid, "cmdline"))), expectedEntrypoint);
  const uid = parseStatusUid(readFileSync(procPath(pid, "status"), "utf8"));
  const statAfter = readFileSync(procPath(pid, "stat"), "utf8");
  if (parseProcStartTicksV1(statAfter, pid) !== processStartTicks || invocationId !== invocationIdExpected || controlGroup !== controlGroupExpected) throw new TypeError("pre-release process identity changed during /proc observation");
  const bootIdHash = hashDomain("aloha/runtime-boot-id/v1", bootId);
  const argvSha256 = sha256Hex(Buffer.from([...argv, ""].join("\0")));
  const identity = Object.freeze({
    pid,
    processStartTicks,
    bootId,
    bootIdHash,
    invocationId,
    controlGroup,
    executablePath: LAYOUT.targetNodePath,
    executableSha256,
    executableDevice: executableIdentity.device,
    executableInode: executableIdentity.inode,
    argv,
    argvSha256,
    uid,
  });
  return identity;
}

export function observeFixedPreReleaseProcessV1(systemd: PreReleaseControllerSystemdObservationV1): PreReleaseControllerProcessObservationV1 {
  if (systemd.activeState !== "active" || systemd.subState !== "running" || systemd.mainPid === "0"
    || !INVOCATION_ID.test(systemd.invocationId) || !systemd.controlGroup.startsWith("/")) {
    throw new TypeError("pre-release A is not one active/running systemd main process");
  }
  const identity = observeProcessIdentity(systemd.mainPid, systemd.invocationId, systemd.controlGroup, LAYOUT.targetEntrypointPath);
  return Object.freeze({ ...identity, processIdentityHash: hashDomain("aloha/pre-release-controller-process-identity/v1", identity) });
}

export function observeFixedPreReleaseControllerOwnerV1(): PreReleaseRestartControllerOwnerProcessObservationV1 {
  const values = readFixedSystemdProperties(LAYOUT.controllerSystemdUnit);
  if (values.Id !== LAYOUT.controllerSystemdUnit || values.FragmentPath !== LAYOUT.controllerSystemdUnitPath
    || values.LoadState !== "loaded" || values.ActiveState !== "activating" || values.SubState !== "start"
    || values.MainPID !== String(process.pid) || !INVOCATION_ID.test(values.InvocationID ?? "")
    || !(values.ControlGroup ?? "").startsWith("/") || values.Restart !== "no") {
    throw new TypeError("restart controller is not the exact systemd-owned oneshot main process");
  }
  const identity = observeProcessIdentity(values.MainPID!, values.InvocationID!, values.ControlGroup!, LAYOUT.controllerEntrypointPath);
  if (identity.uid !== "0") throw new TypeError("restart controller process is not root-owned");
  const ownerIdentity = Object.freeze({ ...identity, uid: "0" as const });
  return Object.freeze({
    ...ownerIdentity,
    processIdentityHash: hashDomain("aloha/pre-release-restart-controller-owner-process-identity/v1", ownerIdentity),
  });
}

export function assertFixedPreReleaseUnitBytesV1(): Hash {
  const expected = new TextEncoder().encode(PRE_RELEASE_RESTART_TARGET_UNIT_V1);
  const observed = readConcrete(LAYOUT.targetSystemdUnitPath);
  if (observed.byteLength !== expected.byteLength || observed.some((byte, index) => byte !== expected[index])) throw new TypeError("installed pre-release systemd unit is not canonical");
  return sha256Hex(observed);
}

function fixedSystemctlCommand(args: readonly string[]): PreReleaseControllerCommandFactV1 {
  exactPhysicalFile(LAYOUT.systemctlPath, 0n);
  const invokedAtUnixNs = unixNs();
  execFileSync(LAYOUT.systemctlPath, [...args], {
    env: SYSTEMCTL_ENV,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 10_000,
    maxBuffer: 64 * 1024,
  });
  return Object.freeze({
    commandIdentityHash: hashDomain("aloha/pre-release-controller-systemctl-command/v1", { executable: LAYOUT.systemctlPath, args }),
    invokedAtUnixNs,
  });
}

function fixedFreezerState<const T extends "frozen" | "running">(expected: T): T {
  exactPhysicalFile(LAYOUT.systemctlPath, 0n);
  const output = execFileSync(LAYOUT.systemctlPath, [
    "show",
    LAYOUT.targetSystemdUnit,
    "--no-pager",
    "--property=FreezerState",
    "--value",
  ], {
    encoding: "utf8",
    env: SYSTEMCTL_ENV,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 10_000,
    maxBuffer: 4 * 1024,
  });
  return parseFixedFreezerStateV1(output, expected);
}

function exactCgroupPath(controlGroup: string): string {
  if (!controlGroup.startsWith("/") || controlGroup.includes("..") || controlGroup.includes("\0")) throw new TypeError("systemd control group path is invalid");
  const path = `${LAYOUT.cgroupRoot}${controlGroup}`;
  if (realpathSync(path) !== path || !lstatSync(path).isDirectory()) throw new TypeError("systemd control group is not one canonical cgroup-v2 directory");
  const identity = statSync(path, { bigint: true });
  if (identity.uid !== 0n || (identity.mode & 0o022n) !== 0n) throw new TypeError("systemd control group is not root-owned and protected from group/world writes");
  return path;
}

function readCgroupState(path: string, leaf: "cgroup.freeze" | "cgroup.procs"): string {
  const physical = `${path}/${leaf}`;
  if (realpathSync(physical) !== physical || !lstatSync(physical).isFile()) throw new TypeError(`cgroup state path is not canonical: ${leaf}`);
  const before = statSync(physical, { bigint: true });
  const bytes = new Uint8Array(readFileSync(physical));
  const after = statSync(physical, { bigint: true });
  assertStableVirtualFileReadFenceV1(fence(before), fence(after), bytes);
  return Buffer.from(bytes).toString("utf8");
}

export function invokeFixedPreReleaseFreezeV1(): PreReleaseControllerCommandFactV1 {
  return fixedSystemctlCommand(Object.freeze(["freeze", LAYOUT.targetSystemdUnit]));
}

export function observeFixedPreReleaseFrozenCgroupV1(process: PreReleaseControllerProcessObservationV1): PreReleaseControllerFrozenStateProofV1 {
  const systemdFreezerState = fixedFreezerState("frozen");
  const cgroupPath = exactCgroupPath(process.controlGroup);
  const cgroupFreeze = readCgroupState(cgroupPath, "cgroup.freeze");
  if (cgroupFreeze !== "1\n") throw new TypeError("kernel cgroup freezer state is not exactly frozen");
  const taskPids = parseFixedCgroupTasksV1(readCgroupState(cgroupPath, "cgroup.procs"), process.pid);
  const tasks = Object.freeze(taskPids.map(pid => {
    const statBefore = readFileSync(procPath(pid, "stat"), "utf8");
    const processStartTicks = parseProcStartTicksV1(statBefore, pid);
    const controlGroup = parseCgroup(readFileSync(procPath(pid, "cgroup"), "utf8"));
    const statAfter = readFileSync(procPath(pid, "stat"), "utf8");
    if (controlGroup !== process.controlGroup || parseProcStartTicksV1(statAfter, pid) !== processStartTicks) {
      throw new TypeError("frozen cgroup task identity or membership changed during observation");
    }
    return Object.freeze({ pid, processStartTicks, controlGroup });
  }));
  const taskSetRoot = hashDomain("aloha/pre-release-controller-frozen-cgroup-task-set/v1", tasks);
  const observedAtUnixNs = unixNs();
  return Object.freeze({
    systemdFreezerState,
    cgroupPath,
    cgroupFreeze: "1" as const,
    tasks,
    taskSetRoot,
    observedAtUnixNs,
    stableReobservedAtUnixNs: observedAtUnixNs,
  });
}

export function bindStablePreReleaseFrozenCgroupV1(
  first: PreReleaseControllerFrozenStateProofV1,
  second: PreReleaseControllerFrozenStateProofV1,
): PreReleaseControllerFrozenStateProofV1 {
  const identity = (value: PreReleaseControllerFrozenStateProofV1) => Object.freeze({
    systemdFreezerState: value.systemdFreezerState,
    cgroupPath: value.cgroupPath,
    cgroupFreeze: value.cgroupFreeze,
    tasks: value.tasks,
    taskSetRoot: value.taskSetRoot,
  });
  if (!Buffer.from(encodeCanonicalBytes(identity(first))).equals(Buffer.from(encodeCanonicalBytes(identity(second))))) {
    throw new TypeError("frozen cgroup task set changed across the durable recheck");
  }
  return Object.freeze({ ...first, stableReobservedAtUnixNs: second.observedAtUnixNs });
}

export function invokeFixedPreReleaseThawV1(process: PreReleaseControllerProcessObservationV1): PreReleaseControllerCommandFactV1 & Readonly<{ readonly proof: PreReleaseControllerThawedStateProofV1 }> {
  const command = fixedSystemctlCommand(Object.freeze(["thaw", LAYOUT.targetSystemdUnit]));
  try {
    const systemdFreezerState = fixedFreezerState("running");
    const cgroupPath = exactCgroupPath(process.controlGroup);
    if (readCgroupState(cgroupPath, "cgroup.freeze") !== "0\n") throw new TypeError("kernel cgroup freezer state is not exactly thawed");
    return Object.freeze({
      ...command,
      proof: Object.freeze({ kind: "cgroup-thawed" as const, systemdFreezerState, cgroupPath, cgroupFreeze: "0" as const, observedAtUnixNs: unixNs() }),
    });
  } catch (error) {
    if (exactProcessStillExistsV1(process)) throw error;
    return Object.freeze({
      ...command,
      proof: Object.freeze({
        kind: "exact-process-exited-after-thaw" as const,
        processIdentityHash: process.processIdentityHash,
        observedAtUnixNs: unixNs(),
      }),
    });
  }
}

export function bestEffortFixedPreReleaseThawV1(): void {
  try {
    fixedSystemctlCommand(Object.freeze(["thaw", LAYOUT.targetSystemdUnit]));
  } catch {
    // The durable one-shot lock remains consumed; cleanup cannot grant retry authority.
  }
}

export function invokeFixedPreReleaseSigtermV1(): PreReleaseControllerCommandFactV1 {
  const args = Object.freeze(["kill", "--kill-whom=main", "--signal=SIGTERM", LAYOUT.targetSystemdUnit] as const);
  return fixedSystemctlCommand(args);
}

export function exactProcessStillExistsV1(process: PreReleaseControllerProcessObservationV1): boolean {
  try {
    return parseProcStartTicksV1(readFileSync(procPath(process.pid, "stat"), "utf8"), process.pid) === process.processStartTicks;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ESRCH") return false;
    throw error;
  }
}

export function assertRootControllerHostV1(): PreReleaseRestartControllerOwnerProcessObservationV1 {
  if (process.platform !== "linux" || typeof process.getuid !== "function" || process.getuid() !== 0) throw new TypeError("pre-release restart controller requires a root Linux owner");
  exactPhysicalFile(LAYOUT.controllerEntrypointPath, 0n);
  exactPhysicalFile(LAYOUT.controllerSystemdUnitPath, 0n);
  const descriptor = openSync(LAYOUT.controllerEntrypointPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  // A successful O_NOFOLLOW open proves the final path is not substituted by
  // a symlink between the identity checks above and controller startup.
  if (descriptor < 0) throw new TypeError("controller entrypoint could not be opened");
  closeSync(descriptor);
  return observeFixedPreReleaseControllerOwnerV1();
}

export function controllerImplementationFactsV1(): Readonly<{
  readonly systemdUnitSha256: Hash;
  readonly entrypointSha256: Hash;
  readonly implementationIdentityHash: Hash;
}> {
  const unitBytes = readConcrete(LAYOUT.controllerSystemdUnitPath);
  const canonicalUnitBytes = new TextEncoder().encode(PRE_RELEASE_RESTART_CONTROLLER_UNIT_V1);
  if (unitBytes.byteLength !== canonicalUnitBytes.byteLength || unitBytes.some((byte, index) => byte !== canonicalUnitBytes[index])) throw new TypeError("installed restart controller unit is not canonical");
  const entrypointSha256 = sha256Hex(readConcrete(LAYOUT.controllerEntrypointPath));
  const systemdUnitSha256 = sha256Hex(unitBytes);
  return Object.freeze({
    systemdUnitSha256,
    entrypointSha256,
    implementationIdentityHash: hashDomain("aloha/pre-release-restart-controller-implementation/v1", {
      systemdUnitSha256,
      entrypointSha256,
      fixedLayout: LAYOUT,
      receiptSchema: "aloha.pre-release-restart-controller-receipt/v1",
    }),
  });
}

export function sameProcessObservationV1(left: PreReleaseControllerProcessObservationV1, right: PreReleaseControllerProcessObservationV1): boolean {
  return Buffer.from(encodeCanonicalBytes(left)).equals(Buffer.from(encodeCanonicalBytes(right)));
}
