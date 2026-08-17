import { ethers } from "ethers";
import {
  createProtocolDiscoveryEvidenceCache,
  protocolAddressCacheKey,
  type ProtocolAddressCacheEntry,
  type ProtocolDiscoveryEvidenceCache,
} from "./protocol-discovery-cache.js";
import { strictObservedEventDedupeKey } from
  "./live-discovery-event-observations.js";
import {
  ProtocolDiscoveryFamilyCircuitOpen,
  ProtocolDiscoveryFamilyGuard,
  type ProtocolDiscoveryFamilyGuardOptions,
  withProtocolDiscoveryFamilyContext,
} from "./protocol-discovery-family-guard.js";
import type {
  ExecutionFamilyId,
  ProtocolCandidate,
  RouteLegAdapter,
  ProtocolDiscoveryContext,
  ProtocolDiscoveryLog,
  ProtocolDiscoveryReadControl,
  ProtocolDiscoveryReceipt,
  RouteCandidateSourceKind,
} from "./venues/route-leg-adapter.js";

const TRANSFER_TOPIC = ethers.id("Transfer(address,address,uint256)").toLowerCase();
const LP_TOPICS = new Set([
  ethers.id("Mint(address,uint256,uint256)").toLowerCase(),
  ethers.id("Burn(address,uint256,uint256,address)").toLowerCase(),
  ethers.id("Mint(address,address,int24,int24,uint128,uint256,uint256)").toLowerCase(),
  ethers.id("Burn(address,int24,int24,uint128,uint256,uint256)").toLowerCase(),
  ethers.id("ModifyLiquidity(bytes32,address,int24,int24,int256,bytes32)").toLowerCase(),
]);
const ZERO_TOPIC = `0x${"0".repeat(64)}`;
const LOG_BATCH = 2_000;
const TRACE_CONCURRENCY = 8;
const ADDRESS_CONCURRENCY = 24;
const FAMILY_CALLBACK_CONCURRENCY = 8;
const IMPLEMENTATION_SLOT = BigInt(
  "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc",
);
const ZERO_WORD = `0x${"0".repeat(64)}`;

export interface UnknownProtocolSelectorDiagnostic {
  readonly target: string;
  readonly selector: string;
  readonly reason:
    | "protocol_like_flow_unknown_selector"
    | "protocol_like_flow_unverified_match"
    | "protocol_like_flow_ambiguous_adapter";
  readonly recommendation: "inspect_calltrace";
  readonly matchingAdapterIds?: readonly string[];
}

export interface ObservedProtocolDiscoveryResult {
  readonly candidatesByAdapter: ReadonlyMap<string, readonly ProtocolCandidate[]>;
  readonly unknownSelectors: readonly UnknownProtocolSelectorDiagnostic[];
  readonly sourceErrors: readonly ProtocolDiscoverySourceError[];
}

export interface ProtocolDiscoverySourceError {
  readonly adapterId: string | null;
  /** Candidate source whose coverage was interrupted. */
  readonly sourceKind: RouteCandidateSourceKind;
  /** Exact registered families that depend on this failed source operation. */
  readonly impactedFamilyIds: readonly ExecutionFamilyId[];
  readonly target: string | null;
  readonly reason: string;
  /** Only retryable source failures prevent cursor/candidate-set advancement. */
  readonly retryable: boolean;
}

export interface ProtocolAddressDiscoveryStats {
  readonly addresses: number;
  readonly codeReads: number;
  readonly cacheHits: number;
  readonly probes: number;
  /** Addresses that produced at least one family candidate. */
  readonly matches: number;
  readonly negatives: number;
  /** Addresses shortlisted by more than one distinct family before probing. */
  readonly overlapAddresses: number;
}

export interface ProtocolDiscoveryRangeResult extends ObservedProtocolDiscoveryResult {
  /** False prevents the caller from advancing its discovery cursor. */
  readonly sourceComplete: boolean;
  /** Address retries never pin the independent event block cursor. */
  readonly eventSourceComplete: boolean;
  readonly addressSourceComplete: boolean;
  readonly sourceErrors: readonly ProtocolDiscoverySourceError[];
  readonly addressStats: ProtocolAddressDiscoveryStats;
}

export interface ProtocolTraceMemoStats {
  hits: number;
  misses: number;
}

/**
 * Stable fingerprint for the complete dynamic-discovery registry behind the
 * shared cursor and persisted ownership. Adding/removing any family, or
 * changing either matcher, must invalidate evidence admitted under the old
 * semantics.
 */
export function protocolObservedSourceFingerprint(
  adapters: readonly RouteLegAdapter[],
): string {
  const observed = adapters
    .filter((adapter) =>
      adapter.discovery?.candidateSources.includes("observed-interaction")
    )
    .map((adapter) => ({
      adapterId: adapter.id,
      observedMatcherVersion:
        adapter.discovery!.observedMatcherVersion ?? "",
      eventTopics: [...adapter.discovery!.eventTopics]
        .map((item) => item.toLowerCase())
        .sort(),
      callSelectors: [...adapter.discovery!.callSelectors]
        .map((item) => item.toLowerCase())
        .sort(),
    }))
    .sort((a, b) => a.adapterId.localeCompare(b.adapterId));
  return ethers.keccak256(ethers.toUtf8Bytes(JSON.stringify(observed)));
}

/** Per-family fingerprints let a registry rollout invalidate only its owner. */
export function protocolDiscoverySourceFingerprints(
  adapters: readonly RouteLegAdapter[],
): ReadonlyMap<string, string> {
  const sources = adapters
    .filter((adapter) => adapter.discovery)
    .map((adapter) => ({
      adapterId: adapter.id,
      candidateSources: [...adapter.discovery!.candidateSources].sort(),
      candidateAddressHints: [...(adapter.discovery!.candidateAddressHints ?? [])]
        .map((item) => ethers.getAddress(item).toLowerCase())
        .sort(),
      addressMatcherVersion: adapter.discovery!.addressMatcherVersion ?? "",
      addressMatcherCachePolicy: adapter.discovery!.addressMatcherCachePolicy
        ? {
            kind: adapter.discovery!.addressMatcherCachePolicy.kind,
            invariant: adapter.discovery!.addressMatcherCachePolicy.invariant,
            version: adapter.discovery!.addressMatcherCachePolicy.version,
          }
        : null,
      observedMatcherVersion: adapter.discovery!.observedMatcherVersion ?? "",
      eventTopics: [...adapter.discovery!.eventTopics].map((item) => item.toLowerCase()).sort(),
      callSelectors: [...adapter.discovery!.callSelectors].map((item) => item.toLowerCase()).sort(),
    }))
    .sort((a, b) => a.adapterId.localeCompare(b.adapterId));
  return new Map(sources.map((source) => [
    source.adapterId,
    ethers.keccak256(ethers.toUtf8Bytes(JSON.stringify(source))),
  ]));
}

