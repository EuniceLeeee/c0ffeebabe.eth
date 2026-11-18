import { getAddress, MaxUint256 } from "ethers";
import { runtimeProgramScript } from "../adapters/runtime-amount-program.js";
import { buildSubscriptCalldata } from "../shared/executor/botvm-program-entry.js";
import type { AdapterRequest, AdapterRequestResult, CanonicalSource, TrustedTransportProvenance } from "./venues/adapter-request-program.js";
import { assertDeclarativeExecutionSource } from "./venues/declarative-execution.js";
import { buildObservedCallRuntimeProgram, buildObservedCallSimulation, decodeObservedCallSimulationReceipt } from "./venues/observed-call-runtime.js";
import { OBSERVED_CALL_MAX_AMOUNT, OBSERVED_CALL_MAX_CANDIDATES, validateObservedCallTemplate, type ObservedCallTemplate } from "./venues/observed-call-template.js";

export const OBSERVED_CALL_PROBE_POLICY = "observed-plus-quarter-double" as const;
export interface ObservedCallPositiveProbe {
  readonly amountIn: string;
  readonly amountOut: string;
  readonly requestId: string;
  readonly provenance: TrustedTransportProvenance;
}
export interface ObservedCallControlProbe {
  readonly kind: "zero-runtime-input" | "forced-output-minimum";
  readonly requestId: string;
  readonly completion: "reverted-as-declared";
  readonly provenance: TrustedTransportProvenance;
}
export interface ObservedCallCandidateProbe {
  readonly templateHash: string;
  readonly status: "accepted" | "rejected" | "unresolved" | "unsupported";
  readonly reason?: string;
  readonly positiveProbes: readonly ObservedCallPositiveProbe[];
  readonly controls: readonly ObservedCallControlProbe[];
}
interface ProbeReport {
  readonly probePolicy: typeof OBSERVED_CALL_PROBE_POLICY;
  readonly candidates: readonly ObservedCallCandidateProbe[];
}
export type ObservedCallProbeResult =
  | ProbeReport & {
      /** Probe acceptance only: the existing identity, source and Ready gates
       * must independently admit the resulting Family-owned definition. */
      readonly status: "accepted";
      readonly template: ObservedCallTemplate;
      readonly source: CanonicalSource;
      readonly executor: string;
      /** A tested envelope, not proof of every intermediate amount. Every
       * production quote still executes its actual amount at its own source. */
      readonly amountBounds: { readonly minimum: string; readonly maximum: string };
      readonly positiveProbes: readonly ObservedCallPositiveProbe[];
      readonly controls: readonly ObservedCallControlProbe[];
    }
  | ProbeReport & {
      readonly status: "ambiguous" | "unresolved" | "unsupported" | "rejected";
      readonly reason: string;
    };

export interface ObservedCallProbeInput {
  readonly templates: readonly ObservedCallTemplate[];
  readonly executor: string;
  readonly source: CanonicalSource;
  readonly protectedTokens?: readonly string[];
  /** The issuer owns chain, source, executor authority and isolation. A fresh
   * isolated simulation is required for every request, including controls. */
  readonly execute: (request: AdapterRequest) => Promise<AdapterRequestResult>;
}

type ObservedReceipt = Extract<AdapterRequestResult, { readonly ok: true }>;
type SimulationRequest = Extract<AdapterRequest, { readonly kind: "effect-delta-simulation" | "state-override-simulation" }>;
function sameSource(left: CanonicalSource | undefined, right: CanonicalSource): boolean {
  return !!left && left.number === right.number && left.generation === right.generation &&
    typeof left.hash === "string" && left.hash.toLowerCase() === right.hash.toLowerCase();
}
function observation(result: AdapterRequestResult, request: AdapterRequest, source: CanonicalSource):
  { readonly ok: true; readonly receipt: ObservedReceipt } | { readonly ok: false; readonly reason: string } {
  if (!result || typeof result !== "object" || result.id !== request.id || !sameSource(result.source, source))
    return { ok: false, reason: "receipt-request-or-source-mismatch" };
  if (!result.ok) return { ok: false, reason: "simulation-transport-unresolved" };
  if (!["returned", "reverted-as-declared"].includes(result.completion) || typeof result.data !== "string" ||
      !/^0x(?:[0-9a-fA-F]{2})*$/.test(result.data) ||
      !result.provenance || typeof result.provenance.kind !== "string" || !result.provenance.kind.trim() ||
      result.provenance.kind.trim() !== result.provenance.kind || typeof result.provenance.fingerprint !== "string" ||
      !result.provenance.fingerprint.trim() || result.provenance.fingerprint.trim() !== result.provenance.fingerprint)
    return { ok: false, reason: "simulation-observation-unresolved" };
  return { ok: true, receipt: result };
}
function amounts(template: ObservedCallTemplate): readonly bigint[] | undefined {
  const observed = BigInt(template.sample.amountIn);
  const quarter = observed / 4n, second = observed + (quarter > 0n ? quarter : 1n), last = observed * 2n;
  if (last > OBSERVED_CALL_MAX_AMOUNT || !(observed < second && second < last)) return undefined;
  return Object.freeze([observed, second, last]);
}
const provenance = (value: TrustedTransportProvenance) => Object.freeze({ kind: value.kind, fingerprint: value.fingerprint });

