import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  hashDomain,
  sha256Hex,
  type Hash,
} from "../../../packages/canonical-codec/src/index.ts";
import { createSqliteDurableStore, type SQLiteDurableStore } from "../../../packages/durable-store/src/index.ts";
import { readGeneratedFamilyRuntimeFactoryMetadata } from "../../../packages/family-composition/src/internal/generated-runtime-composition.ts";
import {
  createRuntimeAuthorityDescriptorV1,
} from "../../../packages/runtime-authority/src/index.ts";
import {
  createReleaseFamilyRuntimeComposition,
} from "../../../generated/runtime-composition/index.ts";
import {
  buildRuntimeComposition,
  type RuntimeCompositionServicesV1,
} from "../../../packages/runtime-release-authority/src/internal/bootstrap.ts";
import { issueRuntimeAuthorityV1, type RuntimeAuthorityV1 } from "../../../packages/runtime-release-authority/src/index.ts";
import { createRethSearcherRuntimeSourceV1, type RethSearcherRuntimeSourceV1 } from "./internal/reth-source.ts";
import {
  assertIssuedSearcherRuntimeApplicationOwnerV1,
  issueSearcherRuntimeApplicationOwnerV1,
  type SearcherRuntimeApplicationV1,
} from "./internal/application-owner.ts";
import { issueRuntimeObservationOwnerV1 } from "./runtime-observation.ts";
import {
  decodeRuntimePolicyBytesV1,
  type RuntimePolicyV1,
} from "./deployment-runtime-policy.ts";
import {
  decodeRuntimeSourceConfigBytesV1,
  runtimeSourceAuthorityRootV1,
  type RuntimeSourceConfigV1,
} from "./deployment-source.ts";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

export interface RuntimeStartInputV1 {
  readonly sourceConfigPath: string;
  readonly policyPath: string;
  readonly revmWorkerExecutablePath: string;
  readonly rpcEndpoint: string;
}

export interface RuntimeServiceHandleV1 {
  readonly application: SearcherRuntimeApplicationV1;
  readonly done: Promise<void>;
  readonly stop: () => Promise<void>;
}

function exactAbsolutePath(value: string, name: string): string {
  if (typeof value !== "string" || !value.startsWith("/")) {
    throw new TypeError(`${name} must be an absolute path`);
  }
  return realpathSync(value);
}

function rpcEndpoint(value: string): string {
  let parsed: URL;
  try { parsed = new URL(value); } catch { throw new TypeError("runtime RPC endpoint must be a URL"); }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new TypeError("runtime RPC endpoint must use HTTP(S)");
  }
  return parsed.href;
}

function currentImplementationCommit(): string {
  const value = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: repositoryRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
  if (!/^[0-9a-f]{40}$/.test(value)) throw new TypeError("runtime implementation commit is unavailable");
  return value;
}

function objective(policy: RuntimePolicyV1): Readonly<{
  readonly objectiveRef: Hash;
  readonly payload: RuntimePolicyV1["objective"];
}> {
  return Object.freeze({
    objectiveRef: hashDomain("aloha/runtime-objective/v1", policy.objective),
    payload: policy.objective,
  });
}

function createSource(
  source: RuntimeSourceConfigV1,
  policy: RuntimePolicyV1,
  endpoint: string,
): RethSearcherRuntimeSourceV1 {
  return createRethSearcherRuntimeSourceV1({
    canonical: {
      profile: source.profile,
      endpoint,
      chainId: source.chainId,
      timeoutMs: source.timeoutMs,
      journalPath: source.canonicalJournalPath,
      headPollIntervalMs: source.headPollIntervalMs,
    },
    ingress: {
      profile: source.profile,
      endpoint,
      pending: policy.pending,
      timeoutMs: source.timeoutMs,
      blockscan: {
        objective: objective(policy),
        callerId: policy.callerId,
        deadlineMs: policy.deadlineMs,
        admission: policy.admission,
      },
    },
  });
}

function createAuthority(
  sourceBytes: Uint8Array,
  policyBytes: Uint8Array,
  workerPath: string,
): RuntimeAuthorityV1 {
  const implementationCommit = currentImplementationCommit();
  const metadata = readGeneratedFamilyRuntimeFactoryMetadata(createReleaseFamilyRuntimeComposition);
  const runtimeBindingId = hashDomain("aloha/runtime-binding/input/v1", {
    implementationCommit,
    sourceConfigHash: sha256Hex(sourceBytes),
    policyHash: sha256Hex(policyBytes),
    revmExecutableHash: sha256Hex(new Uint8Array(readFileSync(workerPath))),
    definitionCatalogRoot: metadata.definitionCatalogRoot,
    familyDescriptorRoot: metadata.descriptorRoot,
  });
  return issueRuntimeAuthorityV1(createRuntimeAuthorityDescriptorV1({
    runtimeBindingId,
    implementationCommit,
  }));
}

