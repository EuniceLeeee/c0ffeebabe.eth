import { getAddress } from "ethers";
import { immutableDeclarativeData } from "./declarative-immutable.js";
import { applyExactTrialState, emptyExactTrialState } from "../exact-trial-state.js";
import type { CompiledInstanceDescriptor, ExactQuoteInput, ExactQuoteResult, ExactTrialStateRef,
  ExactTrialStateChange, FamilyRouteDescriptor, LocalExactAttempt } from "./adapter-family-plugin.js";
import type { AdapterRequestResult, CanonicalSource } from "./adapter-request-program.js";
import type { DeclarativeMathFunctions } from "./declarative-math.js";
import { assertModuleData } from "./declarative-modules.js";
import { validateDeclarativeValue } from "./declarative-values.js";
import { assertSource } from "./protocols/standard-family/common.js";

type Value = any;
export interface DeclarativeTrialState {
  readonly version: 1;
  readonly reads: readonly { readonly id: string; readonly refs: Value; readonly initial?: Value;
    readonly onMissing?: "not-applicable" | "continue" }[];
  readonly model: string;
  readonly input: Value;
  readonly amountOut: Value;
  readonly stateChanges: Value;
  readonly stateEffects: Value;
}
const forbidden = new Set(["__proto__", "prototype", "constructor"]);
function shape(value: Value, required: readonly string[], optional: readonly string[], label: string): void {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype ||
    required.some(key => !Object.hasOwn(value, key)) || Reflect.ownKeys(value).some(key => typeof key !== "string" || ![...required, ...optional].includes(key)))
    throw new Error(`invalid trial-state ${label}`);
}
function refs(value: Value, seen: ReadonlySet<string>): void {
  if (typeof value === "string" && /^(\$stateReads|\$stateRefs)(\.|$)/.test(value)) {
    const id = value.split(".")[1];
    if (!id || !seen.has(id)) throw new Error(`unknown or forward trial-state read: ${value}`);
  }
  if (value && typeof value === "object") Object.values(value).forEach(child => refs(child, seen));
}
export function validateDeclarativeTrialState(raw: unknown): asserts raw is DeclarativeTrialState {
  assertModuleData(raw); validateDeclarativeValue(raw);
  shape(raw, ["version", "reads", "model", "input", "amountOut", "stateChanges", "stateEffects"], [], "module");
  const definition = raw as DeclarativeTrialState;
  if (definition.version !== 1 || !Array.isArray(definition.reads) || !definition.reads.length || definition.reads.length > 128 ||
    typeof definition.model !== "string" || !/^[a-zA-Z][a-zA-Z0-9]*$/.test(definition.model) || forbidden.has(definition.model))
    throw new Error("invalid trial-state version, reads or model");
  const seen = new Set<string>();
  for (const read of definition.reads) {
    shape(read, ["id", "refs"], ["initial", "onMissing"], "read");
    if (typeof read.id !== "string" || !/^[a-zA-Z][a-zA-Z0-9]*$/.test(read.id) || forbidden.has(read.id) || seen.has(read.id) ||
      (read.onMissing !== undefined && read.onMissing !== "continue" && read.onMissing !== "not-applicable"))
      throw new Error("invalid trial-state read id or missing policy");
    refs(read.refs, seen); refs(read.initial, seen); seen.add(read.id);
  }
  for (const field of [definition.input, definition.amountOut, definition.stateChanges, definition.stateEffects]) refs(field, seen);
}
function immutable(value: Value): Value { return immutableDeclarativeData(value, "trial"); }
function canonicalSource(value: CanonicalSource): void {
  if (!value || !Number.isSafeInteger(value.number) || value.number < 0 || !Number.isSafeInteger(value.generation) ||
    value.generation < 0 || !/^0x[0-9a-fA-F]{64}$/.test(value.hash)) throw new Error("trial-state requires canonical source");
}
function reference(value: Value): ExactTrialStateRef {
  shape(value, ["key", "schema", "binding"], ["dependencies"], "reference");
  if ([value.key, value.schema, value.binding].some(key => typeof key !== "string" || !key || key.trim() !== key) ||
    (value.dependencies !== undefined && (!Array.isArray(value.dependencies) || value.dependencies.some((key: Value) =>
      typeof key !== "string" || !key || key.trim() !== key)))) throw new Error("invalid trial-state reference binding");
  return immutable({ key: value.key, schema: value.schema, binding: value.binding,
    ...(value.dependencies === undefined ? {} : { dependencies: [...new Set([value.key, ...value.dependencies])].sort() }) });
}
function matching(a: ExactTrialStateRef, b: ExactTrialStateRef): boolean {
  return a.key === b.key && a.schema === b.schema && a.binding === b.binding && a.dependencies !== undefined &&
    JSON.stringify(a.dependencies) === JSON.stringify(b.dependencies);
}

