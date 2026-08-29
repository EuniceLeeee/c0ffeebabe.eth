import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import * as ts from "typescript";
import { decodeCanonicalJson, encodeCanonicalJson, hashDomain, type Hash } from "../../../packages/canonical-codec/src/index.ts";
import { computeProgramInputSetRoot, recomputeImplementationClosureDigest, type ImplementationClosure, type ImplementationCompilerInput } from "../../architecture-boundaries/src/index.ts";
import { computeReuseLedgerRoot, computeReuseReceiptId, REFERENCE_COMMIT, type ReuseLedgerV2, type ReuseReceiptSetV2 } from "../../../specs/reuse-ledger/src/index.ts";
import { CURRENT_REUSE_DECLARATIONS } from "../../../specs/reuse-ledger/src/current-ledger.ts";
import {
  GENERATED_AUTHORITY_PATHS,
  assertCleanRoomProductionClosure,
  assertDeclaredCleanRoomProductionClosureForTesting,
  generateAuthorityArtifacts,
  validateReferenceLockIntegrity,
} from "../src/index.ts";

const repoPath = resolve(new URL("../../..", import.meta.url).pathname);
const referenceRepoPath = "/private/tmp/mev-s1-impl";
const sha = (value: string | Uint8Array): Hash => `0x${createHash("sha256").update(value).digest("hex")}` as Hash;
const configFor = (path: string): string => `${path.split("/").slice(0, path.startsWith("families/") ? 2 : 2).join("/")}/tsconfig.json`;
const gitBlob = (path: string): string => {
  try { return execFileSync("git", ["-C", repoPath, "rev-parse", `:${path}`], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); }
  catch { return "0".repeat(40); }
};
const emptyExternalRoot = (): string => hashDomain("aloha/boundary/external-dependencies/closure/v3", { dependencies: [], owners: [] });

function closure(modulePath: string, salt = "base"): ImplementationClosure {
  const text = readFileSync(resolve(repoPath, modulePath), "utf8");
  const configPath = configFor(modulePath);
  const configText = readFileSync(resolve(repoPath, configPath), "utf8");
  const sourceFile = Object.freeze({ path: modulePath, blobSha: gitBlob(modulePath), contentSha256: sha(text), byteLength: Buffer.byteLength(text) });
  const configFile = Object.freeze({ path: configPath, blobSha: gitBlob(configPath), contentSha256: sha(configText), byteLength: Buffer.byteLength(configText) });
  const programInputs: readonly ImplementationCompilerInput[] = Object.freeze([Object.freeze({
    kind: "tracked", logicalPath: `repo/${modulePath}`, blobSha: sourceFile.blobSha,
    packageName: null, packageVersion: null, packageRelativePath: null, packageManifestSha256: null,
    lockRecordPath: null, lockRecordHash: null, contentSha256: sourceFile.contentSha256,
    compilerTextSha256: sourceFile.contentSha256, byteLength: sourceFile.byteLength,
  })]);
  const facts: Omit<ImplementationClosure, "closureDigest"> = {
    entrypoint: modulePath, entrypointId: `compiler-root:${configPath}:${modulePath}`, kind: "compiler-root", packageName: null, packageManifestPath: null,
    configPath, tsconfigRoot: hashDomain("aloha/boundary/tsconfig-chain/v1", { rootPath: configPath, files: [configFile], edges: [] }), configChain: { rootPath: configPath, files: [configFile], edges: [] },
    optionsRoot: hashDomain("test/options", { configPath, salt }), programInputs, programInputSetRoot: computeProgramInputSetRoot(programInputs), typescriptVersion: "5.9.3",
    packageManifestRoot: hashDomain("test/package", { modulePath, salt }), externalDependencyRoot: emptyExternalRoot(),
    files: Object.freeze([sourceFile]), edges: Object.freeze([]),
  };
  return Object.freeze({ ...facts, closureDigest: recomputeImplementationClosureDigest(facts) });
}

