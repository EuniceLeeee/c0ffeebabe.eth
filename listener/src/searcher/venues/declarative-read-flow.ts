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
function freeze<T>(value: T): T {
  if (Array.isArray(value)) return Object.freeze(value.map(freeze)) as T;
  if (value && typeof value === "object") {
    if (Object.getPrototypeOf(value) !== Object.prototype) throw new Error("read-flow values must be plain data");
    return Object.freeze(Object.fromEntries(Object.entries(Object.getOwnPropertyDescriptors(value)).map(([key, field]) => {
      if (forbidden.has(key) || !("value" in field)) throw new Error("invalid read-flow data property");
      return [key, freeze(field.value)];
    }))) as T;
  }
  if (typeof value === "function" || typeof value === "symbol") throw new Error("read-flow values must be data");
  return value;
}
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
    keys(step, ["id", "requirements", "requests", hasDecode ? "decode" : "result"], "read-flow step");
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
export function compileDeclarativeReadFlow(raw: unknown, values: ReadFlowValues) {
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
  function requestsAt(index: number, input: ReadFlowInput, steps: Record<string, Value>, seen: ReadonlySet<string>) {
    const requests = values.evaluate(definition.steps[index]!.requests, env(input, steps));
    if (!Array.isArray(requests) || requests.some(request => !request || typeof request !== "object" ||
      typeof request.id !== "string" || !request.id.length || seen.has(request.id)) ||
      new Set(requests.map(request => request.id)).size !== requests.length)
      throw new Error("invalid or duplicate read-flow request ids");
    return freeze(requests) as readonly AdapterRequest[];
  }
  function decodeAt(index: number, input: ReadFlowInput, steps: Record<string, Value>,
    requests: readonly AdapterRequest[], results: readonly AdapterRequestResult[]): Value {
    if (!Array.isArray(results) || results.length !== requests.length || new Set(results.map(result => result.id)).size !== results.length ||
      results.some(result => !requests.some(request => request.id === result.id)))
      throw new Error("read-flow result ids do not match requests");
    const expectedSource = source(input.source);
    for (const result of results) {
      source(result.source); assertSource(result.source, expectedSource);
      if (!result.ok && requests.find(request => request.id === result.id)!.required !== false)
        throw new RequiredAdapterRequestError(result);
    }
    const output = values.run(definition.steps[index]!.decode, env(input, steps, results));
    if (output === undefined) throw new Error("read-flow step returned undefined");
    return freeze(output);
  }
  function reconstruct(input: ReadFlowInput, initialResults: readonly AdapterRequestResult[], prior: readonly unknown[]) {
    source(input.source);
    if (prior.length >= definition.steps.length) throw new Error("too many read-flow rounds");
    const steps: Record<string, Value> = {}, seen = new Set<string>();
    const evidence: { stepId: string; request: AdapterRequest; result: AdapterRequestResult }[] = [];
    for (let index = 0; index <= prior.length; index++) {
      const step = definition.steps[index]!;
      let results = initialResults;
      if (index > 0) {
        const evidence = prior[index - 1];
        keys(evidence, ["stepId", "results"], "read-flow round evidence");
        if (evidence.stepId !== step.id || !Array.isArray(evidence.results)) throw new Error("read-flow round order mismatch");
        results = evidence.results;
      }
      const requests = requestsAt(index, input, steps, seen);
      steps[step.id] = decodeAt(index, input, steps, requests, results);
      requests.forEach(request => {
        seen.add(request.id);
        evidence.push({ stepId: step.id, request, result: results.find(result => result.id === request.id)! });
      });
    }
    return { steps, seen, evidence };
  }
  function bound(index: number, input: ReadFlowInput, steps: Record<string, Value>, seen: ReadonlySet<string>): BoundRequestProgram<ReadFlowRoundEvidence> {
    const scoped = { ...input, source: source(input.source) };
    const requests = requestsAt(index, scoped, steps, seen);
    const requirements = values.evaluate(definition.steps[index]!.requirements, env(scoped, steps));
    if (!requirements || typeof requirements !== "object" || Array.isArray(requirements)) throw new Error("invalid read-flow requirements");
    return Object.freeze({
      requirements: freeze(requirements) as RequestRequirements, requests,
      decode(results: readonly AdapterRequestResult[]) {
        decodeAt(index, scoped, steps, requests, results);
        return freeze({ stepId: definition.steps[index]!.id, results: [...results] });
      },
    });
  }
  const program = Object.freeze<DependentRequestProgram<ReadFlowInput, unknown>>({
    requirements: (input: ReadFlowInput) => bound(0, input, {}, new Set()).requirements,
    buildRequests: (input: ReadFlowInput) => bound(0, input, {}, new Set()).requests,
    buildDependentProgram({ programInput, completedRound, initialResults, priorEvidence }) {
      if (!Number.isSafeInteger(completedRound) || completedRound < 0 || completedRound !== priorEvidence.length)
        throw new Error("read-flow completed round mismatch");
      const { steps, seen } = reconstruct(programInput, initialResults, priorEvidence);
      const next = completedRound + 1;
      return next === definition.steps.length ? null : bound(next, programInput, steps, seen);
    },
    decode({ programInput, initialResults, dependentEvidence }) {
      if (dependentEvidence.length !== definition.steps.length - 1) throw new Error("read-flow is incomplete");
      const { steps } = reconstruct(programInput, initialResults, dependentEvidence);
      const output = values.evaluate(definition.result, env(programInput, steps));
      if (output === undefined) throw new Error("read-flow result is undefined");
      return freeze(output);
    },
  });
  return Object.freeze({ program,
    start: (input: ReadFlowInput) => bound(0, input, {}, new Set()),
    stepIds: Object.freeze(definition.steps.map(step => step.id)),
    observedResults(input: ReadFlowInput, initial: readonly AdapterRequestResult[], dependent: readonly unknown[]) {
      if (dependent.length !== definition.steps.length - 1) throw new Error("read-flow is incomplete");
      return freeze(reconstruct(input, initial, dependent).evidence.map(item => item.result));
    },
    requestEvidence(input: ReadFlowInput, initial: readonly AdapterRequestResult[], dependent: readonly unknown[], stepId: string, requestId: string) {
      if (dependent.length !== definition.steps.length - 1) throw new Error("read-flow is incomplete");
      const found = reconstruct(input, initial, dependent).evidence.find(item => item.stepId === stepId && item.request.id === requestId);
      if (!found) throw new Error("read-flow proof request is missing");
      return freeze({ request: found.request, result: found.result });
    },
  });
}
