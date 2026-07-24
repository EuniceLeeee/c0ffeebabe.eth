import { createHash, createHmac } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, extname, isAbsolute, resolve } from "node:path";
import {
  blindProductionCanonicalJson,
} from "../blind-production-audit.js";
import {
  blindProductionArtifactFileContents,
  createBlindProductionArtifact,
  validateBlindProductionArtifact,
  type BlindProductionArtifact,
  type BlindProductionArtifactDocuments,
  type BlindProductionArtifactKind,
} from "../blind-production-artifacts.js";

export const BLIND_MODULE_CLOSURE_PROFILE =
  "adapter-family-production-module-closure-v1" as const;

export interface BlindModuleClosure {
  readonly schemaVersion: 1;
  readonly profile: typeof BLIND_MODULE_CLOSURE_PROFILE;
  readonly entryPath: string;
  readonly modules: readonly {
    readonly path: string;
    readonly sha256: string;
  }[];
  readonly closureSha256: string;
}

export interface BlindBackendAttestationDraft {
  readonly upstreamKind:
    | "local-reth"
    | "local-content-addressed-state"
    | "local-snapshot";
  readonly endpointSha256: string;
  readonly localProcessPid: number;
  /**
   * Required for a content-addressed backend and forbidden for every other
   * backend kind. This binds the attested process to the exact frozen cache it
   * serves, rather than merely attesting a loopback endpoint.
   */
  readonly frozenManifestSha256?: string;
}

export interface BlindBackendAttestationDeclaration
  extends BlindBackendAttestationDraft {
  readonly schemaVersion: 1;
  readonly profile: "adapter-family-blind-local-backend-attestation-v1";
  readonly attestationMode: "trusted-file-hmac-sha256";
  readonly issuerHmacSha256: string;
}

export function writeBlindProductionArtifact(
  path: string,
  artifact: BlindProductionArtifact,
): void {
  validateBlindProductionArtifact(artifact);
  writeOwnerOnly(path, blindProductionArtifactFileContents(artifact));
}

export function generateBlindProductionArtifact(
  path: string,
  kind: BlindProductionArtifactKind,
  payload: Readonly<Record<string, unknown>>,
): BlindProductionArtifact {
  const artifact = createBlindProductionArtifact(kind, payload);
  writeBlindProductionArtifact(path, artifact);
  return artifact;
}

export function writeBlindProductionArtifactDocuments(
  outDir: string,
  documents: BlindProductionArtifactDocuments,
): Readonly<Record<BlindProductionArtifactKind, string>> {
  if (!isAbsolute(outDir)) {
    throw new Error("blind artifact output directory must be absolute");
  }
  mkdirSync(outDir, { recursive: true, mode: 0o700 });
  chmodSync(outDir, 0o700);
  const entries = [
    ["resolved-config", documents.resolvedConfig],
    ["production-universe", documents.universe],
    ["active-family-manifest", documents.activeFamilyManifest],
    ["base-graph-view", documents.baseGraphView],
    ["source-delta", documents.sourceDelta],
  ] as const;
  const paths = {} as Record<BlindProductionArtifactKind, string>;
  for (const [kind, artifact] of entries) {
    validateBlindProductionArtifact(artifact, kind);
    const path = resolve(outDir, `${kind}.json`);
    writeBlindProductionArtifact(path, artifact);
    paths[kind] = path;
  }
  return Object.freeze(paths);
}

export function readBlindProductionArtifact(
  path: string,
  kind: BlindProductionArtifactKind,
): BlindProductionArtifact {
  assertAbsoluteOwnerOnly(path);
  const raw = readFileSync(path, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`blind ${kind} artifact is not JSON: ${path}`);
  }
  const artifact = validateBlindProductionArtifact(parsed, kind);
  if (raw !== blindProductionArtifactFileContents(artifact)) {
    throw new Error(`blind ${kind} artifact is not canonical: ${path}`);
  }
  return artifact;
}

export function writeBlindModuleClosure(
  path: string,
  productionEntryPath: string,
): BlindModuleClosure {
  const closure = buildBlindModuleClosure(productionEntryPath);
  writeOwnerOnly(path, `${blindProductionCanonicalJson(closure)}\n`);
  return closure;
}

