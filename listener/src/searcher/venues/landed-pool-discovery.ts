import { ethers } from "ethers";
import type { PoolEntry } from "../planner/token-graph.js";
import type {
  ExecutionFamilyId,
  SwapAdapter,
} from "./route-leg-adapter.js";
import type { IdentityAdmissionPolicy } from "./admission.js";
import {
  observedLandedPoolIdentity,
  type LandedSwapEventDescriptor,
  type LandedEventRegistry,
} from "./landed-event-registry.js";

export interface LandedPoolDiscoveryLog {
  readonly address: string;
  readonly topics: readonly string[];
  readonly data: string;
  readonly blockNumber: string | number;
}

export interface LandedPoolDiscoveryLogFilter {
  readonly address?: string;
  readonly topics: readonly (string | readonly string[] | null)[];
  readonly fromBlock: number;
  readonly toBlock: number;
}

export interface LandedPoolDiscoveryReadBackend {
  getLogs(
    filter: LandedPoolDiscoveryLogFilter,
    control?: { readonly signal?: AbortSignal },
  ): Promise<readonly LandedPoolDiscoveryLog[]>;
  call(
    req: { readonly to: string; readonly data: string },
    control?: { readonly signal?: AbortSignal },
  ): Promise<string>;
  getCode?(
    address: string,
    control?: { readonly signal?: AbortSignal },
  ): Promise<string>;
}

export interface LandedPoolDiscoveryScanResult {
  readonly logs: readonly LandedPoolDiscoveryLog[];
  readonly complete: boolean;
  readonly issues: readonly string[];
}

export interface LandedPoolMaterializationContext {
  readonly familyId: ExecutionFamilyId;
  readonly event: LandedSwapEventDescriptor;
  readonly logs: readonly LandedPoolDiscoveryLog[];
  /**
   * Previously admitted family instances from the frozen input inventory.
   * They may resolve opaque landed identities (for example a V4 poolId), but
   * retryable/unpublished instances must still be re-attested before
   * publication.
   */
  readonly retainedPools: readonly PoolEntry[];
  /**
   * Previously observed instances whose family-owned identity/materialization
   * read did not reach a terminal decision. They must be retried even when the
   * original Swap log is no longer inside the next incremental block range.
   */
  readonly retryablePools: readonly PoolEntry[];
  /**
   * True only for an instance already admitted into the frozen graph
   * generation. A materializer may reuse that exact metadata rather than
   * repeating identity RPC.
   */
  isKnownPool(pool: PoolEntry): boolean;
  readonly fromBlock: number;
  readonly toBlock: number;
  readonly minSwaps: number;
  readonly admissionPolicy: IdentityAdmissionPolicy;
  /**
   * Hot current-head discovery must not perform an unbounded historical
   * identity crawl. A bounded miss remains an explicit family-owned retry;
   * detached/startup discovery may complete the historical proof.
   */
  readonly historicalResolution: "bounded" | "complete";
  readonly signal?: AbortSignal;
  readonly backend: LandedPoolDiscoveryReadBackend;
  scanLogs(filter: LandedPoolDiscoveryLogFilter): Promise<LandedPoolDiscoveryScanResult>;
}

export interface LandedPoolMaterializationResult {
  readonly pools: readonly PoolEntry[];
  /**
   * True only when every qualifying event identity reached a terminal
   * source-pinned outcome: an admitted PoolEntry or a proven permanent
   * negative. Returning positives while false is allowed, but the
   * family/source may not publish negative completeness.
   */
  readonly complete: boolean;
  readonly issues?: readonly string[];
  /**
   * Present only when every unresolved materialization candidate is represented
   * here and can therefore be retried without replaying the original log.
   * Strict discovery may advance source coverage only for this typed deferred
   * state; an incomplete result without this proof remains globally fail-closed.
   */
  readonly retryablePools?: readonly PoolEntry[];
}

export interface LandedPoolMaterializationCapability {
  readonly version: string;
  /** Landed swap declaration ids owned by this materializer. */
  readonly eventIds: readonly string[];
  /**
   * This materializer can reconstruct an address-emitter candidate from a
   * persisted PoolEntry after the original log leaves the incremental range.
   */
  readonly consumesAddressRetries?: true;
  /**
   * This materializer can reconstruct a non-address identity (for example a
   * V4 poolId) from a persisted typed PoolEntry after the original log leaves
   * the incremental range.
   */
  readonly consumesOpaqueRetries?: true;
  materialize(
    context: LandedPoolMaterializationContext,
  ): Promise<LandedPoolMaterializationResult>;
}

export interface LandedAddressPoolCandidate {
  readonly address: string;
  readonly poolAdapter: PoolEntry["adapter"];
  readonly swapCount: number;
  readonly lastSwapBlock: number;
}

export interface AddressLandedPoolMaterializerOptions {
  readonly version: string;
  readonly eventIds: readonly string[];
  readonly concurrency?: number;
  /**
   * One untrusted emitter must not consume the whole block-scan deadline.
   * Expiry keeps this family/source incomplete; sibling families remain
   * eligible for the same source block.
   */
  readonly materializationTimeoutMs?: number;
  /**
   * Return null only for a completed, permanent negative identity decision.
   * Transport/incomplete reads must throw so source completeness stays false.
   */
  materializePool(
    candidate: LandedAddressPoolCandidate,
    context: LandedPoolMaterializationContext,
  ): Promise<PoolEntry | null>;
}