/** Runtime guard controls deliberately exercise the generated program, not the
 * original protocol's funding independence. Zero input stops at its input guard
 * even if the executor has old inventory. The forced-minimum control tightens
 * only the outer output guard; it never guesses a protocol calldata parameter. */
function controls(input: ObservedCallProbeInput, template: ObservedCallTemplate, amountIn: bigint): readonly {
  readonly kind: ObservedCallControlProbe["kind"]; readonly request: SimulationRequest;
}[] {
  const common = { template, executor: input.executor, source: input.source, protectedTokens: input.protectedTokens, amountIn };
  const zero = buildObservedCallSimulation({ ...common, id: `observed:${template.templateHash}:zero-runtime-input` });
  const program = buildObservedCallRuntimeProgram({ ...common, actionAdapterId: "observed-call-probe" }).bytes();
  const zeroRequest = Object.freeze({ ...zero,
    call: Object.freeze({ ...zero.call, data: buildSubscriptCalldata(runtimeProgramScript(program, 0n)) }),
    overrideIntent: Object.freeze({ caller: zero.overrideIntent.caller, tokenBalances: Object.freeze([]) }),
  });
  const minimum = buildObservedCallSimulation({ ...common, id: `observed:${template.templateHash}:forced-output-minimum`, minimumAmountOut: MaxUint256 });
  return Object.freeze([{ kind: "zero-runtime-input" as const, request: zeroRequest },
    { kind: "forced-output-minimum" as const, request: minimum }]);
}

async function probe(input: ObservedCallProbeInput, template: ObservedCallTemplate): Promise<ObservedCallCandidateProbe> {
  const positiveProbes: ObservedCallPositiveProbe[] = [], controlProbes: ObservedCallControlProbe[] = [];
  const finish = (status: ObservedCallCandidateProbe["status"], reason?: string): ObservedCallCandidateProbe => Object.freeze({
    templateHash: template.templateHash, status, ...(reason ? { reason } : {}),
    positiveProbes: Object.freeze([...positiveProbes]), controls: Object.freeze([...controlProbes]),
  });
  const points = amounts(template);
  if (!points) return finish("unsupported", "probe-input-points-outside-supported-range");
  for (const amountIn of points) {
    const current = { template, executor: input.executor, source: input.source, protectedTokens: input.protectedTokens, amountIn,
      id: `observed:${template.templateHash}:positive:${amountIn}` };
    let request: SimulationRequest;
    try { request = buildObservedCallSimulation(current); }
    catch { return finish("unsupported", "candidate-program-not-supported"); }
    let result: AdapterRequestResult;
    try { result = await input.execute(request); }
    catch { return finish("unresolved", "simulation-transport-unresolved"); }
    const observed = observation(result, request, input.source);
    if (!observed.ok) return finish("unresolved", observed.reason);
    if (observed.receipt.completion === "reverted-as-declared") return finish("rejected", "positive-execution-reverted");
    let amountOut: bigint;
    try { amountOut = decodeObservedCallSimulationReceipt({ ...current, request, result: observed.receipt }); }
    // A purportedly successful guarded program with incompatible effects is an
    // observation/program defect, not permission to choose another candidate.
    catch { return finish("unresolved", "positive-receipt-verification-failed"); }
    positiveProbes.push(Object.freeze({ amountIn: amountIn.toString(), amountOut: amountOut.toString(),
      requestId: request.id, provenance: provenance(observed.receipt.provenance) }));
  }
  let requests: ReturnType<typeof controls>;
  try { requests = controls(input, template, points[0]!); }
  catch { return finish("unsupported", "candidate-control-program-not-supported"); }
  for (const control of requests) {
    let result: AdapterRequestResult;
    try { result = await input.execute(control.request); }
    catch { return finish("unresolved", "control-transport-unresolved"); }
    const observed = observation(result, control.request, input.source);
    if (!observed.ok) return finish("unresolved", observed.reason);
    if (observed.receipt.completion !== "reverted-as-declared") return finish("unresolved", "runtime-guard-control-did-not-revert");
    controlProbes.push(Object.freeze({ kind: control.kind, requestId: control.request.id,
      completion: "reverted-as-declared", provenance: provenance(observed.receipt.provenance) }));
  }
  return finish("accepted");
}