/**
 * Cross-entrance trace memo: the live observed lane and the range scanner
 * share it so one transaction is debug_traced at most once globally. Failed
 * fetches are never memoized, so transient trace errors stay retryable.
 */
export interface ProtocolTraceMemo {
  trace(txHash: string, blockNumber: number, fetch: () => Promise<unknown>): Promise<unknown>;
  readonly stats: ProtocolTraceMemoStats;
  prune(currentBlock: number): void;
}

export function createProtocolTraceMemo(
  maxAgeBlocks = 100,
  maxEntries = 2_048,
): ProtocolTraceMemo {
  const entries = new Map<string, { blockNumber: number; trace: Promise<unknown> }>();
  const stats: ProtocolTraceMemoStats = { hits: 0, misses: 0 };
  const prune = (currentBlock: number): void => {
    for (const [key, entry] of entries) {
      if (currentBlock - entry.blockNumber >= maxAgeBlocks) entries.delete(key);
    }
    while (entries.size > maxEntries) {
      let oldestKey: string | null = null;
      let oldestBlock = Infinity;
      for (const [key, entry] of entries) {
        if (entry.blockNumber < oldestBlock) {
          oldestBlock = entry.blockNumber;
          oldestKey = key;
        }
      }
      if (oldestKey === null) break;
      entries.delete(oldestKey);
    }
  };
  return {
    stats,
    prune,
    trace(txHash, blockNumber, fetch) {
      const key = txHash.toLowerCase();
      const cached = entries.get(key);
      if (cached) {
        stats.hits++;
        return cached.trace;
      }
      stats.misses++;
      const pending = fetch();
      entries.set(key, { blockNumber, trace: pending });
      pending.catch(() => entries.delete(key));
      prune(blockNumber);
      return pending;
    },
  };
}

/**
 * Receipt-only, cheap gate for deciding whether a call trace can teach us a
 * protocol route. F8: the legacy adapter list is empty (the strict catalog
 * owns discovery), so callers pass the strict catalog's log-pattern topics
 * as the enumerable surface; the LP mint/burn heuristic stays unchanged.
 */
export function shouldTraceForProtocolDiscovery(
  logs: readonly ProtocolDiscoveryLog[],
  adapters: readonly RouteLegAdapter[],
  strictCatalogTopics?: ReadonlySet<string>,
): boolean {
  const declaredTopics = registeredEventTopics(adapters);
  if (
    logs.some((log) =>
      declaredTopics.has(log.topics[0]?.toLowerCase() ?? "") ||
      strictCatalogTopics?.has(log.topics[0]?.toLowerCase() ?? "")
    )
  ) return true;
  const lpEmitters = new Set(
    logs
      .filter((log) => LP_TOPICS.has(log.topics[0]?.toLowerCase() ?? ""))
      .map((log) => log.address.toLowerCase()),
  );
  const minted = new Set<string>();
  const burned = new Set<string>();
  for (const log of logs) {
    if (log.topics[0]?.toLowerCase() !== TRANSFER_TOPIC || log.topics.length < 3) continue;
    if (log.topics[1]?.toLowerCase() === ZERO_TOPIC) minted.add(log.address.toLowerCase());
    if (log.topics[2]?.toLowerCase() === ZERO_TOPIC) burned.add(log.address.toLowerCase());
  }
  if (minted.size === 0 || burned.size === 0) return false;
  if (lpEmitters.size === 0) return true;
  // Suppress a pure LP mint/burn, but do not hide a separate protocol burn+mint
  // merely because the same transaction also touched an LP.
  return [...minted].some((address) => !lpEmitters.has(address)) &&
    [...burned].some((address) => !lpEmitters.has(address));
}

/**
 * Shared active scanner. It owns both candidate-source loops: DEX-universe
 * addresses and event-window -> receipt -> trace. Family adapters only parse.
 */