/**
 * Shared address-emitter transport. Families own identity and metadata reads;
 * the coordinator owns log aggregation, minSwaps, bounded concurrency and
 * completeness. Adding a non-V2/V3 family therefore needs no universe switch.
 */
export function createAddressLandedPoolMaterializer(
  options: AddressLandedPoolMaterializerOptions,
): LandedPoolMaterializationCapability {
  const concurrency = Math.max(1, Math.floor(options.concurrency ?? 24));
  const materializationTimeoutMs = options.materializationTimeoutMs ?? 3_000;
  if (
    !Number.isFinite(materializationTimeoutMs) ||
    materializationTimeoutMs <= 0
  ) {
    throw new Error("address materialization timeout must be positive");
  }
  return Object.freeze({
    version: options.version,
    eventIds: Object.freeze([...options.eventIds]),
    consumesAddressRetries: true,
    async materialize(
      context: LandedPoolMaterializationContext,
    ): Promise<LandedPoolMaterializationResult> {
      if (context.event.emitter.mode === "singleton-indexed-bytes32") {
        return {
          pools: [],
          complete: false,
          issues: ["address materializer cannot consume a bytes32 pool identity"],
        };
      }
      const candidates = new Map<string, {
        address: string;
        count: number;
        lastSwapBlock: number;
      }>();
      const retainedByAddress = new Map<string, PoolEntry | null>();
      for (const pool of context.retainedPools) {
        if (
          pool.adapter !== context.event.discovery.poolAdapter ||
          !context.isKnownPool(pool)
        ) {
          continue;
        }
        const key = pool.address.toLowerCase();
        // A bare address event cannot distinguish two logical instances.
        // Re-run the family probe instead of choosing one arbitrarily.
        retainedByAddress.set(
          key,
          retainedByAddress.has(key) ? null : pool,
        );
      }
      const sourceIssues: string[] = [];
      for (const pool of context.retryablePools) {
        const activity = pool as PoolEntry & {
          readonly lastSwapBlock?: number;
          readonly source?: string;
        };
        if (
          pool.adapter !== context.event.discovery.poolAdapter ||
          !materializerConsumesRetry(
            pool,
            context.event.id,
            options.eventIds,
          ) ||
          context.isKnownPool(pool)
        ) {
          continue;
        }
        try {
          const address = ethers.getAddress(pool.address);
          const key = address.toLowerCase();
          const count = Math.max(
            context.minSwaps,
            Math.floor(pool.score ?? context.minSwaps),
          );
          const candidate = candidates.get(key) ?? {
            address,
            count: 0,
            lastSwapBlock: 0,
          };
          candidate.count = Math.max(candidate.count, count);
          const lastSwapBlock =
            Number.isSafeInteger(activity.lastSwapBlock) &&
              (activity.lastSwapBlock ?? -1) >= 0
              ? activity.lastSwapBlock!
              : 0;
          candidate.lastSwapBlock = Math.max(
            candidate.lastSwapBlock,
            lastSwapBlock,
          );
          candidates.set(key, candidate);
        } catch {
          sourceIssues.push(
            `invalid retryable landed pool address ${pool.address}`,
          );
        }
      }
      for (const log of context.logs) {
        const identity = observedLandedPoolIdentity(context.event, {
          address: log.address,
          topics: log.topics,
        });
        if (!identity) {
          sourceIssues.push(
            "landed event could not be materialized as an address",
          );
          continue;
        }
        try {
          const address = ethers.getAddress(identity);
          const key = address.toLowerCase();
          const candidate = candidates.get(key) ?? {
            address,
            count: 0,
            lastSwapBlock: 0,
          };
          candidate.count++;
          candidate.lastSwapBlock = Math.max(
            candidate.lastSwapBlock,
            parseBlockNumber(log.blockNumber),
          );
          candidates.set(key, candidate);
        } catch {
          sourceIssues.push(`invalid landed pool address ${identity}`);
        }
      }

      const qualifying = [...candidates.values()]
        .filter((candidate) => candidate.count >= context.minSwaps);
      const resolvedPools = new Array<PoolEntry | null>(qualifying.length)
        .fill(null);
      const retryablePools = new Array<PoolEntry | null>(qualifying.length)
        .fill(null);
      const states = new Array<
        "pending" | "resolved" | "permanent" | "retryable"
      >(qualifying.length).fill("pending");
      const materializationIssues = new Array<string | null>(
        qualifying.length,
      ).fill(null);
      const controller = new AbortController();
      const signal = context.signal === undefined
        ? controller.signal
        : AbortSignal.any([context.signal, controller.signal]);
      const timeout = setTimeout(
        () =>
          controller.abort(
            new Error(
              `landed family ${context.familyId} materialization exceeded ` +
                `${materializationTimeoutMs}ms`,
            ),
          ),
        materializationTimeoutMs,
      );
      const scopedBackend: LandedPoolDiscoveryReadBackend = {
        getLogs: (filter, control) =>
          context.backend.getLogs(filter, {
            signal: mergeAbortSignals(signal, control?.signal),
          }),
        call: (req, control) =>
          context.backend.call(req, {
            signal: mergeAbortSignals(signal, control?.signal),
          }),
        ...(context.backend.getCode === undefined
          ? {}
          : {
              getCode: (address: string, control?: { readonly signal?: AbortSignal }) =>
                context.backend.getCode!(address, {
                  signal: mergeAbortSignals(signal, control?.signal),
                }),
            }),
      };
      const scopedContext: LandedPoolMaterializationContext = Object.freeze({
        ...context,
        signal,
        backend: scopedBackend,
      });
      try {
        let next = 0;
        const workers = Array.from(
          { length: Math.min(concurrency, Math.max(1, qualifying.length)) },
          async () => {
            while (next < qualifying.length) {
              throwIfAborted(context.signal);
              if (controller.signal.aborted) break;
              const index = next++;
              const candidate = qualifying[index];
              const input = Object.freeze({
                address: candidate.address,
                poolAdapter: context.event.discovery.poolAdapter,
                swapCount: candidate.count,
                lastSwapBlock: candidate.lastSwapBlock,
              });
              try {
                const retained = retainedByAddress.get(
                  candidate.address.toLowerCase(),
                );
                const pool = retained ??
                  await raceAbort(
                    options.materializePool(input, scopedContext),
                    signal,
                  );
                if (pool === null) {
                  states[index] = "permanent";
                  continue;
                }
                if (
                  ethers.getAddress(pool.address).toLowerCase() !==
                    candidate.address.toLowerCase() ||
                  pool.adapter !== context.event.discovery.poolAdapter
                ) {
                  throw new Error(
                    "family materializer returned a foreign pool identity",
                  );
                }
                resolvedPools[index] = Object.freeze({
                  ...pool,
                  score: candidate.count,
                  swapCount30d: candidate.count,
                  lastSwapBlock: candidate.lastSwapBlock,
                  source: `landed-event:${context.event.id}`,
                }) as PoolEntry;
                states[index] = "resolved";
              } catch (error) {
                if (context.signal?.aborted) throw error;
                states[index] = "retryable";
                retryablePools[index] = retryablePoolEntry(
                  candidate,
                  context.event,
                );
                materializationIssues[index] =
                  `${candidate.address}: ${errorMessage(error)}`;
              }
            }
          },
        );
        await Promise.all(workers);
      } finally {
        clearTimeout(timeout);
      }
      throwIfAborted(context.signal);
      for (let index = 0; index < qualifying.length; index++) {
        if (states[index] !== "pending") continue;
        const candidate = qualifying[index];
        states[index] = "retryable";
        retryablePools[index] = retryablePoolEntry(
          candidate,
          context.event,
        );
        materializationIssues[index] =
          `${candidate.address}: landed family ${context.familyId} ` +
          `materialization exceeded ${materializationTimeoutMs}ms`;
      }
      const retryIssues = materializationIssues.filter(
        (issue): issue is string => issue !== null,
      );
      const issues = [
        ...sourceIssues,
        ...retryIssues,
      ];
      const deferred = retryablePools.filter(
        (pool): pool is PoolEntry => pool !== null,
      );
      return {
        pools: Object.freeze(
          resolvedPools.filter((pool): pool is PoolEntry => pool !== null),
        ),
        complete: issues.length === 0,
        ...(issues.length === 0
          ? {}
          : { issues: Object.freeze(issues) }),
        ...(sourceIssues.length === 0 && deferred.length > 0
          ? { retryablePools: Object.freeze(deferred) }
          : {}),
      };
    },
  });
}

