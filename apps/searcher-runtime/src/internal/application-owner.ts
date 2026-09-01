import type {
  CanonicalHead,
} from "../../../../packages/canonical-source/src/index.ts";
import {
  assertExactKeys,
} from "../../../../packages/canonical-codec/src/index.ts";
import {
  type ProducerHeadTerminalCapabilityV1,
  type ProducerRuntimeTelemetryV1,
  type ProducerSubmissionResultV1,
  type ProducerHeadInputV1,
} from "../../../../packages/producer/src/index.ts";
import {
  assertIssuedQualifiedFinalSimulationPortFactory,
  type QualifiedFinalSimulationPortFactoryV1,
} from "../../../../packages/final-sim/src/index.ts";
import type { SearchRuntimeCoreInputV1 } from "../../../../packages/search-runtime-core/src/index.ts";
import {
  assertIssuedSearcherStrategyRuntimeServiceV1,
  type SearcherStrategyRuntimeServiceV1,
} from "../../../../packages/runtime-release-authority/src/strategy-runtime-consumer.ts";
import {
  assertIssuedStartupRuntime,
  type StartupRuntimeV1,
} from "../../../../packages/startup-runtime/src/index.ts";
import {
  assertIssuedRethSearcherRuntimeSourceV1,
  type RethSearcherRuntimeSourceV1,
} from "./reth-source.ts";
import {
  createReleaseSearcherProducer,
} from "../index.ts";
import {
  assertIssuedEconomicSafetyFinalizationServiceV1,
  type EconomicSafetyFinalizationServiceV1,
} from "../../../../packages/economics-safety/src/index.ts";
import {
  decodeRuntimeAuthorityProjectionV1,
  type RuntimeAuthorityProjectionV1,
} from "../../../../packages/runtime-authority/src/index.ts";
import {
  assertIssuedRuntimeObservationOwnerV1,
  type RuntimeObservationOwnerV1,
} from "../runtime-observation.ts";

export interface SearcherHeadSourceV1 {
  readonly next: (signal: AbortSignal) => Promise<CanonicalHead | null>;
}

export interface SearcherRuntimeApplicationCompositionInputV1<Simulation> {
  readonly strategyRuntime: SearcherStrategyRuntimeServiceV1;
  readonly runtimeAuthority: RuntimeAuthorityProjectionV1;
  readonly economicSafety: EconomicSafetyFinalizationServiceV1;
  /** Candidate-owned canonical/Reth source bundle; deployment cannot replace its parts. */
  readonly source: RethSearcherRuntimeSourceV1;
  readonly coreInput: Omit<SearchRuntimeCoreInputV1, "familyRuntime" | "sourceRead">;
  readonly finalSimulationFactory: QualifiedFinalSimulationPortFactoryV1<Simulation>;
  /** Owner-issued observation of exact Producer facts. */
  readonly evidence: RuntimeObservationOwnerV1;
}

export interface SearcherRuntimeApplicationV1 {
  readonly run: (signal?: AbortSignal) => Promise<void>;
  readonly submitHead: (head: CanonicalHead, signal?: AbortSignal) => Promise<ProducerSubmissionResultV1 | null>;
  readonly readFinalDurableProducerTerminal: () => ProducerHeadTerminalCapabilityV1;
  readonly waitForIdle: () => Promise<void>;
  readonly telemetry: () => ProducerRuntimeTelemetryV1;
  readonly stop: () => Promise<void>;
  readonly done: Promise<void>;
}

const issuedApplications = new WeakSet<object>();
const issuedOwners = new WeakSet<object>();
const claimedStartups = new WeakSet<object>();

function sameHead(left: CanonicalHead, right: CanonicalHead): boolean {
  return left.chainId === right.chainId
    && left.number === right.number
    && left.hash === right.hash
    && left.parentHash === right.parentHash
    && left.stateRoot === right.stateRoot;
}

/**
 * Assemble the one static application owner.  The deployment bundle carries
 * this owner, never a runner callback or a raw ingress token.  `open()` is
 * the only place that invokes createReleaseSearcherProducer and binds it to
 * the exact StartupRuntime returned by release bootstrap.
 */