export async function scanProtocolDiscoveryRange(input: {
  adapters: readonly RouteLegAdapter[];
  context: ProtocolDiscoveryContext;
  candidateAddresses?: readonly string[];
  evidenceCache?: ProtocolDiscoveryEvidenceCache;
  traceMemo?: ProtocolTraceMemo;
  familyGuardOptions?: ProtocolDiscoveryFamilyGuardOptions;
  /** Parent pass lifetime shared by scanner reads and family callbacks. */
  control?: ProtocolDiscoveryReadControl;
  /**
   * F8: additional enumerable event topics from the strict catalog (all
   * families' log patterns). Logs matching these enter the strict
   * observedEvents surface directly (feeding strict-family lifecycles with
   * real amounts); they never trigger receipt/trace work, which stays scoped
   * to the legacy adapters' observed-interaction surface.
   */
  readonly extraEventTopics?: ReadonlySet<string>;
  /**
   * F8: one-shot historical event-window lookback for the strict
   * observedEvents feed. When set, the first pass extends the event log
   * window back to (toBlock - lookback + 1) so pools whose swap logs
   * predate the incremental cursor still get observed (the ret13 universe
   * was built over a 2d window; without this their logs are never read and
   * the pools can never become instances). Subsequent passes use the
   * normal incremental window; the feed dedups by tx, so the historical
   * sweep is idempotent.
   */
  readonly eventWindowLookbackBlocks?: number;
}): Promise<ProtocolDiscoveryRangeResult> {
  const passControl = mergeProtocolDiscoveryReadControls(
    protocolDiscoveryReadControlFromFamilyOptions(input.familyGuardOptions),
    input.control,
  );
  throwIfProtocolDiscoveryParentStopped(passControl);
  const candidatesByAdapter = new Map<string, ProtocolCandidate[]>();
  const unknownSelectors: UnknownProtocolSelectorDiagnostic[] = [];
  const eventSourceErrors: ProtocolDiscoverySourceError[] = [];
  const addressFamilyIds = familyIdsForSource(input.adapters, "dex-token-domain");
  const observedFamilyIds = familyIdsForSource(input.adapters, "observed-interaction");
  const addressScanPromise = scanAddressCandidates({
    adapters: input.adapters,
    context: input.context,
    candidateAddresses: input.candidateAddresses ?? [],
    evidenceCache: input.evidenceCache ?? createProtocolDiscoveryEvidenceCache(),
    familyGuardOptions: mergeProtocolDiscoveryFamilyGuardOptions(
      input.familyGuardOptions,
      passControl,
    ),
    control: passControl,
  }).catch((error) => {
    return {
      candidatesByAdapter: new Map<string, readonly ProtocolCandidate[]>(),
      issues: [{
        adapterId: null,
        sourceKind: "dex-token-domain",
        impactedFamilyIds: addressFamilyIds,
        target: null,
        reason: `address scanner failed: ${safeError(error)}`,
        retryable: true,
      }] satisfies ProtocolDiscoverySourceError[],
      stats: {
        addresses: 0,
        codeReads: 0,
        cacheHits: 0,
        probes: 0,
        matches: 0,
        negatives: 0,
        overlapAddresses: 0,
      },
    };
  });

  const topics = [...new Set([
    ...registeredEventTopics(input.adapters),
    ...(input.extraEventTopics ?? []),
  ])].sort();
  const traceTopics = new Set(registeredEventTopics(input.adapters));
  const eventLogs: ProtocolDiscoveryLog[] = [];
  const observedFamilyGuard = new ProtocolDiscoveryFamilyGuard(
    sourceAwareFamilyGuardOptions(input.familyGuardOptions, passControl),
  );
  const eventWindowFrom = input.eventWindowLookbackBlocks === undefined
    ? input.context.fromBlock
    : Math.max(
        input.context.fromBlock,
        input.context.toBlock - input.eventWindowLookbackBlocks + 1,
      );
  if (topics.length > 0) {
    for (let start = eventWindowFrom; start <= input.context.toBlock; start += LOG_BATCH) {
      throwIfProtocolDiscoveryParentStopped(passControl);
      const end = Math.min(input.context.toBlock, start + LOG_BATCH - 1);
      try {
        eventLogs.push(...await input.context.backend.getLogs({
          topics: [topics.length === 1 ? topics[0] : topics],
          fromBlock: start,
          toBlock: end,
        }, passControl));
      } catch (error) {
        throwIfProtocolDiscoveryParentStopped(passControl);
        eventSourceErrors.push({
          adapterId: null,
          sourceKind: "observed-interaction",
          impactedFamilyIds: observedFamilyIds,
          target: null,
          reason: `event_window_${start}_${end}: ${safeError(error)}`,
          retryable: true,
        });
      }
    }
  }

  // F8: the blockscan observed lane is the strict pipeline event
  // observation surface (the mempool trace gate cannot fire for public
  // mempool hints, which carry no logs). Surface the matched protocol logs
  // into the evidence cache so the strict publication chain derives event
  // observations with real amounts. Dedup against the existing buffer so
  // repeated scans of one range never duplicate events.
  const observedEventBuffer = input.evidenceCache?.runtime.observedEvents;
  if (observedEventBuffer !== undefined && eventLogs.length > 0) {
    const seenKeys = new Set(observedEventBuffer.map((event) =>
      strictObservedEventDedupeKey(event)
    ));
    for (const log of eventLogs) {
      if (log.transactionHash === undefined ||
          log.blockNumber === undefined) {
        continue;
      }
      const key = strictObservedEventDedupeKey(Object.freeze({
        kind: "log" as const,
        address: log.address.toLowerCase(),
        topics: Object.freeze([...log.topics]),
        data: log.data,
        transactionHash: log.transactionHash.toLowerCase(),
        blockNumber: log.blockNumber,
        ...(log.logIndex === undefined
          ? {}
          : { logIndex: log.logIndex }),
      }));
      if (seenKeys.has(key)) continue;
      seenKeys.add(key);
      observedEventBuffer.push(Object.freeze({
        kind: "log" as const,
        address: log.address.toLowerCase(),
        topics: Object.freeze([...log.topics]),
        data: log.data,
        transactionHash: log.transactionHash.toLowerCase(),
        blockNumber: log.blockNumber,
        ...(log.logIndex === undefined
          ? {}
          : { logIndex: log.logIndex }),
      }));
    }
  }

  const txHashes = new Set<string>();
  const txBlocks = new Map<string, number>();
  for (const log of eventLogs) {
    // F8: extra-catalog logs feed the strict observedEvents surface without
    // receipt/trace work; only the legacy adapters' own topics require the
    // trace path (observed-call matching).
    if (log.topics[0] === undefined || !traceTopics.has(log.topics[0].toLowerCase())) {
      continue;
    }
    if (log.transactionHash) {
      const txHash = log.transactionHash.toLowerCase();
      txHashes.add(txHash);
      if (log.blockNumber !== undefined && !txBlocks.has(txHash)) {
        txBlocks.set(txHash, log.blockNumber);
      }
    } else {
      eventSourceErrors.push({
        adapterId: null,
        sourceKind: "observed-interaction",
        impactedFamilyIds: observedFamilyIds,
        target: log.address,
        reason: "discovery event missing transaction hash",
        retryable: true,
      });
    }
  }
  const traceResults = await mapLimit([...txHashes].sort(), TRACE_CONCURRENCY, async (txHash) => {
    throwIfProtocolDiscoveryParentStopped(passControl);
    try {
      const receipt = await input.context.backend.getTransactionReceipt(
        txHash,
        passControl,
      );
      if (!receipt) throw new Error("receipt unavailable for discovery event");
      const tracePromise = input.traceMemo
        ? input.traceMemo.trace(
          txHash,
          txBlocks.get(txHash) ?? input.context.toBlock,
          () => input.context.backend.traceTransaction(txHash, passControl),
        )
        : input.context.backend.traceTransaction(txHash, passControl);
      const trace = await awaitWithProtocolDiscoveryControl(
        tracePromise,
        passControl,
      );
      const observed = await scanObservedProtocolTrace({
        adapters: input.adapters,
        context: input.context,
        txHash,
        receipt,
        trace,
        familyGuard: observedFamilyGuard,
        control: passControl,
      });
      return { observed, error: null };
    } catch (error) {
      throwIfProtocolDiscoveryParentStopped(passControl);
      return {
        observed: null,
        error: {
          adapterId: null,
          sourceKind: "observed-interaction",
          impactedFamilyIds: observedFamilyIds,
          target: null,
          reason: `${txHash}: ${safeError(error)}`,
          // Receipt/trace evidence is part of this source's completeness
          // contract. A pruned backend cannot recover it, but advancing the
          // cursor would permanently erase the only candidate source for an
          // observed-only family (for example Eigenpie). Keep the range
          // incomplete and require an archive/materialized-history backend.
          retryable: true,
        } satisfies ProtocolDiscoverySourceError,
      };
    }
  });
  const seenUnknown = new Set<string>();
  for (const result of traceResults) {
    if (result.error) {
      eventSourceErrors.push(result.error);
      continue;
    }
    if (!result.observed) continue;
    eventSourceErrors.push(...result.observed.sourceErrors);
    for (const [adapterId, candidates] of result.observed.candidatesByAdapter) {
      for (const candidate of candidates) pushCandidate(candidatesByAdapter, adapterId, candidate);
    }
    for (const diagnostic of result.observed.unknownSelectors) {
      const key = `${diagnostic.target.toLowerCase()}|${diagnostic.selector}`;
      if (seenUnknown.has(key) || unknownSelectors.length >= 32) continue;
      seenUnknown.add(key);
      unknownSelectors.push(diagnostic);
    }
  }

  const addressScan = await addressScanPromise;
  throwIfProtocolDiscoveryParentStopped(passControl);
  for (const [adapterId, candidates] of addressScan.candidatesByAdapter) {
    for (const candidate of candidates) pushCandidate(candidatesByAdapter, adapterId, candidate);
  }
  for (const candidates of candidatesByAdapter.values()) {
    candidates.sort((a, b) => candidateSortKey(a).localeCompare(candidateSortKey(b)));
  }
  const addressSourceComplete = !addressScan.issues.some((issue) => issue.retryable);
  const eventSourceComplete = !eventSourceErrors.some((issue) => issue.retryable);
  const sourceErrors = sourceErrorsPreservingFamilyCoverage([
    ...addressScan.issues,
    ...eventSourceErrors,
  ]);
  return {
    candidatesByAdapter,
    unknownSelectors,
    sourceComplete: addressSourceComplete && eventSourceComplete,
    eventSourceComplete,
    addressSourceComplete,
    sourceErrors,
    addressStats: addressScan.stats,
  };
}