/** Resolve one sample's bounded patch alternatives by actual execution. At most
 * 16 candidates * (3 positive + 2 control) = 80 isolated simulations. A transport
 * uncertainty on another candidate blocks selecting a nominal sole success.
 * No expected historical output is supplied to the simulator or decoder. */
export async function runObservedCallProbes(input: ObservedCallProbeInput): Promise<ObservedCallProbeResult> {
  const rejectedInput = (reason: string): ObservedCallProbeResult => Object.freeze({ status: "unsupported", reason,
    probePolicy: OBSERVED_CALL_PROBE_POLICY, candidates: Object.freeze([]) });
  let templates: readonly ObservedCallTemplate[], executor: string, source: CanonicalSource, protectedTokens: readonly string[] | undefined;
  try {
    assertDeclarativeExecutionSource(input.source);
    source = Object.freeze({ number: input.source.number, hash: input.source.hash, generation: input.source.generation });
    executor = getAddress(input.executor);
    if (!Array.isArray(input.templates) || !input.templates.length || input.templates.length > OBSERVED_CALL_MAX_CANDIDATES ||
        typeof input.execute !== "function") return rejectedInput("invalid-probe-input-or-budget");
    input.templates.forEach(validateObservedCallTemplate);
    // Snapshot mutable JSON inputs before the first await. Issuer callbacks may
    // not retroactively change the template, source or observation scope.
    const copied: ObservedCallTemplate[] = JSON.parse(JSON.stringify(input.templates));
    templates = [...new Map(copied.map(template => [template.templateHash, template])).values()];
    protectedTokens = input.protectedTokens === undefined ? undefined : Object.freeze([...input.protectedTokens]);
    // Alternatives must concern the same observed call. Comparing unrelated
    // pools, senders or transactions is not selector/parameter disambiguation.
    const sample = JSON.stringify(templates[0]!.sample);
    if (templates.some(template => JSON.stringify(template.sample) !== sample)) return rejectedInput("candidate-observations-differ");
  } catch { return rejectedInput("invalid-probe-input-or-template"); }
  const normalized = { ...input, executor, source, protectedTokens };
  const candidates: ObservedCallCandidateProbe[] = [];
  for (const template of templates) candidates.push(await probe(normalized, template));
  const report = { probePolicy: OBSERVED_CALL_PROBE_POLICY, candidates: Object.freeze(candidates) };
  const accepted = candidates.filter(candidate => candidate.status === "accepted");
  if (candidates.some(candidate => candidate.status === "unresolved"))
    return Object.freeze({ ...report, status: "unresolved", reason: "candidate-observations-incomplete" });
  if (accepted.length > 1) return Object.freeze({ ...report, status: "ambiguous", reason: "multiple-candidates-passed" });
  if (accepted.length === 1) {
    const selected = accepted[0]!, template = templates.find(candidate => candidate.templateHash === selected.templateHash)!;
    const points = amounts(template)!;
    return Object.freeze({ ...report, status: "accepted", template, executor,
      source,
      amountBounds: Object.freeze({ minimum: points[0]!.toString(), maximum: points[2]!.toString() }),
      positiveProbes: selected.positiveProbes, controls: selected.controls });
  }
  return Object.freeze({ ...report, status: candidates.some(candidate => candidate.status === "rejected") ? "rejected" : "unsupported",
    reason: "no-candidate-passed" });
}
