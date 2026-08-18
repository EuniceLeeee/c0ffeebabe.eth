import type { FamilyId } from "./adapter-family-identifiers.js";
import {
  hashCanonical,
  type CanonicalValue,
} from "./canonical-value.js";

export type AdapterTransport =
  | "eth-call"
  | "get-code"
  | "get-storage"
  | "state-override-simulation"
  | "effect-delta-simulation";

export type EffectObservationKind =
  | "return-data"
  | "revert-data"
  | "logs"
  | "trace"
  | "token-delta"
  | "native-delta"
  | "total-supply-delta";

export interface CanonicalSource {
  readonly number: number;
  readonly hash: string;
  readonly generation: number;
}

export interface RequestRequirements {
  readonly transports: readonly AdapterTransport[];
  readonly caller?: CallerRef["kind"];
  /** Omitted legacy declarations are centrally completed from built requests. */
  readonly completions?: readonly (
    | "return-data"
    | "return-or-revert-data"
  )[];
  readonly effects?: readonly EffectObservationKind[];
}

/** Family-owned symbolic caller declaration. Only the central runtime binds it. */
export type CallerRef =
  | { readonly kind: "none" }
  | { readonly kind: "executor" }
  | { readonly kind: "observed-sender" }
  | { readonly kind: "verified-actor"; readonly evidenceId: string };

export interface FundedCallerOverrideIntent {
  readonly caller: CallerRef;
  readonly nativeBalanceWei?: bigint;
  readonly tokenBalances?: readonly {
    readonly token: string;
    readonly amount: bigint;
  }[];
}

export type AdapterRequest =
  | {
      readonly id: string;
      /** Defaults to true. Only an explicit false lets decode observe failure. */
      readonly required?: boolean;
      readonly kind: "eth-call";
      readonly to: string;
      readonly data: string;
      readonly caller?: CallerRef;
      readonly completion: "return-data" | "return-or-revert-data";
    }
  | {
      readonly id: string;
      readonly required?: boolean;
      readonly kind: "get-code";
      readonly address: string;
    }
  | {
      readonly id: string;
      readonly required?: boolean;
      readonly kind: "get-storage";
      readonly address: string;
      readonly slot: string;
    }
  | {
      readonly id: string;
      readonly required?: boolean;
      readonly kind: "state-override-simulation" | "effect-delta-simulation";
      /** Ordered calls executed in the same isolated simulation before call. */
      readonly preCalls?: readonly {
        readonly caller: CallerRef;
        readonly to: string;
        readonly data: string;
      }[];
      readonly call: {
        readonly caller: CallerRef;
        readonly to: string;
        readonly data: string;
      };
      readonly overrideIntent: FundedCallerOverrideIntent;
      readonly observe: readonly EffectObservationKind[];
    };

/** Central-only transport form produced after CallerRef authority binding. */
export type MaterializedAdapterRequest =
  | {
      readonly id: string;
      readonly required?: boolean;
      readonly kind: "eth-call";
      readonly to: string;
      readonly data: string;
      readonly from?: string;
      readonly completion: "return-data" | "return-or-revert-data";
    }
  | Extract<AdapterRequest, { readonly kind: "get-code" | "get-storage" }>
  | {
      readonly id: string;
      readonly required?: boolean;
      readonly kind: "state-override-simulation" | "effect-delta-simulation";
      readonly preCalls?: readonly {
        readonly from: string;
        readonly to: string;
        readonly data: string;
      }[];
      readonly call: {
        readonly from: string;
        readonly to: string;
        readonly data: string;
      };
      readonly overrideIntent: Omit<FundedCallerOverrideIntent, "caller"> & {
        readonly caller: string;
      };
      readonly observe: readonly EffectObservationKind[];
    };

export interface ObservedEffects {
  readonly tokenDeltas?: readonly {
    readonly token: string;
    readonly account: string;
    readonly delta: bigint;
  }[];
  readonly nativeDeltas?: readonly {
    readonly account: string;
    readonly delta: bigint;
  }[];
  readonly totalSupplyDeltas?: readonly {
    readonly token: string;
    readonly delta: bigint;
  }[];
  readonly logs?: readonly {
    readonly address: string;
    readonly topics: readonly string[];
    readonly data: string;
  }[];
  readonly traceRef?: string;
}

/** Opaque scheduler-owned transport attestation. */
export interface TrustedTransportProvenance {
  readonly kind: string;
  readonly fingerprint: string;
}

export type AdapterRequestResult =
  | {
      readonly id: string;
      readonly ok: true;
      readonly source: CanonicalSource;
      readonly provenance: TrustedTransportProvenance;
      readonly completion: "returned" | "reverted-as-declared";
      readonly data: string;
      readonly effects?: ObservedEffects;
    }
  | {
      readonly id: string;
      readonly ok: false;
      readonly source: CanonicalSource;
      readonly failure: "rpc" | "deadline" | "aborted" | "resource-limited";
    };

/**
 * A decode failure over chain-proven reverted outcomes: the callee reverted
 * deterministically at the fixed cutoff, so this is terminal negative
 * evidence, not a transport or program failure.
 */
export class ChainRevertEvidenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChainRevertEvidenceError";
  }
}

/** A required transport failure is unresolved and must never reach decode. */
export class RequiredAdapterRequestError extends Error {
  readonly failureCode: Extract<
    AdapterRequestResult,
    { readonly ok: false }
  >["failure"];

  constructor(result: Extract<AdapterRequestResult, { readonly ok: false }>) {
    super(`required adapter request ${result.id} failed: ${result.failure}`);
    this.name = "RequiredAdapterRequestError";
    this.failureCode = result.failure;
  }
}

export interface RequestProgram<Input, Evidence> {
  requirements(input: Input): RequestRequirements;
  buildRequests(input: Input): readonly AdapterRequest[];
  decode(input: {
    readonly programInput: Input;
    readonly results: readonly AdapterRequestResult[];
  }): Evidence;
}

export type StaticEvidenceReusePolicy<Input> =
  | { readonly kind: "source-local" }
  | {
      readonly kind: "immutable-code";
      readonly codeSubjects: readonly string[];
    }
  | {
      readonly kind: "dependency-proof";
      dependencyKeys(input: Input): readonly string[];
    };

export interface StaticEvidenceProgram<Input, Evidence>
  extends RequestProgram<Input, Evidence> {
  readonly reusePolicy: StaticEvidenceReusePolicy<Input>;
}

/** Central-only form used while Family plugin validation migrates separately. */
export interface InputResolvedStaticEvidenceProgram<Input, Evidence>
  extends RequestProgram<Input, Evidence> {
  reusePolicy(input: Input): StaticEvidenceReusePolicy<Input>;
}

export type StaticEvidenceProgramLike<Input, Evidence> =
  | StaticEvidenceProgram<Input, Evidence>
  | InputResolvedStaticEvidenceProgram<Input, Evidence>;

const staticEvidenceReuseProofBrand: unique symbol = Symbol(
  "static-evidence-reuse-proof",
);

export interface StaticEvidenceReuseProof {
  readonly [staticEvidenceReuseProofBrand]: true;
  readonly source: CanonicalSource;
  readonly policyKind: ResolvedStaticEvidenceReusePolicy["kind"];
  readonly requestFingerprint: string;
  readonly trustedResultsFingerprint: string;
  readonly proofHash: string;
}

