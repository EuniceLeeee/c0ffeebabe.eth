import { createHash } from "node:crypto";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import {
  BLIND_PROFILE,
  BLIND_SCHEMA_VERSION,
  canonicalJson,
  sha256Canonical,
  validateBlindRunManifest,
  type BlindBlockAnchor,
  type BlindProducerCommand,
  type BlindRunManifest,
  type BlindRunOrderEntry,
  type BlindRunProfile,
} from "./adapter-family-blind-contract.js";
import {
  readAndVerifyBlindModuleClosure,
  readBlindProductionArtifact,
  validateBackendAttestationArtifact,
} from "./adapter-family-blind-artifacts.js";

export interface BlindManifestDraft {
  /** Defaults to the reusable generic profile. */
  readonly profile?: BlindRunProfile;
  readonly experimentId: string;
  readonly base: BlindBlockAnchor;
  readonly source: BlindBlockAnchor;
  readonly runCountPerSide: number;
  readonly orderSeed: string;
  readonly timingLimitMs: number;
  readonly responseTimeoutMs: number;
  readonly resolvedConfigPath: string;
  readonly universePath: string;
  readonly activeFamilyManifestPath: string;
  readonly baseGraphViewPath: string;
  readonly sourceDeltaPath: string;
  readonly heldOut: {
    readonly base: BlindBlockAnchor;
    readonly source: BlindBlockAnchor;
    readonly resolvedConfigPath: string;
    readonly universePath: string;
    readonly activeFamilyManifestPath: string;
    readonly baseGraphViewPath: string;
    readonly sourceDeltaPath: string;
  };
  readonly oracleCommitment: string;
  readonly trusted: {
    readonly runnerPath: string;
    readonly oracleBuilderPath: string;
    readonly comparatorPath: string;
    readonly backendControllerPath: string;
    readonly anvilBinaryPath: string;
  };
  readonly producers: {
    readonly baseline: {
      readonly productionEntryPath: string;
      readonly productionModuleClosurePath: string;
      readonly producerHarnessPath: string;
      readonly cases: Readonly<Record<"primary" | "held-out", {
        readonly command: BlindProducerCommand;
        readonly backendIdentityPath: string;
      }>>;
    };
    readonly challenger: {
      readonly productionEntryPath: string;
      readonly productionModuleClosurePath: string;
      readonly producerHarnessPath: string;
      readonly cases: Readonly<Record<"primary" | "held-out", {
        readonly command: BlindProducerCommand;
        readonly backendIdentityPath: string;
      }>>;
    };
  };
}

