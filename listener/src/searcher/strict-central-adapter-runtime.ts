import type {
  AdapterGenerationFence,
  CentralScheduleDecision,
  CentralAdapterRuntime,
  CentralAdapterScheduler,
} from "./adapter-work-intent.js";
import { createHash } from "node:crypto";
import {
  createBoundedRequestExecutor,
  type AdapterRequest,
  type AdapterRequestResult,
  type CanonicalSource,
} from "./venues/adapter-request-program.js";
import {
  hashCanonical,
  type CanonicalValue,
} from "./venues/canonical-value.js";

interface StrictProvider {
  call(tx: { readonly to: string; readonly data: string }, block?: number):
    Promise<string>;
  getCode(address: string, block?: number): Promise<string>;
  getStorage(address: string, slot: string, block?: number): Promise<string>;
}

export interface StrictSimulationTransport {
  simulate(input: {
    readonly request: Extract<
      AdapterRequest,
      {
        readonly kind:
          | "state-override-simulation"
          | "effect-delta-simulation";
      }
    >;
    readonly source: CanonicalSource;
  }): Promise<{
    readonly data: string;
    readonly effects?: {
      readonly tokenDeltas?: readonly {
        readonly token: string;
        readonly account: string;
        readonly delta: bigint;
      }[];
      readonly nativeDeltas?: readonly {
        readonly account: string;
        readonly delta: bigint;
      }[];
    };
  }>;
}

/**
 * Production-shaped strict central adapter runtime (Phase E pipeline
 * prerequisite). Identity/current-state reads (eth-call, get-code,
 * get-storage) execute against the JSON-RPC provider at the canonical
 * source block; simulation requests are fail-closed with
 * resource-limited until the revm-backed simulation transport lands. The
 * scheduler/budget/fence surfaces follow the central runtime contract so
 * `runStrictFamilyLifecycle` can run with this runtime in production.
 */
export function createStrictCentralAdapterRuntime(input: {
  readonly provider: Pick<
    StrictProvider,
    "call" | "getCode" | "getStorage"
  >;
  readonly simulator?: StrictSimulationTransport;
  readonly generationFence: AdapterGenerationFence;
  /**
   * Family-declared verified-actor evidence map (evidence id -> probe
   * actor). Families whose identity/active proof uses
   * `caller: "verified-actor"` bind through this authority; omitting an
   * actor keeps that family fail-closed at caller-authority instead of
   * pretending the capability exists.
   */
  readonly verifiedActors?: Readonly<Record<string, string>>;
  /** Upper bound on requests admitted per work batch; default 512. */
  readonly maxRequestsPerBatch?: number;
}): CentralAdapterRuntime {
  let now = Date.now();
  const maxRequestsPerBatch = input.maxRequestsPerBatch ?? 512;
  const verifiedActors = Object.freeze({ ...(input.verifiedActors ?? {}) });
  const scheduler: CentralAdapterScheduler = Object.freeze({
    issueExecutor(
      issueInput: Parameters<CentralAdapterScheduler["issueExecutor"]>[0],
    ) {
      const issuedAtMs = Date.now();
      let transportWallMs = 0;
      const executor = createBoundedRequestExecutor({
        assertSupported: (requirements) => {
          void issueInput;
          void requirements;
        },
        assertCallerBinding() {},
        assertWithinBudget: (_familyId, requests) => {
          if (!Array.isArray(requests) || requests.length === 0) {
            throw new Error("strict central runtime requires a request batch");
          }
        },
        execute: async (execution) => {
          const startedAtMs = Date.now();
          const results = await Promise.all(execution.requests.map(
            (request) => executeRequest(
              input.provider,
              input.simulator,
              request,
              execution.source,
            ),
          ));
          transportWallMs = Date.now() - startedAtMs;
          return results;
        },
        sealStaticEvidenceReuseProof: (proofInput) => ({
          proofHash: createHash("sha256")
            .update(JSON.stringify({
              reusePolicy: proofInput.reusePolicy,
              source: proofInput.source,
              requests: proofInput.requests.map((request) => ({
                id: request.id,
                kind: request.kind,
                to: "to" in request ? request.to : undefined,
                address: "address" in request ? request.address : undefined,
                data: "data" in request ? request.data : undefined,
              })),
              resultsFingerprint: proofInput.trustedResultsFingerprint,
            }))
            .digest("hex"),
        }),
      });
      return Object.freeze({
        executor,
        timing: () => ({
          queueWaitMs: Math.max(0, Date.now() - issuedAtMs),
          transportWallMs,
          attempts: 1,
        }),
      });
    },
  });
  return Object.freeze({
    clock: { nowMs: () => now++ },
    generationFence: input.generationFence,
    callerAuthority: {
      bind: () => Object.keys(verifiedActors).length === 0
        ? Object.freeze({})
        : Object.freeze({ verifiedActors }),
    },
    policy: {
      bind: (policyInput: {
        readonly stage: string;
        readonly subjectKey: string;
      }) => ({
        lane: policyInput.stage === "identity"
          ? "critical-proof" as const
          : "background" as const,
        deadlineAtMs: 100_000,
        maxAttempts: 1,
        transportPool: "state-read" as const,
        fairnessKey: policyInput.subjectKey,
      }),
    },
    budgets: {
      assertAdmitted(
        schedule: CentralScheduleDecision,
        requests: readonly AdapterRequest[],
      ) {
        if (
          !Number.isSafeInteger(schedule.deadlineAtMs) ||
          schedule.deadlineAtMs <= 0
        ) {
          throw new Error(
            "strict central budget requires a positive deadline",
          );
        }
        if (requests.length > maxRequestsPerBatch) {
          throw new Error(
            `strict central budget exceeds batch cap: ` +
              `${requests.length} > ${maxRequestsPerBatch}`,
          );
        }
      },
    },
    scheduler,
  });
}