export interface LandedPoolDiscoveryDescriptor {
  readonly event: LandedSwapEventDescriptor;
  readonly sourceId: string;
  readonly sourceFingerprint: string;
  readonly materializer: LandedPoolMaterializationCapability | null;
  readonly materializerFamilyId: ExecutionFamilyId | null;
}

export interface LandedPoolDiscoveryCoverage {
  readonly familyId: ExecutionFamilyId;
  readonly sourceId: string;
  readonly sourceFingerprint: string;
  readonly eventId: string;
  readonly consumed: boolean;
  readonly complete: boolean;
  readonly issues: readonly string[];
}

export interface LandedPoolActivity {
  readonly address: string;
  readonly adapterCounts: Map<PoolEntry["adapter"], number>;
  count: number;
  lastSwapBlock: number;
}

export interface LandedPoolDiscoveryResult {
  readonly activity: Map<string, LandedPoolActivity>;
  readonly materializedPools: readonly PoolEntry[];
  readonly retryablePools: readonly PoolEntry[];
  readonly coverage: readonly LandedPoolDiscoveryCoverage[];
  readonly logCountsByEventId: ReadonlyMap<string, number>;
}

/**
 * Registry-derived discovery projection. Only mature V2/V3 address emitters
 * retain the existing generic enrichment fast path. Every other swap family
 * must ship a typed materializer, so registering it is sufficient to reach the
 * universe without adding another central venue branch.
 */
export class LandedPoolDiscoveryRegistry {
  private readonly descriptors: readonly LandedPoolDiscoveryDescriptor[];
  private readonly addressRetryPoolAdapters: ReadonlySet<PoolEntry["adapter"]>;
  private readonly materializationRetryPoolAdapters:
    ReadonlySet<PoolEntry["adapter"]>;

