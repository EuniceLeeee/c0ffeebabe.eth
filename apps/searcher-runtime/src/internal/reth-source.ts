import {
  assertExactKeys,
  assertNonEmptyString,
  assertPlainObject,
} from "../../../../packages/canonical-codec/src/index.ts";
import {
  CanonicalSource,
  CanonicalSourceError,
  SQLiteCanonicalJournalStore,
  createRethCanonicalHeaderProviderV1,
  type CanonicalHead,
  type CanonicalHeadObservationCapabilityV1,
  type CanonicalSourceAuthorityV1,
  type ProducerCurrentSourceSessionCapabilityV1,
  type RethCanonicalHeaderProviderConfigV1,
  readIssuedProducerCurrentSourceSessionCapabilityV1,
} from "../../../../packages/canonical-source/src/index.ts";
import {
  createRethProducerIngressPortV1,
  type RethProducerIngressConfigV1,
} from "../../../../packages/producer/src/internal/reth-intake.ts";
import type {
  ProducerCurrentSourceHeadPortV1,
  ProducerIngressPortV1,
} from "../../../../packages/producer/src/index.ts";
import { issueProducerCurrentSourceHeadPortV1 } from "../../../../packages/producer/src/internal/owners.ts";
import {
  CurrentSourceRpcReadTransport,
  type CurrentSourceRpcLogicalReadScopeV1,
  type CurrentSourceRpcLogicalScopeBindingV1,
  type CurrentSourceRpcLogicalScopeFactsV1,
  type CurrentSourceRpcPhysicalFactsV1,
} from "../../../../packages/current-source-rpc/src/index.ts";
import type { SearcherProducerSessionV1 } from "./ports.ts";

export interface RethSearcherRuntimeSourceConfigV1 {
  readonly canonical: RethCanonicalHeaderProviderConfigV1 & {
    readonly journalPath: string;
    readonly chainGenesis?: string;
    /** Candidate-owned polling cadence. Repeated reads never re-emit the same head. */
    readonly headPollIntervalMs?: number;
  };
  readonly ingress: RethProducerIngressConfigV1;
}

export interface RethSearcherRuntimeSourceV1 {
  readonly canonical: CanonicalSource;
  readonly canonicalAuthority: CanonicalSourceAuthorityV1;
  readonly headSource: Readonly<{
    readonly next: (signal: AbortSignal) => Promise<CanonicalHead | null>;
  }>;
  readonly ingress: ProducerIngressPortV1;
  /** Producer-only single-seal port for shared physical head facts. */
  readonly currentSourceHead: ProducerCurrentSourceHeadPortV1<SearcherProducerSessionV1>;
  /** Resolve and consume only a head observation emitted by this source. */
  consumeHeadObservation(head: CanonicalHead): CanonicalHeadObservationCapabilityV1;
  /** Logical lanes share one physical transport but never its cumulative snapshot. */
  issueCurrentSourceReadScope(
    session: ProducerCurrentSourceSessionCapabilityV1,
    binding: CurrentSourceRpcLogicalScopeBindingV1,
  ): CurrentSourceRpcLogicalReadScopeV1;
  closeCurrentSourceReadScope(
    session: ProducerCurrentSourceSessionCapabilityV1,
    scope: CurrentSourceRpcLogicalReadScopeV1,
  ): CurrentSourceRpcLogicalScopeFactsV1;
  closeCurrentSourceReadHead(
    session: ProducerCurrentSourceSessionCapabilityV1,
  ): Promise<CurrentSourceRpcPhysicalFactsV1>;
  close(): void;
}

const issued = new WeakSet<object>();