async function scanAddressCandidates(input: {
  adapters: readonly RouteLegAdapter[];
  context: ProtocolDiscoveryContext;
  candidateAddresses: readonly string[];
  evidenceCache: ProtocolDiscoveryEvidenceCache;
  familyGuardOptions?: ProtocolDiscoveryFamilyGuardOptions;
  control?: ProtocolDiscoveryReadControl;
}): Promise<{
  candidatesByAdapter: ReadonlyMap<string, readonly ProtocolCandidate[]>;
  issues: readonly ProtocolDiscoverySourceError[];
  stats: ProtocolAddressDiscoveryStats;
}> {
  const adapters = input.adapters.filter((adapter) =>
    adapter.discovery?.candidateSources.includes("dex-token-domain") &&
    adapter.discovery.candidateFromAddress
  );
  const graphTokens = new Set(
    input.context.graphTokens.flatMap((raw) => {
      try {
        return [ethers.getAddress(raw).toLowerCase()];
      } catch {
        return [];
      }
    }),
  );
  const hintOwners = new Map<string, Set<string>>();
  for (const adapter of adapters) {
    for (const raw of adapter.discovery?.candidateAddressHints ?? []) {
      const address = ethers.getAddress(raw).toLowerCase();
      const owners = hintOwners.get(address) ?? new Set<string>();
      owners.add(adapter.id);
      hintOwners.set(address, owners);
    }
  }
  const addresses = new Map<string, string>();
  if (adapters.length > 0) {
    for (const raw of input.candidateAddresses) {
      try {
        const address = ethers.getAddress(raw);
        addresses.set(address.toLowerCase(), address);
      } catch {
        // Invalid DEX metadata is not a protocol source failure.
      }
    }
  }
  const familyGuard = new ProtocolDiscoveryFamilyGuard(
    sourceAwareFamilyGuardOptions(input.familyGuardOptions, input.control),
  );
  const reportedOpenCircuits = new Set<string>();
  const results = await mapLimit([...addresses.values()].sort(), ADDRESS_CONCURRENCY, async (target) => {
    throwIfProtocolDiscoveryParentStopped(input.control);
    const targetKey = target.toLowerCase();
    const owners = hintOwners.get(targetKey);
    const eligibleAdapters = owners !== undefined && !graphTokens.has(targetKey)
      ? adapters.filter((adapter) => owners.has(adapter.id))
      : adapters;
    if (eligibleAdapters.length === 0) {
      return {
        matches: [] as Array<{ adapterId: string; candidate: ProtocolCandidate }>,
        issues: [] as ProtocolDiscoverySourceError[],
        matcherFailures: [] as Array<{
          readonly adapterId: ExecutionFamilyId;
          readonly target: string;
          readonly error: unknown;
        }>,
        codeReads: 0,
        cacheHits: 0,
        probes: 0,
        negatives: 0,
      };
    }
    const impactedFamilyIds = Object.freeze(
      eligibleAdapters.map((adapter) => adapter.id).sort(),
    );
    let code: string;
    let implementationWord: string;
    try {
      code = await input.context.backend.getCode(target, input.control);
      implementationWord = code === "0x"
        ? ZERO_WORD
        : (
          await input.context.backend.getStorageAt(
            target,
            IMPLEMENTATION_SLOT,
            input.control,
          )
        ).toLowerCase();
    } catch (error) {
      throwIfProtocolDiscoveryParentStopped(input.control);
      return {
        matches: [] as Array<{ adapterId: string; candidate: ProtocolCandidate }>,
        issues: [{
          adapterId: null,
          sourceKind: "dex-token-domain",
          impactedFamilyIds,
          target,
          reason: `address code read failed: ${safeError(error)}`,
          retryable: true,
        }] satisfies ProtocolDiscoverySourceError[],
        matcherFailures: [] as Array<{
          readonly adapterId: ExecutionFamilyId;
          readonly target: string;
          readonly error: unknown;
        }>,
        codeReads: 1,
        cacheHits: 0,
        probes: 0,
        negatives: 0,
      };
    }
    const codeHash = ethers.keccak256(code).toLowerCase();
    const matches: Array<{ adapterId: string; candidate: ProtocolCandidate }> = [];
    const issues: ProtocolDiscoverySourceError[] = [];
    const matcherFailures: Array<{
      readonly adapterId: ExecutionFamilyId;
      readonly target: string;
      readonly error: unknown;
    }> = [];
    let cacheHits = 0;
    let probes = 0;
    let negatives = 0;
    const adapterResults = await mapLimit(
      eligibleAdapters,
      FAMILY_CALLBACK_CONCURRENCY,
      async (adapter) => {
        const adapterIssues: ProtocolDiscoverySourceError[] = [];
        let adapterCacheHits = 0;
        let adapterProbes = 0;
        let adapterNegatives = 0;
        let matcherError: unknown | null = null;
        let matchedCandidate: ProtocolCandidate | null = null;
        let cacheEntry: {
          readonly key: string;
          readonly value: ProtocolAddressCacheEntry;
        } | null = null;
        // candidateAddressHints are owner-scoped provenance, not a global
        // identity allowlist. A hint-only address enters only its declaring
        // family. If independently present in the DEX domain, every matcher
        // may still classify it.
        if (
          owners !== undefined &&
          !graphTokens.has(targetKey) &&
          !owners.has(adapter.id)
        ) {
          return {
            adapter,
            issues: adapterIssues,
            cacheHits: adapterCacheHits,
            probes: adapterProbes,
            negatives: adapterNegatives,
            matcherError,
            matchedCandidate,
            cacheEntry,
          };
        }
        const matcher = adapter.discovery?.candidateFromAddress;
        if (!matcher) {
          return {
            adapter,
            issues: adapterIssues,
            cacheHits: adapterCacheHits,
            probes: adapterProbes,
            negatives: adapterNegatives,
            matcherError,
            matchedCandidate,
            cacheEntry,
          };
        }
        const matcherVersion = adapter.discovery?.addressMatcherVersion?.trim();
        if (!matcherVersion) {
          adapterIssues.push({
            adapterId: adapter.id,
            sourceKind: "dex-token-domain",
            impactedFamilyIds: [adapter.id],
            target,
            reason: "address matcher omitted addressMatcherVersion",
            retryable: false,
          });
          return {
            adapter,
            issues: adapterIssues,
            cacheHits: adapterCacheHits,
            probes: adapterProbes,
            negatives: adapterNegatives,
            matcherError,
            matchedCandidate,
            cacheEntry,
          };
        }
        const cachePolicy = adapter.discovery?.addressMatcherCachePolicy;
        let dependencyFingerprint: string | null = null;
        if (cachePolicy && code !== "0x") {
          try {
            const rawFingerprint = await familyGuard.run(
              adapter.id,
              "address-cache-fingerprint",
              (control) =>
                cachePolicy.currentDependencyFingerprint(
                  { target, codeHash, implementationWord },
                  withProtocolDiscoveryFamilyContext(input.context, control),
                ),
            );
            if (!ethers.isHexString(rawFingerprint, 32)) {
              throw new Error("dependency fingerprint must be 32-byte hex");
            }
            dependencyFingerprint = rawFingerprint.toLowerCase();
          } catch (error) {
            throwIfProtocolDiscoveryParentStopped(input.control);
            // Cache evidence is optional. A failed fingerprint disables reuse;
            // the current-N matcher below still establishes source truth.
            adapterIssues.push({
              adapterId: adapter.id,
              sourceKind: "dex-token-domain",
              impactedFamilyIds: [adapter.id],
              target,
              reason:
                `address cache fingerprint unavailable; current matcher forced: ` +
                safeError(error),
              retryable: false,
            });
          }
        }
        const key = protocolAddressCacheKey(adapter.id, target);
        const cached = input.evidenceCache.addressEntries.get(key);
        const fingerprintMatches =
          cached?.codeHash.toLowerCase() === codeHash &&
          cached.implementationWord.toLowerCase() === implementationWord &&
          cached.matcherVersion === matcherVersion;
        const familyProvedReusable =
          cachePolicy !== undefined &&
          dependencyFingerprint !== null &&
          cached?.dependencyPolicyVersion === cachePolicy.version &&
          cached.dependencyFingerprint === dependencyFingerprint;
        if (cached && fingerprintMatches && familyProvedReusable) {
          adapterCacheHits++;
          if (cached.candidate) matchedCandidate = cached.candidate;
          else adapterNegatives++;
          return {
            adapter,
            issues: adapterIssues,
            cacheHits: adapterCacheHits,
            probes: adapterProbes,
            negatives: adapterNegatives,
            matcherError,
            matchedCandidate,
            cacheEntry,
          };
        }
        let candidate: ProtocolCandidate | null;
        if (code === "0x") {
          candidate = null;
        } else {
          try {
            candidate = await familyGuard.run(
              adapter.id,
              "address-matcher",
              (control) =>
                matcher(
                  { target, codeHash, implementationWord },
                  withProtocolDiscoveryFamilyContext(input.context, control),
                ),
            );
          } catch (error) {
            throwIfProtocolDiscoveryParentStopped(input.control);
            matcherError = error;
            return {
              adapter,
              issues: adapterIssues,
              cacheHits: adapterCacheHits,
              probes: adapterProbes,
              negatives: adapterNegatives,
              matcherError,
              matchedCandidate,
              cacheEntry,
            };
          }
        }
        adapterProbes++;
        if (candidate) {
          let candidateTarget: string;
          try {
            candidateTarget = ethers.getAddress(candidate.pool.address);
          } catch {
            candidateTarget = ethers.ZeroAddress;
          }
          if (candidateTarget.toLowerCase() !== target.toLowerCase()) {
            adapterIssues.push({
              adapterId: adapter.id,
              sourceKind: "dex-token-domain",
              impactedFamilyIds: [adapter.id],
              target,
              reason: "address matcher changed candidate target",
              retryable: false,
            });
            return {
              adapter,
              issues: adapterIssues,
              cacheHits: adapterCacheHits,
              probes: adapterProbes,
              negatives: adapterNegatives,
              matcherError,
              matchedCandidate,
              cacheEntry,
            };
          }
          matchedCandidate = candidate;
        } else {
          adapterNegatives++;
        }
        if (cachePolicy && dependencyFingerprint !== null) {
          cacheEntry = {
            key,
            value: {
              adapterId: adapter.id,
              address: target,
              codeHash,
              implementationWord,
              matcherVersion,
              dependencyPolicyVersion: cachePolicy.version,
              dependencyFingerprint,
              checkedAtBlock: input.context.blockNumber,
              candidate,
            },
          };
        }
        return {
          adapter,
          issues: adapterIssues,
          cacheHits: adapterCacheHits,
          probes: adapterProbes,
          negatives: adapterNegatives,
          matcherError,
          matchedCandidate,
          cacheEntry,
        };
      },
    );
    // Commit in registration order only after each guarded callback settled.
    // A late result from a timed-out matcher has no cache entry to publish.
    for (const result of adapterResults) {
      issues.push(...result.issues);
      cacheHits += result.cacheHits;
      probes += result.probes;
      negatives += result.negatives;
      if (result.matcherError !== null) {
        matcherFailures.push({
          adapterId: result.adapter.id,
          target,
          error: result.matcherError,
        });
        continue;
      }
      if (result.cacheEntry) {
        input.evidenceCache.addressEntries.set(
          result.cacheEntry.key,
          result.cacheEntry.value,
        );
      }
      if (result.matchedCandidate) {
        matches.push({
          adapterId: result.adapter.id,
          candidate: result.matchedCandidate,
        });
      }
    }
    return {
      matches,
      issues,
      matcherFailures,
      codeReads: 1,
      cacheHits,
      probes,
      negatives,
    };
  });

  const candidatesByAdapter = new Map<string, ProtocolCandidate[]>();
  const issues: ProtocolDiscoverySourceError[] = [];
  let codeReads = 0;
  let cacheHits = 0;
  let probes = 0;
  let matches = 0;
  let negatives = 0;
  let overlapAddresses = 0;
  for (const result of results) {
    codeReads += result.codeReads;
    cacheHits += result.cacheHits;
    probes += result.probes;
    negatives += result.negatives;
    issues.push(...result.issues);
    for (const failure of result.matcherFailures) {
      if (
        failure.error instanceof ProtocolDiscoveryFamilyCircuitOpen &&
        reportedOpenCircuits.has(failure.adapterId)
      ) {
        continue;
      }
      reportedOpenCircuits.add(failure.adapterId);
      issues.push({
        adapterId: failure.adapterId,
        sourceKind: "dex-token-domain",
        impactedFamilyIds: [failure.adapterId],
        target: failure.target,
        reason: `address match failed: ${safeError(failure.error)}`,
        retryable: true,
      });
    }
    if (result.matches.length === 1) {
      const match = result.matches[0];
      pushCandidate(candidatesByAdapter, match.adapterId, match.candidate);
      matches++;
    } else if (result.matches.length > 1) {
      const adapterIds = [...new Set(result.matches.map((item) => item.adapterId))];
      // Preserve distinct candidates for the coordinator's post-probe route
      // arbitration, including any previously retained route. Duplicate
      // registrations of one adapter id remain scanner-local invalid input.
      if (adapterIds.length > 1) {
        matches++;
        overlapAddresses++;
        for (const match of result.matches) {
          pushCandidate(candidatesByAdapter, match.adapterId, match.candidate);
        }
      } else {
        issues.push({
          adapterId: adapterIds[0] ?? null,
          sourceKind: "dex-token-domain",
          impactedFamilyIds: adapterIds as ExecutionFamilyId[],
          target: result.matches[0].candidate.pool.address,
          reason: `duplicate address adapter registration: ${adapterIds[0] ?? "unknown"}`,
          retryable: false,
        });
      }
    }
  }
  return {
    candidatesByAdapter,
    issues,
    stats: {
      addresses: addresses.size,
      codeReads,
      cacheHits,
      probes,
      matches,
      negatives,
      overlapAddresses,
    },
  };
}