export interface StaticEvidenceReuseSeal {
  readonly proofHash: string;
}

export type ResolvedStaticEvidenceReusePolicy =
  | { readonly kind: "source-local" }
  | {
      readonly kind: "immutable-code";
      readonly codeSubjects: readonly string[];
    }
  | {
      readonly kind: "dependency-proof";
      readonly dependencyKeys: readonly string[];
    };

export interface ExecutedProgram<Evidence> {
  readonly evidence: Evidence;
  readonly trustedResultsFingerprint: string;
  readonly reuseProof?: StaticEvidenceReuseProof;
  /** Central-only replay material. Adapter modules never receive this object. */
  readonly trustedResults: readonly AdapterRequestResult[];
}

const boundedRequestExecutorBrand: unique symbol = Symbol(
  "bounded-request-executor",
);
const issuedBoundedRequestExecutors = new WeakSet<object>();
const issuedRequestResults = new WeakSet<object>();
const issuedStaticEvidenceReuseProofs = new WeakSet<object>();
const issuedExecutedPrograms = new WeakSet<object>();

export interface DeclaredStaticEvidenceProgram {
  readonly requirements: RequestRequirements;
  readonly requests: readonly AdapterRequest[];
  readonly reusePolicy: ResolvedStaticEvidenceReusePolicy;
  readonly requestFingerprint: string;
}

export interface BoundedRequestExecutor {
  readonly [boundedRequestExecutorBrand]: true;
  assertSupported(requirements: RequestRequirements): void;
  assertCallerBinding(input: {
    readonly familyId: FamilyId;
    readonly source: CanonicalSource;
    readonly callerRef: Exclude<CallerRef, { readonly kind: "none" }>;
  }): void;
  assertWithinBudget(
    familyId: FamilyId,
    requests: readonly AdapterRequest[],
  ): void;
  execute(input: {
    readonly familyId: FamilyId;
    readonly source: CanonicalSource;
    readonly requirements: RequestRequirements;
    readonly requests: readonly AdapterRequest[];
  }): Promise<readonly AdapterRequestResult[]>;
  sealStaticEvidenceReuseProof(input: {
    readonly reusePolicy: ResolvedStaticEvidenceReusePolicy;
    readonly source: CanonicalSource;
    readonly requests: readonly AdapterRequest[];
    readonly results: readonly AdapterRequestResult[];
    readonly trustedResultsFingerprint: string;
  }): StaticEvidenceReuseSeal;
}

export type BoundedRequestExecutorHandlers = Omit<
  BoundedRequestExecutor,
  typeof boundedRequestExecutorBrand | "assertCallerBinding"
> & {
  readonly assertCallerBinding?: BoundedRequestExecutor["assertCallerBinding"];
};

/**
 * Central runtime issuance point. Family modules are forbidden from importing
 * this factory by the Adapter boundary gate; the unexported brand also makes a
 * structurally forged executor fail at runtime.
 */
export function createBoundedRequestExecutor(
  handlers: BoundedRequestExecutorHandlers,
): BoundedRequestExecutor {
  const executor: BoundedRequestExecutor = Object.freeze({
    [boundedRequestExecutorBrand]: true as const,
    assertSupported: handlers.assertSupported.bind(handlers),
    assertCallerBinding(
      input: Parameters<BoundedRequestExecutor["assertCallerBinding"]>[0],
    ) {
      if (handlers.assertCallerBinding === undefined) {
        throw new Error("central runtime did not bind the declared caller role");
      }
      handlers.assertCallerBinding.call(handlers, input);
    },
    assertWithinBudget: handlers.assertWithinBudget.bind(handlers),
    async execute(
      input: Parameters<BoundedRequestExecutor["execute"]>[0],
    ) {
      const declaredResults = await handlers.execute(input);
      if (!Array.isArray(declaredResults)) {
        throw new Error("request executor must return an array");
      }
      return Object.freeze(declaredResults.map(issueAdapterRequestResult));
    },
    sealStaticEvidenceReuseProof:
      handlers.sealStaticEvidenceReuseProof.bind(handlers),
  });
  issuedBoundedRequestExecutors.add(executor);
  return executor;
}

/**
 * Runtime assertion for central scheduler boundaries. Structural compatibility
 * is insufficient: only this module can add an executor to the issuance set.
 */
export function assertIssuedBoundedRequestExecutor(
  value: unknown,
): asserts value is BoundedRequestExecutor {
  if (
    value === null ||
    typeof value !== "object" ||
    (value as Partial<BoundedRequestExecutor>)[boundedRequestExecutorBrand] !==
      true ||
    !issuedBoundedRequestExecutors.has(value)
  ) {
    throw new Error("request executor must be issued by the central runtime");
  }
}

export function isIssuedStaticEvidenceReuseProof(
  value: unknown,
): value is StaticEvidenceReuseProof {
  return typeof value === "object" && value !== null &&
    issuedStaticEvidenceReuseProofs.has(value);
}

export function isIssuedExecutedProgram(
  value: unknown,
): value is ExecutedProgram<unknown> {
  return typeof value === "object" && value !== null &&
    issuedExecutedPrograms.has(value);
}

/**
 * Validates the pure declaration used to address the central static-evidence
 * content cache. The real execution path calls the same declaration helper,
 * so a cache key cannot be built from a weaker request shape.
 */
export function declareStaticEvidenceProgram<Input, Evidence>(input: {
  readonly program: StaticEvidenceProgramLike<Input, Evidence>;
  readonly programInput: Input;
}): DeclaredStaticEvidenceProgram {
  const declared = declareRequestProgram(input.program, input.programInput);
  if (declared.reusePolicy === undefined) {
    throw new Error("static evidence program must declare a reuse policy");
  }
  return Object.freeze({
    requirements: declared.requirements,
    requests: declared.requests,
    reusePolicy: declared.reusePolicy,
    requestFingerprint: requestSetFingerprint(declared.requests),
  });
}

