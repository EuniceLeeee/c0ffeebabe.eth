import {
  decodeCanonicalJson,
  encodeCanonicalJson,
  assertExactKeys,
} from "../../../packages/canonical-codec/src/index.ts";
import {
  assertDispatchRequestShape,
  hashAuthorityBinding,
  hashExecutionReceipt,
  hashFrozenProgram,
  hashProgramInput,
  type RevmCallerBinding,
  type RevmSourceAnchor,
  type RevmWorkerResponseV1,
  type RevmWorkerDispatchRequestV1,
  type RevmWorkerSimulateRequestV1,
  type FrozenProgramWire,
  type RevmWorkerResultV1,
  type RevmWorkerAuthorityBindingV1,
} from "./protocol.ts";
import { sameEffectTransportDeclaration, type EffectTransportDeclarationV1 } from "../../../packages/execution-program/src/index.ts";
import {
  RevmWorkerLifecycleError,
  RevmWorkerPool,
  type RevmWorkerPoolSnapshot,
} from "./lifecycle.ts";

export * from "./protocol.ts";
export * from "./lifecycle.ts";

export interface RevmSimulationRequest {
  readonly requestId: string;
  readonly ownerRef: string;
  readonly generationId: string;
  readonly attemptId: string;
  readonly source: RevmSourceAnchor;
  readonly caller: RevmCallerBinding;
  readonly observeAccounts: readonly string[];
  readonly program: FrozenProgramWire;
  readonly input: RevmWorkerSimulateRequestV1["input"];
  readonly deadlineAtMs: number;
  readonly signal?: AbortSignal;
}

export interface RevmSimulationReceipt {
  readonly kind: "revm-simulation-receipt-v1";
  readonly requestId: string;
  readonly workerEpoch: string;
  readonly ownerRef: string;
  readonly generationId: string;
  readonly attemptId: string;
  readonly authority: RevmWorkerAuthorityBindingV1;
  readonly inputHash: string;
  readonly deadlineAtMs: number;
  readonly engine: "revm";
  readonly engineBuildFingerprint: string;
  readonly source: RevmSourceAnchor;
  readonly caller: RevmCallerBinding;
  readonly observeAccounts: readonly string[];
  readonly programHash: string;
  readonly status: "returned" | "reverted";
  readonly output: string;
  readonly effects: RevmWorkerResultV1["effects"];
  readonly effectTransport?: EffectTransportDeclarationV1;
  readonly executionReceiptHash: string;
}

export type RevmSimulationFailureCode = "worker-unavailable" | "timeout" | "deadline" | "retired" | "invalid-response" | "source-stale" | "caller-mismatch" | "observe-scope-mismatch" | "program-mismatch" | "owner-mismatch" | "generation-mismatch" | "attempt-mismatch" | "worker-error";

export class RevmSimulationError extends Error {
  readonly code: RevmSimulationFailureCode;
  readonly requestId: string;

  constructor(input: { readonly code: RevmSimulationFailureCode; readonly requestId: string; readonly message: string }) {
    super(input.message);
    this.name = "RevmSimulationError";
    this.code = input.code;
    this.requestId = input.requestId;
  }
}

export interface RevmSimulationClientOptions {
  /** The release bootstrap may expose a narrow, authority-guarded pool port. */
  readonly pool?: Pick<RevmWorkerPool, "submit" | "snapshot">;
}

function equalSource(left: RevmSourceAnchor, right: RevmSourceAnchor): boolean {
  return left.chainId === right.chainId && left.number === right.number && left.hash === right.hash && left.stateRoot === right.stateRoot;
}

function equalCaller(left: RevmCallerBinding, right: RevmCallerBinding): boolean {
  const leftActors = Object.entries(left.verifiedActors ?? {}).sort(([a], [b]) => a.localeCompare(b));
  const rightActors = Object.entries(right.verifiedActors ?? {}).sort(([a], [b]) => a.localeCompare(b));
  return left.address === right.address && left.mode === right.mode && left.observedSender === right.observedSender && JSON.stringify(leftActors) === JSON.stringify(rightActors);
}

function equalAccounts(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((item, index) => item === right[index]);
}

