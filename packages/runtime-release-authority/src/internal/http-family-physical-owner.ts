import {
  assertExactKeys,
  assertHash,
  assertNonEmptyString,
  type CanonicalJson,
  type Hash,
} from "../../../../packages/canonical-codec/src/index.ts";
import type {
  FamilyPhysicalRpcCompletionV1,
  FamilyPhysicalRpcPortV1,
  FamilyPhysicalRpcRequestV1,
  FamilyRuntimeStageV1,
} from "../../../../packages/family-sdk/runtime/index.ts";
import {
  executeGeneratedFamilyPhysicalLifecycle,
  readGeneratedFamilyRuntimeFactoryMetadata,
} from "../../../../packages/family-composition/src/internal/generated-runtime-composition.ts";
import {
  createReleaseFamilyRuntimeComposition,
} from "../../../../generated/runtime-composition/index.ts";
import type {
  QualifiedExecutorAuthorityCapability,
  QualifiedExecutorAuthorityIssuer,
} from "../../../../packages/scheduler/src/index.ts";
import type {
  QualifiedSharedSchedulerRuntimePortV1,
} from "../../../../packages/scheduler/src/internal/shared-runtime-owner.ts";
import {
  issueQualifiedPhysicalExecutionPort,
} from "../../../../packages/work-plane/src/internal/family-execution-port.ts";
import type {
  CapabilityWorkIntentV1,
  QualifiedPhysicalExecutionPortV1,
} from "../../../../packages/work-plane/src/index.ts";

const PHYSICAL_STAGES = new Set<FamilyRuntimeStageV1>([
  "nomination",
  "identity",
  "materialization",
  "projection",
  "rehydration",
]);

type RecordValue = Record<string, unknown>;