export async function runRequestProgram<Input, Evidence>(input: {
  readonly familyId: FamilyId;
  readonly program: RequestProgram<Input, Evidence>;
  readonly programInput: Input;
  readonly source: CanonicalSource;
  readonly executor: BoundedRequestExecutor;
}): Promise<ExecutedProgram<Evidence>> {
  assertIssuedBoundedRequestExecutor(input.executor);
  assertFamilyId(input.familyId);
  assertCanonicalSource(input.source);
  const declared = declareRequestProgram(input.program, input.programInput);
  const { requirements, requests } = declared;
  const staticReusePolicy = declared.reusePolicy;
  input.executor.assertSupported(requirements);
  assertCallerBindings({
    executor: input.executor,
    familyId: input.familyId,
    source: input.source,
    requirements,
    requests,
  });
  input.executor.assertWithinBudget(input.familyId, requests);

  const executedResults = await input.executor.execute({
    familyId: input.familyId,
    source: input.source,
    requirements,
    requests,
  });
  if (!Array.isArray(executedResults)) {
    throw new Error("request executor must return an array");
  }
  const results = Object.freeze([...executedResults]);
  for (const result of results) {
    if (!issuedRequestResults.has(result)) {
      throw new Error("request result must be issued by the central runtime");
    }
  }
  assertResultSet(requests, results, input.source);
  const requestById = new Map(requests.map((request) => [request.id, request]));
  const requiredFailure = results
    .filter((result): result is Extract<AdapterRequestResult, { ok: false }> =>
      !result.ok && requestById.get(result.id)?.required !== false
    )
    .sort((left, right) => left.id.localeCompare(right.id))[0];
  if (requiredFailure !== undefined) {
    throw new RequiredAdapterRequestError(requiredFailure);
  }
  const trustedResultsFingerprint = fingerprintTrustedResults(results);
  let evidence: Evidence;
  try {
    evidence = requireSynchronous(
      input.program.decode({
        programInput: input.programInput,
        results,
      }),
      "request decode",
    );
  } catch (error) {
    // A decode failure over a result set that contains chain-proven
    // reverted-as-declared outcomes is itself chain evidence (the callee
    // reverted deterministically at this cutoff), never a transport or
    // program error. Surface it as such so identity can reject terminally
    // instead of retrying forever.
    // A decode failure over a result set whose chain shape is
    // deterministic at this cutoff (a reverted-as-declared outcome, or an
    // empty "0x" return that a contract without the requested function
    // produces) is chain evidence itself, never a transport or program
    // error: the same call at the same block always returns the same shape.
    const chainShape = results.find((result) =>
      result.completion === "reverted-as-declared" ||
      (result.completion === "returned" && result.data === "0x")
    );
    if (chainShape !== undefined) {
      throw new ChainRevertEvidenceError(
        `decode over chain-shaped result ${chainShape.id}: ` +
          (error instanceof Error ? error.message : String(error)),
      );
    }
    throw error;
  }
  const reuseProof = staticReusePolicy !== undefined &&
      results.every((result) => result.ok)
    ? issueStaticEvidenceReuseProof({
        seal: input.executor.sealStaticEvidenceReuseProof({
          reusePolicy: staticReusePolicy,
          source: input.source,
          requests,
          results,
          trustedResultsFingerprint,
        }),
        reusePolicy: staticReusePolicy,
        source: input.source,
        requests,
        trustedResultsFingerprint,
      })
    : undefined;

  return issueExecutedProgram({
    evidence,
    trustedResultsFingerprint,
    ...(reuseProof === undefined ? {} : { reuseProof }),
    trustedResults: results,
  });
}

/**
 * Re-decodes centrally cached trusted results against the current program
 * input. This prevents opaque Adapter evidence from becoming the cache key or
 * from carrying a stale draft across generations.
 */
export function replayStaticEvidenceProgram<Input, Evidence>(input: {
  readonly program: StaticEvidenceProgramLike<Input, Evidence>;
  readonly programInput: Input;
  readonly source: CanonicalSource;
  readonly cached: ExecutedProgram<unknown>;
}): ExecutedProgram<Evidence> {
  assertCanonicalSource(input.source);
  if (!isIssuedExecutedProgram(input.cached)) {
    throw new Error("cached static evidence must be a central issued program");
  }
  const proof = input.cached.reuseProof;
  if (!isIssuedStaticEvidenceReuseProof(proof)) {
    throw new Error("cached static evidence lacks a central reuse proof");
  }
  const declared = declareStaticEvidenceProgram({
    program: input.program,
    programInput: input.programInput,
  });
  if (
    declared.requestFingerprint !== proof.requestFingerprint ||
    declared.reusePolicy.kind !== proof.policyKind
  ) {
    throw new Error("cached static evidence declaration changed");
  }
  if (input.cached.trustedResults.some((result) => !result.ok)) {
    throw new Error("failed request results cannot enter the static cache");
  }
  const reboundResults = Object.freeze(input.cached.trustedResults.map((result) =>
    issueAdapterRequestResult({
      ...result,
      source: input.source,
    })
  ));
  assertResultSet(declared.requests, reboundResults, input.source);
  const evidence = requireSynchronous(
    input.program.decode({
      programInput: input.programInput,
      results: reboundResults,
    }),
    "cached request decode",
  );
  return issueExecutedProgram({
    evidence,
    trustedResultsFingerprint: input.cached.trustedResultsFingerprint,
    reuseProof: proof,
    trustedResults: reboundResults,
  });
}

export function declareRequestProgram<Input, Evidence>(
  program: RequestProgram<Input, Evidence>,
  programInput: Input,
): Readonly<{
  readonly requirements: RequestRequirements;
  readonly requests: readonly AdapterRequest[];
  readonly reusePolicy?: ResolvedStaticEvidenceReusePolicy;
}> {
  const declaredRequirements = requireSynchronous(
    program.requirements(programInput),
    "request requirements",
  );
  assertRequirements(declaredRequirements);
  const reusePolicy = resolveStaticReusePolicy(program, programInput);
  const declaredRequests = requireSynchronous(
    program.buildRequests(programInput),
    "request construction",
  );
  if (!Array.isArray(declaredRequests)) {
    throw new Error("request construction must return an array");
  }
  assertRequestIds(declaredRequests);
  const requests = Object.freeze([
    ...declaredRequests.map(freezeAdapterRequest),
  ]);
  const requirements = freezeRequirements(
    completeRequirements(declaredRequirements, requests),
  );
  assertRequestsMatchRequirements(requirements, requests);
  return Object.freeze({
    requirements,
    requests,
    ...(reusePolicy === undefined ? {} : { reusePolicy }),
  });
}

function issueExecutedProgram<Evidence>(input: ExecutedProgram<Evidence>):
  ExecutedProgram<Evidence> {
  const executed = Object.freeze({
    evidence: input.evidence,
    trustedResultsFingerprint: input.trustedResultsFingerprint,
    ...(input.reuseProof === undefined ? {} : { reuseProof: input.reuseProof }),
    trustedResults: Object.freeze([...input.trustedResults]),
  });
  issuedExecutedPrograms.add(executed);
  return executed;
}

export function fingerprintTrustedResults(
  results: readonly AdapterRequestResult[],
): string {
  return hashCanonical(
    results
      .filter((result) => result.ok)
      .map((result) => ({
        id: result.id,
        source: canonicalSourceValue(result.source),
        provenance: {
          kind: result.provenance.kind,
          fingerprint: result.provenance.fingerprint,
        },
        completion: result.completion,
        data: result.data.toLowerCase(),
        effects: observedEffectsValue(result.effects),
      }))
      .sort((a, b) => a.id.localeCompare(b.id)),
  );
}

export function requestSetFingerprint(
  requests: readonly AdapterRequest[],
): string {
  return hashCanonical(
    requests
      .map(requestCanonicalValue)
      .sort((a, b) => {
        const aId = (a as { readonly id: string }).id;
        const bId = (b as { readonly id: string }).id;
        return aId.localeCompare(bId);
      }),
  );
}

/** Physical identity deliberately excludes consumer-local id and requiredness. */
export function physicalAdapterRequestFingerprint(
  request: AdapterRequest,
): string {
  return hashCanonical(physicalRequestCanonicalValue(request));
}

/** Order-independent physical multiset identity used only for transport sharing. */
export function physicalRequestSetFingerprint(
  requests: readonly AdapterRequest[],
): string {
  return hashCanonical(
    requests.map(physicalAdapterRequestFingerprint).sort(),
  );
}