  constructor(
    families: readonly SwapAdapter[],
    landedEvents: LandedEventRegistry,
  ) {
    const familyById = new Map(families.map((family) => [family.id, family]));
    const descriptors: LandedPoolDiscoveryDescriptor[] = [];
    for (const event of landedEvents.swapEvents) {
      const materializers = event.executionFamilies.flatMap((familyId) => {
        const family = familyById.get(familyId as ExecutionFamilyId);
        if (!family) {
          throw new Error(
            `landed-pool discovery: event ${event.id} has missing family ${familyId}`,
          );
        }
        const materializer = family.poolDiscovery;
        return materializer?.eventIds.includes(event.id)
          ? [{ familyId, materializer }]
          : [];
      });
      const requiresFamilyMaterializer =
        event.materialization === "family" ||
        event.emitter.mode === "singleton-indexed-bytes32" ||
        event.executionFamilies.some((familyId) =>
          familyById.get(familyId as ExecutionFamilyId)
            ?.matureDexUniverseDiscovery !== true
        );
      if (requiresFamilyMaterializer && materializers.length === 0) {
        throw new Error(
          `landed-pool discovery: ${event.id} requires a family materializer`,
        );
      }
      if (materializers.length > 1) {
        throw new Error(
          `landed-pool discovery: ${event.id} has multiple family materializers`,
        );
      }
      descriptors.push(Object.freeze({
        event,
        sourceId: `landed-event:${event.id}`,
        sourceFingerprint: discoverySourceFingerprint(
          event,
          materializers[0]?.materializer ?? null,
        ),
        materializer: materializers[0]?.materializer ?? null,
        materializerFamilyId:
          (materializers[0]?.familyId as ExecutionFamilyId | undefined) ?? null,
      }));
    }

    for (const family of families) {
      const declaredEventIds = new Set(
        family.landedEvents.swaps.map((event) => event.id),
      );
      const materializedEventIds = family.poolDiscovery?.eventIds ?? [];
      if (
        new Set(materializedEventIds).size !== materializedEventIds.length ||
        materializedEventIds.some((eventId) => !declaredEventIds.has(eventId))
      ) {
        throw new Error(
          `landed-pool discovery: ${family.id} materializes undeclared/duplicate events`,
        );
      }
      if (
        family.poolDiscovery !== undefined &&
        (
          !family.poolDiscovery.version.trim() ||
          family.poolDiscovery.eventIds.length === 0
        )
      ) {
        throw new Error(
          `landed-pool discovery: ${family.id} has invalid materializer contract`,
        );
      }
    }
    this.descriptors = Object.freeze(descriptors);
    this.addressRetryPoolAdapters = new Set(
      descriptors
        .filter((descriptor) =>
          descriptor.materializer?.consumesAddressRetries === true
        )
        .map((descriptor) => descriptor.event.discovery.poolAdapter),
    );
    this.materializationRetryPoolAdapters = new Set(
      descriptors
        .filter((descriptor) =>
          descriptor.materializer?.consumesAddressRetries === true ||
          descriptor.materializer?.consumesOpaqueRetries === true
        )
        .map((descriptor) => descriptor.event.discovery.poolAdapter),
    );
  }

  list(): readonly LandedPoolDiscoveryDescriptor[] {
    return this.descriptors;
  }

  consumesAddressRetries(poolAdapter: PoolEntry["adapter"]): boolean {
    return this.addressRetryPoolAdapters.has(poolAdapter);
  }

  consumesMaterializationRetries(
    poolAdapter: PoolEntry["adapter"],
  ): boolean {
    return this.materializationRetryPoolAdapters.has(poolAdapter);
  }
}

