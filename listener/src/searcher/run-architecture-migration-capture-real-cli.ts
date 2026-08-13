import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { ethers } from "ethers";
import {
  architectureMigrationSideJson,
  exercisedStage,
  generateArchitectureMigrationSideCapture,
  type ArchitectureMigrationCaptureCorpus,
} from "./architecture-migration-capture.js";
import type {
  ArchitectureMigrationStage,
  RawFamilyMigrationCaseCapture,
  RawMigrationStageCapture,
} from "./architecture-migration-parity-runner.js";
import {
  captureFamilyGenerically,
  materializeGenericCaptureFundingPlan,
  runGenericCaptureBatch,
  type GenericCaptureProvider,
} from "./generic-family-capture.js";
import { createGenericCaptureRevmFinalSimulation } from
  "./generic-capture-revm-final-simulation.js";
import { RevmSimClient } from "./revm-sim-client.js";
import { createRevmStrictSimulationTransport } from
  "./revm-strict-simulation-transport.js";
import { createStrictCentralAdapterRuntime } from
  "./strict-central-adapter-runtime.js";
import type { CentralAdapterRuntime } from "./adapter-work-intent.js";
import type { FamilyCaptureDescriptor } from
  "./venues/adapter-family-plugin.js";
import type { CanonicalSource } from
  "./venues/adapter-request-program.js";
import type { CanonicalValue } from "./venues/canonical-value.js";
import { hashCanonical } from "./venues/canonical-value.js";
import { familyId } from "./venues/adapter-family-identifiers.js";
import { PRODUCTION_STRICT_VERIFIED_ACTORS } from
  "./venues/production-verified-actors.js";
import {
  PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG,
} from "./venues/production-family-composition.js";

interface CaptureDescriptorFile {
  readonly sourceBlock: number;
  readonly sourceBlockHash: string;
  readonly captureId?: string;
  readonly commit?: string;
  readonly cases: readonly {
    readonly familyId: string;
    readonly candidateIdentity: string;
    readonly opaqueBinding: CanonicalValue;
  }[];
}

const RPC_URL = process.env.S1_CAPTURE_RPC_URL ?? "http://127.0.0.1:8545";
const CASE_TIMEOUT_MS = positiveInteger(
  process.env.S1_GENERIC_CAPTURE_CASE_TIMEOUT_MS,
  60_000,
  "S1_GENERIC_CAPTURE_CASE_TIMEOUT_MS",
);
const REVM_TIMEOUT_MS = positiveInteger(
  process.env.S1_REVM_TIMEOUT_MS,
  60_000,
  "S1_REVM_TIMEOUT_MS",
);
const EXECUTOR = process.env.S1_CAPTURE_EXECUTOR;
const OWNER = process.env.S1_CAPTURE_OWNER;
const REVM_BIN = process.env.S1_REVM_SIM_BIN;

function buildRuntime(
  provider: GenericCaptureProvider,
  client: RevmSimClient,
): CentralAdapterRuntime {
  if (REVM_BIN === undefined || REVM_BIN.trim() === "") {
    throw new Error("S1_REVM_SIM_BIN is required for real capture");
  }
  if (EXECUTOR === undefined) throw new Error("S1_CAPTURE_EXECUTOR is required");
  return createStrictCentralAdapterRuntime({
    provider,
    generationFence: Object.freeze({ assertCurrent() {} }),
    verifiedActors: PRODUCTION_STRICT_VERIFIED_ACTORS,
    simulator: createRevmStrictSimulationTransport({
      client,
      executor: EXECUTOR,
      verifiedActors: PRODUCTION_STRICT_VERIFIED_ACTORS,
    }),
  });
}