function isStaticEvidenceProgram<Input, Evidence>(
  program: RequestProgram<Input, Evidence>,
): program is StaticEvidenceProgramLike<Input, Evidence> {
  return "reusePolicy" in program;
}

function assertCanonicalSource(source: CanonicalSource): void {
  if (!Number.isSafeInteger(source.number) || source.number < 0) {
    throw new Error("canonical source number must be a non-negative safe integer");
  }
  if (!Number.isSafeInteger(source.generation) || source.generation < 0) {
    throw new Error("canonical source generation must be a non-negative safe integer");
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(source.hash)) {
    throw new Error("canonical source hash must be a 32-byte hex value");
  }
}

function freezeRequirements(
  requirements: RequestRequirements,
): RequestRequirements {
  return Object.freeze({
    transports: Object.freeze([...requirements.transports]),
    ...(requirements.caller === undefined
      ? {}
      : { caller: requirements.caller }),
    ...(requirements.completions === undefined
      ? {}
      : { completions: Object.freeze([...requirements.completions]) }),
    ...(requirements.effects === undefined
      ? {}
      : { effects: Object.freeze([...requirements.effects]) }),
  });
}

function completeRequirements(
  requirements: RequestRequirements,
  requests: readonly AdapterRequest[],
): RequestRequirements {
  if (requirements.completions !== undefined) return requirements;
  const completions = [...new Set(requests.flatMap((request) =>
    request.kind === "eth-call" ? [request.completion] : []
  ))].sort();
  return {
    ...requirements,
    completions,
  };
}

function freezeCallerRef(caller: CallerRef): CallerRef {
  assertCallerRef(caller);
  return caller.kind === "verified-actor"
    ? Object.freeze({ kind: caller.kind, evidenceId: caller.evidenceId })
    : Object.freeze({ kind: caller.kind });
}

function callerRefKey(caller: CallerRef): string {
  return caller.kind === "verified-actor"
    ? `${caller.kind}\u001f${caller.evidenceId}`
    : caller.kind;
}

function freezeAdapterRequest(request: AdapterRequest): AdapterRequest {
  switch (request.kind) {
    case "eth-call":
      return Object.freeze({
        id: request.id,
        ...(request.required === undefined ? {} : { required: request.required }),
        kind: request.kind,
        to: request.to,
        data: request.data,
        ...(request.caller === undefined
          ? {}
          : { caller: freezeCallerRef(request.caller) }),
        completion: request.completion,
      });
    case "get-code":
      return Object.freeze({
        id: request.id,
        ...(request.required === undefined ? {} : { required: request.required }),
        kind: request.kind,
        address: request.address,
      });
    case "get-storage":
      return Object.freeze({
        id: request.id,
        ...(request.required === undefined ? {} : { required: request.required }),
        kind: request.kind,
        address: request.address,
        slot: request.slot,
      });
    case "state-override-simulation":
    case "effect-delta-simulation":
      return Object.freeze({
        id: request.id,
        ...(request.required === undefined ? {} : { required: request.required }),
        kind: request.kind,
        ...(request.preCalls === undefined
          ? {}
          : {
              preCalls: Object.freeze(request.preCalls.map((call) =>
                Object.freeze({
                  caller: freezeCallerRef(call.caller),
                  to: call.to,
                  data: call.data,
                })
              )),
            }),
        call: Object.freeze({
          caller: freezeCallerRef(request.call.caller),
          to: request.call.to,
          data: request.call.data,
        }),
        overrideIntent: Object.freeze({
          caller: freezeCallerRef(request.overrideIntent.caller),
          ...(request.overrideIntent.nativeBalanceWei === undefined
            ? {}
            : { nativeBalanceWei: request.overrideIntent.nativeBalanceWei }),
          ...(request.overrideIntent.tokenBalances === undefined
            ? {}
            : {
                tokenBalances: Object.freeze(
                  request.overrideIntent.tokenBalances.map((item) =>
                    Object.freeze({ ...item })
                  ),
                ),
              }),
        }),
        observe: Object.freeze([...request.observe]),
      });
  }
}

function freezeAdapterRequestResult(
  result: AdapterRequestResult,
): AdapterRequestResult {
  assertPlainRecord(result, "adapter request result");
  const source = freezeCanonicalSource(result.source, `${String(result.id)} result`);
  if (!result.ok) {
    assertRecordKeys(
      result,
      ["id", "ok", "source", "failure"],
      `${String(result.id)} failed result`,
    );
    return Object.freeze({
      id: result.id,
      ok: false as const,
      source,
      failure: result.failure,
    });
  }
  assertRecordKeys(
    result,
    ["id", "ok", "source", "provenance", "completion", "data", "effects"],
    `${String(result.id)} successful result`,
  );
  assertRecordKeys(
    result.provenance,
    ["kind", "fingerprint"],
    `${String(result.id)} result provenance`,
  );
  return Object.freeze({
    id: result.id,
    ok: true as const,
    source,
    provenance: Object.freeze({
      kind: result.provenance.kind,
      fingerprint: result.provenance.fingerprint,
    }),
    completion: result.completion,
    data: result.data,
    ...(result.effects === undefined
      ? {}
      : { effects: freezeObservedEffects(result.effects) }),
  });
}

function issueAdapterRequestResult(
  result: AdapterRequestResult,
): AdapterRequestResult {
  const issued = freezeAdapterRequestResult(result);
  issuedRequestResults.add(issued);
  return issued;
}

function freezeObservedEffects(effects: ObservedEffects): ObservedEffects {
  assertRecordKeys(
    effects,
    [
      "tokenDeltas",
      "nativeDeltas",
      "totalSupplyDeltas",
      "logs",
      "traceRef",
    ],
    "observed effects",
  );
  return Object.freeze({
    ...(effects.tokenDeltas === undefined
      ? {}
      : {
          tokenDeltas: Object.freeze(
            effects.tokenDeltas.map((item) => {
              assertRecordKeys(
                item,
                ["token", "account", "delta"],
                "token delta",
              );
              return Object.freeze({
                token: item.token,
                account: item.account,
                delta: item.delta,
              });
            }),
          ),
        }),
    ...(effects.nativeDeltas === undefined
      ? {}
      : {
          nativeDeltas: Object.freeze(
            effects.nativeDeltas.map((item) => {
              assertRecordKeys(item, ["account", "delta"], "native delta");
              return Object.freeze({
                account: item.account,
                delta: item.delta,
              });
            }),
          ),
        }),
    ...(effects.totalSupplyDeltas === undefined
      ? {}
      : {
          totalSupplyDeltas: Object.freeze(
            effects.totalSupplyDeltas.map((item) => {
              assertRecordKeys(
                item,
                ["token", "delta"],
                "total supply delta",
              );
              return Object.freeze({ token: item.token, delta: item.delta });
            }),
          ),
        }),
    ...(effects.logs === undefined
      ? {}
      : {
          logs: Object.freeze(effects.logs.map((log) => {
            assertRecordKeys(log, ["address", "topics", "data"], "observed log");
            return Object.freeze({
              address: log.address,
              topics: Object.freeze([...log.topics]),
              data: log.data,
            });
          })),
        }),
    ...(effects.traceRef === undefined ? {} : { traceRef: effects.traceRef }),
  });
}