export async function discoverLandedPools(input: {
  readonly registry: LandedPoolDiscoveryRegistry;
  readonly backend: LandedPoolDiscoveryReadBackend;
  readonly fromBlock: number;
  readonly toBlock: number;
  readonly batchSize: number;
  readonly minSwaps: number;
  readonly admissionPolicy: IdentityAdmissionPolicy;
  readonly retainedPools?: readonly PoolEntry[];
  readonly retryablePools?: readonly PoolEntry[];
  readonly isKnownPool?: (pool: PoolEntry) => boolean;
  readonly topicScanMode?: "per-event" | "union";
  readonly historicalResolution?: "bounded" | "complete";
  readonly strict?: boolean;
  readonly signal?: AbortSignal;
}): Promise<LandedPoolDiscoveryResult> {
  assertRange(input.fromBlock, input.toBlock);
  if (!Number.isSafeInteger(input.batchSize) || input.batchSize <= 0) {
    throw new Error("landed-pool discovery batchSize must be positive");
  }
  if (!Number.isSafeInteger(input.minSwaps) || input.minSwaps < 1) {
    throw new Error("landed-pool discovery minSwaps must be positive");
  }
  if (input.topicScanMode === "union") {
    return discoverLandedPoolsByTopicUnion(input);
  }

  const activity = new Map<string, LandedPoolActivity>();
  const materializedPools: PoolEntry[] = [];
  const retryablePools: PoolEntry[] = [];
  const coverage: LandedPoolDiscoveryCoverage[] = [];
  const logCountsByEventId = new Map<string, number>();
  for (const descriptor of input.registry.list()) {
    throwIfAborted(input.signal);
    let complete = true;
    const issues: string[] = [];
    if (descriptor.materializer) {
      const eventScan = await scanDescriptorRange(
        input.backend,
        descriptor.event,
        input.fromBlock,
        input.toBlock,
        input.batchSize,
        input.signal,
      );
      logCountsByEventId.set(descriptor.event.id, eventScan.logs.length);
      assertStrictSourceComplete(
        input.strict,
        descriptor.sourceId,
        eventScan.complete,
        eventScan.issues,
      );
      complete &&= eventScan.complete;
      issues.push(...eventScan.issues);
      try {
        const result = await descriptor.materializer.materialize({
          familyId: descriptor.materializerFamilyId ??
            descriptor.event.executionFamilies[0] as ExecutionFamilyId,
          event: descriptor.event,
          logs: eventScan.logs,
          retainedPools: input.retainedPools ?? [],
          retryablePools: input.retryablePools ?? [],
          isKnownPool: input.isKnownPool ?? (() => false),
          fromBlock: input.fromBlock,
          toBlock: input.toBlock,
          minSwaps: input.minSwaps,
          admissionPolicy: input.admissionPolicy,
          historicalResolution: input.historicalResolution ?? "complete",
          ...(input.signal === undefined ? {} : { signal: input.signal }),
          backend: input.backend,
          scanLogs: (filter) =>
            scanFilterRange(
              input.backend,
              filter,
              input.batchSize,
              input.signal,
            ),
        });
        materializedPools.push(...result.pools);
        retryablePools.push(...(result.retryablePools ?? []));
        complete &&= result.complete;
        issues.push(...(result.issues ?? []));
        assertStrictMaterializationDeferred(
          input.strict,
          descriptor.sourceId,
          result,
        );
      } catch (error) {
        if (input.strict || input.signal?.aborted) throw error;
        complete = false;
        issues.push(errorMessage(error));
      }
    } else {
      const eventScan = await scanGenericActivityRange(
        input.backend,
        descriptor.event,
        input.fromBlock,
        input.toBlock,
        input.batchSize,
        activity,
        input.signal,
      );
      logCountsByEventId.set(descriptor.event.id, eventScan.logCount);
      assertStrictSourceComplete(
        input.strict,
        descriptor.sourceId,
        eventScan.complete,
        eventScan.issues,
      );
      complete &&= eventScan.complete;
      issues.push(...eventScan.issues);
    }
    for (const familyId of descriptor.event.executionFamilies) {
      coverage.push(Object.freeze({
        familyId: familyId as ExecutionFamilyId,
        sourceId: descriptor.sourceId,
        sourceFingerprint: descriptor.sourceFingerprint,
        eventId: descriptor.event.id,
        consumed: true,
        complete,
        issues: Object.freeze([...issues]),
      }));
    }
  }

  return {
    activity,
    materializedPools: Object.freeze(materializedPools),
    retryablePools: Object.freeze(retryablePools),
    coverage: Object.freeze(coverage),
    logCountsByEventId,
  };
}

/**
 * Production universe builds consume every registered Swap topic over the
 * same historical interval. Querying that interval once per event makes the
 * RPC repeat the same block traversal for every family. The union path scans
 * all declared topic0 values together, then dispatches each log back through
 * the owning registry descriptor. Materializers still receive the same
 * per-event, ordered log sequence and any follow-up scans remain family-owned.
 *
 * A failed union slice is conservatively incomplete for every descriptor:
 * strict callers fail closed instead of publishing negative completeness for
 * an event whose portion of that slice is unknowable.
 */
