import type { RevmFatalReason } from "./revm-sim-client.js";

export type RevmFaultStage = "client-daemon" | "client-attestation" | "client-response"
  | "client-retired-daemon" | "client-retired-response" | "transport-operation"
  | "transport-lease-pin" | "transport-pin-changed" | "transport-response"
  | "transport-attestation" | "transport-attestation-shape" | "rebuild-candidate";

/** Observational only: no remote messages, request/response objects or endpoints.
 * Never let diagnostics change the caller's failure/retirement behavior. */
export function logRevmFault(stage: RevmFaultStage, reason: RevmFatalReason, context: {
  readonly daemonPid?: number;
  readonly requestId?: string;
  readonly candidateKey?: string;
  readonly blockNumber?: number;
} = {}): void {
  try {
    const kind = ["source-fault", "protocol-fault", "rpc-throttle"].includes(reason.kind) ? reason.kind : "unknown";
    console.error("[revm-fault] " + JSON.stringify({ schemaVersion: 1, stage, kind,
      timeUnixMs: Date.now(), pid: process.pid,
      ...(Number.isSafeInteger(context.daemonPid) && context.daemonPid! > 0 ? { daemonPid: context.daemonPid } : {}),
      ...(typeof context.requestId === "string" && /^[1-9][0-9]{0,19}$/.test(context.requestId) ? { requestId: context.requestId } : {}),
      ...(typeof context.candidateKey === "string" && /^[0-9a-f]{64}$/.test(context.candidateKey) ? { candidateKey: context.candidateKey } : {}),
      ...(Number.isSafeInteger(context.blockNumber) && context.blockNumber! >= 0 ? { blockNumber: context.blockNumber } : {}),
      ...(reason.kind === "rpc-throttle" ? {
        ...(["http429", "rpc-limit-code", "rpc-rate-limit", "rpc-quota"].includes(reason.category) ? { category: reason.category } : {}),
        ...(reason.httpStatus === 429 ? { httpStatus: 429 } : {}),
        ...(Number.isSafeInteger(reason.rpcCode) ? { rpcCode: reason.rpcCode } : {}),
      } : {}),
    }));
  } catch { /* Logging is never an authority or an execution gate. */ }
}
