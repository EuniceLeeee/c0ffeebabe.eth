import { ethers } from "ethers";
import {
  createProtocolDiscoveryEvidenceCache,
  protocolAddressCacheKey,
  type ProtocolDiscoveryEvidenceCache,
} from "./protocol-discovery-cache.js";
import type {
  ProtocolCandidate,
  ProtocolConversionAdapter,
  ProtocolDiscoveryContext,
  ProtocolDiscoveryLog,
  ProtocolDiscoveryReceipt,
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
const IMPLEMENTATION_SLOT = BigInt(
  "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc",
);
const ZERO_WORD = `0x${"0".repeat(64)}`;
const NEGATIVE_CACHE_BLOCKS = 7_200;

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
}

export interface ProtocolDiscoverySourceError {
  readonly adapterId: string | null;
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
  readonly matches: number;
  readonly negatives: number;
  readonly ambiguous: number;
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

/** Receipt-only, cheap gate for deciding whether a call trace can teach us a protocol route. */
export function shouldTraceForProtocolDiscovery(
  logs: readonly ProtocolDiscoveryLog[],
  adapters: readonly ProtocolConversionAdapter[],
): boolean {
  const declaredTopics = registeredEventTopics(adapters);
  if (logs.some((log) => declaredTopics.has(log.topics[0]?.toLowerCase() ?? ""))) return true;
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
  adapters: readonly ProtocolConversionAdapter[];
  context: ProtocolDiscoveryContext;
  candidateAddresses?: readonly string[];
  evidenceCache?: ProtocolDiscoveryEvidenceCache;
}): Promise<ProtocolDiscoveryRangeResult> {
  const candidatesByAdapter = new Map<string, ProtocolCandidate[]>();
  const unknownSelectors: UnknownProtocolSelectorDiagnostic[] = [];
  const eventSourceErrors: ProtocolDiscoverySourceError[] = [];
  const addressScanPromise = scanAddressCandidates({
    adapters: input.adapters,
    context: input.context,
    candidateAddresses: input.candidateAddresses ?? [],
    evidenceCache: input.evidenceCache ?? createProtocolDiscoveryEvidenceCache(),
  }).catch((error) => ({
    candidatesByAdapter: new Map<string, readonly ProtocolCandidate[]>(),
    issues: [{
      adapterId: null,
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
      ambiguous: 0,
    },
  }));

  const topics = [...registeredEventTopics(input.adapters)].sort();
  const eventLogs: ProtocolDiscoveryLog[] = [];
  if (topics.length > 0) {
    for (let start = input.context.fromBlock; start <= input.context.toBlock; start += LOG_BATCH) {
      const end = Math.min(input.context.toBlock, start + LOG_BATCH - 1);
      try {
        eventLogs.push(...await input.context.backend.getLogs({
          topics: [topics.length === 1 ? topics[0] : topics],
          fromBlock: start,
          toBlock: end,
        }));
      } catch (error) {
        eventSourceErrors.push({
          adapterId: null,
          target: null,
          reason: `event_window_${start}_${end}: ${safeError(error)}`,
          retryable: true,
        });
      }
    }
  }

  const txHashes = new Set<string>();
  for (const log of eventLogs) {
    if (log.transactionHash) txHashes.add(log.transactionHash.toLowerCase());
    else {
      eventSourceErrors.push({
        adapterId: null,
        target: log.address,
        reason: "discovery event missing transaction hash",
        retryable: true,
      });
    }
  }
  const traceResults = await mapLimit([...txHashes].sort(), TRACE_CONCURRENCY, async (txHash) => {
    try {
      const receipt = await input.context.backend.getTransactionReceipt(txHash);
      if (!receipt) throw new Error("receipt unavailable for discovery event");
      const trace = await input.context.backend.traceTransaction(txHash);
      const observed = await scanObservedProtocolTrace({
        adapters: input.adapters,
        context: input.context,
        txHash,
        receipt,
        trace,
      });
      return { observed, error: null };
    } catch (error) {
      return {
        observed: null,
        error: {
          adapterId: null,
          target: null,
          reason: `${txHash}: ${safeError(error)}`,
          // A pruned local node cannot recover an old trace by retrying the
          // same window. Skip that evidence fail-closed; current-state DEX
          // address discovery remains the archive-free recovery path.
          retryable: !isPrunedHistoricalStateFailure(error),
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
  for (const [adapterId, candidates] of addressScan.candidatesByAdapter) {
    for (const candidate of candidates) pushCandidate(candidatesByAdapter, adapterId, candidate);
  }
  for (const candidates of candidatesByAdapter.values()) {
    candidates.sort((a, b) => candidateSortKey(a).localeCompare(candidateSortKey(b)));
  }
  const addressSourceComplete = !addressScan.issues.some((issue) => issue.retryable);
  const eventSourceComplete = !eventSourceErrors.some((issue) => issue.retryable);
  const sourceErrors = [...addressScan.issues, ...eventSourceErrors];
  return {
    candidatesByAdapter,
    unknownSelectors,
    sourceComplete: addressSourceComplete && eventSourceComplete,
    eventSourceComplete,
    addressSourceComplete,
    sourceErrors: sourceErrors.slice(0, 32),
    addressStats: addressScan.stats,
  };
}

async function scanAddressCandidates(input: {
  adapters: readonly ProtocolConversionAdapter[];
  context: ProtocolDiscoveryContext;
  candidateAddresses: readonly string[];
  evidenceCache: ProtocolDiscoveryEvidenceCache;
}): Promise<{
  candidatesByAdapter: ReadonlyMap<string, readonly ProtocolCandidate[]>;
  issues: readonly ProtocolDiscoverySourceError[];
  stats: ProtocolAddressDiscoveryStats;
}> {
  const adapters = input.adapters.filter((adapter) => adapter.discovery?.candidateFromAddress);
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
  const results = await mapLimit([...addresses.values()].sort(), ADDRESS_CONCURRENCY, async (target) => {
    let code: string;
    let implementationWord: string;
    try {
      code = await input.context.backend.getCode(target);
      implementationWord = code === "0x"
        ? ZERO_WORD
        : (await input.context.backend.getStorageAt(target, IMPLEMENTATION_SLOT)).toLowerCase();
    } catch (error) {
      return {
        matches: [] as Array<{ adapterId: string; candidate: ProtocolCandidate }>,
        issues: [{
          adapterId: null,
          target,
          reason: `address code read failed: ${safeError(error)}`,
          retryable: true,
        }] satisfies ProtocolDiscoverySourceError[],
        codeReads: 1,
        cacheHits: 0,
        probes: 0,
        negatives: 0,
        matcherUndecided: true,
      };
    }
    const codeHash = ethers.keccak256(code).toLowerCase();
    const matches: Array<{ adapterId: string; candidate: ProtocolCandidate }> = [];
    const issues: ProtocolDiscoverySourceError[] = [];
    let cacheHits = 0;
    let probes = 0;
    let negatives = 0;
    let matcherUndecided = false;
    for (const adapter of adapters) {
      const matcher = adapter.discovery?.candidateFromAddress;
      if (!matcher) continue;
      const matcherVersion = adapter.discovery?.addressMatcherVersion?.trim();
      if (!matcherVersion) {
        matcherUndecided = true;
        issues.push({
          adapterId: adapter.id,
          target,
          reason: "address matcher omitted addressMatcherVersion",
          retryable: false,
        });
        continue;
      }
      const key = protocolAddressCacheKey(adapter.id, target);
      const cached = input.evidenceCache.addressEntries.get(key);
      const cacheAge = cached ? input.context.blockNumber - cached.checkedAtBlock : Infinity;
      const fingerprintMatches = cached?.codeHash.toLowerCase() === codeHash &&
        cached.implementationWord.toLowerCase() === implementationWord &&
        cached.matcherVersion === matcherVersion &&
        cacheAge >= 0;
      const negativeFresh = cached?.candidate !== null || cacheAge <= NEGATIVE_CACHE_BLOCKS;
      if (cached && fingerprintMatches && negativeFresh) {
        cacheHits++;
        if (cached.candidate) matches.push({ adapterId: adapter.id, candidate: cached.candidate });
        else negatives++;
        continue;
      }
      let candidate: ProtocolCandidate | null;
      if (code === "0x") {
        candidate = null;
      } else {
        try {
          candidate = await matcher({ target, codeHash, implementationWord }, input.context);
        } catch (error) {
          matcherUndecided = true;
          issues.push({
            adapterId: adapter.id,
            target,
            reason: `address match failed: ${safeError(error)}`,
            retryable: true,
          });
          continue;
        }
      }
      probes++;
      if (candidate) {
        let candidateTarget: string;
        try {
          candidateTarget = ethers.getAddress(candidate.pool.address);
        } catch {
          candidateTarget = ethers.ZeroAddress;
        }
        if (candidateTarget.toLowerCase() !== target.toLowerCase()) {
          issues.push({
            adapterId: adapter.id,
            target,
            reason: "address matcher changed candidate target",
            retryable: false,
          });
          continue;
        }
        matches.push({ adapterId: adapter.id, candidate });
      } else {
        negatives++;
      }
      input.evidenceCache.addressEntries.set(key, {
        adapterId: adapter.id,
        address: target,
        codeHash,
        implementationWord,
        matcherVersion,
        checkedAtBlock: input.context.blockNumber,
        candidate,
      });
    }
    return { matches, issues, matcherUndecided, codeReads: 1, cacheHits, probes, negatives };
  });

  const candidatesByAdapter = new Map<string, ProtocolCandidate[]>();
  const issues: ProtocolDiscoverySourceError[] = [];
  let codeReads = 0;
  let cacheHits = 0;
  let probes = 0;
  let matches = 0;
  let negatives = 0;
  let ambiguous = 0;
  for (const result of results) {
    codeReads += result.codeReads;
    cacheHits += result.cacheHits;
    probes += result.probes;
    negatives += result.negatives;
    issues.push(...result.issues);
    if (result.matcherUndecided) {
      // A successful family cannot be declared unique while another matching
      // family's classifier is unavailable for the same target.
      continue;
    }
    if (result.matches.length === 1) {
      const match = result.matches[0];
      pushCandidate(candidatesByAdapter, match.adapterId, match.candidate);
      matches++;
    } else if (result.matches.length > 1) {
      ambiguous++;
      const adapterIds = [...new Set(result.matches.map((item) => item.adapterId))];
      // Preserve distinct candidates for the coordinator's target-level
      // quarantine, including any previously retained route. Duplicate
      // registrations of one adapter id remain scanner-local invalid input.
      if (adapterIds.length > 1) {
        for (const match of result.matches) {
          pushCandidate(candidatesByAdapter, match.adapterId, match.candidate);
        }
      }
      issues.push({
        adapterId: null,
        target: result.matches[0].candidate.pool.address,
        reason: `ambiguous address adapters: ${result.matches.map((item) => item.adapterId).sort().join(",")}`,
        retryable: false,
      });
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
      ambiguous,
    },
  };
}

/**
 * Selector matching only shortlists address+selector pairs. Each adapter must
 * still construct a candidate and the shared coordinator must attest identity
 * and probe routes before any graph mutation.
 */
export async function scanObservedProtocolTrace(input: {
  adapters: readonly ProtocolConversionAdapter[];
  context: ProtocolDiscoveryContext;
  txHash: string;
  receipt: ProtocolDiscoveryReceipt;
  trace: unknown;
}): Promise<ObservedProtocolDiscoveryResult> {
  const candidatesByAdapter = new Map<string, ProtocolCandidate[]>();
  const unknownSelectors: UnknownProtocolSelectorDiagnostic[] = [];
  const calls = uniqueCalls(successfulCalls(input.trace));
  const protocolLike = shouldTraceForProtocolDiscovery(input.receipt.logs, input.adapters);
  const diagnosticTargets = protocolLike
    ? likelyProtocolTargets(input.trace, input.receipt.logs, input.adapters)
    : new Set<string>();

  for (const call of calls) {
    const matches: Array<{ adapterId: string; candidate: ProtocolCandidate }> = [];
    let selectorRecognized = false;
    for (const adapter of input.adapters) {
      const discovery = adapter.discovery;
      if (!discovery?.candidateFromObservedCall) continue;
      const selectorMatches = discovery.callSelectors.some(
        (selector) => selector.toLowerCase() === call.selector,
      );
      if (!selectorMatches) continue;
      selectorRecognized = true;
      const candidate = await discovery.candidateFromObservedCall({
        ...call,
        txHash: input.txHash,
        receipt: input.receipt,
        trace: input.trace,
      }, input.context);
      if (!candidate) continue;
      matches.push({ adapterId: adapter.id, candidate });
    }
    if (matches.length === 1) {
      pushCandidate(candidatesByAdapter, matches[0].adapterId, matches[0].candidate);
      continue;
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
  return { candidatesByAdapter, unknownSelectors };
}

function registeredEventTopics(adapters: readonly ProtocolConversionAdapter[]): Set<string> {
  return new Set(
    adapters.flatMap((adapter) => adapter.discovery?.eventTopics ?? [])
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

function safeError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/https?:\/\/\S+/g, "<redacted-url>")
    .slice(0, 240);
}

function isPrunedHistoricalStateFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /prun(?:ed|ing)|historical state.*(?:unavailable|missing)|missing trie node/i.test(message);
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
}

function uniqueCalls(calls: readonly ObservedCall[]): ObservedCall[] {
  const unique = new Map<string, ObservedCall>();
  for (const call of calls) {
    unique.set(`${call.target.toLowerCase()}|${call.selector}`, call);
  }
  return [...unique.values()];
}

function successfulCalls(trace: unknown): ObservedCall[] {
  const result: ObservedCall[] = [];
  const visit = (node: unknown, ancestorFailed: boolean): void => {
    if (!node || typeof node !== "object") return;
    const call = node as { to?: unknown; input?: unknown; error?: unknown; calls?: unknown };
    const failed = ancestorFailed || Boolean(call.error);
    if (!failed && typeof call.to === "string" && typeof call.input === "string") {
      const selector = call.input.slice(0, 10).toLowerCase();
      if (/^0x[0-9a-f]{8}$/.test(selector)) {
        try {
          result.push({ target: ethers.getAddress(call.to), selector });
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
  adapters: readonly ProtocolConversionAdapter[],
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