function assertRequirements(requirements: RequestRequirements): void {
  assertRecordKeys(
    requirements,
    ["transports", "caller", "completions", "effects"],
    "request requirements",
  );
  if (!Array.isArray(requirements.transports)) {
    throw new Error("request requirements transports must be an array");
  }
  if (new Set(requirements.transports).size !== requirements.transports.length) {
    throw new Error("request requirements transports must be unique");
  }
  for (const transport of requirements.transports) {
    if (!ADAPTER_TRANSPORTS.has(transport)) {
      throw new Error(`unsupported request requirements transport: ${transport}`);
    }
  }
  if (
    requirements.caller !== undefined &&
    !REQUEST_CALLERS.has(requirements.caller)
  ) {
      throw new Error(`unsupported request caller requirement: ${requirements.caller}`);
  }
  if (
    requirements.completions !== undefined &&
    !Array.isArray(requirements.completions)
  ) {
    throw new Error("request requirements completions must be an array");
  }
  if (
    requirements.completions !== undefined &&
    new Set(requirements.completions).size !== requirements.completions.length
  ) {
    throw new Error("request requirements completions must be unique");
  }
  for (const completion of requirements.completions ?? []) {
    if (
      completion !== "return-data" &&
      completion !== "return-or-revert-data"
    ) {
      throw new Error(
        `unsupported request completion requirement: ${String(completion)}`,
      );
    }
  }
  if (
    requirements.effects !== undefined &&
    new Set(requirements.effects).size !== requirements.effects.length
  ) {
    throw new Error("request requirements effects must be unique");
  }
  for (const effect of requirements.effects ?? []) {
    if (!EFFECT_OBSERVATIONS.has(effect)) {
      throw new Error(`unsupported request effect requirement: ${effect}`);
    }
  }
}

function assertFamilyId(value: FamilyId): void {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) {
    throw new Error("request familyId must be non-empty and canonical");
  }
}

function assertRequestIds(requests: readonly AdapterRequest[]): void {
  const ids = new Set<string>();
  for (const request of requests) {
    assertPlainRecord(request, "adapter request");
    if (
      typeof request.id !== "string" ||
      request.id.length === 0 ||
      request.id.trim() !== request.id
    ) {
      throw new Error("adapter request id must be non-empty without surrounding whitespace");
    }
    if (ids.has(request.id)) {
      throw new Error(`adapter request id must be unique: ${request.id}`);
    }
    if (
      request.required !== undefined &&
      typeof request.required !== "boolean"
    ) {
      throw new Error(`adapter request ${request.id} required must be boolean`);
    }
    ids.add(request.id);
    assertRequestShape(request);
  }
}

function assertRequestsMatchRequirements(
  requirements: RequestRequirements,
  requests: readonly AdapterRequest[],
): void {
  const transports = new Set(requirements.transports);
  const usedTransports = new Set<AdapterTransport>();
  const completions = new Set(requirements.completions ?? []);
  const usedCompletions = new Set<"return-data" | "return-or-revert-data">();
  const effects = new Set(requirements.effects ?? []);
  const usedEffects = new Set<EffectObservationKind>();
  let callerUses = 0;
  for (const request of requests) {
    usedTransports.add(request.kind);
    if (!transports.has(request.kind)) {
      throw new Error(
        `adapter request ${request.id} uses undeclared transport ${request.kind}`,
      );
    }
    if (request.kind === "eth-call") {
      usedCompletions.add(request.completion);
      if (!completions.has(request.completion)) {
        throw new Error(
          `adapter request ${request.id} uses undeclared completion ${request.completion}`,
        );
      }
      if (
        request.completion === "return-or-revert-data" &&
        effects.has("revert-data")
      ) {
        usedEffects.add("revert-data");
      } else if (effects.has("return-data")) {
        usedEffects.add("return-data");
      }
    }
    for (const caller of requestCallerRefs(request)) {
      if (
        caller.kind !== "none" &&
        (requirements.caller === undefined || requirements.caller === "none")
      ) {
        throw new Error(
          `adapter request ${request.id} uses caller without a caller requirement`,
        );
      }
      if (caller.kind === "none") continue;
      callerUses++;
      if (caller.kind !== requirements.caller) {
        throw new Error(
          `adapter request ${request.id} caller ${caller.kind} does not match ` +
            `requirement ${String(requirements.caller)}`,
        );
      }
    }
    if (
      request.kind === "state-override-simulation" ||
      request.kind === "effect-delta-simulation"
    ) {
      if (
        callerRefKey(request.call.caller) !==
          callerRefKey(request.overrideIntent.caller)
      ) {
        throw new Error(
          `adapter request ${request.id} override caller must match call caller`,
        );
      }
      for (const preCall of request.preCalls ?? []) {
        if (
          callerRefKey(preCall.caller) !== callerRefKey(request.call.caller)
        ) {
          throw new Error(
            `adapter request ${request.id} preCall caller must match call caller`,
          );
        }
      }
      if (
        request.overrideIntent.nativeBalanceWei !== undefined &&
        (request.overrideIntent.nativeBalanceWei < 0n ||
          request.overrideIntent.nativeBalanceWei > MAX_UINT256)
      ) {
        throw new Error(
          `adapter request ${request.id} native override must fit uint256`,
        );
      }
      const tokens = new Set<string>();
      for (const balance of request.overrideIntent.tokenBalances ?? []) {
        if (balance.amount < 0n || balance.amount > MAX_UINT256) {
          throw new Error(
            `adapter request ${request.id} token override must fit uint256`,
          );
        }
        const token = balance.token.toLowerCase();
        if (tokens.has(token)) {
          throw new Error(
            `adapter request ${request.id} has duplicate token override ${token}`,
          );
        }
        tokens.add(token);
      }
      const observed = new Set<EffectObservationKind>();
      for (const effect of request.observe) {
        if (observed.has(effect)) {
          throw new Error(
            `adapter request ${request.id} has duplicate effect ${effect}`,
          );
        }
        observed.add(effect);
        usedEffects.add(effect);
        if (!effects.has(effect)) {
          throw new Error(
            `adapter request ${request.id} observes undeclared effect ${effect}`,
          );
        }
      }
    }
  }
  for (const transport of transports) {
    if (!usedTransports.has(transport)) {
      throw new Error(
        `declared request transport ${transport} is not used by any request`,
      );
    }
  }
  for (const completion of completions) {
    if (!usedCompletions.has(completion)) {
      throw new Error(
        `declared request completion ${completion} is not used by any request`,
      );
    }
  }
  if (
    requirements.caller !== undefined &&
    requirements.caller !== "none" &&
    callerUses === 0
  ) {
    throw new Error(
      `request caller requirement ${requirements.caller} is not used by any request`,
    );
  }
  for (const effect of usedEffects) {
    if (!effects.has(effect)) {
      throw new Error(`request uses undeclared effect ${effect}`);
    }
  }
  for (const effect of effects) {
    if (!usedEffects.has(effect)) {
      throw new Error(`declared request effect ${effect} is not observed by any request`);
    }
  }
}