/** Pure trial-cell projection. The existing issuer owns source-bound views and
 * atomic publication; readFlow owns all source reads and dependency scheduling. */
export function compileDeclarativeTrialState<D extends CompiledInstanceDescriptor, R extends FamilyRouteDescriptor, E>(
  raw: unknown,
  options: {
    readonly values: { evaluate(value: Value, environment: Record<string, Value>): Value };
    readonly models: DeclarativeMathFunctions;
    readonly environment: (input: ExactQuoteInput<D, R>) => Record<string, Value>;
    readonly evidence: (input: ExactQuoteInput<D, R>, amountOut: bigint) => E;
  },
) {
  validateDeclarativeTrialState(raw);
  const definition: DeclarativeTrialState = immutable(JSON.parse(JSON.stringify(raw)));
  if (!Object.hasOwn(options.models, definition.model) || typeof options.models[definition.model] !== "function")
    throw new Error("trial-state requires a registered math model");
  const model = options.models[definition.model]!;
  const missing = (id: string): LocalExactAttempt<E> => Object.freeze({ status: "not-applicable", reason: `trial-state-missing:${id}` });
  function run(input: ExactQuoteInput<D, R>, prepared?: unknown): LocalExactAttempt<E> {
    canonicalSource(input.source);
    if (typeof input.amountIn !== "bigint" || input.amountIn <= 0n) throw new Error("trial-state model requires positive input");
    const route = input.route as R & { direction?: string; bindingRef?: { fingerprint?: string } };
    const executor = getAddress(input.executor), direction = route.direction, fingerprint = route.bindingRef?.fingerprint;
    if (typeof direction !== "string" || !direction || typeof fingerprint !== "string" || !fingerprint)
      throw new Error("trial-state invocation lacks direction or binding");
    if (!input.trialState && input.prefix?.length) throw new Error("trial-state prefix requires issued state");
    if (!input.trialState && prepared === undefined) return missing("initial");
    const reads: Record<string, Value> = {}, readRefs: Record<string, readonly ExactTrialStateRef[]> = {}, allRefs: ExactTrialStateRef[] = [];
    let availableCells = 0;
    const checked = (data: Record<string, Value>) => new Proxy(Object.freeze({ ...data }), {
      get(target, key) {
        if (typeof key === "string" && !Object.hasOwn(target, key)) throw new Error(`unavailable trial-state read: ${key}`);
        return Reflect.get(target, key);
      },
      getOwnPropertyDescriptor(target, key) {
        if (typeof key === "string" && !Object.hasOwn(target, key)) throw new Error(`unavailable trial-state read: ${key}`);
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
    });
    const base = { ...options.environment(input), source: immutable(input.source), executor, amountIn: input.amountIn,
      prepared: immutable(prepared) };
    const env = (extra: Record<string, Value> = {}) => ({ ...base, stateReads: checked(reads), stateRefs: checked(readRefs), ...extra });
    for (const read of definition.reads) {
      const evaluated = options.values.evaluate(read.refs, env());
      if (!Array.isArray(evaluated)) throw new Error("trial-state refs must be an array");
      const declared = evaluated.map(reference);
      if (new Set(declared.map(ref => ref.key)).size !== declared.length) throw new Error("duplicate trial-state read reference");
      const current = declared.map(ref => input.trialState?.get(ref)); // conflicts must propagate, never use a baseline
      let initial: readonly unknown[] | undefined;
      if (prepared !== undefined && read.initial !== undefined && current.some(value => value === undefined)) {
        initial = options.values.evaluate(read.initial, env());
        if (!Array.isArray(initial) || initial.length !== declared.length) throw new Error("trial-state initial values do not match references");
      }
      const selected = current.map((value, index) => value === undefined ? initial?.[index] : value);
      if (read.onMissing !== "continue" && selected.some(value => value === undefined)) return missing(read.id);
      availableCells += selected.filter(value => value !== undefined).length;
      reads[read.id] = immutable(selected); readRefs[read.id] = immutable(declared); allRefs.push(...declared);
    }
    if (!availableCells) return missing("initial");
    const modelResult = immutable(model(options.values.evaluate(definition.input, env())));
    const outputEnv = env({ modelResult });
    const amountOut = options.values.evaluate(definition.amountOut, outputEnv);
    if (typeof amountOut !== "bigint" || amountOut <= 0n) throw new Error("trial-state model returned no output");
    const changes = options.values.evaluate(definition.stateChanges, outputEnv) as readonly ExactTrialStateChange[];
    const effects = options.values.evaluate(definition.stateEffects, outputEnv) as readonly string[];
    if (!Array.isArray(changes) || !Array.isArray(effects) || (!changes.length && !effects.length))
      throw new Error("trial-state model must declare its transition");
    const checkedChanges = changes.map(change => {
      shape(change, ["ref", "value"], [], "change");
      const ref = reference(change.ref);
      if (!allRefs.some(read => matching(read, ref))) throw new Error("trial-state change requires a read with complete binding and dependencies");
      input.trialState?.get(ref);
      return { ref, value: immutable(change.value) };
    });
    // Reuse the production transition verifier, including duplicate keys,
    // undefined cells and malformed effect names. The issuer commits later.
    applyExactTrialState(emptyExactTrialState(), checkedChanges, effects);
    const evidence = immutable(options.evidence(input, amountOut));
    canonicalSource(evidence?.source); assertSource(evidence.source, input.source);
    if (getAddress(evidence.executor) !== executor || evidence.direction !== direction || evidence.amountIn !== input.amountIn ||
      evidence.amountOut !== amountOut || evidence.bindingFingerprint !== fingerprint)
      throw new Error("trial-state quote evidence does not match invocation");
    return Object.freeze({ status: "quoted", result: immutable({ amountOut, evidence, stateChanges: checkedChanges, stateEffects: effects }) });
  }
  return Object.freeze({
    model: Object.freeze({ quote: (input: ExactQuoteInput<D, R>) => run(input) }),
    fromReadFlow(input: ExactQuoteInput<D, R>, prepared: unknown, observedResults: readonly AdapterRequestResult[]): ExactQuoteResult<E> {
      canonicalSource(input.source);
      if (prepared === undefined || !observedResults.length || !observedResults.some(result => result.ok))
        throw new Error("trial-state bootstrap requires observed source state");
      if (new Set(observedResults.map(result => result.id)).size !== observedResults.length) throw new Error("duplicate trial-state source result");
      for (const result of observedResults) {
        canonicalSource(result.source); assertSource(result.source, input.source);
        if (result.ok && (!result.provenance?.kind || !result.provenance.fingerprint)) throw new Error("trial-state bootstrap lacks transport provenance");
      }
      const attempt = run(input, prepared);
      if (attempt.status !== "quoted") throw new Error(`trial-state bootstrap remains unavailable: ${attempt.reason}`);
      return attempt.result;
    },
  });
}