async function main(): Promise<void> {
  const checkOnly = process.argv[2] === "--check";
  const descriptorPath = process.argv[checkOnly ? 3 : 2];
  const outPath = checkOnly ? undefined : process.argv[3];
  if (descriptorPath === undefined || (!checkOnly && outPath === undefined)) {
    throw new Error(
      "usage: run-architecture-migration-capture-real-cli.ts " +
        "[--check] <descriptor.json> [out-side.json]",
    );
  }
  if (REVM_BIN === undefined || EXECUTOR === undefined || OWNER === undefined) {
    throw new Error(
      "real capture requires S1_REVM_SIM_BIN, S1_CAPTURE_EXECUTOR and " +
        "S1_CAPTURE_OWNER",
    );
  }
  const manifest = validateDescriptorFile(
    JSON.parse(await readFile(descriptorPath, "utf8")),
  );
  const source: CanonicalSource = Object.freeze({
    number: manifest.sourceBlock,
    hash: manifest.sourceBlockHash.toLowerCase(),
    generation: manifest.sourceBlock,
  });
  const buildSide = async () => {
    const failures: { readonly id: string; readonly reason: string }[] = [];
    const tasks = manifest.cases.map((item) => {
      const request = new ethers.FetchRequest(RPC_URL);
      request.timeout = CASE_TIMEOUT_MS;
      const ethersProvider = new ethers.JsonRpcProvider(request);
      const provider = providerFacade(ethersProvider);
      const client = new RevmSimClient({
        executablePath: REVM_BIN,
        timeoutMs: REVM_TIMEOUT_MS,
      });
      const descriptor: FamilyCaptureDescriptor = Object.freeze({
        familyId: familyId(item.familyId),
        candidateIdentity: item.candidateIdentity,
        source,
        opaqueBinding: item.opaqueBinding,
      });
      return Object.freeze({
        id: `${item.familyId}:${item.candidateIdentity}`,
        timeoutMs: CASE_TIMEOUT_MS,
        cancel: () => {
          client.stop();
          ethersProvider.destroy();
        },
        run: async () => {
          try {
            const runtime = buildRuntime(provider, client);
            return await captureFamilyGenerically({
              catalog: PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG,
              descriptor,
              provider,
              runtime,
              fundingPlanFactory: (plan) =>
                materializeGenericCaptureFundingPlan({
                  catalog:
                    PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG,
                  ...plan,
                  runtime,
                }),
              finalSimulation: createGenericCaptureRevmFinalSimulation({
                client,
                rpcUrl: RPC_URL,
                owner: OWNER,
                executor: EXECUTOR,
              }),
            });
          } finally {
            client.stop();
            ethersProvider.destroy();
          }
        },
      });
    });
    const familyCases = await runGenericCaptureBatch({
      items: tasks,
      onFailure(id, error) {
        failures.push(Object.freeze({
          id,
          reason: error instanceof Error ? error.message : String(error),
        }));
      },
    });
    if (failures.length !== 0) {
      throw new Error(
        `generic capture incomplete: ${JSON.stringify(failures)}`,
      );
    }
    if (familyCases.length !== manifest.cases.length) {
      throw new Error("generic capture produced an incomplete denominator");
    }
    const evidenceRefs = Object.freeze([...new Set(familyCases.flatMap(
      (familyCase) => Object.values(familyCase.stages).flatMap(
        (stage) => stage?.evidenceRefs ?? [],
      ),
    ))].sort());
    const block = await new ethers.JsonRpcProvider(RPC_URL).send(
      "eth_getBlockByNumber",
      [ethers.toQuantity(source.number), false],
    ) as { readonly hash?: unknown; readonly stateRoot?: unknown } | null;
    if (
      typeof block?.hash !== "string" ||
      block.hash.toLowerCase() !== source.hash ||
      typeof block.stateRoot !== "string" ||
      !ethers.isHexString(block.stateRoot, 32)
    ) {
      throw new Error("capture source block is not canonical on the provider");
    }
    const commit = manifest.commit ?? currentCommit();
    const corpus: ArchitectureMigrationCaptureCorpus = Object.freeze({
      captureId: `${manifest.captureId ?? `catalog-capture-${source.number}`}:` +
        commit.slice(0, 12),
      commit,
      productionClosureHash: hashCanonical({
        commit,
        catalogHash:
          PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG.catalogHash,
      }),
      activationManifestHash:
        PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG.catalogHash,
      normalizedConfigHash: sha256(JSON.stringify({
        executor: EXECUTOR.toLowerCase(),
        owner: OWNER.toLowerCase(),
      })),
      productionPolicyHash: sha256(JSON.stringify({
        caseTimeoutMs: CASE_TIMEOUT_MS,
        revmTimeoutMs: REVM_TIMEOUT_MS,
        failureIsolation: true,
      })),
      corpusHash: hashCanonical(manifest as unknown as CanonicalValue),
      evidenceRefs,
      stateAnchors: Object.freeze([Object.freeze({
        number: source.number,
        hash: source.hash,
        stateRoot: block.stateRoot.toLowerCase(),
      })]),
      familyCases,
      commonGraph: commonGraph(source, familyCases, evidenceRefs),
    });
    return generateArchitectureMigrationSideCapture(corpus);
  };
  if (checkOnly) {
    const first = architectureMigrationSideJson(await buildSide());
    const second = architectureMigrationSideJson(await buildSide());
    if (first !== second) throw new Error("real capture is not reproducible");
    process.stdout.write("real catalog capture reproducible\n");
    return;
  }
  await writeFile(outPath!, architectureMigrationSideJson(await buildSide()));
  process.stdout.write(`real catalog capture written: ${outPath}\n`);
}