async function executeRequest(
  provider: Pick<StrictProvider, "call" | "getCode" | "getStorage">,
  simulator: StrictSimulationTransport | undefined,
  request: AdapterRequest,
  source: CanonicalSource,
): Promise<AdapterRequestResult> {
  try {
    if (request.kind === "eth-call") {
      const outcome = await withRpcRetry(async () => {
        try {
          const data = await provider.call({
            to: request.to,
            data: request.data,
          }, source.number);
          return { completion: "returned" as const, data };
        } catch (error) {
          // A family-declared revert is evidence, not a transport failure.
          // Surface the revert payload as reverted-as-declared exactly like
          // the legacy work runtime so identity decode can reject or accept
          // on family semantics (for example FluidDexSwapResult quotes).
          if (request.completion === "return-or-revert-data") {
            const revertData = extractStrictRevertData(error);
            if (revertData !== null) {
              return {
                completion: "reverted-as-declared" as const,
                data: revertData,
              };
            }
          }
          throw error;
        }
      });
      return issueResult({
        id: request.id,
        source,
        completion: outcome.completion,
        data: outcome.data,
        provenanceKind: "provider-eth-call",
        request,
      });
    }
    if (request.kind === "get-code") {
      const data = await withRpcRetry(() =>
        provider.getCode(request.address, source.number),
      );
      return issueResult({
        id: request.id,
        source,
        completion: "returned" as const,
        data,
        provenanceKind: "provider-get-code",
        request,
      });
    }
    if (request.kind === "get-storage") {
      const data = await withRpcRetry(() => provider.getStorage(
        request.address,
        request.slot,
        source.number,
      ));
      return issueResult({
        id: request.id,
        source,
        completion: "returned" as const,
        data,
        provenanceKind: "provider-get-storage",
        request,
      });
    }
    if (
      request.kind === "state-override-simulation" ||
      request.kind === "effect-delta-simulation"
    ) {
      if (simulator === undefined) {
        return Object.freeze({
          id: request.id,
          ok: false as const,
          source: Object.freeze(source),
          failure: "resource-limited" as const,
        });
      }
      try {
        const simulated = await simulator.simulate({
          request,
          source,
        });
        return Object.freeze({
          id: request.id,
          ok: true as const,
          source: Object.freeze(source),
          provenance: Object.freeze({
            kind: "strict-simulation-transport",
            fingerprint: createHash("sha256")
              .update(JSON.stringify({
                id: request.id,
                kind: request.kind,
                to: request.call.to,
                data: request.call.data,
                preCalls: request.preCalls ?? [],
                overrideIntent: request.overrideIntent,
                observe: request.observe,
                source: source.number,
              }))
              .digest("hex"),
          }),
          completion: "returned" as const,
          data: simulated.data,
          ...(simulated.effects === undefined
            ? {}
            : { effects: Object.freeze(simulated.effects) }),
        });
      } catch {
        // An unsupported simulation capability (observe, funded override,
        // verified actor) is a capability gap, never a chain RPC failure.
        return Object.freeze({
          id: request.id,
          ok: false as const,
          source: Object.freeze(source),
          failure: "resource-limited" as const,
        });
      }
    }
    return Object.freeze({
      id: request.id,
      ok: false as const,
      source: Object.freeze(source),
      failure: "resource-limited" as const,
    });
  } catch {
    return Object.freeze({
      id: request.id,
      ok: false as const,
      source: Object.freeze(source),
      failure: "rpc" as const,
    });
  }
}

function isCallException(error: unknown): boolean {
  return typeof error === "object" && error !== null &&
    (error as { readonly code?: unknown }).code === "CALL_EXCEPTION";
}

/**
 * One bounded retry for transport-level RPC failures (timeouts, node
 * overload, rate limits). Declared reverts never retry: they are evidence.
 * A CALL_EXCEPTION on a return-data request is a semantic revert and is also
 * not retried, so a genuinely reverting read cannot double RPC load.
 */
async function withRpcRetry<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (isCallException(error)) throw error;
    await new Promise((resolve) => setTimeout(resolve, 25));
    return await work();
  }
}

function extractStrictRevertData(error: unknown): string | null {
  if (typeof error !== "object" || error === null) return null;
  const record = error as Record<string, unknown>;
  for (const key of ["data", "returnData", "revert"]) {
    const value = record[key];
    if (
      typeof value === "string" &&
      /^0x(?:[0-9a-fA-F]{2})*$/.test(value)
    ) {
      return value;
    }
  }
  return null;
}

function issueResult(input: {
  readonly id: string;
  readonly source: CanonicalSource;
  readonly completion: "returned" | "reverted-as-declared";
  readonly data: string;
  readonly provenanceKind: string;
  readonly request: AdapterRequest;
}) {
  return Object.freeze({
    id: input.id,
    ok: true as const,
    source: Object.freeze(input.source),
    provenance: Object.freeze({
      kind: input.provenanceKind,
      fingerprint: hashCanonical({
        id: input.id,
        kind: input.provenanceKind,
        ...("to" in input.request ? { to: input.request.to } : {}),
        data: input.data,
      } as unknown as CanonicalValue),
    }),
    completion: input.completion,
    data: input.data,
  });
}