export function buildBlindRunManifest(draft: BlindManifestDraft): BlindRunManifest {
  readBlindProductionArtifact(draft.resolvedConfigPath, "resolved-config");
  readBlindProductionArtifact(draft.universePath, "production-universe");
  readBlindProductionArtifact(
    draft.activeFamilyManifestPath,
    "active-family-manifest",
  );
  const baseGraph = readBlindProductionArtifact(
    draft.baseGraphViewPath,
    "base-graph-view",
  );
  const sourceDelta = readBlindProductionArtifact(
    draft.sourceDeltaPath,
    "source-delta",
  );
  assertArtifactAnchor(baseGraph.payload, draft.base, "base graph");
  assertArtifactAnchor(sourceDelta.payload, draft.source, "source delta");
  if (
    sourceDelta.payload.baseGraphViewSha256 !==
      fileSha256(draft.baseGraphViewPath)
  ) {
    throw new Error("source delta does not bind the frozen N-1 graph view");
  }
  readBlindProductionArtifact(
    draft.heldOut.resolvedConfigPath,
    "resolved-config",
  );
  readBlindProductionArtifact(
    draft.heldOut.universePath,
    "production-universe",
  );
  readBlindProductionArtifact(
    draft.heldOut.activeFamilyManifestPath,
    "active-family-manifest",
  );
  const heldOutBaseGraph = readBlindProductionArtifact(
    draft.heldOut.baseGraphViewPath,
    "base-graph-view",
  );
  const heldOutSourceDelta = readBlindProductionArtifact(
    draft.heldOut.sourceDeltaPath,
    "source-delta",
  );
  assertArtifactAnchor(
    heldOutBaseGraph.payload,
    draft.heldOut.base,
    "held-out base graph",
  );
  assertArtifactAnchor(
    heldOutSourceDelta.payload,
    draft.heldOut.source,
    "held-out source delta",
  );
  if (
    heldOutSourceDelta.payload.baseGraphViewSha256 !==
      fileSha256(draft.heldOut.baseGraphViewPath)
  ) {
    throw new Error(
      "held-out source delta does not bind the frozen N-1 graph view",
    );
  }
  const backendDeclarations = (
    ["baseline", "challenger"] as const
  ).flatMap((side) =>
    (["primary", "held-out"] as const).map((caseId) => ({
      side,
      caseId,
      path: draft.producers[side].cases[caseId].backendIdentityPath,
      declaration: validateBackendAttestationArtifact(
        draft.producers[side].cases[caseId].backendIdentityPath,
      ),
    }))
  );
  assertIndependentBackendDeclarations(backendDeclarations);
  readAndVerifyBlindModuleClosure(
    draft.producers.baseline.productionModuleClosurePath,
    draft.producers.baseline.productionEntryPath,
  );
  readAndVerifyBlindModuleClosure(
    draft.producers.challenger.productionModuleClosurePath,
    draft.producers.challenger.productionEntryPath,
  );
  const bind = (path: string) => ({ path, sha256: fileSha256(path) });
  const manifest: BlindRunManifest = {
    schemaVersion: BLIND_SCHEMA_VERSION,
    profile: draft.profile ?? BLIND_PROFILE,
    experimentId: draft.experimentId,
    base: draft.base,
    source: draft.source,
    runCountPerSide: draft.runCountPerSide,
    runOrder: seededInterleavedOrder(draft.runCountPerSide, draft.orderSeed),
    p95Algorithm: "nearest-rank-ceil",
    timingLimitMs: draft.timingLimitMs,
    responseTimeoutMs: draft.responseTimeoutMs,
    inputs: {
      resolvedConfig: bind(draft.resolvedConfigPath),
      universe: bind(draft.universePath),
      activeFamilyManifest: bind(draft.activeFamilyManifestPath),
      baseGraphView: bind(draft.baseGraphViewPath),
      sourceDelta: bind(draft.sourceDeltaPath),
    },
    heldOut: {
      base: draft.heldOut.base,
      source: draft.heldOut.source,
      inputs: {
        resolvedConfig: bind(draft.heldOut.resolvedConfigPath),
        universe: bind(draft.heldOut.universePath),
        activeFamilyManifest: bind(
          draft.heldOut.activeFamilyManifestPath,
        ),
        baseGraphView: bind(draft.heldOut.baseGraphViewPath),
        sourceDelta: bind(draft.heldOut.sourceDeltaPath),
      },
    },
    oracleCommitment: draft.oracleCommitment,
    trusted: {
      runner: bind(draft.trusted.runnerPath),
      oracleBuilder: bind(draft.trusted.oracleBuilderPath),
      comparator: bind(draft.trusted.comparatorPath),
      backendController: bind(draft.trusted.backendControllerPath),
      anvilBinary: bind(draft.trusted.anvilBinaryPath),
    },
    producers: {
      baseline: {
        productionEntry: bind(draft.producers.baseline.productionEntryPath),
        productionModuleClosure: bind(
          draft.producers.baseline.productionModuleClosurePath,
        ),
        producerHarness: bind(draft.producers.baseline.producerHarnessPath),
        cases: {
          primary: {
            command: draft.producers.baseline.cases.primary.command,
            backendIdentity: bind(
              draft.producers.baseline.cases.primary.backendIdentityPath,
            ),
          },
          "held-out": {
            command: draft.producers.baseline.cases["held-out"].command,
            backendIdentity: bind(
              draft.producers.baseline.cases["held-out"].backendIdentityPath,
            ),
          },
        },
      },
      challenger: {
        productionEntry: bind(draft.producers.challenger.productionEntryPath),
        productionModuleClosure: bind(
          draft.producers.challenger.productionModuleClosurePath,
        ),
        producerHarness: bind(draft.producers.challenger.producerHarnessPath),
        cases: {
          primary: {
            command: draft.producers.challenger.cases.primary.command,
            backendIdentity: bind(
              draft.producers.challenger.cases.primary.backendIdentityPath,
            ),
          },
          "held-out": {
            command: draft.producers.challenger.cases["held-out"].command,
            backendIdentity: bind(
              draft.producers.challenger.cases["held-out"].backendIdentityPath,
            ),
          },
        },
      },
    },
  };
  validateBlindRunManifest(manifest);
  return manifest;
}