/**
 * Selector matching only shortlists address+selector pairs. Each adapter must
 * still construct a candidate and the shared coordinator must attest identity
 * and probe routes before any graph mutation.
 */
export async function scanObservedProtocolTrace(input: {
  adapters: readonly RouteLegAdapter[];
  context: ProtocolDiscoveryContext;
  txHash: string;
  receipt: ProtocolDiscoveryReceipt;
  trace: unknown;
  familyGuard?: ProtocolDiscoveryFamilyGuard;
  familyGuardOptions?: ProtocolDiscoveryFamilyGuardOptions;
  control?: ProtocolDiscoveryReadControl;
}): Promise<ObservedProtocolDiscoveryResult> {
  const passControl = mergeProtocolDiscoveryReadControls(
    protocolDiscoveryReadControlFromFamilyOptions(input.familyGuardOptions),
    input.control,
  );
  throwIfProtocolDiscoveryParentStopped(passControl);
  const candidatesByAdapter = new Map<string, ProtocolCandidate[]>();
  const unknownSelectors: UnknownProtocolSelectorDiagnostic[] = [];
  const sourceErrors: ProtocolDiscoverySourceError[] = [];
  const familyGuard = input.familyGuard ??
    new ProtocolDiscoveryFamilyGuard(
      sourceAwareFamilyGuardOptions(input.familyGuardOptions, passControl),
    );
  const reportedOpenCircuits = new Set<string>();
  const calls = uniqueCalls(successfulCalls(input.trace));
  const protocolLike = shouldTraceForProtocolDiscovery(input.receipt.logs, input.adapters);
  const diagnosticTargets = protocolLike
    ? likelyProtocolTargets(input.trace, input.receipt.logs, input.adapters)
    : new Set<string>();

  for (const call of calls) {
    const matches: Array<{ adapterId: string; candidate: ProtocolCandidate }> = [];
    const matchingAdapters = input.adapters.filter((adapter) => {
      const discovery = adapter.discovery;
      if (
        !discovery?.candidateSources.includes("observed-interaction") ||
        !discovery.candidateFromObservedCall
      ) return false;
      return discovery.callSelectors.some(
        (selector) => selector.toLowerCase() === call.selector,
      );
    });
    const selectorRecognized = matchingAdapters.length > 0;
    const matcherResults = await mapLimit(
      matchingAdapters,
      FAMILY_CALLBACK_CONCURRENCY,
      async (adapter) => {
        const discovery = adapter.discovery!;
        try {
          const candidate = await familyGuard.run(
            adapter.id,
            "observed-matcher",
            (control) =>
              discovery.candidateFromObservedCall!({
                ...call,
                txHash: input.txHash,
                receipt: input.receipt,
                trace: input.trace,
              }, withProtocolDiscoveryFamilyContext(input.context, control)),
          );
          return { adapter, candidate, error: null };
        } catch (error) {
          throwIfProtocolDiscoveryParentStopped(passControl);
          return { adapter, candidate: null, error };
        }
      },
    );
    // mapLimit preserves registration order, so diagnostics and arbitration
    // remain deterministic even though sibling families execute concurrently.
    for (const result of matcherResults) {
      const adapter = result.adapter;
      if (result.error !== null) {
        const error = result.error;
        if (
          !(error instanceof ProtocolDiscoveryFamilyCircuitOpen) ||
          !reportedOpenCircuits.has(adapter.id)
        ) {
          reportedOpenCircuits.add(adapter.id);
          sourceErrors.push({
            adapterId: adapter.id,
            sourceKind: "observed-interaction",
            impactedFamilyIds: [adapter.id],
            target: call.target,
            reason: `observed match failed: ${safeError(error)}`,
            retryable: true,
          });
        }
        continue;
      }
      const candidate = result.candidate;
      if (!candidate) continue;
      matches.push({ adapterId: adapter.id, candidate });
    }
    if (matches.length === 1) {
      pushCandidate(candidatesByAdapter, matches[0].adapterId, matches[0].candidate);
      continue;
    }
    const distinctAdapterIds = new Set(matches.map((match) => match.adapterId));
    if (matches.length > 1 && distinctAdapterIds.size > 1) {
      // Cross-adapter full matches all reach the coordinator, which verifies
      // each candidate independently and adjudicates post-probe. Same-id
      // duplicate registrations remain scanner-local invalid input.
      for (const match of matches) {
        pushCandidate(candidatesByAdapter, match.adapterId, match.candidate);
      }
    }
    if (
      protocolLike &&
      diagnosticTargets.has(call.target.toLowerCase()) &&
      unknownSelectors.length < 8
    ) {
      unknownSelectors.push({
        target: call.target,
        selector: call.selector,
        reason: matches.length === 0
          ? (selectorRecognized
            ? "protocol_like_flow_unverified_match"
            : "protocol_like_flow_unknown_selector")
          : "protocol_like_flow_ambiguous_adapter",
        recommendation: "inspect_calltrace",
        ...(matches.length > 1
          ? { matchingAdapterIds: matches.map((match) => match.adapterId).sort() }
          : {}),
      });
    }
  }

  // Diagnostics stay separate from graph admission. A transaction can contain
  // one verified route and a second unregistered protocol-like selector; the
  // verified edge remains clean while the unknown pair is still observable.
  return { candidatesByAdapter, unknownSelectors, sourceErrors };
}