async function discoverLandedPoolsByTopicUnion(input: {
  readonly registry: LandedPoolDiscoveryRegistry;
  readonly backend: LandedPoolDiscoveryReadBackend;
  readonly fromBlock: number;
  readonly toBlock: number;
  readonly batchSize: number;
  readonly minSwaps: number;
  readonly admissionPolicy: IdentityAdmissionPolicy;
  readonly retainedPools?: readonly PoolEntry[];
  readonly retryablePools?: readonly PoolEntry[];
  readonly isKnownPool?: (pool: PoolEntry) => boolean;
  readonly historicalResolution?: "bounded" | "complete";
  readonly strict?: boolean;
  readonly signal?: AbortSignal;
}): Promise<LandedPoolDiscoveryResult> {
  const descriptors = input.registry.list();
  const descriptorsByTopic = new Map<string, LandedPoolDiscoveryDescriptor[]>();
  const materializerLogs = new Map<string, LandedPoolDiscoveryLog[]>();
  const genericActivityByEventId = new Map<
    string,
    Map<string, LandedPoolActivity>
  >();
  const logCountsByEventId = new Map<string, number>();
  for (const descriptor of descriptors) {
    const topic = descriptor.event.topic.toLowerCase();
    const owners = descriptorsByTopic.get(topic) ?? [];
    owners.push(descriptor);
    descriptorsByTopic.set(topic, owners);
    logCountsByEventId.set(descriptor.event.id, 0);
    if (descriptor.materializer) {
      materializerLogs.set(descriptor.event.id, []);
    } else {
      genericActivityByEventId.set(descriptor.event.id, new Map());
    }
  }

  const unionIssues: string[] = [];
  let unionComplete = true;
  const topics = [...descriptorsByTopic.keys()].sort();
  const ranges: Array<{ fromBlock: number; toBlock: number }> = [];
  for (
    let start = input.fromBlock;
    start <= input.toBlock;
    start += input.batchSize
  ) {
    ranges.push({
      fromBlock: start,
      toBlock: Math.min(start + input.batchSize - 1, input.toBlock),
    });
  }
  // Local reth traverses the same receipts/index range for every slice. Four
  // independent range reads keep that work parallel without retaining the
  // whole historical result in memory. Results are still folded in block
  // order, preserving the previous deterministic insertion/tie behavior.
  for (let groupStart = 0; groupStart < ranges.length; groupStart += 4) {
    const slices = await Promise.all(
      ranges.slice(groupStart, groupStart + 4).map((range) =>
        scanFilterSlice(
          input.backend,
          {
            topics: [topics],
            fromBlock: range.fromBlock,
            toBlock: range.toBlock,
          },
          input.signal,
        )
      ),
    );
    for (const slice of slices) {
      unionComplete &&= slice.complete;
      unionIssues.push(...slice.issues);
      for (const log of slice.logs) {
        const topic = log.topics[0]?.toLowerCase();
        if (!topic) continue;
        for (const descriptor of descriptorsByTopic.get(topic) ?? []) {
          if (!landedEmitterMatches(descriptor.event, log)) continue;
          logCountsByEventId.set(
            descriptor.event.id,
            (logCountsByEventId.get(descriptor.event.id) ?? 0) + 1,
          );
          if (descriptor.materializer) {
            materializerLogs.get(descriptor.event.id)?.push(log);
          } else if (!recordGenericActivity(
            genericActivityByEventId.get(descriptor.event.id)!,
            descriptor.event,
            log,
          )) {
            unionComplete = false;
            unionIssues.push(
              `${descriptor.event.id}: landed event could not be materialized as an address`,
            );
          }
        }
      }
    }
  }
  assertStrictSourceComplete(
    input.strict,
    "landed-event-union",
    unionComplete,
    unionIssues,
  );

  // Rebuild the public activity map in registry descriptor order. The legacy
  // path scans one complete event before the next; preserving that insertion
  // order keeps stable tie behavior byte-for-byte equivalent when count and
  // lastSwapBlock are equal.
  const activity = new Map<string, LandedPoolActivity>();
  for (const descriptor of descriptors) {
    for (
      const item of
        genericActivityByEventId.get(descriptor.event.id)?.values() ?? []
    ) {
      mergeLandedActivity(activity, item);
    }
  }

  const materializationResults = new Map<string, {
    readonly pools: readonly PoolEntry[];
    readonly retryablePools: readonly PoolEntry[];
    readonly complete: boolean;
    readonly issues: readonly string[];
  }>();
  await Promise.all(
    descriptors
      .filter((descriptor) => descriptor.materializer !== null)
      .map(async (descriptor) => {
        let complete = unionComplete;
        const issues = [...unionIssues];
        const pools: PoolEntry[] = [];
        try {
          const result = await descriptor.materializer!.materialize({
            familyId: descriptor.materializerFamilyId ??
              descriptor.event.executionFamilies[0] as ExecutionFamilyId,
            event: descriptor.event,
            logs: materializerLogs.get(descriptor.event.id) ?? [],
            retainedPools: input.retainedPools ?? [],
            retryablePools: input.retryablePools ?? [],
            isKnownPool: input.isKnownPool ?? (() => false),
            fromBlock: input.fromBlock,
            toBlock: input.toBlock,
            minSwaps: input.minSwaps,
            admissionPolicy: input.admissionPolicy,
            historicalResolution: input.historicalResolution ?? "complete",
            ...(input.signal === undefined ? {} : { signal: input.signal }),
            backend: input.backend,
            scanLogs: (filter) =>
              scanFilterRange(
                input.backend,
                filter,
                input.batchSize,
                input.signal,
              ),
          });
          pools.push(...result.pools);
          assertStrictMaterializationDeferred(
            input.strict,
            descriptor.sourceId,
            result,
          );
          complete &&= result.complete;
          issues.push(...(result.issues ?? []));
          materializationResults.set(descriptor.event.id, {
            pools: Object.freeze(pools),
            retryablePools: Object.freeze([
              ...(result.retryablePools ?? []),
            ]),
            complete,
            issues: Object.freeze(issues),
          });
        } catch (error) {
          if (input.strict || input.signal?.aborted) throw error;
          complete = false;
          issues.push(errorMessage(error));
          materializationResults.set(descriptor.event.id, {
            pools: Object.freeze(pools),
            retryablePools: Object.freeze([]),
            complete,
            issues: Object.freeze(issues),
          });
        }
      }),
  );

  const materializedPools: PoolEntry[] = [];
  const retryablePools: PoolEntry[] = [];
  const coverage: LandedPoolDiscoveryCoverage[] = [];
  for (const descriptor of descriptors) {
    let complete = unionComplete;
    let issues: readonly string[] = unionIssues;
    if (descriptor.materializer) {
      const result = materializationResults.get(descriptor.event.id);
      if (!result) {
        throw new Error(
          `missing landed materialization result for ${descriptor.event.id}`,
        );
      }
      materializedPools.push(...result.pools);
      retryablePools.push(...result.retryablePools);
      complete = result.complete;
      issues = result.issues;
    }
    for (const familyId of descriptor.event.executionFamilies) {
      coverage.push(Object.freeze({
        familyId: familyId as ExecutionFamilyId,
        sourceId: descriptor.sourceId,
        sourceFingerprint: descriptor.sourceFingerprint,
        eventId: descriptor.event.id,
        consumed: true,
        complete,
        issues: Object.freeze([...issues]),
      }));
    }
  }

  return {
    activity,
    materializedPools: Object.freeze(materializedPools),
    retryablePools: Object.freeze(retryablePools),
    coverage: Object.freeze(coverage),
    logCountsByEventId,
  };
}

function landedEmitterMatches(
  event: LandedSwapEventDescriptor,
  log: LandedPoolDiscoveryLog,
): boolean {
  if (event.emitter.mode === "address") return true;
  return log.address.toLowerCase() === event.emitter.address.toLowerCase();
}