function resealClosure(base: ImplementationClosure, change: Partial<Omit<ImplementationClosure, "closureDigest">>): ImplementationClosure {
  const { closureDigest: _old, ...facts } = base;
  const changed = { ...facts, ...change };
  const inputs = changed.programInputs;
  const sealed = { ...changed, programInputSetRoot: computeProgramInputSetRoot(inputs) };
  return Object.freeze({ ...sealed, closureDigest: recomputeImplementationClosureDigest(sealed) });
}

function nodeRuntimeInput(): ImplementationCompilerInput {
  const executable = readFileSync(process.execPath);
  const identity = Buffer.from(encodeCanonicalJson({ version: process.version, versions: process.versions, release: process.release, platform: process.platform, arch: process.arch }), "utf8");
  return {
    kind: "node-runtime", logicalPath: `runtime/node@${process.version}/${process.platform}-${process.arch}`,
    blobSha: null, packageName: "node", packageVersion: process.version, packageRelativePath: null,
    packageManifestSha256: sha(identity), lockRecordPath: null, lockRecordHash: null,
    contentSha256: sha(executable), compilerTextSha256: null, byteLength: executable.byteLength,
  };
}

function externalRoot(edges: ImplementationClosure["edges"], owners: readonly { readonly packageName: string; readonly packageVersion: string; readonly lockRecordPath: string; readonly lockRecordHash: string }[] = []): string {
  return hashDomain("aloha/boundary/external-dependencies/closure/v3", {
    dependencies: Array.from(new Set(edges.filter(edge => edge.to.startsWith("@external/")).map(edge => edge.specifier))).sort(),
    owners: [...owners].sort((left, right) => `${left.lockRecordPath}:${left.lockRecordHash}`.localeCompare(`${right.lockRecordPath}:${right.lockRecordHash}`)),
  });
}

const options = { repoPath, referenceRepoPath };
let canonicalAuthorityPromise: ReturnType<typeof generateAuthorityArtifacts> | null = null;
const canonicalAuthority = () => canonicalAuthorityPromise ??= generateAuthorityArtifacts(options);
const validationInput = (
  generated: Awaited<ReturnType<typeof generateAuthorityArtifacts>>,
  artifacts: ReadonlyMap<string, string>,
) => ({ ...options, canonicalGeneration: generated, artifacts });
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
type Mutable<T> = T extends readonly (infer U)[] ? Mutable<U>[] : T extends object ? { -readonly [K in keyof T]: Mutable<T[K]> } : T;

function artifactMap(generated: Awaited<ReturnType<typeof generateAuthorityArtifacts>>): Map<string, string> { return new Map(generated.bytes); }
function replaceJson(artifacts: Map<string, string>, path: string, value: unknown): void { artifacts.set(path, encodeCanonicalJson(value)); }

test("fresh authority binds all 27 destinations, evidence sources, compiler roots and receipts", async () => {
  const generated = await canonicalAuthority();
  assert.equal(generated.ledger.entries.length, 27);
  assert.equal(generated.ledger.releaseReuseEntryIds.length, 27);
  assert.equal(generated.ledger.productionOraclePassClaimed, false);
  assert.equal(generated.ledger.entries.every(entry => entry.adoptionMode === "invariant-only-rewrite"), true);
  assert.equal(generated.ledger.entries.every(entry => entry.destinations.length > 0 && entry.evidence.productionOraclePass === false), true);
  const report = await validateReferenceLockIntegrity(validationInput(generated, artifactMap(generated)));
  assert.equal(report.verdict, "pass", report.checks.filter(item => item.status === "invalid").map(item => item.detail).join(";"));
});

