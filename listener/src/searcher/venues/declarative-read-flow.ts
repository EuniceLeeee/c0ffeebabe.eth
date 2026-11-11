import { immutableDeclarativeData } from "./declarative-immutable.js";
import type { BoundRequestProgram, DependentRequestProgram } from "./adapter-family-plugin.js";
import type { AdapterRequest, AdapterRequestResult, CanonicalSource, RequestRequirements } from "./adapter-request-program.js";
import { RequiredAdapterRequestError } from "./adapter-request-failure.js";
import { validateDeclarativeStatements, validateDeclarativeValue } from "./declarative-values.js";
import { assertSource } from "./protocols/standard-family/common.js";

type Value = any;
export type ReadFlowInput = Readonly<Record<string, Value>> & { readonly source: CanonicalSource };
export interface DeclarativeReadFlow {
  readonly version: 1;
  readonly steps: readonly {
    readonly id: string;
    readonly when?: Value;
    readonly requirements: Value;
    readonly requests: Value;
    readonly decode?: readonly Value[];
    readonly result?: Value;
  }[];
  readonly result: Value;
}
export interface ReadFlowValues {
  evaluate(value: Value, env: Record<string, Value>): Value;
  run(statements: readonly Value[], env: Record<string, Value>): Value;
}
export interface ReadFlowRoundEvidence {
  readonly stepId: string;
  readonly results: readonly AdapterRequestResult[];
}
const forbidden = new Set(["__proto__", "prototype", "constructor"]);
function keys(value: unknown, allowed: readonly string[], label: string): asserts value is Record<string, Value> {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
    Object.keys(value).length !== allowed.length || Object.keys(value).some(key => !allowed.includes(key)))
    throw new Error(`invalid ${label}`);
}
function freeze<T>(value: T): T { return immutableDeclarativeData(value, "trial"); }
function source(value: CanonicalSource): CanonicalSource {
  if (!value || !Number.isSafeInteger(value.number) || value.number < 0 ||
    !Number.isSafeInteger(value.generation) || value.generation < 0 || !/^0x[0-9a-fA-F]{64}$/.test(value.hash))
    throw new Error("read flow requires canonical source");
  return Object.freeze({ ...value });
}
function references(value: Value, known: ReadonlySet<string>): void {
  if (typeof value === "string" && (value === "$steps" || value.startsWith("$steps."))) {
    const id = value.split(".")[1];
    if (!id || !known.has(id)) throw new Error(`unknown or forward read-flow reference: ${value}`);
  }
  if (value && typeof value === "object") Object.values(value).forEach(child => references(child, known));
}

export function validateDeclarativeReadFlow(raw: unknown): asserts raw is DeclarativeReadFlow {
  validateDeclarativeValue(raw);
  keys(raw, ["version", "steps", "result"], "read flow");
  if (raw.version !== 1 || !Array.isArray(raw.steps) || !raw.steps.length || raw.steps.length > 128)
    throw new Error("unsupported read-flow version or step budget");
  const seen = new Set<string>();
  for (const step of raw.steps) {
    const hasDecode = Object.hasOwn(step, "decode");
    keys(step, ["id", "requirements", "requests", hasDecode ? "decode" : "result", ...(Object.hasOwn(step, "when") ? ["when"] : [])], "read-flow step");
    if (step.when !== undefined) {
      if (!seen.size) throw new Error("the initial read-flow step must be unconditional");
      references(step.when, new Set()); // Selection depends only on this invocation, before any evidence is acquired.
    }
    if (typeof step.id !== "string" || !/^[a-zA-Z][a-zA-Z0-9]*$/.test(step.id) || forbidden.has(step.id) || seen.has(step.id))
      throw new Error("invalid or duplicate read-flow step id");
    references(step.requirements, seen); references(step.requests, seen); references(hasDecode ? step.decode : step.result, seen);
    if (hasDecode) validateDeclarativeStatements(step.decode);
    seen.add(step.id);
  }
  references(raw.result, seen);
}

/** JSON owns the ordered dependency rounds. The returned program declares
 * work to the existing issuer/scheduler; it performs no transport or scheduling.
 * Each invocation is reconstructed from its source-bound prior round evidence. */