function mergeLandedActivity(
  target: Map<string, LandedPoolActivity>,
  source: LandedPoolActivity,
): void {
  const key = source.address.toLowerCase();
  const existing = target.get(key);
  if (!existing) {
    target.set(key, {
      address: source.address,
      adapterCounts: new Map(source.adapterCounts),
      count: source.count,
      lastSwapBlock: source.lastSwapBlock,
    });
    return;
  }
  existing.count += source.count;
  existing.lastSwapBlock = Math.max(
    existing.lastSwapBlock,
    source.lastSwapBlock,
  );
  for (const [adapter, count] of source.adapterCounts) {
    existing.adapterCounts.set(
      adapter,
      (existing.adapterCounts.get(adapter) ?? 0) + count,
    );
  }
}

/**
 * Address-emitter families do not need cross-log correlation. Fold each
 * response slice directly into the activity map instead of retaining an
 * entire 30-day Swap corpus in one V8 array. Family materializers keep the
 * buffered path above because their singleton identities may require
 * cross-log deduplication.
 */
async function scanGenericActivityRange(
  backend: LandedPoolDiscoveryReadBackend,
  event: LandedSwapEventDescriptor,
  fromBlock: number,
  toBlock: number,
  batchSize: number,
  activity: Map<string, LandedPoolActivity>,
  signal?: AbortSignal,
): Promise<{
  readonly logCount: number;
  readonly complete: boolean;
  readonly issues: readonly string[];
}> {
  const filter: LandedPoolDiscoveryLogFilter = {
    topics: [event.topic],
    fromBlock,
    toBlock,
  };
  assertRange(filter.fromBlock, filter.toBlock);
  let logCount = 0;
  let complete = true;
  const issues: string[] = [];
  for (let start = fromBlock; start <= toBlock; start += batchSize) {
    const end = Math.min(start + batchSize - 1, toBlock);
    const slice = await scanFilterSlice(
      backend,
      { ...filter, fromBlock: start, toBlock: end },
      signal,
    );
    logCount += slice.logs.length;
    complete &&= slice.complete;
    issues.push(...slice.issues);
    for (const log of slice.logs) {
      if (!recordGenericActivity(activity, event, log)) {
        complete = false;
        issues.push("landed event could not be materialized as an address");
      }
    }
  }
  return {
    logCount,
    complete,
    issues: Object.freeze(issues),
  };
}

async function scanDescriptorRange(
  backend: LandedPoolDiscoveryReadBackend,
  event: LandedSwapEventDescriptor,
  fromBlock: number,
  toBlock: number,
  batchSize: number,
  signal?: AbortSignal,
): Promise<LandedPoolDiscoveryScanResult> {
  const address = event.emitter.mode === "address"
    ? undefined
    : event.emitter.address;
  return scanFilterRange(
    backend,
    {
      ...(address === undefined ? {} : { address }),
      topics: [event.topic],
      fromBlock,
      toBlock,
    },
    batchSize,
    signal,
  );
}

async function scanFilterRange(
  backend: LandedPoolDiscoveryReadBackend,
  filter: LandedPoolDiscoveryLogFilter,
  batchSize: number,
  signal?: AbortSignal,
): Promise<LandedPoolDiscoveryScanResult> {
  assertRange(filter.fromBlock, filter.toBlock);
  const logs: LandedPoolDiscoveryLog[] = [];
  const issues: string[] = [];
  let complete = true;
  for (
    let start = filter.fromBlock;
    start <= filter.toBlock;
    start += batchSize
  ) {
    const end = Math.min(start + batchSize - 1, filter.toBlock);
    const slice = await scanFilterSlice(
      backend,
      { ...filter, fromBlock: start, toBlock: end },
      signal,
    );
    // A production-wide event slice can contain more entries than V8 accepts
    // as function-call arguments. Append iteratively so discovery remains
    // byte-for-byte equivalent without turning the log count into a hidden
    // batch-size limit.
    for (const log of slice.logs) {
      logs.push(log);
    }
    complete &&= slice.complete;
    issues.push(...slice.issues);
  }
  return {
    logs: Object.freeze(logs),
    complete,
    issues: Object.freeze(issues),
  };
}

async function scanFilterSlice(
  backend: LandedPoolDiscoveryReadBackend,
  filter: LandedPoolDiscoveryLogFilter,
  signal?: AbortSignal,
): Promise<LandedPoolDiscoveryScanResult> {
  throwIfAborted(signal);
  try {
    const logs = await backend.getLogs(
      filter,
      signal === undefined ? undefined : { signal },
    );
    return { logs, complete: true, issues: [] };
  } catch (error) {
    if (signal?.aborted || isDiscoveryCancellationError(error)) {
      throw signal?.reason ?? error;
    }
    if (filter.fromBlock < filter.toBlock) {
      const middle = Math.floor((filter.fromBlock + filter.toBlock) / 2);
      const [left, right] = await Promise.all([
        scanFilterSlice(
          backend,
          { ...filter, toBlock: middle },
          signal,
        ),
        scanFilterSlice(
          backend,
          { ...filter, fromBlock: middle + 1 },
          signal,
        ),
      ]);
      return {
        logs: Object.freeze([...left.logs, ...right.logs]),
        complete: left.complete && right.complete,
        issues: Object.freeze([...left.issues, ...right.issues]),
      };
    }
    return {
      logs: [],
      complete: false,
      issues: Object.freeze([
        `log block ${filter.fromBlock}: ${errorMessage(error)}`,
      ]),
    };
  }
}