test("destination bytes, path, export and compiler-input mutations fail closed", async () => {
  const generated = await canonicalAuthority();
  for (const mutate of [
    (ledger: Mutable<ReuseLedgerV2>) => { ledger.entries[0]!.destinations[0]!.contentSha256 = `0x${"1".repeat(64)}` as Hash; },
    (ledger: Mutable<ReuseLedgerV2>) => { ledger.entries[0]!.destinations[0]!.modulePath = "families/not-real/src/index.ts"; },
    (ledger: Mutable<ReuseLedgerV2>) => { ledger.entries[0]!.destinations[0]!.exportNames[0] = "fabricatedExport"; },
    (ledger: Mutable<ReuseLedgerV2>) => { ledger.entries[0]!.destinations[0]!.compiler.programInputSetRoot = `0x${"2".repeat(64)}` as Hash; },
  ]) {
    const artifacts = artifactMap(generated); const ledger = clone(generated.ledger) as Mutable<ReuseLedgerV2>; mutate(ledger); replaceJson(artifacts, GENERATED_AUTHORITY_PATHS[1]!, ledger);
    assert.equal((await validateReferenceLockIntegrity(validationInput(generated, artifacts))).verdict, "invalid");
  }
});

test("pending credit, oracle elevation and receipt mutation fail closed", async () => {
  const generated = await canonicalAuthority();
  const pendingArtifacts = artifactMap(generated); const pending = clone(generated.ledger) as Mutable<ReuseLedgerV2>; pending.entries[0]!.nonCreditReason = "pending future contract"; replaceJson(pendingArtifacts, GENERATED_AUTHORITY_PATHS[1]!, pending); assert.equal((await validateReferenceLockIntegrity(validationInput(generated, pendingArtifacts))).verdict, "invalid");
  const oracleArtifacts = artifactMap(generated); const oracle = clone(generated.ledger) as Mutable<ReuseLedgerV2>; (oracle.entries[0]!.evidence as unknown as { productionOraclePass: boolean }).productionOraclePass = true; replaceJson(oracleArtifacts, GENERATED_AUTHORITY_PATHS[1]!, oracle); assert.equal((await validateReferenceLockIntegrity(validationInput(generated, oracleArtifacts))).verdict, "invalid");
  const receiptArtifacts = artifactMap(generated); const receipts = clone(generated.receiptSet) as Mutable<ReuseReceiptSetV2>; receipts.receipts[0]!.receiptId = `0x${"3".repeat(64)}` as Hash; replaceJson(receiptArtifacts, GENERATED_AUTHORITY_PATHS[2]!, receipts); assert.equal((await validateReferenceLockIntegrity(validationInput(generated, receiptArtifacts))).verdict, "invalid");
});

test("extra, missing and duplicate rows fail exact output and schema checks", async () => {
  const generated = await canonicalAuthority();
  const extra = artifactMap(generated); extra.set("generated/authority/forged.json", "{}"); assert.equal((await validateReferenceLockIntegrity(validationInput(generated, extra))).verdict, "invalid");
  const missing = artifactMap(generated); missing.delete(GENERATED_AUTHORITY_PATHS[0]!); assert.equal((await validateReferenceLockIntegrity(validationInput(generated, missing))).verdict, "invalid");
  const duplicate = artifactMap(generated); const ledger = clone(generated.ledger) as Mutable<ReuseLedgerV2>; ledger.entries = [ledger.entries[0]!, ...ledger.entries]; replaceJson(duplicate, GENERATED_AUTHORITY_PATHS[1]!, ledger); assert.equal((await validateReferenceLockIntegrity(validationInput(generated, duplicate))).verdict, "invalid");
});