export function compileDeclarativeReadFlow(raw: unknown, values: ReadFlowValues,
  materializeRequests?: (requests: readonly Value[], environment: Record<string, Value>) => readonly AdapterRequest[]) {
  validateDeclarativeReadFlow(raw);
  const copied: DeclarativeReadFlow = JSON.parse(JSON.stringify(raw));
  const definition = freeze({ ...copied, steps: copied.steps.map(step => ({ ...step,
    decode: step.decode ?? [{ return: step.result }],
  })) });
  const env = (input: ReadFlowInput, steps: Record<string, Value>, results: readonly AdapterRequestResult[] = []) => {
    // Named value expressions can hide a reference from the flow's structural
    // scan. Access to an unfinished step still fails before a call is declared.
    const available = Object.freeze({ ...steps });
    const checked = new Proxy(available, {
      get(target, key) {
        if (typeof key === "string" && !Object.hasOwn(target, key)) throw new Error(`unavailable read-flow step: ${key}`);
        return Reflect.get(target, key);
      },
      getOwnPropertyDescriptor(target, key) {
        if (typeof key === "string" && !Object.hasOwn(target, key)) throw new Error(`unavailable read-flow step: ${key}`);
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
    });
    return { ...input, steps: checked, results };
  };
  const conditional = definition.steps.some(step => step.when !== undefined);
  function invocationSteps(input: ReadFlowInput) {
    if (!conditional) return definition.steps;
    return definition.steps.filter(step => {
      if (step.when === undefined) return true;
      const enabled = values.evaluate(step.when, env(input, {}));
      if (typeof enabled !== "boolean") throw new Error("read-flow step condition must be boolean");
      return enabled;
    });
  }
  function requestsAt(step: (typeof definition.steps)[number], input: ReadFlowInput, steps: Record<string, Value>, seen: ReadonlySet<string>) {
    const environment = env(input, steps);
    const declared = values.evaluate(step.requests, environment);
    const requests = materializeRequests ? materializeRequests(declared, environment) : declared;
    if (!Array.isArray(requests) || requests.some(request => !request || typeof request !== "object" ||
      typeof request.id !== "string" || !request.id.length || seen.has(request.id)) ||
      new Set(requests.map(request => request.id)).size !== requests.length)
      throw new Error("invalid or duplicate read-flow request ids");
    return freeze(requests) as readonly AdapterRequest[];
  }
  function decodeAt(step: (typeof definition.steps)[number], input: ReadFlowInput, steps: Record<string, Value>,
    requests: readonly AdapterRequest[], results: readonly AdapterRequestResult[]) {
    if (!Array.isArray(results) || results.length !== requests.length)
      throw new Error("read-flow result ids do not match requests");
    const requestsById = new Map(requests.map(request => [request.id, request]));
    const resultsById = new Map<string, AdapterRequestResult>();
    for (const result of results) {
      if (resultsById.has(result.id) || !requestsById.has(result.id))
        throw new Error("read-flow result ids do not match requests");
      resultsById.set(result.id, result);
    }
    const expectedSource = source(input.source);
    for (const result of results) {
      source(result.source); assertSource(result.source, expectedSource);
      if (!result.ok && requestsById.get(result.id)!.required !== false)
        throw new RequiredAdapterRequestError(result);
    }
    const output = values.run(step.decode, { ...env(input, steps, results), requests });
    if (output === undefined) throw new Error("read-flow step returned undefined");
    return { output: freeze(output), resultsById };
  }
  function reconstruct(input: ReadFlowInput, initialResults: readonly AdapterRequestResult[], prior: readonly unknown[]) {
    source(input.source);
    const active = invocationSteps(input);
    if (prior.length >= active.length) throw new Error("too many read-flow rounds");
    const steps: Record<string, Value> = {}, seen = new Set<string>();
    const evidence: { stepId: string; request: AdapterRequest; result: AdapterRequestResult }[] = [];
    for (let index = 0; index <= prior.length; index++) {
      const step = active[index]!;
      let results = initialResults;
      if (index > 0) {
        const evidence = prior[index - 1];
        keys(evidence, ["stepId", "results"], "read-flow round evidence");
        if (evidence.stepId !== step.id || !Array.isArray(evidence.results)) throw new Error("read-flow round order mismatch");
        results = evidence.results;
      }
      const requests = requestsAt(step, input, steps, seen);
      const decoded = decodeAt(step, input, steps, requests, results);
      steps[step.id] = decoded.output;
      requests.forEach(request => {
        seen.add(request.id);
        evidence.push({ stepId: step.id, request, result: decoded.resultsById.get(request.id)! });
      });
    }
    return { steps, seen, evidence, active };
  }
  function bound(step: (typeof definition.steps)[number], input: ReadFlowInput, steps: Record<string, Value>, seen: ReadonlySet<string>): BoundRequestProgram<ReadFlowRoundEvidence> {
    const scoped = { ...input, source: source(input.source) };
    const requests = requestsAt(step, scoped, steps, seen);
    const requirements = values.evaluate(step.requirements, env(scoped, steps));
    if (!requirements || typeof requirements !== "object" || Array.isArray(requirements)) throw new Error("invalid read-flow requirements");
    return Object.freeze({
      requirements: freeze(requirements) as RequestRequirements, requests,
      decode(results: readonly AdapterRequestResult[]) {
        decodeAt(step, scoped, steps, requests, results);
        return freeze({ stepId: step.id, results: [...results] });
      },
    });
  }
  // A caller consuming output, context and proof from one synchronous decode
  // can share this reconstruction. It is invocation-local: no source, amount,
  // request or result is memoized across calls, including calls with the same
  // object identities but changed contents.
  function complete(input: ReadFlowInput, initial: readonly AdapterRequestResult[], dependent: readonly unknown[]) {
    if (dependent.length !== invocationSteps(input).length - 1) throw new Error("read-flow is incomplete");
    const { steps, evidence } = reconstruct(input, initial, dependent);
    return Object.freeze({
      decode(): unknown {
        const output = values.evaluate(definition.result, env(input, steps));
        if (output === undefined) throw new Error("read-flow result is undefined");
        return freeze(output);
      },
      environment: () => env(input, steps, initial),
      observedResults: () => freeze(evidence.map(item => item.result)),
      requestEvidence(stepId: string, requestId: string) {
        const found = evidence.find(item => item.stepId === stepId && item.request.id === requestId);
        if (!found) throw new Error("read-flow proof request is missing");
        return freeze({ request: found.request, result: found.result });
      },
    });
  }
  const program = Object.freeze<DependentRequestProgram<ReadFlowInput, unknown>>({
    requirements: (input: ReadFlowInput) => bound(definition.steps[0]!, input, {}, new Set()).requirements,
    buildRequests: (input: ReadFlowInput) => bound(definition.steps[0]!, input, {}, new Set()).requests,
    buildDependentProgram({ programInput, completedRound, initialResults, priorEvidence }) {
      if (!Number.isSafeInteger(completedRound) || completedRound < 0 || completedRound !== priorEvidence.length)
        throw new Error("read-flow completed round mismatch");
      const { steps, seen, active } = reconstruct(programInput, initialResults, priorEvidence);
      const next = completedRound + 1;
      return next === active.length ? null : bound(active[next]!, programInput, steps, seen);
    },
    decode({ programInput, initialResults, dependentEvidence }) {
      return complete(programInput, initialResults, dependentEvidence).decode();
    },
  });
  return Object.freeze({ program, complete,
    start: (input: ReadFlowInput) => bound(definition.steps[0]!, input, {}, new Set()),
    stepIds: Object.freeze(definition.steps.map(step => step.id)),
    completedEnvironment(input: ReadFlowInput, initial: readonly AdapterRequestResult[], dependent: readonly unknown[]) {
      return complete(input, initial, dependent).environment();
    },
    observedResults(input: ReadFlowInput, initial: readonly AdapterRequestResult[], dependent: readonly unknown[]) {
      return complete(input, initial, dependent).observedResults();
    },
    requestEvidence(input: ReadFlowInput, initial: readonly AdapterRequestResult[], dependent: readonly unknown[], stepId: string, requestId: string) {
      return complete(input, initial, dependent).requestEvidence(stepId, requestId);
    },
  });
}