function exactConfig(value: unknown): RethSearcherRuntimeSourceConfigV1 {
  assertPlainObject(value, "rethSearcherRuntimeSource.config");
  assertExactKeys(value, ["canonical", "ingress"], "rethSearcherRuntimeSource.config");
  const canonical = value.canonical;
  assertPlainObject(canonical, "rethSearcherRuntimeSource.config.canonical");
  const canonicalKeys = ["profile", "endpoint", "chainId", "journalPath"];
  if (Object.prototype.hasOwnProperty.call(canonical, "chainGenesis")) canonicalKeys.push("chainGenesis");
  if (Object.prototype.hasOwnProperty.call(canonical, "timeoutMs")) canonicalKeys.push("timeoutMs");
  if (Object.prototype.hasOwnProperty.call(canonical, "headPollIntervalMs")) canonicalKeys.push("headPollIntervalMs");
  assertExactKeys(canonical, canonicalKeys, "rethSearcherRuntimeSource.config.canonical");
  const journalPath = assertNonEmptyString(canonical.journalPath, "rethSearcherRuntimeSource.config.canonical.journalPath");
  if (!journalPath.startsWith("/")) throw new TypeError("Reth canonical journalPath must be absolute");
  assertPlainObject(value.ingress, "rethSearcherRuntimeSource.config.ingress");
  return value as unknown as RethSearcherRuntimeSourceConfigV1;
}

function sameHead(left: CanonicalHead, right: CanonicalHead): boolean {
  return left.chainId === right.chainId
    && left.number === right.number
    && left.hash === right.hash
    && left.parentHash === right.parentHash
    && left.stateRoot === right.stateRoot;
}

function headKey(head: CanonicalHead): string {
  return `${head.chainId}:${head.number}:${head.hash}:${head.parentHash}:${head.stateRoot}`;
}

function pollInterval(value: number | undefined): number {
  const interval = value ?? 250;
  if (!Number.isSafeInteger(interval) || interval < 1 || interval > 60_000) {
    throw new TypeError("Reth headPollIntervalMs must be an integer in [1, 60000]");
  }
  return interval;
}

async function waitForPoll(intervalMs: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return false;
  return new Promise(resolve => {
    const finish = (value: boolean) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      resolve(value);
    };
    const abort = () => finish(false);
    const timer = setTimeout(() => finish(true), intervalMs);
    signal.addEventListener("abort", abort, { once: true });
  });
}

/**
 * The sole candidate-owned source constructor. It creates the durable
 * canonical journal, fixed Reth JSON-RPC header provider, and the optional
 * public-pending intake as one indivisible bundle. Deployment code receives
 * only the resulting owner and cannot replace either source.
 */