function rejectGlobalEip3607(input: RevmSimulationRequest): void {
  if (Object.prototype.hasOwnProperty.call(input, "disable_eip3607") || Object.prototype.hasOwnProperty.call(input, "disableEip3607")) {
    throw new RevmSimulationError({ code: "caller-mismatch", requestId: input.requestId, message: "global EIP-3607 disable is forbidden" });
  }
}

function requestEnvelope(input: RevmSimulationRequest): RevmWorkerDispatchRequestV1 {
  const keys = [
    "requestId", "ownerRef", "generationId", "attemptId", "source", "caller",
    "observeAccounts", "program", "input", "deadlineAtMs",
    ...(Object.prototype.hasOwnProperty.call(input, "signal") ? ["signal"] : []),
  ];
  assertExactKeys(input, keys);
  const canonicalInput = decodeCanonicalJson(encodeCanonicalJson(input.input));
  const source = decodeCanonicalJson(encodeCanonicalJson(input.source)) as unknown as RevmSourceAnchor;
  const caller = decodeCanonicalJson(encodeCanonicalJson(input.caller)) as unknown as RevmCallerBinding;
  const observeAccounts = Object.freeze([...input.observeAccounts]);
  const program = decodeCanonicalJson(encodeCanonicalJson(input.program)) as unknown as FrozenProgramWire;
  const request: RevmWorkerDispatchRequestV1 = Object.freeze({
    wireVersion: 1,
    kind: "request",
    op: "simulate",
    requestId: input.requestId,
    ownerRef: input.ownerRef,
    generationId: input.generationId,
    attemptId: input.attemptId,
    source,
    caller,
    observeAccounts,
    program,
    input: canonicalInput,
    inputHash: hashProgramInput(canonicalInput),
    deadlineAtMs: input.deadlineAtMs,
  });
  assertDispatchRequestShape(request);
  return request;
}

function mapLifecycleError(error: RevmWorkerLifecycleError): RevmSimulationFailureCode {
  if (error.code === "deadline") return "deadline";
  if (error.code === "timeout") return "timeout";
  if (error.code === "retired" || error.code === "not-ready" || error.code === "busy") return "retired";
  if (error.code === "invalid-response") return "invalid-response";
  if (error.code === "invalid-request") return "program-mismatch";
  if (error.code === "resource-limit" || error.code === "queue-full") return "worker-unavailable";
  return "worker-error";
}

/**
 * Fail-closed client boundary for real REVM workers.  There is no fallback
 * evaluator, fixture response, or guessed EVM result in this class.
 */
export class RevmSimulationClient {
  private readonly pool?: Pick<RevmWorkerPool, "submit" | "snapshot">;

  constructor(options: RevmSimulationClientOptions = {}) {
    this.pool = options.pool;
  }

  async simulate(input: RevmSimulationRequest): Promise<RevmSimulationReceipt> {
    rejectGlobalEip3607(input);
    let dispatch: RevmWorkerDispatchRequestV1;
    try {
      dispatch = requestEnvelope(input);
    } catch (error) {
      throw new RevmSimulationError({ code: "program-mismatch", requestId: input.requestId, message: error instanceof Error ? error.message : String(error) });
    }
    if (!this.pool) throw new RevmSimulationError({ code: "worker-unavailable", requestId: input.requestId, message: "no qualified REVM worker pool is configured" });
    let response: RevmWorkerResponseV1;
    let request: RevmWorkerSimulateRequestV1;
    try {
      const execution = await this.pool.submit(dispatch, input.signal);
      request = execution.request;
      response = execution.response;
    } catch (error) {
      if (error instanceof RevmWorkerLifecycleError) {
        throw new RevmSimulationError({ code: mapLifecycleError(error), requestId: input.requestId, message: error.message });
      }
      throw new RevmSimulationError({ code: "worker-error", requestId: input.requestId, message: error instanceof Error ? error.message : String(error) });
    }
    if (response.kind === "error") {
      throw new RevmSimulationError({ code: response.code === "timeout" ? "timeout" : response.code === "retired" ? "retired" : response.code === "source-stale" ? "source-stale" : response.code === "invalid-response" ? "invalid-response" : "worker-error", requestId: input.requestId, message: response.message });
    }
    this.assertResponse(request, response);
    return Object.freeze({
      kind: "revm-simulation-receipt-v1",
      requestId: response.requestId,
      workerEpoch: response.workerEpoch,
      ownerRef: response.ownerRef,
      generationId: response.generationId,
      attemptId: response.attemptId,
      authority: response.authority,
      inputHash: response.inputHash,
      deadlineAtMs: response.deadlineAtMs,
      engine: "revm",
      engineBuildFingerprint: response.engineBuildFingerprint,
      source: Object.freeze({ ...response.source }),
      caller: Object.freeze({ ...response.caller, verifiedActors: Object.freeze({ ...response.caller.verifiedActors }) }),
      observeAccounts: Object.freeze([...response.observeAccounts]),
      programHash: response.programHash,
      status: response.status,
      output: response.output,
      effects: Object.freeze({ ...response.effects, observedAccounts: Object.freeze([...response.effects.observedAccounts]) }),
      ...(response.effectTransport === undefined ? {} : { effectTransport: response.effectTransport }),
      executionReceiptHash: response.executionReceiptHash,
    });
  }