export function generateBlindBackendAttestation(
  path: string,
  draft: BlindBackendAttestationDraft,
  issuerKey: string,
): Readonly<Record<string, unknown>> {
  if (issuerKey.length < 32) {
    throw new Error("backend attestation issuer key is too short");
  }
  if (
    ![
      "local-reth",
      "local-content-addressed-state",
      "local-snapshot",
    ].includes(draft.upstreamKind) ||
    !isHash(draft.endpointSha256) ||
    !Number.isSafeInteger(draft.localProcessPid) ||
    draft.localProcessPid <= 0 ||
    (
      draft.upstreamKind === "local-content-addressed-state"
        ? !isHash(draft.frozenManifestSha256)
        : draft.frozenManifestSha256 !== undefined
    )
  ) {
    throw new Error("backend attestation draft is invalid");
  }
  const unsigned = {
    schemaVersion: 1,
    profile: "adapter-family-blind-local-backend-attestation-v1",
    upstreamKind: draft.upstreamKind,
    endpointSha256: draft.endpointSha256,
    attestationMode: "trusted-file-hmac-sha256",
    localProcessPid: draft.localProcessPid,
    ...(draft.upstreamKind === "local-content-addressed-state"
      ? { frozenManifestSha256: draft.frozenManifestSha256! }
      : {}),
  };
  const attestation = Object.freeze({
    ...unsigned,
    issuerHmacSha256: createHmac("sha256", issuerKey)
      .update(blindProductionCanonicalJson(unsigned))
      .digest("hex"),
  });
  writeOwnerOnly(path, `${blindProductionCanonicalJson(attestation)}\n`);
  validateBackendAttestationArtifact(path);
  return attestation;
}

export function buildBlindModuleClosure(
  productionEntryPath: string,
): BlindModuleClosure {
  if (!isAbsolute(productionEntryPath)) {
    throw new Error("production module closure entry must be absolute");
  }
  const modules = collectModuleClosure(productionEntryPath)
    .map((path) => ({ path, sha256: fileSha256(path) }))
    .sort((a, b) => a.path.localeCompare(b.path));
  if (modules.length === 0) {
    throw new Error("production module closure is empty");
  }
  const body = {
    schemaVersion: 1 as const,
    profile: BLIND_MODULE_CLOSURE_PROFILE,
    entryPath: productionEntryPath,
    modules,
  };
  return Object.freeze({
    ...body,
    closureSha256: sha256Canonical(body),
  });
}

export function readAndVerifyBlindModuleClosure(
  path: string,
  productionEntryPath: string,
): BlindModuleClosure {
  assertAbsoluteOwnerOnly(path);
  const raw = readFileSync(path, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`production module closure is not JSON: ${path}`);
  }
  validateBlindModuleClosure(parsed, productionEntryPath);
  const closure = parsed as BlindModuleClosure;
  if (raw !== `${blindProductionCanonicalJson(closure)}\n`) {
    throw new Error(`production module closure is not canonical: ${path}`);
  }
  const actual = buildBlindModuleClosure(productionEntryPath);
  if (blindProductionCanonicalJson(actual) !== blindProductionCanonicalJson(closure)) {
    throw new Error(`production module import closure changed: ${productionEntryPath}`);
  }
  return closure;
}