test("self-consistent artifact forgery is rejected by fresh regeneration", async () => {
  const generated = await canonicalAuthority(); const artifacts = artifactMap(generated);
  const ledger = clone(generated.ledger) as Mutable<ReuseLedgerV2>; ledger.entries[0]!.destinations[0]!.contentSha256 = `0x${"4".repeat(64)}` as Hash;
  const entry = ledger.entries[0]!; const receiptSet = clone(generated.receiptSet) as Mutable<ReuseReceiptSetV2>; const receipt = receiptSet.receipts[0]!;
  receipt.destinationClosureRoot = hashDomain("aloha/reuse/destination-closure/v2", entry.destinations); const { receiptId: _old, ...facts } = receipt; receipt.receiptId = computeReuseReceiptId(facts); entry.reuseReceiptId = receipt.receiptId;
  const { reuseLedgerRoot: _ledgerRoot, ...ledgerFacts } = ledger; ledger.reuseLedgerRoot = computeReuseLedgerRoot(ledgerFacts); receiptSet.receiptSetRoot = hashDomain("aloha/reuse-receipt-set/v2", receiptSet.receipts);
  replaceJson(artifacts, GENERATED_AUTHORITY_PATHS[1]!, ledger); replaceJson(artifacts, GENERATED_AUTHORITY_PATHS[2]!, receiptSet);
  assert.equal((await validateReferenceLockIntegrity(validationInput(generated, artifacts))).verdict, "invalid");
});

test("compiler projection cannot be injected into generation or validation", async () => {
  const injected = { collect: () => ({ implementationClosures: [] }) };
  await assert.rejects(
    () => generateAuthorityArtifacts({ ...options, compilerProjection: injected } as never),
    /may not inject compiler facts/,
  );
  const generated = await canonicalAuthority();
  const report = await validateReferenceLockIntegrity({
    ...validationInput(generated, artifactMap(generated)),
    compilerProjection: injected,
  } as never);
  assert.equal(report.verdict, "invalid");
  assert.match(report.checks.find(check => check.id === "authority.regenerate")?.detail ?? "", /authority injection seam/);
});

test("canonical generation capability rejects clones and mutable output maps", async () => {
  const generated = await canonicalAuthority();
  const cloned = clone(generated);
  assert.equal((await validateReferenceLockIntegrity({ ...options, canonicalGeneration: cloned, artifacts: artifactMap(generated) })).verdict, "invalid");
  const mutableBytes = generated.bytes as Map<string, string>;
  const original = generated.bytes.get(GENERATED_AUTHORITY_PATHS[3]!)!;
  mutableBytes.set(GENERATED_AUTHORITY_PATHS[3]!, "{}");
  try {
    assert.equal((await validateReferenceLockIntegrity(validationInput(generated, artifactMap(generated)))).verdict, "invalid");
  } finally {
    mutableBytes.set(GENERATED_AUTHORITY_PATHS[3]!, original);
  }
});

test("public clean-room verification rejects a caller closure that omits the canonical compiler graph", () => {
  assert.throws(() => assertCleanRoomProductionClosure(repoPath, closure(CURRENT_TARGET())), /canonical graph/);
});

test("tracked compiler input binds compiler-visible text to exact indexed bytes", () => {
  const base = closure(CURRENT_TARGET());
  assert.doesNotThrow(() => assertDeclaredCleanRoomProductionClosureForTesting(repoPath, base));
  const input = { ...base.programInputs[0]!, compilerTextSha256: sha("different compiler text") };
  assert.throws(() => assertDeclaredCleanRoomProductionClosureForTesting(repoPath, resealClosure(base, { programInputs: [input] })), /compiler-visible Git file/);
});

test("clean-room closure rejects exact reference-only paths and reference repository dependencies", () => {
  const base = closure(CURRENT_TARGET());
  const referenceEdge = {
    from: base.entrypoint,
    to: "tools/reference-only/impl/src/index.ts",
    specifier: "../../../tools/reference-only/impl/src/index.ts",
  };
  assert.throws(
    () => assertDeclaredCleanRoomProductionClosureForTesting(repoPath, resealClosure(base, { edges: [referenceEdge] })),
    /reference-only path/,
  );
  const referencePackage = { ...base.programInputs[0]!, kind: "npm" as const, logicalPath: "npm/impl@1.0.0/index.d.ts", blobSha: null, packageName: "impl" };
  assert.throws(
    () => assertDeclaredCleanRoomProductionClosureForTesting(repoPath, resealClosure(base, { programInputs: [referencePackage] })),
    /reference repository compiler input/,
  );
});