export function issueSearcherRuntimeApplicationOwnerV1<Simulation>(
  input: SearcherRuntimeApplicationCompositionInputV1<Simulation>,
): SearcherRuntimeApplicationOwnerV1 {
  if (input === null || typeof input !== "object") throw new TypeError("searcher application composition is required");
  const inputKeys = [
    "strategyRuntime", "runtimeAuthority", "economicSafety", "coreInput",
    "finalSimulationFactory", "evidence", "source",
  ];
  assertExactKeys(input, inputKeys, "searcherApplication");
  assertIssuedSearcherStrategyRuntimeServiceV1(input.strategyRuntime);
  const expectedRuntimeAuthority = decodeRuntimeAuthorityProjectionV1(input.runtimeAuthority);
  assertIssuedEconomicSafetyFinalizationServiceV1(input.economicSafety);
  const economicSafetyBinding = input.economicSafety.binding();
  if (economicSafetyBinding.runtimeAuthority.authorityBindingHash !== expectedRuntimeAuthority.authorityBindingHash
    || economicSafetyBinding.runtimeAuthority.implementationCommit !== expectedRuntimeAuthority.implementationCommit) {
    throw new TypeError("searcher application economic-safety runtime authority mismatch");
  }
  assertIssuedQualifiedFinalSimulationPortFactory(input.finalSimulationFactory);
  assertIssuedRuntimeObservationOwnerV1(input.evidence);
  assertIssuedRethSearcherRuntimeSourceV1(input.source);
  if (input.coreInput === null || typeof input.coreInput !== "object") throw new TypeError("searcher core input is required");
  if (typeof input.coreInput.amountSeed !== "object" || input.coreInput.amountSeed === null) {
    throw new TypeError("searcher core amount seed is required");
  }
  if (typeof input.coreInput.execution !== "object" || input.coreInput.execution === null) {
    throw new TypeError("searcher core execution context is required");
  }
  const owner: SearcherRuntimeApplicationOwnerV1 = Object.freeze({
    open(startup: StartupRuntimeV1): SearcherRuntimeApplicationV1 {
      assertIssuedStartupRuntime(startup);
      if (claimedStartups.has(startup)) throw new TypeError("searcher startup is already bound to an application");
      if (startup.runtimeAuthority.authorityBindingHash !== expectedRuntimeAuthority.authorityBindingHash
        || startup.runtimeAuthority.implementationCommit !== expectedRuntimeAuthority.implementationCommit
        || startup.canonicalSourceAuthority !== input.source.canonicalAuthority) {
        throw new TypeError("searcher application startup authority mismatch");
      }
      claimedStartups.add(startup);
      const evidence = input.evidence.bindServing(startup);
      const producer = createReleaseSearcherProducer({
        startup,
        strategyRuntime: input.strategyRuntime,
        source: input.source,
        coreInput: input.coreInput,
        finalSimulationFactory: input.finalSimulationFactory,
        economicSafety: input.economicSafety,
        evidence,
      });
      let runPromise: Promise<void> | null = null;
      let stopPromise: Promise<void> | null = null;
      let latestSubmitted: Readonly<{ readonly head: CanonicalHead; readonly revision: string }> | null = null;
      let phase: "ready" | "producing" | "stopping" | "stopped" = "ready";

      const closeApplication = async (): Promise<void> => {
        if (stopPromise !== null) return stopPromise;
        phase = "stopping";
        stopPromise = (async () => {
          await producer.shutdown();
          await startup.close();
          input.source.close();
          input.evidence.close();
          phase = "stopped";
        })();
        return stopPromise;
      };

      const application: SearcherRuntimeApplicationV1 = {
        waitForIdle: () => producer.waitForIdle(),
        telemetry: () => producer.telemetry(),
        readFinalDurableProducerTerminal() {
          const terminal = producer.terminals().at(-1);
          if (terminal === undefined) throw new TypeError("Producer has no durable terminal");
          return terminal;
        },
        async submitHead(head: CanonicalHead, signal = new AbortController().signal) {
          if (phase !== "ready" && phase !== "producing") {
            throw new TypeError("producer admission is closed");
          }
          const sameHeightReplacement = latestSubmitted !== null
            && latestSubmitted.head.chainId === head.chainId
            && latestSubmitted.head.number === head.number
            && !sameHead(latestSubmitted.head, head);
          if (sameHeightReplacement) {
            await producer.invalidateHead(latestSubmitted!.head, "same_height_reorg");
            await producer.waitForIdle();
          }
          const revision = sameHeightReplacement ? (BigInt(latestSubmitted!.revision) + 1n).toString() : "0";
          const envelope = await input.source.ingress.observe({ head, signal });
          if (envelope === null) return null;
          if (!sameHead(envelope.head, head)) throw new TypeError("searcher ingress head changed during observation");
          const result = await producer.submit({ ...(envelope as ProducerHeadInputV1), revision });
          if (result.accepted) latestSubmitted = Object.freeze({ head, revision });
          return result;
        },
        async run(signal = new AbortController().signal) {
          if (runPromise !== null) return runPromise;
          runPromise = (async () => {
            phase = "producing";
            while (!signal.aborted) {
              const head = await input.source.headSource.next(signal);
              if (head === null) break;
              await application.submitHead(head, signal);
              await producer.waitForIdle();
            }
            await producer.waitForIdle();
          })();
          return runPromise;
        },
        async stop() {
          return closeApplication();
        },
        get done() {
          if (runPromise === null) {
            void application.run();
          }
          return runPromise!;
        },
      };
      issuedApplications.add(application);
      return application;
    },
  });
  issuedOwners.add(owner);
  return owner;
}

export interface SearcherRuntimeApplicationOwnerV1 {
  readonly open: (startup: StartupRuntimeV1) => SearcherRuntimeApplicationV1;
}

export function assertIssuedSearcherRuntimeApplicationV1(
  value: unknown,
): asserts value is SearcherRuntimeApplicationV1 {
  if (value === null || typeof value !== "object" || !issuedApplications.has(value)) {
    throw new TypeError("searcher runtime application is not owner-issued");
  }
}

export function assertIssuedSearcherRuntimeApplicationOwnerV1(
  value: unknown,
): asserts value is SearcherRuntimeApplicationOwnerV1 {
  if (value === null || typeof value !== "object" || !issuedOwners.has(value)) {
    throw new TypeError("searcher runtime application owner is not owner-issued");
  }
}