function familyIdsForSource(
  adapters: readonly RouteLegAdapter[],
  sourceKind: RouteCandidateSourceKind,
): readonly ExecutionFamilyId[] {
  return Object.freeze(
    [...new Set(
      adapters
        .filter((adapter) => adapter.discovery?.candidateSources.includes(sourceKind))
        .map((adapter) => adapter.id),
    )].sort(),
  );
}

function sourceErrorsPreservingFamilyCoverage(
  errors: readonly ProtocolDiscoverySourceError[],
  detailLimit = 32,
): readonly ProtocolDiscoverySourceError[] {
  if (errors.length <= detailLimit) return errors;
  const selected: ProtocolDiscoverySourceError[] = [];
  const selectedOriginals = new Set<ProtocolDiscoverySourceError>();
  const covered = new Set<string>();

  // Preserve the first real retryable reason for every family/source before
  // high-volume semantic diagnostics (for example ambiguous matches) consume
  // the detail budget. Generic "omitted" summaries hide the actionable root.
  for (const error of errors) {
    if (!error.retryable) continue;
    for (const familyId of error.impactedFamilyIds) {
      const key = `${error.sourceKind}\u001f${familyId}`;
      if (covered.has(key) || selected.length >= detailLimit) continue;
      covered.add(key);
      selected.push(Object.freeze({
        ...error,
        adapterId: error.adapterId ?? familyId,
        impactedFamilyIds: Object.freeze([familyId]),
      }));
      selectedOriginals.add(error);
    }
  }
  for (const error of errors) {
    if (selected.length >= detailLimit) break;
    if (selectedOriginals.has(error)) continue;
    selected.push(error);
  }
  return Object.freeze(selected);
}