function assertCallerBindings(input: {
  readonly executor: BoundedRequestExecutor;
  readonly familyId: FamilyId;
  readonly source: CanonicalSource;
  readonly requirements: RequestRequirements;
  readonly requests: readonly AdapterRequest[];
}): void {
  const role = input.requirements.caller;
  if (role === undefined || role === "none") return;
  const callers = new Map<string, Exclude<CallerRef, { readonly kind: "none" }>>();
  for (const request of input.requests) {
    for (const caller of requestCallerRefs(request)) {
      if (caller.kind === "none") continue;
      callers.set(callerRefKey(caller), caller);
    }
  }
  for (const callerRef of callers.values()) {
    input.executor.assertCallerBinding({
      familyId: input.familyId,
      source: input.source,
      callerRef,
    });
  }
}

function requestCallerRefs(request: AdapterRequest): readonly CallerRef[] {
  if (request.kind === "eth-call") {
    return request.caller === undefined ? [] : [request.caller];
  }
  if (
    request.kind !== "state-override-simulation" &&
    request.kind !== "effect-delta-simulation"
  ) {
    return [];
  }
  return Object.freeze([
    ...(request.preCalls ?? []).map((call) => call.caller),
    request.call.caller,
    request.overrideIntent.caller,
  ]);
}

function assertRequestShape(request: AdapterRequest): void {
  switch (request.kind) {
    case "eth-call":
      assertRecordKeys(
        request,
        ["id", "required", "kind", "to", "data", "caller", "completion"],
        `${request.id} eth-call request`,
      );
      assertAddress(request.to, `${request.id} eth-call target`);
      assertHex(request.data, `${request.id} eth-call data`);
      if (request.caller !== undefined) assertCallerRef(request.caller);
      if (
        request.completion !== "return-data" &&
        request.completion !== "return-or-revert-data"
      ) {
        throw new Error(`unsupported eth-call completion for ${request.id}`);
      }
      return;
    case "get-code":
      assertRecordKeys(
        request,
        ["id", "required", "kind", "address"],
        `${request.id} get-code request`,
      );
      assertAddress(request.address, `${request.id} code address`);
      return;
    case "get-storage":
      assertRecordKeys(
        request,
        ["id", "required", "kind", "address", "slot"],
        `${request.id} get-storage request`,
      );
      assertAddress(request.address, `${request.id} storage address`);
      if (!/^0x[0-9a-fA-F]{64}$/.test(request.slot)) {
        throw new Error(`${request.id} storage slot must be 32-byte hex`);
      }
      return;
    case "state-override-simulation":
    case "effect-delta-simulation":
      assertRecordKeys(
        request,
        [
          "id",
          "required",
          "kind",
          "preCalls",
          "call",
          "overrideIntent",
          "observe",
        ],
        `${request.id} simulation request`,
      );
      if (request.preCalls !== undefined && !Array.isArray(request.preCalls)) {
        throw new Error(`${request.id} simulation preCalls must be an array`);
      }
      for (const [index, call] of (request.preCalls ?? []).entries()) {
        assertRecordKeys(
          call,
          ["caller", "to", "data"],
          `${request.id} simulation preCall ${index}`,
        );
        assertCallerRef(call.caller);
        assertAddress(call.to, `${request.id} simulation preCall target`);
        assertHex(call.data, `${request.id} simulation preCall data`);
      }
      assertRecordKeys(
        request.call,
        ["caller", "to", "data"],
        `${request.id} simulation call`,
      );
      assertRecordKeys(
        request.overrideIntent,
        ["caller", "nativeBalanceWei", "tokenBalances"],
        `${request.id} override intent`,
      );
      assertCallerRef(request.call.caller);
      assertAddress(request.call.to, `${request.id} simulation target`);
      assertHex(request.call.data, `${request.id} simulation data`);
      assertCallerRef(request.overrideIntent.caller);
      if (
        request.overrideIntent.nativeBalanceWei !== undefined &&
        typeof request.overrideIntent.nativeBalanceWei !== "bigint"
      ) {
        throw new Error(`${request.id} native override must be bigint`);
      }
      if (
        request.overrideIntent.tokenBalances !== undefined &&
        !Array.isArray(request.overrideIntent.tokenBalances)
      ) {
        throw new Error(`${request.id} token balances must be an array`);
      }
      for (const balance of request.overrideIntent.tokenBalances ?? []) {
        assertRecordKeys(
          balance,
          ["token", "amount"],
          `${request.id} token balance`,
        );
        assertAddress(balance.token, `${request.id} override token`);
        if (typeof balance.amount !== "bigint") {
          throw new Error(`${request.id} token override amount must be bigint`);
        }
      }
      if (!Array.isArray(request.observe)) {
        throw new Error(`${request.id} effect observations must be an array`);
      }
      for (const effect of request.observe) {
        if (!EFFECT_OBSERVATIONS.has(effect)) {
          throw new Error(`unsupported effect observation for ${request.id}: ${effect}`);
        }
      }
      return;
    default:
      throw new Error(
        `unsupported adapter request kind: ${String((request as { kind?: unknown }).kind)}`,
      );
  }
}

function resolveStaticReusePolicy<Input, Evidence>(
  program: RequestProgram<Input, Evidence>,
  programInput: Input,
): ResolvedStaticEvidenceReusePolicy | undefined {
  if (!isStaticEvidenceProgram(program)) return undefined;
  const policy = typeof program.reusePolicy === "function"
    ? requireSynchronous(
        program.reusePolicy(programInput),
        "static evidence reusePolicy",
      )
    : program.reusePolicy;
  if (policy === null || typeof policy !== "object") {
    throw new Error("static evidence reusePolicy must be an object");
  }
  switch (policy.kind) {
    case "source-local":
      return Object.freeze({ kind: "source-local" });
    case "immutable-code": {
      if (!Array.isArray(policy.codeSubjects) || policy.codeSubjects.length === 0) {
        throw new Error("immutable-code reuse requires at least one code subject");
      }
      const subjects = new Set<string>();
      for (const subject of policy.codeSubjects) {
        assertAddress(subject, "immutable-code subject");
        const normalized = subject.toLowerCase();
        if (subjects.has(normalized)) {
          throw new Error(`duplicate immutable-code subject: ${normalized}`);
        }
        subjects.add(normalized);
      }
      return Object.freeze({
        kind: "immutable-code",
        codeSubjects: Object.freeze([...subjects]),
      });
    }
    case "dependency-proof": {
      const keys = requireSynchronous(
        policy.dependencyKeys(programInput),
        "static dependency keys",
      );
      if (!Array.isArray(keys)) {
        throw new Error("static dependency keys must be an array");
      }
      if (keys.length === 0) {
        throw new Error("dependency-proof reuse requires at least one dependency key");
      }
      const unique = new Set<string>();
      for (const key of keys) {
        if (
          typeof key !== "string" || key.length === 0 || key.trim() !== key
        ) {
          throw new Error("static dependency keys must be non-empty and canonical");
        }
        if (unique.has(key)) {
          throw new Error(`duplicate static dependency key: ${key}`);
        }
        unique.add(key);
      }
      return Object.freeze({
        kind: "dependency-proof",
        dependencyKeys: Object.freeze([...unique]),
      });
    }
    default:
      throw new Error(
        `unsupported static evidence reuse policy: ${String((policy as { kind?: unknown }).kind)}`,
      );
  }
}