test("invariant-only rewrite rejects an exact whole-file reference blob at a new path", () => {
  const fixture = mkdtempSync(resolve(tmpdir(), "aloha-reference-lock-whole-file-"));
  try {
    const declaration = CURRENT_REUSE_DECLARATIONS[0]!;
    const sourceBytes = execFileSync("git", ["-C", referenceRepoPath, "show", `${REFERENCE_COMMIT}:${declaration.sourcePath}`], { encoding: null });
    const configText = '{"compilerOptions":{"module":"NodeNext","moduleResolution":"NodeNext","noEmit":true},"files":["src.ts"]}\n';
    writeFileSync(resolve(fixture, "src.ts"), sourceBytes);
    writeFileSync(resolve(fixture, "tsconfig.json"), configText);
    execFileSync("git", ["init", "-q", fixture]);
    execFileSync("git", ["-C", fixture, "add", "src.ts", "tsconfig.json"]);
    const sourceBlob = execFileSync("git", ["-C", fixture, "rev-parse", ":src.ts"], { encoding: "utf8" }).trim();
    assert.equal(sourceBlob, declaration.sourceBlob);
    const sourceFile = { path: "src.ts", blobSha: sourceBlob, contentSha256: sha(sourceBytes), byteLength: sourceBytes.byteLength };
    const configFile = { path: "tsconfig.json", blobSha: execFileSync("git", ["-C", fixture, "rev-parse", ":tsconfig.json"], { encoding: "utf8" }).trim(), contentSha256: sha(configText), byteLength: Buffer.byteLength(configText) };
    const compilerText = ts.sys.readFile(resolve(fixture, "src.ts"))!;
    const programInputs: readonly ImplementationCompilerInput[] = [{ kind: "tracked", logicalPath: "repo/src.ts", blobSha: sourceBlob, packageName: null, packageVersion: null, packageRelativePath: null, packageManifestSha256: null, lockRecordPath: null, lockRecordHash: null, contentSha256: sourceFile.contentSha256, compilerTextSha256: sha(Buffer.from(compilerText, "utf8")), byteLength: sourceFile.byteLength }];
    const configChain = { rootPath: "tsconfig.json", files: [configFile], edges: [] };
    const facts: Omit<ImplementationClosure, "closureDigest"> = { entrypoint: "src.ts", entrypointId: "compiler-root:tsconfig.json:src.ts", kind: "compiler-root", packageName: null, packageManifestPath: null, configPath: "tsconfig.json", tsconfigRoot: hashDomain("aloha/boundary/tsconfig-chain/v1", configChain), configChain, optionsRoot: hashDomain("test/options", "whole-file"), programInputs, programInputSetRoot: computeProgramInputSetRoot(programInputs), typescriptVersion: ts.version, packageManifestRoot: hashDomain("test/package", "whole-file"), externalDependencyRoot: emptyExternalRoot(), files: [sourceFile], edges: [] };
    const exact = { ...facts, closureDigest: recomputeImplementationClosureDigest(facts) };
    assert.throws(() => assertDeclaredCleanRoomProductionClosureForTesting(fixture, exact), /whole-file reference blob/);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("tracked compiler text uses TypeScript decoding instead of raw UTF-8 bytes", () => {
  const fixture = mkdtempSync(resolve(tmpdir(), "aloha-reference-lock-bom-"));
  try {
    const sourceBytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("export const value = 1;\n")]);
    const configText = '{"compilerOptions":{"module":"NodeNext","moduleResolution":"NodeNext","noEmit":true},"files":["src.ts"]}\n';
    writeFileSync(resolve(fixture, "src.ts"), sourceBytes);
    writeFileSync(resolve(fixture, "tsconfig.json"), configText);
    execFileSync("git", ["init", "-q", fixture]);
    execFileSync("git", ["-C", fixture, "add", "src.ts", "tsconfig.json"]);
    const sourceFile = { path: "src.ts", blobSha: execFileSync("git", ["-C", fixture, "rev-parse", ":src.ts"], { encoding: "utf8" }).trim(), contentSha256: sha(sourceBytes), byteLength: sourceBytes.byteLength };
    const configFile = { path: "tsconfig.json", blobSha: execFileSync("git", ["-C", fixture, "rev-parse", ":tsconfig.json"], { encoding: "utf8" }).trim(), contentSha256: sha(configText), byteLength: Buffer.byteLength(configText) };
    const compilerText = ts.sys.readFile(resolve(fixture, "src.ts"));
    assert.notEqual(compilerText, undefined);
    const programInputs: readonly ImplementationCompilerInput[] = [{ kind: "tracked", logicalPath: "repo/src.ts", blobSha: sourceFile.blobSha, packageName: null, packageVersion: null, packageRelativePath: null, packageManifestSha256: null, lockRecordPath: null, lockRecordHash: null, contentSha256: sourceFile.contentSha256, compilerTextSha256: sha(Buffer.from(compilerText!, "utf8")), byteLength: sourceFile.byteLength }];
    const configChain = { rootPath: "tsconfig.json", files: [configFile], edges: [] };
    const facts: Omit<ImplementationClosure, "closureDigest"> = { entrypoint: "src.ts", entrypointId: "compiler-root:tsconfig.json:src.ts", kind: "compiler-root", packageName: null, packageManifestPath: null, configPath: "tsconfig.json", tsconfigRoot: hashDomain("aloha/boundary/tsconfig-chain/v1", configChain), configChain, optionsRoot: hashDomain("test/options", "bom"), programInputs, programInputSetRoot: computeProgramInputSetRoot(programInputs), typescriptVersion: ts.version, packageManifestRoot: hashDomain("test/package", "bom"), externalDependencyRoot: emptyExternalRoot(), files: [sourceFile], edges: [] };
    const exact = { ...facts, closureDigest: recomputeImplementationClosureDigest(facts) };
    assert.doesNotThrow(() => assertDeclaredCleanRoomProductionClosureForTesting(fixture, exact));
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("node-runtime input has exact structure and binds the active executable", () => {
  const base = closure(CURRENT_TARGET());
  const edges = [{ from: base.entrypoint, to: "@external/node:crypto", specifier: "node:crypto" }] as const;
  const runtime = nodeRuntimeInput();
  const exact = resealClosure(base, { edges, programInputs: [...base.programInputs, runtime], externalDependencyRoot: externalRoot(edges) });
  assert.doesNotThrow(() => assertDeclaredCleanRoomProductionClosureForTesting(repoPath, exact));
  const forgedRuntime = { ...runtime, contentSha256: sha("different node executable") };
  assert.throws(() => assertDeclaredCleanRoomProductionClosureForTesting(repoPath, resealClosure(exact, { programInputs: [base.programInputs[0]!, forgedRuntime] })), /active runtime/);
  assert.throws(() => assertDeclaredCleanRoomProductionClosureForTesting(repoPath, resealClosure(base, { programInputs: [...base.programInputs, runtime] })), /active runtime/);
});

test("config chain files, Git owners, digest, and extends edges are exact", () => {
  const base = closure(CURRENT_TARGET());
  const forgedFile = { ...base.configChain.files[0]!, contentSha256: sha("different config") };
  assert.throws(() => assertDeclaredCleanRoomProductionClosureForTesting(repoPath, resealClosure(base, { configChain: { ...base.configChain, files: [forgedFile] } })), /config chain is not exact/);
  const forgedEdge = { from: base.configPath, to: base.configPath, specifier: "./tsconfig.json" };
  assert.throws(() => assertDeclaredCleanRoomProductionClosureForTesting(repoPath, resealClosure(base, { configChain: { ...base.configChain, edges: [forgedEdge] } })), /config chain is not exact/);
});

test("external dependency root is recomputed from edges and exact npm owners", () => {
  const fixture = mkdtempSync(resolve(tmpdir(), "aloha-reference-lock-"));
  try {
    const sourceText = 'import type { Marker } from "fixture-pkg";\nexport type Value = Marker;\n';
    const baseConfigText = '{"compilerOptions":{"module":"NodeNext","moduleResolution":"NodeNext","noEmit":true}}\n';
    const configText = '{"extends":"./base.json","files":["src.ts"]}\n';
    const packageText = '{"name":"fixture-pkg","version":"1.0.0","types":"index.d.ts"}\n';
    const declarationText = 'import type { Nested } from "@scope/nested";\nexport interface Marker extends Nested { readonly value: string }\n';
    const nestedPackageText = '{"name":"@scope/nested","version":"2.0.0","types":"index.d.ts"}\n';
    const nestedDeclarationText = "export interface Nested { readonly nested: true }\n";
    const lockRecord = { version: "1.0.0" };
    const nestedLockRecord = { version: "2.0.0" };
    const nestedLockPath = "node_modules/fixture-pkg/node_modules/@scope/nested";
    const lockText = `${JSON.stringify({ name: "fixture", version: "1.0.0", lockfileVersion: 3, packages: { "": { name: "fixture", version: "1.0.0" }, "node_modules/fixture-pkg": lockRecord, [nestedLockPath]: nestedLockRecord } }, null, 2)}\n`;
    mkdirSync(resolve(fixture, "node_modules/fixture-pkg"), { recursive: true });
    mkdirSync(resolve(fixture, nestedLockPath), { recursive: true });
    writeFileSync(resolve(fixture, "src.ts"), sourceText);
    writeFileSync(resolve(fixture, "base.json"), baseConfigText);
    writeFileSync(resolve(fixture, "tsconfig.json"), configText);
    writeFileSync(resolve(fixture, "package-lock.json"), lockText);
    writeFileSync(resolve(fixture, "node_modules/fixture-pkg/package.json"), packageText);
    writeFileSync(resolve(fixture, "node_modules/fixture-pkg/index.d.ts"), declarationText);
    writeFileSync(resolve(fixture, nestedLockPath, "package.json"), nestedPackageText);
    writeFileSync(resolve(fixture, nestedLockPath, "index.d.ts"), nestedDeclarationText);
    execFileSync("git", ["init", "-q", fixture]);
    execFileSync("git", ["-C", fixture, "add", "src.ts", "base.json", "tsconfig.json", "package-lock.json"]);
    const sourceFile = { path: "src.ts", blobSha: execFileSync("git", ["-C", fixture, "rev-parse", ":src.ts"], { encoding: "utf8" }).trim(), contentSha256: sha(sourceText), byteLength: Buffer.byteLength(sourceText) };
    const configFile = { path: "tsconfig.json", blobSha: execFileSync("git", ["-C", fixture, "rev-parse", ":tsconfig.json"], { encoding: "utf8" }).trim(), contentSha256: sha(configText), byteLength: Buffer.byteLength(configText) };
    const baseConfigFile = { path: "base.json", blobSha: execFileSync("git", ["-C", fixture, "rev-parse", ":base.json"], { encoding: "utf8" }).trim(), contentSha256: sha(baseConfigText), byteLength: Buffer.byteLength(baseConfigText) };
    const tracked: ImplementationCompilerInput = { kind: "tracked", logicalPath: "repo/src.ts", blobSha: sourceFile.blobSha, packageName: null, packageVersion: null, packageRelativePath: null, packageManifestSha256: null, lockRecordPath: null, lockRecordHash: null, contentSha256: sourceFile.contentSha256, compilerTextSha256: sha(sourceText), byteLength: sourceFile.byteLength };
    const lockRecordHash = hashDomain("aloha/boundary/npm-lock-record/v1", { path: "node_modules/fixture-pkg", record: lockRecord });
    const npmInput: ImplementationCompilerInput = { kind: "npm", logicalPath: "npm/fixture-pkg@1.0.0/index.d.ts", blobSha: null, packageName: "fixture-pkg", packageVersion: "1.0.0", packageRelativePath: "index.d.ts", packageManifestSha256: sha(packageText), lockRecordPath: "node_modules/fixture-pkg", lockRecordHash, contentSha256: sha(declarationText), compilerTextSha256: sha(declarationText), byteLength: Buffer.byteLength(declarationText) };
    const nestedLockRecordHash = hashDomain("aloha/boundary/npm-lock-record/v1", { path: nestedLockPath, record: nestedLockRecord });
    const nestedInput: ImplementationCompilerInput = { kind: "npm", logicalPath: "npm/@scope/nested@2.0.0/index.d.ts", blobSha: null, packageName: "@scope/nested", packageVersion: "2.0.0", packageRelativePath: "index.d.ts", packageManifestSha256: sha(nestedPackageText), lockRecordPath: nestedLockPath, lockRecordHash: nestedLockRecordHash, contentSha256: sha(nestedDeclarationText), compilerTextSha256: sha(nestedDeclarationText), byteLength: Buffer.byteLength(nestedDeclarationText) };
    const edges = [
      { from: "src.ts", to: "@external/fixture-pkg", specifier: "fixture-pkg", resolutionMode: "import" as const },
      { from: "node_modules/fixture-pkg/index.d.ts", to: "@external/@scope/nested", specifier: "@scope/nested", resolutionMode: "import" as const },
    ];
    const owners = [
      { packageName: "fixture-pkg", packageVersion: "1.0.0", lockRecordPath: "node_modules/fixture-pkg", lockRecordHash },
      { packageName: "@scope/nested", packageVersion: "2.0.0", lockRecordPath: nestedLockPath, lockRecordHash: nestedLockRecordHash },
    ];
    const programInputs = [tracked, npmInput, nestedInput];
    const configChain = { rootPath: "tsconfig.json", files: [baseConfigFile, configFile], edges: [{ from: "tsconfig.json", to: "base.json", specifier: "./base.json" }] };
    const facts: Omit<ImplementationClosure, "closureDigest"> = { entrypoint: "src.ts", entrypointId: "compiler-root:tsconfig.json:src.ts", kind: "compiler-root", packageName: null, packageManifestPath: null, configPath: "tsconfig.json", tsconfigRoot: hashDomain("aloha/boundary/tsconfig-chain/v1", configChain), configChain, optionsRoot: hashDomain("test/options", "fixture"), programInputs, programInputSetRoot: computeProgramInputSetRoot(programInputs), typescriptVersion: ts.version, packageManifestRoot: hashDomain("test/package", "fixture"), externalDependencyRoot: externalRoot(edges, owners), files: [sourceFile], edges };
    const exact = { ...facts, closureDigest: recomputeImplementationClosureDigest(facts) };
    assert.doesNotThrow(() => assertDeclaredCleanRoomProductionClosureForTesting(fixture, exact));
    assert.throws(() => assertDeclaredCleanRoomProductionClosureForTesting(fixture, resealClosure(exact, { externalDependencyRoot: sha("forged external root") })), /mechanically exact/);
    const forgedOwner = { ...npmInput, lockRecordHash: sha("forged lock owner") };
    assert.throws(() => assertDeclaredCleanRoomProductionClosureForTesting(fixture, resealClosure(exact, { programInputs: [tracked, forgedOwner] })), /exact npm owner/);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

function CURRENT_TARGET(): string {
  return "families/univ2-standard/src/kernel/math.ts";
}