export function validateBackendAttestationArtifact(
  path: string,
): BlindBackendAttestationDeclaration {
  assertAbsoluteOwnerOnly(path);
  const raw = readFileSync(path, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`backend attestation is not JSON: ${path}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("backend attestation must be an object");
  }
  const attestation = parsed as Record<string, unknown>;
  const expected = [
    "attestationMode",
    "endpointSha256",
    "issuerHmacSha256",
    "localProcessPid",
    "profile",
    "schemaVersion",
    "upstreamKind",
    ...(attestation.upstreamKind === "local-content-addressed-state"
      ? ["frozenManifestSha256"]
      : []),
  ].sort();
  const actual = Object.keys(attestation).sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    throw new Error("backend attestation contains unexpected or missing fields");
  }
  if (
    attestation.schemaVersion !== 1 ||
    attestation.profile !==
      "adapter-family-blind-local-backend-attestation-v1" ||
    attestation.attestationMode !== "trusted-file-hmac-sha256" ||
    ![
      "local-reth",
      "local-content-addressed-state",
      "local-snapshot",
    ].includes(String(attestation.upstreamKind)) ||
    !Number.isSafeInteger(attestation.localProcessPid) ||
    Number(attestation.localProcessPid) <= 0 ||
    !isHash(attestation.endpointSha256) ||
    !isHash(attestation.issuerHmacSha256) ||
    (
      attestation.upstreamKind === "local-content-addressed-state"
        ? !isHash(attestation.frozenManifestSha256)
        : attestation.frozenManifestSha256 !== undefined
    )
  ) {
    throw new Error("backend attestation schema is invalid");
  }
  if (raw !== `${blindProductionCanonicalJson(attestation)}\n`) {
    throw new Error("backend attestation is not canonical");
  }
  return attestation as unknown as BlindBackendAttestationDeclaration;
}

export function assertAbsoluteOwnerOnly(path: string): void {
  if (!isAbsolute(path)) throw new Error(`trusted artifact path must be absolute: ${path}`);
  const mode = statSync(path).mode & 0o777;
  if ((mode & 0o077) !== 0 || (mode & 0o600) !== 0o600) {
    throw new Error(`trusted artifact must be owner-only: ${path}`);
  }
}

export function fileSha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function validateBlindModuleClosure(
  value: unknown,
  productionEntryPath: string,
): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("production module closure must be an object");
  }
  const closure = value as Partial<BlindModuleClosure>;
  if (
    closure.schemaVersion !== 1 ||
    closure.profile !== BLIND_MODULE_CLOSURE_PROFILE ||
    closure.entryPath !== productionEntryPath ||
    !Array.isArray(closure.modules) ||
    closure.modules.length === 0 ||
    !isHash(closure.closureSha256)
  ) {
    throw new Error("production module closure schema is invalid");
  }
  const body = {
    schemaVersion: closure.schemaVersion,
    profile: closure.profile,
    entryPath: closure.entryPath,
    modules: closure.modules,
  };
  if (closure.closureSha256 !== sha256Canonical(body)) {
    throw new Error("production module closure hash mismatch");
  }
  const seen = new Set<string>();
  for (const module of closure.modules) {
    if (
      !module ||
      typeof module !== "object" ||
      !isAbsolute(module.path) ||
      !isHash(module.sha256) ||
      seen.has(module.path)
    ) {
      throw new Error("production module closure member is invalid");
    }
    seen.add(module.path);
  }
  if (!seen.has(productionEntryPath)) {
    throw new Error("production module closure does not contain its entry");
  }
}

function collectModuleClosure(entryPath: string): string[] {
  const pending = [entryPath];
  const visited = new Set<string>();
  while (pending.length > 0) {
    const path = pending.pop()!;
    if (visited.has(path)) continue;
    if (!existsSync(path)) throw new Error(`production module missing: ${path}`);
    visited.add(path);
    const source = readFileSync(path, "utf8");
    for (const specifier of localModuleSpecifiers(source)) {
      const dependency = resolveLocalModule(path, specifier);
      if (!visited.has(dependency)) pending.push(dependency);
    }
  }
  return [...visited];
}

function localModuleSpecifiers(source: string): string[] {
  const results = new Set<string>();
  const patterns = [
    /\b(?:import|export)\s+(?:[^"'()]*?\s+from\s+)?["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      const specifier = match[1]!;
      if (specifier.startsWith(".")) results.add(specifier);
    }
  }
  return [...results];
}

function resolveLocalModule(importerPath: string, specifier: string): string {
  const candidate = resolve(dirname(importerPath), specifier);
  const extensions = extname(candidate)
    ? [
        candidate,
        ...(candidate.endsWith(".js")
          ? [candidate.slice(0, -3) + ".ts", candidate.slice(0, -3) + ".tsx"]
          : []),
        ...(candidate.endsWith(".mjs")
          ? [candidate.slice(0, -4) + ".mts"]
          : []),
      ]
    : [
        candidate,
        `${candidate}.ts`,
        `${candidate}.tsx`,
        `${candidate}.js`,
        `${candidate}.mjs`,
        resolve(candidate, "index.ts"),
        resolve(candidate, "index.js"),
      ];
  const found = extensions.find((path) => existsSync(path));
  if (!found) {
    throw new Error(
      `production module dependency missing importer=${importerPath} specifier=${specifier}`,
    );
  }
  return found;
}

function writeOwnerOnly(path: string, contents: string): void {
  writeFileSync(path, contents, { mode: 0o600 });
  chmodSync(path, 0o600);
}

function sha256Canonical(value: unknown): string {
  return createHash("sha256")
    .update(blindProductionCanonicalJson(value))
    .digest("hex");
}

function isHash(value: unknown): boolean {
  return /^(?:0x)?[0-9a-f]{64}$/i.test(String(value ?? ""));
}