export function createRethSearcherRuntimeSourceV1(
  rawConfig: RethSearcherRuntimeSourceConfigV1,
): RethSearcherRuntimeSourceV1 {
  const config = exactConfig(rawConfig);
  const headPollIntervalMs = pollInterval(config.canonical.headPollIntervalMs);
  if (config.ingress.endpoint !== config.canonical.endpoint) throw new TypeError("Reth source and ingress endpoints must match");
  if (config.ingress.profile !== "reth-json-rpc-v1" || config.canonical.profile !== "reth-json-rpc-v1") throw new TypeError("Reth source profile mismatch");
  const journal = new SQLiteCanonicalJournalStore(config.canonical.journalPath);
  let canonical: CanonicalSource;
  try {
    canonical = new CanonicalSource(
      createRethCanonicalHeaderProviderV1({
        profile: config.canonical.profile,
        endpoint: config.canonical.endpoint,
        chainId: config.canonical.chainId,
        ...(config.canonical.timeoutMs === undefined ? {} : { timeoutMs: config.canonical.timeoutMs }),
      }),
      {
        journalStore: journal,
        ...(config.canonical.chainGenesis === undefined ? {} : { chainGenesis: config.canonical.chainGenesis }),
      },
    );
  } catch (error) {
    journal.close();
    throw error;
  }
  const ingress = createRethProducerIngressPortV1(config.ingress);
  let lastEmittedHead: CanonicalHead | null = null;
  const pendingHeadObservations = new Map<string, CanonicalHeadObservationCapabilityV1>();
  let closed = false;
  const currentSourceReads = new WeakMap<object, CurrentSourceRpcReadTransport>();
  const sourceRead = (capability: ProducerCurrentSourceSessionCapabilityV1): CurrentSourceRpcReadTransport => {
    if (closed) throw new TypeError("Reth searcher runtime source is closed");
    const session = readIssuedProducerCurrentSourceSessionCapabilityV1(capability);
    if (session.canonicalSourceAuthority !== canonical.authority) {
      throw new TypeError("producer current-source session belongs to another canonical source");
    }
    const existing = currentSourceReads.get(capability);
    if (existing !== undefined) return existing;
    // Canonical/Producer owns the full header, including parentHash. Family
    // current-source reads deliberately consume only the strict four-field
    // source identity; project it here instead of widening the Family schema.
    const currentSource = Object.freeze({
      source: Object.freeze({
        chainId: session.source.chainId,
        number: session.source.number,
        hash: session.source.hash,
        stateRoot: session.source.stateRoot,
      }),
      assertCurrent: () => session.assertCurrent(),
    });
    const created = new CurrentSourceRpcReadTransport({
      endpoint: config.canonical.endpoint,
      currentSource,
      timeoutMs: config.canonical.timeoutMs,
    });
    currentSourceReads.set(capability, created);
    return created;
  };
  const currentSourceHead = issueProducerCurrentSourceHeadPortV1<SearcherProducerSessionV1>({
    closeHead: session => sourceRead(session.currentSourceCapability).closePhysicalFacts(),
  });
  const source: RethSearcherRuntimeSourceV1 = Object.freeze({
    canonical,
    canonicalAuthority: canonical.authority,
    headSource: Object.freeze({
      async next(signal: AbortSignal) {
        while (!signal.aborted) {
          if (lastEmittedHead !== null && !await waitForPoll(headPollIntervalMs, signal)) return null;
          let observed: CanonicalHead;
          let observation: CanonicalHeadObservationCapabilityV1;
          try {
            observation = await canonical.observeCurrentHead(signal);
            observed = canonical.headObservationReader.read(observation).head;
          } catch (error) {
            if (signal.aborted) return null;
            if (error instanceof CanonicalSourceError && error.retryable) {
              if (!await waitForPoll(headPollIntervalMs, signal)) return null;
              continue;
            }
            throw error;
          }
          if (lastEmittedHead === null || !sameHead(lastEmittedHead, observed)) {
            for (const [key, pending] of pendingHeadObservations) {
              const pendingHead = canonical.headObservationReader.read(pending).head;
              if (BigInt(pendingHead.number) <= BigInt(observed.number)) pendingHeadObservations.delete(key);
            }
            pendingHeadObservations.set(headKey(observed), observation);
            lastEmittedHead = observed;
            return observed;
          }
        }
        return null;
      },
    }),
    ingress,
    currentSourceHead,
    consumeHeadObservation(head: CanonicalHead) {
      const observation = pendingHeadObservations.get(headKey(head));
      if (observation === undefined) {
        throw new CanonicalSourceError(
          "fence-invalid",
          "producer head was not emitted by this Reth source",
          false,
          head,
          null,
        );
      }
      const observed = canonical.headObservationReader.read(observation).head;
      if (!sameHead(observed, head)) {
        throw new CanonicalSourceError("fence-invalid", "producer head observation binding changed", false, head, observed);
      }
      pendingHeadObservations.delete(headKey(head));
      return observation;
    },
    issueCurrentSourceReadScope(session: ProducerCurrentSourceSessionCapabilityV1, binding: CurrentSourceRpcLogicalScopeBindingV1) {
      return sourceRead(session).issueLogicalReadScope(binding);
    },
    closeCurrentSourceReadScope(session: ProducerCurrentSourceSessionCapabilityV1, scope: CurrentSourceRpcLogicalReadScopeV1) {
      return sourceRead(session).closeLogicalReadScope(scope);
    },
    closeCurrentSourceReadHead(session: ProducerCurrentSourceSessionCapabilityV1) {
      return sourceRead(session).closePhysicalFacts();
    },
    close() {
      if (closed) return;
      closed = true;
      pendingHeadObservations.clear();
      journal.close();
    },
  });
  issued.add(source);
  return source;
}

export function assertIssuedRethSearcherRuntimeSourceV1(
  value: unknown,
): asserts value is RethSearcherRuntimeSourceV1 {
  if (value === null || typeof value !== "object" || !issued.has(value)) {
    throw new TypeError("Reth searcher runtime source is not candidate-issued");
  }
}