function recordGenericActivity(
  activity: Map<string, LandedPoolActivity>,
  event: LandedSwapEventDescriptor,
  log: LandedPoolDiscoveryLog,
): boolean {
  const identity = observedLandedPoolIdentity(event, {
    address: log.address,
    topics: log.topics,
  });
  if (!identity || event.emitter.mode === "singleton-indexed-bytes32") {
    return false;
  }
  let address: string;
  try {
    address = ethers.getAddress(identity);
  } catch {
    return false;
  }
  const key = address.toLowerCase();
  const item = activity.get(key) ?? {
    address,
    adapterCounts: new Map<PoolEntry["adapter"], number>(),
    count: 0,
    lastSwapBlock: 0,
  };
  item.count++;
  item.lastSwapBlock = Math.max(
    item.lastSwapBlock,
    parseBlockNumber(log.blockNumber),
  );
  item.adapterCounts.set(
    event.discovery.poolAdapter,
    (item.adapterCounts.get(event.discovery.poolAdapter) ?? 0) + 1,
  );
  activity.set(key, item);
  return true;
}

function discoverySourceFingerprint(
  event: LandedSwapEventDescriptor,
  materializer: LandedPoolMaterializationCapability | null,
): string {
  return ethers.keccak256(ethers.toUtf8Bytes(JSON.stringify({
    eventId: event.id,
    topic: event.topic.toLowerCase(),
    emitter: event.emitter.mode === "address"
      ? { mode: event.emitter.mode }
      : {
          mode: event.emitter.mode,
          address: event.emitter.address.toLowerCase(),
          topicIndex: event.emitter.topicIndex,
        },
    poolAdapter: event.discovery.poolAdapter,
    materialization: event.materialization ?? "generic",
    materializerVersion: materializer?.version ?? null,
  })));
}

function assertRange(fromBlock: number, toBlock: number): void {
  if (
    !Number.isSafeInteger(fromBlock) ||
    fromBlock < 0 ||
    !Number.isSafeInteger(toBlock) ||
    toBlock < fromBlock
  ) {
    throw new Error(`invalid landed-pool discovery range ${fromBlock}-${toBlock}`);
  }
}

function parseBlockNumber(value: string | number): number {
  const parsed = typeof value === "number"
    ? value
    : value.startsWith("0x")
    ? parseInt(value, 16)
    : Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function retryablePoolEntry(
  candidate: {
    readonly address: string;
    readonly count: number;
    readonly lastSwapBlock: number;
  },
  event: LandedSwapEventDescriptor,
): PoolEntry {
  return Object.freeze({
    address: candidate.address,
    adapter: event.discovery.poolAdapter,
    score: candidate.count,
    swapCount30d: candidate.count,
    lastSwapBlock: candidate.lastSwapBlock,
    source: `landed-event-retry:${event.id}`,
  });
}

function materializerConsumesRetry(
  pool: PoolEntry,
  eventId: string,
  materializerEventIds: readonly string[],
): boolean {
  const prefix = "landed-event-retry:";
  const source = (pool as PoolEntry & { readonly source?: string }).source;
  if (source?.startsWith(prefix)) {
    return source.slice(prefix.length) === eventId;
  }
  return materializerEventIds[0] === eventId;
}

function assertStrictSourceComplete(
  strict: boolean | undefined,
  sourceId: string,
  complete: boolean,
  issues: readonly string[],
): void {
  if (!strict || complete) return;
  throw new Error(
    `landed-pool source incomplete: ${sourceId}` +
      (issues.length === 0 ? "" : `(${issues.join("; ")})`),
  );
}

function assertStrictMaterializationDeferred(
  strict: boolean | undefined,
  sourceId: string,
  result: LandedPoolMaterializationResult,
): void {
  if (result.complete && (result.retryablePools?.length ?? 0) > 0) {
    throw new Error(
      `landed-pool materialization claimed complete with retries: ${sourceId}`,
    );
  }
  if (!strict || result.complete) return;
  if ((result.retryablePools?.length ?? 0) > 0) return;
  throw new Error(
    `landed-pool materialization incomplete without retry proof: ${sourceId}` +
      ((result.issues?.length ?? 0) === 0
        ? ""
        : `(${result.issues!.join("; ")})`),
  );
}

function isDiscoveryCancellationError(error: unknown): boolean {
  if (!error || typeof error !== "object" || !("code" in error)) return false;
  const code = String((error as { readonly code?: unknown }).code);
  return code === "ABORTED" || code === "DEADLINE_EXCEEDED";
}

function raceAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", abort);
      fn();
    };
    const abort = () =>
      finish(() =>
        reject(
          signal.reason instanceof Error
            ? signal.reason
            : new Error("landed-pool materialization aborted"),
        )
      );
    signal.addEventListener("abort", abort, { once: true });
    promise.then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error)),
    );
    if (signal.aborted) abort();
  });
}

function mergeAbortSignals(
  ...signals: Array<AbortSignal | undefined>
): AbortSignal {
  const present = signals.filter(
    (signal): signal is AbortSignal => signal !== undefined,
  );
  if (present.length === 0) return new AbortController().signal;
  return present.length === 1 ? present[0] : AbortSignal.any(present);
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new Error("landed-pool discovery aborted", { cause: signal.reason });
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