function record(value: unknown, path: string): RecordValue {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${path} must be an object`);
  }
  return value as RecordValue;
}

function normalizeEndpoint(value: string): string {
  let endpoint: URL;
  try { endpoint = new URL(value); } catch { throw new TypeError("Family physical endpoint must be a URL"); }
  if (endpoint.protocol !== "http:" && endpoint.protocol !== "https:") {
    throw new TypeError("Family physical endpoint must use HTTP(S)");
  }
  return endpoint.href;
}

function canonicalHex(value: unknown): value is string {
  return typeof value === "string" && /^0x(?:[0-9a-f]{2})*$/.test(value);
}

function executionRevertData(error: RecordValue): string | null {
  if (canonicalHex(error.data)) return error.data;
  return typeof error.message === "string" && error.message.toLowerCase().includes("revert")
    ? "0x"
    : null;
}

function assertRequestAtSource(request: FamilyPhysicalRpcRequestV1, sourceHash: Hash): void {
  assertExactKeys(request, ["requestId", "method", "params"], "familyPhysical.request");
  assertHash(request.requestId, "familyPhysical.request.requestId");
  if (request.method !== "eth_call" && request.method !== "eth_getCode") {
    throw new TypeError("Family physical RPC method is not allowed");
  }
  if (!Array.isArray(request.params) || request.params.length !== 2) {
    throw new TypeError("Family physical RPC params must contain an exact source selector");
  }
  const selector = record(request.params[1], "familyPhysical.request.params[1]");
  assertExactKeys(selector, ["blockHash", "requireCanonical"], "familyPhysical.request.params[1]");
  if (assertHash(selector.blockHash, "familyPhysical.request.params[1].blockHash") !== sourceHash
    || selector.requireCanonical !== true) {
    throw new TypeError("Family physical RPC source selector mismatch");
  }
}

function rpcPort(endpoint: string, timeoutMs: number, sourceHash: Hash): FamilyPhysicalRpcPortV1 {
  return Object.freeze({
    async request(
      input: FamilyPhysicalRpcRequestV1,
      signal: AbortSignal,
    ): Promise<FamilyPhysicalRpcCompletionV1> {
      assertRequestAtSource(input, sourceHash);
      if (signal.aborted) return Object.freeze({ kind: "transportFailure", failureCode: "abort" });
      const controller = new AbortController();
      let deadline = false;
      const abort = () => controller.abort(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
      const timer = setTimeout(() => {
        deadline = true;
        controller.abort(new Error("Family physical RPC deadline"));
      }, timeoutMs);
      try {
        for (let attempt = 0; attempt < 2; attempt += 1) {
          try {
            const response = await fetch(endpoint, {
              method: "POST",
              headers: Object.freeze({ "content-type": "application/json" }),
              body: JSON.stringify(Object.freeze({
                jsonrpc: "2.0",
                id: input.requestId,
                method: input.method,
                params: input.params,
              })),
              signal: controller.signal,
            });
            let completion: FamilyPhysicalRpcCompletionV1;
            if (!response.ok) {
              completion = Object.freeze({ kind: "transportFailure", failureCode: "rpc" });
            } else {
              const value = record(await response.json(), "familyPhysical.response");
              if (value.jsonrpc !== "2.0" || value.id !== input.requestId) {
                completion = Object.freeze({ kind: "transportFailure", failureCode: "rpc" });
              } else {
                const hasResult = Object.prototype.hasOwnProperty.call(value, "result");
                const hasError = Object.prototype.hasOwnProperty.call(value, "error");
                if (hasResult === hasError) {
                  completion = Object.freeze({ kind: "transportFailure", failureCode: "rpc" });
                } else if (hasResult) {
                  completion = canonicalHex(value.result)
                    ? Object.freeze({ kind: "returned", dataHex: value.result })
                    : Object.freeze({ kind: "transportFailure", failureCode: "rpc" });
                } else {
                  const error = record(value.error, "familyPhysical.response.error");
                  const revertData = executionRevertData(error);
                  completion = revertData !== null
                    ? Object.freeze({ kind: "reverted", dataHex: revertData })
                    : Object.freeze({ kind: "transportFailure", failureCode: "rpc" });
                }
              }
            }
            if (completion.kind !== "transportFailure" || completion.failureCode !== "rpc" || attempt === 1) {
              return completion;
            }
          } catch {
            if (signal.aborted || deadline || attempt === 1) {
              return Object.freeze({
                kind: "transportFailure",
                failureCode: signal.aborted ? "abort" : deadline ? "deadline" : "rpc",
              });
            }
          }
        }
        return Object.freeze({ kind: "transportFailure", failureCode: "rpc" });
      } finally {
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
      }
    },
  });
}

function exactProgramRoute(intent: CapabilityWorkIntentV1) {
  const ref = record(intent.programInputRef, "familyPhysical.programInputRef");
  assertExactKeys(ref, [
    "recordHash",
    "familyId",
    "familyDefinitionHash",
    "familyCandidateKey",
  ], "familyPhysical.programInputRef");
  const recordHash = assertHash(ref.recordHash, "familyPhysical.programInputRef.recordHash");
  const familyId = assertNonEmptyString(ref.familyId, "familyPhysical.programInputRef.familyId");
  const familyDefinitionHash = assertHash(
    ref.familyDefinitionHash,
    "familyPhysical.programInputRef.familyDefinitionHash",
  );
  assertNonEmptyString(ref.familyCandidateKey, "familyPhysical.programInputRef.familyCandidateKey");
  if (typeof intent.ownerRef !== "string"
    || typeof intent.capabilityRef !== "string"
    || typeof intent.workClassRef !== "string"
    || typeof intent.frozenProgramRef.issuerRef !== "string"
    || intent.capabilityRef !== intent.workClassRef
    || intent.ownerRef !== intent.frozenProgramRef.issuerRef
    || intent.frozenProgramRef.ref !== recordHash) {
    throw new TypeError("Family physical intent reference binding mismatch");
  }
  if (!PHYSICAL_STAGES.has(intent.phase as FamilyRuntimeStageV1)) {
    throw new TypeError("Family physical lifecycle stage is invalid");
  }
  const stage = intent.phase as FamilyRuntimeStageV1;
  const family = readGeneratedFamilyRuntimeFactoryMetadata(createReleaseFamilyRuntimeComposition)
    .families.find(entry => entry.familyId === familyId && entry.familyDefinitionHash === familyDefinitionHash);
  if (family === undefined) throw new TypeError("Family physical lifecycle is not generated");
  const stageRef = family.lifecycleRefs[stage];
  if (stageRef.ownerRef !== intent.ownerRef
    || stageRef.capabilityId !== intent.capabilityRef
    || stageRef.schemaHash !== intent.frozenProgramRef.schemaHash) {
    throw new TypeError("Family physical generated lifecycle binding mismatch");
  }
  return Object.freeze({ familyId, familyDefinitionHash, stage, stageRef });
}

/** Candidate-owned production physical transport. The caller supplies only
 * the already runtime-qualified endpoint and scheduler authority; generated
 * Family adapters retain all target, calldata and lifecycle semantics. */
export function issueRuntimeReleaseHttpFamilyPhysicalExecutionPortV1(input: Readonly<{
  readonly issuer: QualifiedExecutorAuthorityIssuer;
  readonly capability: QualifiedExecutorAuthorityCapability;
  readonly schedulerRuntime: QualifiedSharedSchedulerRuntimePortV1;
  readonly endpoint: string;
  readonly timeoutMs: number;
}>): QualifiedPhysicalExecutionPortV1<readonly unknown[]> {
  assertExactKeys(input, ["issuer", "capability", "schedulerRuntime", "endpoint", "timeoutMs"]);
  const endpoint = normalizeEndpoint(input.endpoint);
  if (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 1 || input.timeoutMs > 60_000) {
    throw new TypeError("Family physical timeoutMs must be an integer in [1, 60000]");
  }
  return issueQualifiedPhysicalExecutionPort({
    issuer: input.issuer,
    capability: input.capability,
    schedulerRuntime: input.schedulerRuntime,
    async execute({ intent, rawEvidence, signal }) {
      const route = exactProgramRoute(intent);
      const sourceHash = assertHash(intent.source.hash, "familyPhysical.source.hash");
      return executeGeneratedFamilyPhysicalLifecycle(
        createReleaseFamilyRuntimeComposition,
        Object.freeze({
          stageRef: route.stageRef,
          execution: Object.freeze({
            familyId: route.familyId,
            familyDefinitionHash: route.familyDefinitionHash,
            stage: route.stage,
            source: Object.freeze({
              chainId: assertNonEmptyString(intent.source.chainId, "familyPhysical.source.chainId"),
              number: assertNonEmptyString(intent.source.number, "familyPhysical.source.number"),
              hash: sourceHash,
              stateRoot: assertHash(intent.source.stateRoot, "familyPhysical.source.stateRoot"),
            }),
            programInput: intent.programInput as CanonicalJson,
          }),
        }),
        Object.freeze({ rpc: rpcPort(endpoint, input.timeoutMs, sourceHash), rawEvidence }),
        signal,
      );
    },
  });
}