function sourceAwareFamilyGuardOptions(
  options: ProtocolDiscoveryFamilyGuardOptions | undefined,
  control: ProtocolDiscoveryReadControl | undefined,
): ProtocolDiscoveryFamilyGuardOptions {
  return {
    ...mergeProtocolDiscoveryFamilyGuardOptions(options, control),
    countsTowardCircuit: isRetryableDiscoverySourceFailure,
  };
}

function isRetryableDiscoverySourceFailure(error: unknown): boolean {
  if (error instanceof ProtocolDiscoveryFamilyCircuitOpen) return true;
  const code = error && typeof error === "object" && "code" in error
    ? String((error as { code?: unknown }).code).toUpperCase()
    : "";
  if (
    new Set([
      "CALL_EXCEPTION",
      "BAD_DATA",
      "INVALID_ARGUMENT",
      "NUMERIC_FAULT",
    ]).has(code)
  ) return false;
  if (
    new Set([
      "TIMEOUT",
      "NETWORK_ERROR",
      "SERVER_ERROR",
      "ABORTED",
      "ABORT_ERR",
      "ETIMEDOUT",
      "EAI_AGAIN",
      "ENETUNREACH",
      "EHOSTUNREACH",
      "ENOTFOUND",
      "EPIPE",
    ]).has(code) ||
    code.startsWith("ECONN") ||
    code.startsWith("UND_ERR_")
  ) return true;
  const message = error instanceof Error ? error.message : String(error);
  if (
    /execution reverted|could not decode|invalid (?:result|data|address)|unsupported|behavior[_ -]?mismatch/i
      .test(message)
  ) return false;
  return true;
}

function registeredEventTopics(adapters: readonly RouteLegAdapter[]): Set<string> {
  return new Set(
    adapters.flatMap((adapter) =>
      adapter.discovery?.candidateSources.includes("observed-interaction")
        ? adapter.discovery.eventTopics
        : []
    )
      .map((topic) => topic.toLowerCase()),
  );
}

function pushCandidate(
  candidatesByAdapter: Map<string, ProtocolCandidate[]>,
  adapterId: string,
  candidate: ProtocolCandidate,
): void {
  const candidates = candidatesByAdapter.get(adapterId) ?? [];
  candidates.push(candidate);
  candidatesByAdapter.set(adapterId, candidates);
}

function candidateSortKey(candidate: ProtocolCandidate): string {
  return `${candidate.pool.address.toLowerCase()}|${candidate.selector ?? ""}|${candidate.source}`;
}

function mergeProtocolDiscoveryReadControls(
  parent: ProtocolDiscoveryReadControl | undefined,
  operation: ProtocolDiscoveryReadControl | undefined,
): ProtocolDiscoveryReadControl {
  const deadlines = [parent?.deadlineAtMs, operation?.deadlineAtMs]
    .filter((value): value is number => value !== undefined);
  const deadlineAtMs = deadlines.length > 0 ? Math.min(...deadlines) : undefined;
  const signals = [...new Set(
    [parent?.signal, operation?.signal]
      .filter((value): value is AbortSignal => value !== undefined),
  )];
  const signal = signals.length === 0
    ? undefined
    : signals.length === 1
      ? signals[0]
      : AbortSignal.any(signals);
  const run = composeProtocolDiscoveryReadRunners(
    parent?.run,
    operation?.run,
  );
  return {
    ...(deadlineAtMs === undefined ? {} : { deadlineAtMs }),
    ...(signal === undefined ? {} : { signal }),
    ...(run === undefined ? {} : { run }),
  };
}

function mergeProtocolDiscoveryFamilyGuardOptions(
  options: ProtocolDiscoveryFamilyGuardOptions | undefined,
  control: ProtocolDiscoveryReadControl | undefined,
): ProtocolDiscoveryFamilyGuardOptions {
  const merged = mergeProtocolDiscoveryReadControls(
    {
      ...(options?.deadlineAtMs === undefined
        ? {}
        : { deadlineAtMs: options.deadlineAtMs }),
      ...(options?.signal === undefined ? {} : { signal: options.signal }),
      ...(options?.run === undefined ? {} : { run: options.run }),
    },
    control,
  );
  return {
    ...options,
    ...merged,
  };
}

function protocolDiscoveryReadControlFromFamilyOptions(
  options: ProtocolDiscoveryFamilyGuardOptions | undefined,
): ProtocolDiscoveryReadControl {
  return {
    ...(options?.deadlineAtMs === undefined
      ? {}
      : { deadlineAtMs: options.deadlineAtMs }),
    ...(options?.signal === undefined ? {} : { signal: options.signal }),
    ...(options?.run === undefined ? {} : { run: options.run }),
  };
}

