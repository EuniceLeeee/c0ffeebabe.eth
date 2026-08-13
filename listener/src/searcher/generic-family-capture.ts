import {
  exercisedStage,
  frameworkBlockedStage,
} from "./architecture-migration-capture.js";
import type {
  RawFamilyMigrationCaseCapture,
  RawMigrationStageCapture,
} from "./architecture-migration-parity-runner.js";
import {
  projectFamilyRouteGraph,
} from "./adapter-family-graph-runtime.js";
import { runStrictFamilyLifecycle } from
  "./strict-family-lifecycle-runner.js";
import type {
  CentralAdapterRuntime,
} from "./adapter-work-intent.js";
import type { FamilyCapabilityCatalog } from
  "./venues/family-capability-catalog.js";
import type { UnifiedObservation } from
  "./venues/adapter-family-plugin.js";
import type { CanonicalSource } from
  "./venues/adapter-request-program.js";
import type { FamilyId } from
  "./venues/adapter-family-identifiers.js";
import type { PreparedFamilyInstance } from
  "./venues/adapter-family-runtime.js";
import { definedFamilyPluginContractSummary } from
  "./venues/adapter-family-plugin.js";
import { ethers } from "ethers";
import type { OnchainUniv2Provider } from
  "./architecture-migration-fixture-replay.js";
import type { AdapterFamilyPublication } from
  "./venues/adapter-family-runtime.js";

export interface GenericCaptureProvider extends OnchainUniv2Provider {
  getCode(address: string, blockTag?: number): Promise<string>;
  getStorage(
    address: string,
    slot: string,
    blockTag?: number,
  ): Promise<string>;
  getLogs(filter: {
    readonly address?: string;
    readonly fromBlock?: number;
    readonly toBlock?: number;
    readonly topics?: (string | null)[];
  }): Promise<readonly {
    readonly address: string;
    readonly topics: readonly string[];
    readonly data: string;
    readonly transactionHash?: string;
  }[]>;
}

const EIP1967_IMPLEMENTATION_SLOT =
  "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";

/**
 * Central fault-isolation boundary for one plugin work item. The caller owns
 * the transport and supplies cancellation; a stuck Family cannot hold the
 * batch scheduler indefinitely or leave its provider alive in the background.
 */