  snapshot(): RevmWorkerPoolSnapshot | null {
    return this.pool?.snapshot() ?? null;
  }

  private assertResponse(request: RevmWorkerSimulateRequestV1, response: RevmWorkerResultV1): void {
    if (response.requestId !== request.requestId) throw new RevmSimulationError({ code: "invalid-response", requestId: request.requestId, message: "REVM response request id mismatch" });
    if (response.ownerRef !== request.ownerRef) throw new RevmSimulationError({ code: "owner-mismatch", requestId: request.requestId, message: "REVM response owner binding mismatch" });
    if (response.generationId !== request.generationId) throw new RevmSimulationError({ code: "generation-mismatch", requestId: request.requestId, message: "REVM response generation binding mismatch" });
    if (response.attemptId !== request.attemptId) throw new RevmSimulationError({ code: "attempt-mismatch", requestId: request.requestId, message: "REVM response attempt binding mismatch" });
    if (hashAuthorityBinding(response.authority) !== hashAuthorityBinding(request.authority)) throw new RevmSimulationError({ code: "invalid-response", requestId: request.requestId, message: "REVM response authority binding mismatch" });
    if (response.inputHash !== request.inputHash) throw new RevmSimulationError({ code: "program-mismatch", requestId: request.requestId, message: "REVM response input binding mismatch" });
    if (response.deadlineAtMs !== request.deadlineAtMs) throw new RevmSimulationError({ code: "invalid-response", requestId: request.requestId, message: "REVM response deadline binding mismatch" });
    if (!equalSource(response.source, request.source)) throw new RevmSimulationError({ code: "source-stale", requestId: request.requestId, message: "REVM response source does not match current source" });
    if (!equalCaller(response.caller, request.caller)) throw new RevmSimulationError({ code: "caller-mismatch", requestId: request.requestId, message: "REVM response caller binding mismatch" });
    if (!equalAccounts(response.observeAccounts, request.observeAccounts)) throw new RevmSimulationError({ code: "observe-scope-mismatch", requestId: request.requestId, message: "REVM response observe-account scope mismatch" });
    if (!equalAccounts(response.effects.observedAccounts, request.observeAccounts)) throw new RevmSimulationError({ code: "observe-scope-mismatch", requestId: request.requestId, message: "REVM effects observe-account scope mismatch" });
    if (!sameEffectTransportDeclaration(response.effectTransport, request.program.effectTransport)) throw new RevmSimulationError({ code: "program-mismatch", requestId: request.requestId, message: "REVM response effect transport declaration mismatch" });
    if (response.programHash !== request.program.programHash || response.programHash !== hashFrozenProgram(request.program)) throw new RevmSimulationError({ code: "program-mismatch", requestId: request.requestId, message: "REVM response program hash mismatch" });
    if (response.workerEpoch !== request.workerEpoch) throw new RevmSimulationError({ code: "invalid-response", requestId: request.requestId, message: "REVM response worker epoch mismatch" });
    if (response.executionReceiptHash !== hashExecutionReceipt(response)) throw new RevmSimulationError({ code: "invalid-response", requestId: request.requestId, message: "REVM execution receipt hash mismatch" });
  }
}

export function createFailClosedRevmClient(): RevmSimulationClient {
  return new RevmSimulationClient();
}