function composeProtocolDiscoveryReadRunners(
  first: ProtocolDiscoveryReadControl["run"],
  second: ProtocolDiscoveryReadControl["run"],
): ProtocolDiscoveryReadControl["run"] {
  if (!first) return second;
  if (!second || first === second) return first;
  return async <T>(
    work: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> =>
    first((firstSignal) =>
      second((secondSignal) =>
        work(
          firstSignal === secondSignal
            ? firstSignal
            : AbortSignal.any([firstSignal, secondSignal]),
        )
      )
    );
}

async function awaitWithProtocolDiscoveryControl<T>(
  promise: Promise<T>,
  control: ProtocolDiscoveryReadControl | undefined,
): Promise<T> {
  throwIfProtocolDiscoveryParentStopped(control);
  if (control?.signal === undefined && control?.deadlineAtMs === undefined) {
    return promise;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  let detach = (): void => {};
  const stopped = new Promise<never>((_resolve, reject) => {
    const stop = (): void => {
      try {
        throwIfProtocolDiscoveryParentStopped(control);
        reject(new Error("protocol discovery parent stopped"));
      } catch (error) {
        reject(error);
      }
    };
    if (control?.signal) {
      control.signal.addEventListener("abort", stop, { once: true });
      detach = () => control.signal?.removeEventListener("abort", stop);
    }
    if (control?.deadlineAtMs !== undefined) {
      timer = setTimeout(
        stop,
        Math.max(0, control.deadlineAtMs - Date.now()),
      );
    }
  });
  try {
    return await Promise.race([promise, stopped]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    detach();
  }
}

function throwIfProtocolDiscoveryParentStopped(
  control: ProtocolDiscoveryReadControl | undefined,
): void {
  if (control?.signal?.aborted) {
    throw control.signal.reason ?? Object.assign(
      new Error("protocol discovery parent signal aborted"),
      { code: "ABORTED" },
    );
  }
  if (
    control?.deadlineAtMs !== undefined &&
    Date.now() >= control.deadlineAtMs
  ) {
    throw Object.assign(
      new Error("protocol discovery parent deadline exceeded"),
      { code: "TIMEOUT" },
    );
  }
}

function safeError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/https?:\/\/\S+/g, "<redacted-url>")
    .slice(0, 240);
}

async function mapLimit<T, R>(
  values: readonly T[],
  concurrency: number,
  work: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (true) {
      const index = cursor++;
      if (index >= values.length) return;
      results[index] = await work(values[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

interface ObservedCall {
  readonly target: string;
  readonly selector: string;
  readonly input: string;
  readonly from?: string;
}

function uniqueCalls(calls: readonly ObservedCall[]): ObservedCall[] {
  const unique = new Map<string, ObservedCall>();
  for (const call of calls) {
    unique.set(
      `${call.target.toLowerCase()}|${call.from?.toLowerCase() ?? ""}|${call.input.toLowerCase()}`,
      call,
    );
  }
  return [...unique.values()];
}

function successfulCalls(trace: unknown): ObservedCall[] {
  const result: ObservedCall[] = [];
  const visit = (node: unknown, ancestorFailed: boolean): void => {
    if (!node || typeof node !== "object") return;
    const call = node as {
      to?: unknown;
      from?: unknown;
      input?: unknown;
      error?: unknown;
      calls?: unknown;
    };
    const failed = ancestorFailed || Boolean(call.error);
    if (!failed && typeof call.to === "string" && typeof call.input === "string") {
      const selector = call.input.slice(0, 10).toLowerCase();
      if (/^0x[0-9a-f]{8}$/.test(selector)) {
        try {
          const from = typeof call.from === "string"
            ? ethers.getAddress(call.from)
            : undefined;
          result.push({
            target: ethers.getAddress(call.to),
            selector,
            input: call.input,
            ...(from === undefined ? {} : { from }),
          });
        } catch {
          // malformed trace target
        }
      }
    }
    if (Array.isArray(call.calls)) {
      for (const child of call.calls) visit(child, failed);
    }
  };
  visit(trace, false);
  return result;
}

/**
 * Unknown diagnostics are restricted to likely protocol actors. A protocol-like
 * receipt must not turn every ERC20/router helper in the trace into an unknown
 * protocol selector.
 */
function likelyProtocolTargets(
  trace: unknown,
  logs: readonly ProtocolDiscoveryLog[],
  adapters: readonly RouteLegAdapter[],
): Set<string> {
  const targets = new Set<string>();
  const declaredTopics = registeredEventTopics(adapters);
  const declaredEmitters = new Set(
    logs
      .filter((log) => declaredTopics.has(log.topics[0]?.toLowerCase() ?? ""))
      .map((log) => log.address.toLowerCase()),
  );
  for (const call of successfulCalls(trace)) {
    if (declaredEmitters.has(call.target.toLowerCase())) targets.add(call.target.toLowerCase());
  }

  const lpEmitters = new Set(
    logs
      .filter((log) => LP_TOPICS.has(log.topics[0]?.toLowerCase() ?? ""))
      .map((log) => log.address.toLowerCase()),
  );
  const minted = new Set<string>();
  const burned = new Set<string>();
  for (const log of logs) {
    if (log.topics[0]?.toLowerCase() !== TRANSFER_TOPIC || log.topics.length < 3) continue;
    const token = log.address.toLowerCase();
    if (lpEmitters.has(token)) continue;
    if (log.topics[1]?.toLowerCase() === ZERO_TOPIC) minted.add(token);
    if (log.topics[2]?.toLowerCase() === ZERO_TOPIC) burned.add(token);
  }
  const flowTokens = new Set([...minted, ...burned]);

  interface FlowVisit { mint: boolean; burn: boolean; actorFound: boolean }
  const visit = (node: unknown, ancestorFailed: boolean): FlowVisit => {
    if (!node || typeof node !== "object") return { mint: false, burn: false, actorFound: false };
    const call = node as { to?: unknown; input?: unknown; error?: unknown; calls?: unknown };
    const failed = ancestorFailed || Boolean(call.error);
    let target: string | null = null;
    if (!failed && typeof call.to === "string") {
      try {
        target = ethers.getAddress(call.to).toLowerCase();
      } catch {
        target = null;
      }
    }
    let mint = target !== null && minted.has(target);
    let burn = target !== null && burned.has(target);
    let childActorFound = false;
    if (Array.isArray(call.calls)) {
      for (const child of call.calls) {
        const childFlow = visit(child, failed);
        mint ||= childFlow.mint;
        burn ||= childFlow.burn;
        childActorFound ||= childFlow.actorFound;
      }
    }
    const isCallable = target !== null &&
      typeof call.input === "string" &&
      /^0x[0-9a-fA-F]{8}/.test(call.input) &&
      !flowTokens.has(target);
    const isActor = mint && burn && !childActorFound && isCallable;
    if (isActor) targets.add(target!);
    return { mint, burn, actorFound: childActorFound || isActor };
  };
  visit(trace, false);

  if (targets.size === 0) {
    const root = successfulCalls(trace)[0];
    if (root) targets.add(root.target.toLowerCase());
  }
  return targets;
}