export async function runGenericCaptureWorkItem<T>(input: {
  readonly id: string;
  readonly timeoutMs: number;
  readonly run: () => Promise<T>;
  readonly cancel: () => void;
}): Promise<T> {
  if (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs <= 0) {
    throw new Error("generic capture work-item timeout must be positive");
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      input.run(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          input.cancel();
          reject(new Error(
            `${input.id} exceeded ${input.timeoutMs}ms`,
          ));
        }, input.timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export async function runGenericCaptureBatch<T>(input: {
  readonly items: readonly {
    readonly id: string;
    readonly timeoutMs: number;
    readonly run: () => Promise<T>;
    readonly cancel: () => void;
  }[];
  readonly onFailure: (id: string, error: unknown) => void;
}): Promise<readonly T[]> {
  const completed: T[] = [];
  for (const item of input.items) {
    try {
      completed.push(await runGenericCaptureWorkItem(item));
    } catch (error) {
      input.onFailure(item.id, error);
    }
  }
  return Object.freeze(completed);
}

/**
 * Per-plugin exact/execution driver registry (architecture-sanctioned:
 * each family plugin ships its own exact/execution modules). A family with a
 * registered driver gets exact/execution/final-sim exercised by the generic
 * capture; without one the stages stay honestly framework-blocked.
 */
export interface GenericCaptureDriver {
  readonly familyId: FamilyId;
  buildExactQuotes(input: {
    readonly publication: AdapterFamilyPublication;
    readonly source: CanonicalSource;
    readonly evidenceRefs: readonly string[];
  }): RawMigrationStageCapture;
  buildExecutionAndFinalSim(input: {
    readonly publication: AdapterFamilyPublication;
    readonly source: CanonicalSource;
    readonly evidenceRefs: readonly string[];
  }): {
    readonly executionFragments: RawMigrationStageCapture;
    readonly finalSimulations: RawMigrationStageCapture;
  };
}

const genericCaptureDrivers = new Map<FamilyId, GenericCaptureDriver>();

export function registerGenericCaptureDriver(
  driver: GenericCaptureDriver,
): void {
  if (genericCaptureDrivers.has(driver.familyId)) {
    throw new Error(
      `generic capture driver already registered for ${driver.familyId}`,
    );
  }
  genericCaptureDrivers.set(driver.familyId, driver);
}

export function resolveGenericCaptureDriver(
  familyId: FamilyId,
): GenericCaptureDriver | null {
  return genericCaptureDrivers.get(familyId) ?? null;
}

/**
 * Generic observation derivation driven by the family plugin's discovery
 * declarations: singleton log emitters -> real historical log, then
 * callPatterns -> call observation, address logPatterns -> log
 * observation, addressSurfaces -> address-surface observation with real
 * code hash + EIP-1967 implementation word read at the source block.
 */
export async function deriveFamilyObservationFromNodeData(input: {
  readonly catalog: FamilyCapabilityCatalog;
  readonly familyId: FamilyId;
  readonly source: CanonicalSource;
  readonly address: string;
  readonly provider: GenericCaptureProvider;
}): Promise<UnifiedObservation> {
  const family = input.catalog.forFamily(input.familyId);
  const discovery = "discovery" in family.plugin
    ? family.plugin.discovery
    : null;
  if (discovery === null) {
    throw new Error(
      `family ${input.familyId} declares no discovery semantics`,
    );
  }
  const address = input.address.toLowerCase();
  const singletonPattern = discovery.logPatterns?.find((pattern) =>
    pattern.emitter !== undefined && pattern.emitter.mode !== "address"
  );
  if (singletonPattern?.emitter !== undefined &&
      singletonPattern.emitter.mode !== "address") {
    const emitter = singletonPattern.emitter;
    const identityTopic = emitter.mode === "singleton-indexed-bytes32"
      ? ethers.hexlify(ethers.getBytes(address))
      : ethers.zeroPadValue(ethers.getAddress(address), 32).toLowerCase();
    if (ethers.dataLength(identityTopic) !== 32) {
      throw new Error(
        `family ${input.familyId} singleton identity must be 32 bytes`,
      );
    }
    const topics: (string | null)[] = [singletonPattern.topic];
    while (topics.length < emitter.topicIndex) topics.push(null);
    topics.push(identityTopic.toLowerCase());
    const logs = await input.provider.getLogs({
      address: emitter.address,
      fromBlock: emitter.fromBlock,
      toBlock: input.source.number,
      topics,
    });
    const log = logs.at(-1);
    if (log === undefined) {
      throw new Error(
        `family ${input.familyId} has no declared singleton log for ${address}`,
      );
    }
    return Object.freeze({
      kind: "log" as const,
      source: input.source,
      address: log.address.toLowerCase(),
      topics: Object.freeze([...log.topics]),
      data: log.data,
      ...(log.transactionHash === undefined
        ? {}
        : { transactionHash: log.transactionHash }),
    });
  }
  if ((discovery.callPatterns?.length ?? 0) > 0) {
    const pattern = discovery.callPatterns![0];
    return Object.freeze({
      kind: "call" as const,
      source: input.source,
      target: address,
      data: `${pattern.selector}${"0".repeat(64)}`,
    });
  }
  if ((discovery.logPatterns?.length ?? 0) > 0) {
    const pattern = discovery.logPatterns![0];
    return Object.freeze({
      kind: "log" as const,
      source: input.source,
      address,
      topics: Object.freeze([pattern.topic]),
      data: "0x",
    });
  }
  if ((discovery.addressSurfaces?.length ?? 0) > 0) {
    const [code, implementationWord] = await Promise.all([
      input.provider.getCode(address, input.source.number),
      input.provider.getStorage(
        address,
        EIP1967_IMPLEMENTATION_SLOT,
        input.source.number,
      ),
    ]);
    return Object.freeze({
      kind: "address-surface" as const,
      source: input.source,
      address,
      codeHash: ethers.keccak256(code),
      implementationWord: implementationWord.toLowerCase(),
    });
  }
  throw new Error(
    `family ${input.familyId} declares no usable discovery pattern`,
  );
}

/**
 * Generic real-capture core (F5-b generic path): one family is captured by
 * (a) deriving the observation from the family plugin's discovery
 * declarations plus a real address, (b) running the standard strict
 * lifecycle, and (c) assembling every publication-derivable stage
 * generically. Exact/execution/final-sim are driven by the family plugin's
 * own exact/execution modules (per-plugin by architecture design), supplied
 * through the optional driver; absent a driver they are honestly marked
 * framework-blocked instead of fabricated.
 */
export async function captureFamilyGenerically(input: {
  readonly catalog: FamilyCapabilityCatalog;
  readonly familyId: FamilyId;
  readonly source: CanonicalSource;
  readonly observation: UnifiedObservation;
  readonly runtime: CentralAdapterRuntime;
  readonly caseId?: string;
  readonly driver?: GenericCaptureDriver | null;
}): Promise<RawFamilyMigrationCaseCapture> {
  const family = input.catalog.forFamily(input.familyId);
  const publication = await runStrictFamilyLifecycle({
    catalog: input.catalog,
    familyId: input.familyId,
    source: input.source,
    observations: Object.freeze([input.observation]),
    runtime: input.runtime,
  });
  const evidenceRefs = Object.freeze([
    `onchain:1:${input.source.hash}:generic:${input.familyId}`,
  ]);
  const edges: RawMigrationStageCapture["items"][number][] = [];
  const prices: RawMigrationStageCapture["items"][number][] = [];
  for (const instance of publication.instances) {
    for (const route of instance.routes) {
      const handle = instance.routeHandles.find((candidate) =>
        candidate.routeKey === route.routeKey
      );
      if (handle === undefined) {
        throw new Error(
          `prepared route ${route.routeKey} has no issued handle`,
        );
      }
      const projected = projectFamilyRouteGraph({
        family,
        descriptor: instance.descriptor,
        route,
        handle,
      });
      edges.push(Object.freeze({
        id: projected.edge.canonicalEdgeId,
        value: Object.freeze({
          routeKey: route.routeKey,
          tokenIn: route.tokenIn,
          tokenOut: route.tokenOut,
          canonicalEdgeId: projected.edge.canonicalEdgeId,
        }),
      }));
    }
    const routeByKey = new Map(
      instance.routes.map((route) => [route.routeKey, route]),
    );
    for (const pricing of instance.pricingInstances) {
      for (const [routeKey, mid] of pricing.mids) {
        const route = routeByKey.get(routeKey);
        if (route === undefined) {
          throw new Error(
            `${input.familyId} pricing route ${routeKey} is missing`,
          );
        }
        prices.push(Object.freeze({
          id: `${pricing.stateKey}:${route.tokenIn.toLowerCase()}>` +
            `${route.tokenOut.toLowerCase()}`,
          value: Object.freeze({
            stateKey: pricing.stateKey,
            mid: Object.freeze({ ...mid }),
          }) as unknown as RawMigrationStageCapture["items"][number]["value"],
        }));
      }
    }
  }
  const enumeratedRoutes: RawMigrationStageCapture["items"][number][] = edges
    .map((edge) => edge.value as {
      readonly routeKey: string;
      readonly tokenIn: string;
      readonly tokenOut: string;
      readonly canonicalEdgeId: string;
    })
    .sort((left, right) => left.routeKey.localeCompare(right.routeKey))
    .map((value, order) => Object.freeze({
      id: value.canonicalEdgeId,
      value: Object.freeze({
        routeKey: value.routeKey,
        tokenIn: value.tokenIn,
        tokenOut: value.tokenOut,
        canonicalEdgeId: value.canonicalEdgeId,
        order,
      }),
    }));
  const driver = input.driver === undefined
    ? resolveGenericCaptureDriver(input.familyId)
    : input.driver;
  const exactQuotes = driver === null
    ? frameworkBlockedStage(
        evidenceRefs,
        "generic-capture-exact-driver-not-registered",
      )
    : driver.buildExactQuotes({
        publication,
        source: input.source,
        evidenceRefs,
      });
  const execution = driver === null
    ? {
        executionFragments: frameworkBlockedStage(
          evidenceRefs,
          "generic-capture-execution-driver-not-registered",
        ),
        finalSimulations: frameworkBlockedStage(
          evidenceRefs,
          "generic-capture-final-sim-driver-not-registered",
        ),
      }
    : driver.buildExecutionAndFinalSim({
        publication,
        source: input.source,
        evidenceRefs,
      });
  const instances = publication.instances;
  const summary = definedFamilyPluginContractSummary(family.plugin);
  return Object.freeze({
    familyId: input.familyId,
    caseId: input.caseId ?? `${input.familyId}:${input.source.number}`,
    inputFingerprint: input.source.hash.slice(2).padStart(64, "0"),
    stateAnchorNumber: input.source.number,
    implementationClosureHash: summary.definitionBoundaryHash,
    stages: Object.freeze({
      instances: instanceStage(instances, evidenceRefs),
      edges: exercisedStage(edges, evidenceRefs),
      stateCoverage: exercisedStage([], evidenceRefs),
      pricedEdges: exercisedStage([], evidenceRefs),
      prices: exercisedStage(prices, evidenceRefs),
      failures: exercisedStage([], evidenceRefs),
      enumeratedRoutes: exercisedStage(enumeratedRoutes, evidenceRefs),
      exactQuotes,
      executionFragments: execution.executionFragments,
      finalSimulations: execution.finalSimulations,
    }),
  });
}

function instanceStage(
  instances: readonly PreparedFamilyInstance[],
  evidenceRefs: readonly string[],
): RawMigrationStageCapture {
  return exercisedStage(instances.map((instance) => Object.freeze({
    id: instance.instanceKey,
    value: Object.freeze({
      familyId: instance.familyId,
      instanceKey: instance.instanceKey,
      staticBindingFingerprint: instance.staticBindingFingerprint,
    }),
  })), evidenceRefs);
}