function issueStaticEvidenceReuseProof(input: {
  readonly seal: StaticEvidenceReuseSeal;
  readonly reusePolicy: ResolvedStaticEvidenceReusePolicy;
  readonly source: CanonicalSource;
  readonly requests: readonly AdapterRequest[];
  readonly trustedResultsFingerprint: string;
}): StaticEvidenceReuseProof {
  if (
    input.seal === null || typeof input.seal !== "object" ||
    typeof input.seal.proofHash !== "string" ||
    !/^[0-9a-fA-F]{64}$/.test(input.seal.proofHash)
  ) {
    throw new Error("static evidence reuse seal must contain a SHA-256 proof hash");
  }
  const proof: StaticEvidenceReuseProof = Object.freeze({
    [staticEvidenceReuseProofBrand]: true as const,
    source: Object.freeze({ ...input.source }),
    policyKind: input.reusePolicy.kind,
    requestFingerprint: requestSetFingerprint(input.requests),
    trustedResultsFingerprint: input.trustedResultsFingerprint,
    proofHash: input.seal.proofHash.toLowerCase(),
  });
  issuedStaticEvidenceReuseProofs.add(proof);
  return proof;
}

function assertResultSet(
  requests: readonly AdapterRequest[],
  results: readonly AdapterRequestResult[],
  source: CanonicalSource,
): void {
  const expected = new Set(requests.map((request) => request.id));
  const requestById = new Map(requests.map((request) => [request.id, request]));
  const actual = new Set<string>();
  for (const result of results) {
    if (result.ok !== true && result.ok !== false) {
      throw new Error("request executor result ok must be boolean");
    }
    if (!expected.has(result.id)) {
      throw new Error(`request executor returned unknown result id: ${result.id}`);
    }
    if (actual.has(result.id)) {
      throw new Error(`request executor returned duplicate result id: ${result.id}`);
    }
    actual.add(result.id);
    if (!sameSource(result.source, source)) {
      throw new Error(`request result source mismatch for ${result.id}`);
    }
    if (result.ok) {
      const request = requestById.get(result.id)!;
      assertHex(result.data, `${result.id} result data`);
      if (
        typeof result.provenance.kind !== "string" ||
        result.provenance.kind.length === 0 ||
        result.provenance.kind.trim() !== result.provenance.kind ||
        typeof result.provenance.fingerprint !== "string" ||
        result.provenance.fingerprint.length === 0 ||
        result.provenance.fingerprint.trim() !== result.provenance.fingerprint
      ) {
        throw new Error(
          `request result ${result.id} requires trusted transport provenance`,
        );
      }
      if (
        result.completion !== "returned" &&
        result.completion !== "reverted-as-declared"
      ) {
        throw new Error(
          `request result ${result.id} has unsupported completion`,
        );
      }
      const simulationRequest = request.kind === "state-override-simulation" ||
        request.kind === "effect-delta-simulation"
        ? request
        : undefined;
      // An execution-layer revert is chain evidence for any eth-call: the
      // callee reverted deterministically at the fixed cutoff, so the
      // central runtime surfaces it as reverted-as-declared regardless of
      // the request's declared completion, and the family decode decides.
      const revertAllowed = request.kind === "eth-call"
        ? true
        : simulationRequest?.observe.includes("revert-data") === true;
      if (result.completion === "reverted-as-declared" && !revertAllowed) {
        throw new Error(
          `request result ${result.id} returned undeclared revert data`,
        );
      }
      if (simulationRequest !== undefined) {
        const observesReturn = simulationRequest.observe.includes("return-data");
        const observesRevert = simulationRequest.observe.includes("revert-data");
        if (
          (observesReturn || observesRevert) &&
          !(
            (result.completion === "returned" && observesReturn) ||
            (result.completion === "reverted-as-declared" && observesRevert)
          )
        ) {
          throw new Error(
            `request result ${result.id} completion does not match declared data observation`,
          );
        }
        assertObservedEffectsMatchRequest(simulationRequest, result.effects);
      } else if (result.effects !== undefined) {
        throw new Error(
          `request result ${result.id} returned effects for a non-simulation request`,
        );
      }
    } else if (!REQUEST_FAILURES.has(result.failure)) {
      throw new Error(`request result ${result.id} has unsupported failure`);
    }
  }
  for (const id of expected) {
    if (!actual.has(id)) {
      throw new Error(`request executor omitted result id: ${id}`);
    }
  }
}

function assertObservedEffectsMatchRequest(
  request: Extract<
    AdapterRequest,
    { readonly kind: "state-override-simulation" | "effect-delta-simulation" }
  >,
  effects: ObservedEffects | undefined,
): void {
  const expected = new Set(request.observe);
  const physicalKinds = [
    "logs",
    "trace",
    "token-delta",
    "native-delta",
    "total-supply-delta",
  ] as const;
  const hasExpectedPhysicalEffect = physicalKinds.some((kind) =>
    expected.has(kind)
  );
  if (hasExpectedPhysicalEffect && effects === undefined) {
    throw new Error(
      `request result ${request.id} omitted declared effect observations`,
    );
  }
  if (effects === undefined) return;

  assertEffectCollection({
    requestId: request.id,
    kind: "token-delta",
    expected,
    value: effects.tokenDeltas,
    validate(items) {
      for (const item of items) {
        assertAddress(item.token, `${request.id} token delta token`);
        assertAddress(item.account, `${request.id} token delta account`);
        assertBigInt(item.delta, `${request.id} token delta`);
      }
    },
  });
  assertEffectCollection({
    requestId: request.id,
    kind: "native-delta",
    expected,
    value: effects.nativeDeltas,
    validate(items) {
      for (const item of items) {
        assertAddress(item.account, `${request.id} native delta account`);
        assertBigInt(item.delta, `${request.id} native delta`);
      }
    },
  });
  assertEffectCollection({
    requestId: request.id,
    kind: "total-supply-delta",
    expected,
    value: effects.totalSupplyDeltas,
    validate(items) {
      for (const item of items) {
        assertAddress(item.token, `${request.id} total-supply delta token`);
        assertBigInt(item.delta, `${request.id} total-supply delta`);
      }
    },
  });
  assertEffectCollection({
    requestId: request.id,
    kind: "logs",
    expected,
    value: effects.logs,
    validate(logs) {
      for (const log of logs) {
        assertAddress(log.address, `${request.id} log address`);
        if (!Array.isArray(log.topics)) {
          throw new Error(`request result ${request.id} log topics must be an array`);
        }
        for (const topic of log.topics) {
          if (typeof topic !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(topic)) {
            throw new Error(
              `request result ${request.id} log topic must be 32-byte hex`,
            );
          }
        }
        assertHex(log.data, `${request.id} log data`);
      }
    },
  });

  if (effects.traceRef !== undefined) {
    if (!expected.has("trace")) {
      throw new Error(`request result ${request.id} returned undeclared trace`);
    }
    if (
      typeof effects.traceRef !== "string" ||
      effects.traceRef.length === 0 ||
      effects.traceRef.trim() !== effects.traceRef
    ) {
      throw new Error(`request result ${request.id} trace reference must be canonical`);
    }
  } else if (expected.has("trace")) {
    throw new Error(`request result ${request.id} omitted declared trace`);
  }
}