function assertIndependentBackendDeclarations(
  entries: readonly {
    readonly side: "baseline" | "challenger";
    readonly caseId: "primary" | "held-out";
    readonly path: string;
    readonly declaration: {
      readonly endpointSha256: string;
      readonly localProcessPid: number;
    };
  }[],
): void {
  const paths = new Set<string>();
  const endpoints = new Set<string>();
  const pids = new Set<number>();
  for (const entry of entries) {
    const label = `${entry.side}/${entry.caseId}`;
    if (
      paths.has(entry.path) ||
      endpoints.has(entry.declaration.endpointSha256) ||
      pids.has(entry.declaration.localProcessPid)
    ) {
      throw new Error(
        `${label} must bind an independent backend process/cache`,
      );
    }
    paths.add(entry.path);
    endpoints.add(entry.declaration.endpointSha256);
    pids.add(entry.declaration.localProcessPid);
  }
}

function assertArtifactAnchor(
  payload: Readonly<Record<string, unknown>>,
  anchor: BlindBlockAnchor,
  label: string,
): void {
  if (
    payload.anchorNumber !== anchor.number ||
    String(payload.anchorHash).toLowerCase() !== anchor.hash.toLowerCase()
  ) {
    throw new Error(`${label} anchor mismatch`);
  }
}

export function seededInterleavedOrder(
  runCountPerSide: number,
  seed: string,
): readonly BlindRunOrderEntry[] {
  if (!Number.isSafeInteger(runCountPerSide) || runCountPerSide <= 0) {
    throw new Error("runCountPerSide must be positive");
  }
  if (!seed) throw new Error("order seed is required");
  const order: BlindRunOrderEntry[] = [];
  for (let runIndex = 0; runIndex < runCountPerSide; runIndex += 1) {
    const baselineFirst = Number.parseInt(
      sha256Canonical({ seed, runIndex }).slice(0, 2),
      16,
    ) % 2 === 0;
    order.push(
      {
        caseId: "primary",
        side: baselineFirst ? "baseline" : "challenger",
        runIndex,
      },
      {
        caseId: "primary",
        side: baselineFirst ? "challenger" : "baseline",
        runIndex,
      },
    );
  }
  const heldOutBaselineFirst = Number.parseInt(
    sha256Canonical({ seed, caseId: "held-out" }).slice(0, 2),
    16,
  ) % 2 === 0;
  const heldOut = [
    {
      caseId: "held-out" as const,
      side: heldOutBaselineFirst ? "baseline" as const : "challenger" as const,
      runIndex: 0,
    },
    {
      caseId: "held-out" as const,
      side: heldOutBaselineFirst ? "challenger" as const : "baseline" as const,
      runIndex: 0,
    },
  ];
  const insertAt = Number.parseInt(
    sha256Canonical({ seed, position: "held-out" }).slice(0, 8),
    16,
  ) % (order.length + 1);
  order.splice(insertAt, 0, ...heldOut);
  return Object.freeze(order);
}

function fileSha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function writeBlindRunManifest(
  path: string,
  manifest: BlindRunManifest,
): void {
  validateBlindRunManifest(manifest);
  writeFileSync(path, `${canonicalJson(manifest)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
}

function parseArgs(args: readonly string[]): { inputPath: string; outPath: string } {
  let inputPath = "";
  let outPath = "";
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (!value) throw new Error(`${name} requires a value`);
    if (name === "--input") inputPath = value;
    else if (name === "--out") outPath = value;
    else throw new Error(`unknown argument ${name}`);
  }
  if (!inputPath || !outPath) {
    throw new Error("usage: --input <blind-manifest-draft.json> --out <blind-manifest.json>");
  }
  return { inputPath, outPath };
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const draft = JSON.parse(readFileSync(args.inputPath, "utf8")) as BlindManifestDraft;
  const manifest = buildBlindRunManifest(draft);
  writeBlindRunManifest(args.outPath, manifest);
  console.log(`BLIND_MANIFEST_SHA256=${sha256Canonical(manifest)}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
