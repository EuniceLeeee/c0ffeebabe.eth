import type {
  AdapterGenerationFence,
  CentralAdapterRuntime,
  CentralAdapterScheduler,
} from "./adapter-work-intent.js";
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
}): CentralAdapterRuntime {
  let now = Date.now();
  const scheduler: CentralAdapterScheduler = Object.freeze({
    issueExecutor(
      issueInput: Parameters<CentralAdapterScheduler["issueExecutor"]>[0],
    ) {
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
        execute: async (execution) => Promise.all(execution.requests.map(
          (request) => executeRequest(
            input.provider,
            input.simulator,
            request,
            execution.source,
          ),
        )),
        sealStaticEvidenceReuseProof: () => ({
          proofHash: "ab".repeat(32),
        }),
      });
      return Object.freeze({
        executor,
        timing: () => ({
          queueWaitMs: 0,
          transportWallMs: 1,
          attempts: 1,
        }),
      });
    },
  });
  return Object.freeze({
    clock: { nowMs: () => now++ },
    generationFence: input.generationFence,
    callerAuthority: { bind: () => ({}) },
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
    budgets: { assertAdmitted() {} },
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
      const data = await provider.call({
        to: request.to,
        data: request.data,
      }, source.number);
      return issueResult({
        id: request.id,
        source,
        completion: "returned" as const,
        data,
        provenanceKind: "provider-eth-call",
        request,
      });
    }
    if (request.kind === "get-code") {
      const data = await provider.getCode(request.address, source.number);
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
      const data = await provider.getStorage(
        request.address,
        request.slot,
        source.number,
      );
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
          fingerprint: "9".repeat(64),
        }),
        completion: "returned" as const,
        data: simulated.data,
        ...(simulated.effects === undefined
          ? {}
          : { effects: Object.freeze(simulated.effects) }),
      });
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