function assertEffectCollection<T>(input: {
  readonly requestId: string;
  readonly kind: EffectObservationKind;
  readonly expected: ReadonlySet<EffectObservationKind>;
  readonly value: readonly T[] | undefined;
  readonly validate: (value: readonly T[]) => void;
}): void {
  if (input.value === undefined) {
    if (input.expected.has(input.kind)) {
      throw new Error(
        `request result ${input.requestId} omitted declared ${input.kind}`,
      );
    }
    return;
  }
  if (!input.expected.has(input.kind)) {
    throw new Error(
      `request result ${input.requestId} returned undeclared ${input.kind}`,
    );
  }
  if (!Array.isArray(input.value)) {
    throw new Error(
      `request result ${input.requestId} ${input.kind} must be an array`,
    );
  }
  input.validate(input.value);
}

function assertBigInt(value: bigint, label: string): void {
  if (typeof value !== "bigint") throw new Error(`${label} must be bigint`);
}

function assertAddress(value: string, label: string): void {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(value)) {
    throw new Error(`${label} must be a 20-byte hex address`);
  }
}

function freezeCanonicalSource(
  source: CanonicalSource,
  label: string,
): CanonicalSource {
  assertRecordKeys(
    source,
    ["number", "hash", "generation"],
    `${label} source`,
  );
  return Object.freeze({
    number: source.number,
    hash: source.hash,
    generation: source.generation,
  });
}

function assertPlainRecord(
  value: unknown,
  label: string,
): asserts value is Readonly<Record<PropertyKey, unknown>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a plain record`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${label} must be a plain record`);
  }
}

function assertRecordKeys(
  value: unknown,
  allowed: readonly string[],
  label: string,
): void {
  assertPlainRecord(value, label);
  const allowedKeys = new Set<PropertyKey>(allowed);
  for (const key of Reflect.ownKeys(value)) {
    if (!allowedKeys.has(key)) {
      throw new Error(`${label} contains unsupported field ${String(key)}`);
    }
  }
}

function assertHex(value: string, label: string): void {
  if (typeof value !== "string" || !/^0x(?:[0-9a-fA-F]{2})*$/.test(value)) {
    throw new Error(`${label} must be even-length hex bytes`);
  }
}

function assertCallerRef(value: CallerRef): void {
  assertPlainRecord(value, "caller ref");
  switch (value.kind) {
    case "none":
    case "executor":
    case "observed-sender":
      assertRecordKeys(value, ["kind"], `${value.kind} caller ref`);
      return;
    case "verified-actor":
      assertRecordKeys(value, ["kind", "evidenceId"], "verified actor caller ref");
      if (
        typeof value.evidenceId !== "string" ||
        value.evidenceId.length === 0 ||
        value.evidenceId.trim() !== value.evidenceId
      ) {
        throw new Error("verified actor caller evidenceId must be non-empty and canonical");
      }
      return;
    default:
      throw new Error(
        `unsupported caller ref kind: ${String((value as { kind?: unknown }).kind)}`,
      );
  }
}

function sameSource(left: CanonicalSource, right: CanonicalSource): boolean {
  return left.number === right.number &&
    left.generation === right.generation &&
    left.hash.toLowerCase() === right.hash.toLowerCase();
}

function canonicalSourceValue(source: CanonicalSource): CanonicalValue {
  return {
    number: source.number,
    hash: source.hash.toLowerCase(),
    generation: source.generation,
  };
}

function requestCanonicalValue(request: AdapterRequest): CanonicalValue {
  return {
    id: request.id,
    required: request.required !== false,
    physical: physicalRequestCanonicalValue(request),
  };
}

function physicalRequestCanonicalValue(request: AdapterRequest): CanonicalValue {
  switch (request.kind) {
    case "eth-call":
      return {
        kind: request.kind,
        to: request.to.toLowerCase(),
        data: request.data.toLowerCase(),
        caller: callerRefCanonicalValue(request.caller),
        completion: request.completion,
      };
    case "get-code":
      return {
        kind: request.kind,
        address: request.address.toLowerCase(),
      };
    case "get-storage":
      return {
        kind: request.kind,
        address: request.address.toLowerCase(),
        slot: request.slot.toLowerCase(),
      };
    case "state-override-simulation":
    case "effect-delta-simulation":
      return {
        kind: request.kind,
        preCalls: (request.preCalls ?? []).map((call) => ({
          caller: callerRefCanonicalValue(call.caller),
          to: call.to.toLowerCase(),
          data: call.data.toLowerCase(),
        })),
        call: {
          caller: callerRefCanonicalValue(request.call.caller),
          to: request.call.to.toLowerCase(),
          data: request.call.data.toLowerCase(),
        },
        overrideIntent: {
          caller: callerRefCanonicalValue(request.overrideIntent.caller),
          nativeBalanceWei: request.overrideIntent.nativeBalanceWei ?? null,
          tokenBalances: (request.overrideIntent.tokenBalances ?? []).map((item) => ({
            token: item.token.toLowerCase(),
            amount: item.amount,
          })),
        },
        observe: [...request.observe],
      };
  }
}

function callerRefCanonicalValue(caller: CallerRef | undefined): CanonicalValue {
  if (caller === undefined || caller.kind === "none") return null;
  return caller.kind === "verified-actor"
    ? { kind: caller.kind, evidenceId: caller.evidenceId }
    : { kind: caller.kind };
}

function observedEffectsValue(
  effects: ObservedEffects | undefined,
): CanonicalValue {
  if (effects === undefined) return null;
  return {
    tokenDeltas: (effects.tokenDeltas ?? []).map((item) => ({
      token: item.token.toLowerCase(),
      account: item.account.toLowerCase(),
      delta: item.delta,
    })),
    nativeDeltas: (effects.nativeDeltas ?? []).map((item) => ({
      account: item.account.toLowerCase(),
      delta: item.delta,
    })),
    totalSupplyDeltas: (effects.totalSupplyDeltas ?? []).map((item) => ({
      token: item.token.toLowerCase(),
      delta: item.delta,
    })),
    logs: (effects.logs ?? []).map((log) => ({
      address: log.address.toLowerCase(),
      topics: log.topics.map((topic) => topic.toLowerCase()),
      data: log.data.toLowerCase(),
    })),
    traceRef: effects.traceRef ?? "",
  };
}

function requireSynchronous<T>(value: T, label: string): T {
  if (
    value !== null &&
    (typeof value === "object" || typeof value === "function") &&
    typeof (value as { readonly then?: unknown }).then === "function"
  ) {
    throw new Error(`${label} must be synchronous`);
  }
  return value;
}

const ADAPTER_TRANSPORTS = new Set<AdapterTransport>([
  "eth-call",
  "get-code",
  "get-storage",
  "state-override-simulation",
  "effect-delta-simulation",
]);

const REQUEST_CALLERS = new Set<NonNullable<RequestRequirements["caller"]>>([
  "none",
  "executor",
  "observed-sender",
  "verified-actor",
]);

const EFFECT_OBSERVATIONS = new Set<EffectObservationKind>([
  "return-data",
  "revert-data",
  "logs",
  "trace",
  "token-delta",
  "native-delta",
  "total-supply-delta",
]);

const REQUEST_FAILURES = new Set<
  Extract<AdapterRequestResult, { readonly ok: false }>["failure"]
>([
  "rpc",
  "deadline",
  "aborted",
  "resource-limited",
]);

const MAX_UINT256 = (1n << 256n) - 1n;