function objectiveTemplate(policy: RuntimePolicyV1) {
  const searchObjective = objective(policy);
  return Object.freeze({
    objectiveRef: searchObjective.objectiveRef,
    profitAsset: policy.economicSafety.profitAsset,
    profitAccount: policy.economicSafety.profitAccount,
    minNetGain: policy.objective.minNetGain,
    maxGas: policy.objective.maxGas,
    maxValueAtRisk: policy.objective.maxValueAtRisk,
    priorityFeePerGas: policy.economicSafety.priorityFeePerGas,
    bidCostNative: policy.economicSafety.bidCostNative,
    valuationOwnerRef: policy.economicSafety.valuationOwnerRef,
  });
}

function compose(
  authority: RuntimeAuthorityV1,
  durable: SQLiteDurableStore,
  sourceOwner: RethSearcherRuntimeSourceV1,
  source: RuntimeSourceConfigV1,
  policy: RuntimePolicyV1,
  workerPath: string,
  endpoint: string,
): RuntimeCompositionServicesV1 {
  return buildRuntimeComposition({
    authority,
    durable,
    canonical: sourceOwner.canonical,
    source: {
      profile: source.profile,
      endpoint,
      chainId: source.chainId,
      timeoutMs: source.timeoutMs,
      provider: {
        provider: source.providerIdentity,
        backendEpoch: source.backendEpoch,
      },
      sourceAuthorityRoot: runtimeSourceAuthorityRootV1(source),
    },
    processEpoch: `${process.pid}:${Date.now()}`,
    revmWorkerExecutablePath: workerPath,
    generationPolicy: policy.generation,
    objectiveTemplates: Object.freeze([objectiveTemplate(policy)]),
    executor: policy.executor,
    revm: policy.revm,
  });
}

/** Start the only runtime. Its search terminal is a dry-run receipt because
 * this application has no signing or broadcast port at all. */
export async function startRuntimeServiceV1(
  input: RuntimeStartInputV1,
): Promise<RuntimeServiceHandleV1> {
  const sourcePath = exactAbsolutePath(input.sourceConfigPath, "runtime source config path");
  const policyPath = exactAbsolutePath(input.policyPath, "runtime policy path");
  const workerPath = exactAbsolutePath(input.revmWorkerExecutablePath, "REVM worker path");
  const sourceBytes = new Uint8Array(readFileSync(sourcePath));
  const policyBytes = new Uint8Array(readFileSync(policyPath));
  const source = decodeRuntimeSourceConfigBytesV1(sourceBytes);
  const policy = decodeRuntimePolicyBytesV1(policyBytes);
  const endpoint = rpcEndpoint(input.rpcEndpoint);
  const authority = createAuthority(sourceBytes, policyBytes, workerPath);
  const durable = createSqliteDurableStore(source.checkpointDatabasePath);
  let sourceOwner: RethSearcherRuntimeSourceV1 | null = null;
  let services: RuntimeCompositionServicesV1 | null = null;
  try {
    sourceOwner = createSource(source, policy, endpoint);
    services = compose(authority, durable, sourceOwner, source, policy, workerPath, endpoint);
    const observation = issueRuntimeObservationOwnerV1({
      databasePath: source.observationDatabasePath,
      runtimeAuthority: services.runtimeAuthority,
    });
    const applicationOwner = issueSearcherRuntimeApplicationOwnerV1({
      strategyRuntime: services.strategyRuntime,
      runtimeAuthority: services.runtimeAuthority,
      economicSafety: services.economicSafety,
      source: sourceOwner,
      coreInput: {
        amountSeed: policy.amountSeed,
        execution: {
          transactionOrigin: policy.executor.callerAddress,
          executorAddress: policy.executor.address,
        },
      },
      finalSimulationFactory: services.finalSimulationFactory,
      evidence: observation,
    });
    assertIssuedSearcherRuntimeApplicationOwnerV1(applicationOwner);
    const startup = await services.startup.startStartup();
    const application = applicationOwner.open(startup);
    const done = application.run();
    let stopPromise: Promise<void> | null = null;
    return Object.freeze({
      application,
      done,
      stop() {
        if (stopPromise !== null) return stopPromise;
        stopPromise = (async () => {
          await application.stop();
          await services!.revmPool.retireAll();
          authority.revoke();
          durable.close();
        })();
        return stopPromise;
      },
    });
  } catch (error) {
    if (services !== null) await services.revmPool.retireAll();
    sourceOwner?.close();
    authority.revoke();
    durable.close();
    throw error;
  }
}