function commonGraph(
  source: CanonicalSource,
  cases: readonly RawFamilyMigrationCaseCapture[],
  evidenceRefs: readonly string[],
) {
  const stages: Partial<Record<ArchitectureMigrationStage, RawMigrationStageCapture>> = {};
  for (const stageName of [
    "edges",
    "enumeratedRoutes",
    "exactQuotes",
    "executionFragments",
    "finalSimulations",
  ] as const) {
    stages[stageName] = exercisedStage(cases.flatMap((item) =>
      item.stages[stageName]?.items ?? []
    ), evidenceRefs);
  }
  return Object.freeze({
    inputFingerprint: source.hash.slice(2),
    stages: Object.freeze(stages),
    crossFamilyBindings: Object.freeze([]),
  });
}

function providerFacade(provider: ethers.JsonRpcProvider): GenericCaptureProvider {
  const facade: GenericCaptureProvider = {
    call: (transaction, blockTag) => provider.call({
      ...transaction,
      ...(blockTag === undefined ? {} : { blockTag }),
    }),
    getCode: (address, blockTag) => provider.getCode(address, blockTag),
    getStorage: (address, slot, blockTag) =>
      provider.getStorage(address, slot, blockTag),
    getLogs: async (filter) => provider.getLogs({
      ...filter,
      topics: filter.topics === undefined ? undefined : [...filter.topics],
    }),
    getTransactionReceipt: async (hash) => provider.getTransactionReceipt(hash),
    send: (method, params) => provider.send(method, [...params]),
  };
  return Object.freeze(facade);
}

function validateDescriptorFile(value: unknown): CaptureDescriptorFile {
  if (value === null || typeof value !== "object") {
    throw new Error("capture descriptor must be an object");
  }
  const descriptor = value as Partial<CaptureDescriptorFile>;
  if (!Number.isSafeInteger(descriptor.sourceBlock) || descriptor.sourceBlock! < 0) {
    throw new Error("capture descriptor sourceBlock is invalid");
  }
  if (
    typeof descriptor.sourceBlockHash !== "string" ||
    !ethers.isHexString(descriptor.sourceBlockHash, 32)
  ) {
    throw new Error("capture descriptor sourceBlockHash is invalid");
  }
  if (!Array.isArray(descriptor.cases) || descriptor.cases.length === 0) {
    throw new Error("capture descriptor cases must be non-empty");
  }
  const seen = new Set<string>();
  for (const item of descriptor.cases) {
    if (
      item === null || typeof item !== "object" ||
      typeof item.familyId !== "string" || item.familyId.length === 0 ||
      typeof item.candidateIdentity !== "string" ||
      item.candidateIdentity.length === 0 ||
      !("opaqueBinding" in item)
    ) {
      throw new Error("capture descriptor case is malformed");
    }
    const key = `${item.familyId}\u001f${item.candidateIdentity.toLowerCase()}`;
    if (seen.has(key)) throw new Error(`capture descriptor duplicates ${key}`);
    seen.add(key);
    hashCanonical(item.opaqueBinding);
    PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG.forStrictFamily(
      familyId(item.familyId),
    );
  }
  return descriptor as CaptureDescriptorFile;
}

function currentCommit(): string {
  return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function positiveInteger(
  value: string | undefined,
  fallback: number,
  label: string,
): number {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return parsed;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
