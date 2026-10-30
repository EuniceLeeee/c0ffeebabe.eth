import { compileDeclarativeCreditDomain } from "./declarative-credit-domain.js";
import { compileInstanceEvidence, executionProjection } from "./declarative-instance-evidence.js";
import { compileDeclarativeSwap } from "./declarative-swap-domain.js";
import { projectDeclarativePrices } from "./declarative-pricing-projection.js";
import { buildDeclarativeExecutionSimulation } from "./declarative-simulation.js";
import { getAddress, hexlify } from "ethers";
import { readFamilyModules, type DeclarativeQuoteFlow } from "./declarative-family-modules.js";
import { verifyDeclarativeQuoteChain } from "./declarative-quote-proof.js";
import { compileDeclarativeTrialState } from "./declarative-trial-state.js";
import { compileDeclarativeProtocolDomain } from "./declarative-protocol-domain.js";
import { compileDeclarativeReadFlow } from "./declarative-read-flow.js";
import type { BoundRuntimeMath, createDeclarativeRuntimeMathRegistry } from "./declarative-runtime-math.js";
import type { DeclarativeMathFunctions, createDeclarativeMathRegistry } from "./declarative-math.js";
import { normalizeDeclarativeVariant, normalizeDeclarativeChecks, normalizeDeclarativeFieldModel } from "./declarative-variant.js";
import { validateDeclarativeTypeMetadata } from "./declarative-types.js";
import { compileDeclarativeDiscovery } from "./declarative-discovery.js";
import { compileDeclarativeIdentity } from "./declarative-identity.js";
import { expandConversionDefinition } from "./declarative-definition.js";
import { compileDeclarativeValues, validateDeclarativeValue, validateDeclarativeStatements } from "./declarative-values.js";
import { createCreditCaptureMaterialization, createRouteCaptureMaterialization } from "./capture-materialization.js";
import { compileAddressMutations } from "./mutation-index.js";
import { hashCanonical } from "./canonical-value.js";
import { instanceKey, routeKey } from "./adapter-family-identifiers.js";
import { localZeroExactMethod, NO_EXECUTION_RUNTIME_PROJECTION } from "./adapter-family-plugin.js";
import type { ExactQuoteInput, FamilyCandidate, VerifiedIdentity, CompiledInstanceDescriptor, FamilyRouteDescriptor,
  IdentitySemantics, InstanceSemantics, RouteProjectionSemantics, PricingSemantics, ExactQuoteSemantics,
  ExecutionSemantics, FamilyManifest, ProtocolFamilyPlugin } from "./adapter-family-plugin.js";
import type { AdapterRequest, AdapterRequestResult, RequestRequirements } from "./adapter-request-program.js";
import { assertSameSource, assertSource, protocolMid, returnedResult, sameAddress,
  type ProtocolPricingSnapshot } from "./protocols/standard-family/common.js";
import { runtimeExecutor } from "./runtime-execution.js";
import { buildDeclarativeExecutionProgram, createDeclarativeProgramAction, assertDeclarativeExecutionSource, buildDeclarativeRuntimeLeg,
  type DeclarativeConversionExecution } from "./declarative-execution.js";

type Data = Record<string, any>;
type Descriptor = CompiledInstanceDescriptor & Data;
type Route = FamilyRouteDescriptor & Data;
type Identity = VerifiedIdentity & Data;
type Candidate = FamilyCandidate & Data;
type Values = ReturnType<typeof compileDeclarativeValues>;
type Variant = { document: Data; execution: DeclarativeConversionExecution; values: Values; modules: ReturnType<typeof readFamilyModules>;
  quoteFlow?: ReturnType<typeof compileDeclarativeReadFlow>; pricingFlow?: ReturnType<typeof compileDeclarativeReadFlow>;
  trialState?: ReturnType<typeof compileDeclarativeTrialState<Descriptor, Route, Data>> };
export interface DeclarativeFamilyTypes {
  readonly candidate: FamilyCandidate;
  readonly identity: VerifiedIdentity;
  readonly descriptor: CompiledInstanceDescriptor;
  readonly route: FamilyRouteDescriptor;
  readonly pricingDraft: object;
  readonly pricingDescriptor: object;
  readonly pricingStatic: object;
  readonly exactEvidence: unknown;
}
export type TypedDeclarativeProtocol<T extends DeclarativeFamilyTypes> = ProtocolFamilyPlugin<
  T["candidate"], T["identity"], T["descriptor"], T["route"],
  T["pricingDescriptor"], ProtocolPricingSnapshot, T["exactEvidence"],
  T["descriptor"], T["pricingDraft"], unknown, T["pricingStatic"]
>;
const forbidden = new Set(["__proto__", "prototype", "constructor", "module", "export", "handler"]);

function data(value: unknown, label: string): asserts value is Data {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be a record`);
}
function shape(value: Data, required: readonly string[], optional: readonly string[], label: string): void {
  data(value, label);
  if (required.some(key => !Object.hasOwn(value, key)) ||
      Object.keys(value).some(key => !required.includes(key) && !optional.includes(key)))
    throw new Error(`${label} has missing or unknown fields`);
}
function json(value: any): void {
  if (typeof value === "function" || typeof value === "bigint" || value === undefined ||
      (typeof value === "number" && !Number.isSafeInteger(value))) throw new Error("Family definition must be lossless JSON");
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (forbidden.has(key)) throw new Error(`Family definition contains executable binding: ${key}`);
    json(child);
  }
}
function frozen<T>(value: T): T {
  if (value && typeof value === "object") { Object.values(value).forEach(frozen); Object.freeze(value); }
  return value;
}
function uniqueAddresses(values: readonly string[]): readonly string[] {
  return Object.freeze([...new Set(values.map(v => getAddress(v).toLowerCase()))].sort());
}

/** Validated data is compiled once at registration. No Family identifier is
 * interpreted here; live scheduling and issued-object authority remain outside. */
export function createDeclarativeFamilyRuntime(raw: Data, children: readonly Data[] = [],
  options: { math?: ReturnType<typeof createDeclarativeMathRegistry>; executionMath?: ReturnType<typeof createDeclarativeRuntimeMathRegistry> } = {}) {
  json(raw); children.forEach(json);
  validateDeclarativeValue(raw); children.forEach(v => validateDeclarativeValue(v));
  const domain = raw.production?.domain;
  if (raw.version !== 2 || !["protocol", "swap", "credit"].includes(domain)) throw new Error("unsupported declarative Family version/domain");
  const allowed = new Set(["version", "scope", "production", "manifest", "discovery", "identity", "instance", "routes", "pricing", domain, "standard", "variantFiles", "actionAdapters", "types", "modules"]);
  if (Object.keys(raw).some(key => !allowed.has(key))) throw new Error("unknown declarative protocol field");
  if (Object.hasOwn(raw, "types")) validateDeclarativeTypeMetadata(raw.types);
  for (const key of ["manifest", "discovery", "identity", "instance", "routes", "pricing", domain, "standard"]) data(raw[key], key);
  if (raw.manifest.familyId !== raw.scope?.family || raw.manifest.domain !== domain) throw new Error("declaration manifest identity mismatch");
  if (!Array.isArray(raw.variantFiles) || raw.variantFiles.length !== children.length) throw new Error("declaration child count mismatch");
  shape(raw.instance, ["key", "draft", "bindingProjection"], [], "instance declaration");
  shape(raw.routes, ["target", "bindingKey", "directions", "graphVenue", "effects"], ["assertions", "descriptorChecks", "key"], "route declaration");
  shape(raw.pricing, ["draft", "compatibility", "static", "finalize", "sampleAmount", "exactCompatibility", "mutationKinds"], ["finalizeChecks", "stateKey", "bindingProjection"], "pricing declaration");
  shape(raw.pricing.static, ["requirements", "dependencies", "requests", "decode"], [], "static pricing declaration");
  if (Array.isArray(raw.routes.directions)) validateDirections(raw.routes.directions);
  else if (!raw.routes.directions?.op) throw new Error("directions require a list or declared projection");
  function validateDirections(directions: Data[]): void {
    if (!directions.length || directions.length > 10000 || new Set(directions.map(d => d.id)).size !== directions.length)
      throw new Error("declared directions must be unique and nonempty");
    for (const d of directions) {
      shape(d, ["id", "enabled", "tokenIn", "tokenOut", "adapterId", "taxonomy"], ["executionAssets", "fields"], "direction declaration");
      if (typeof d.id !== "string" || !d.id.trim()) throw new Error("invalid direction identity");
      if (d.fields !== undefined) {
        data(d.fields, "route fields");
        const reserved = ["routeKey", "familyId", "lineageId", "instanceKey", "tokenIn", "tokenOut", "taxonomy", "bindingRef", "runtimeRequirements", "target", "direction", "adapterId", "executionAssets"];
        if (Object.keys(d.fields).some(key => reserved.includes(key))) throw new Error("declared route fields replace a bound field");
      }
    }
  }
  const normalized = JSON.parse(JSON.stringify(raw)) as Data;
  normalized.standard = normalizeDeclarativeVariant(normalized.standard);
  normalized.pricing.static.decode = normalizeDeclarativeFieldModel(normalized.pricing.static.decode);
  if (normalized.routes.descriptorChecks) normalized.routes.descriptorChecks = normalizeDeclarativeChecks(normalized.routes.descriptorChecks);
  if (normalized.routes.assertions) normalized.routes.assertions = normalizeDeclarativeChecks(normalized.routes.assertions);
  if (normalized.pricing.finalizeChecks) normalized.pricing.finalizeChecks = normalizeDeclarativeChecks(normalized.pricing.finalizeChecks);
  const document = frozen(normalized);
  const documents = [document.standard, ...children.map(c => frozen(normalizeDeclarativeVariant(c)))];
  if (new Set(documents.map(v => v.id)).size !== documents.length) throw new Error("duplicate declarative variant");
  const variants: Variant[] = documents.map(v => {
    shape(v, ["id", "lineageId", "abi", "constants", "expressions", "match", "context", "boundState", "pricing", "exact", "readPrograms", "execution"],
      ["version", "identity", "identityParameters", "assertions", "programs", "inputs", "types", "modules", "identityKind"], "variant declaration");
    shape(v.pricing, ["refreshPolicy", "requirements", "dependencies", "mutationAddresses"],
      ["guardProgram", "guardPrefix", "finalizeChecks", "mutationPredicate", "classifyUnavailable"], "variant pricing declaration");
    if (v.exact.unavailableReason !== undefined) {
      shape(v.exact, ["unavailableReason"], [], "unavailable exact declaration");
      if (typeof v.exact.unavailableReason !== "string" || !v.exact.unavailableReason.trim()) throw new Error("exact unavailable reason is required");
    } else {
      shape(v.exact, ["methodId", "requirements", "evidence"],
        ["guardProgram", "guardPrefix", "caller", "checks", "outputChecks", "protectedAddresses", "retainReadEvidence", "zeroEvidence", "stateOnlyReads", "amountOut"], "exact declaration");
      if (v.exact.stateOnlyReads !== undefined && typeof v.exact.stateOnlyReads !== "boolean")
        throw new Error("stateOnlyReads must be an explicit boolean declaration");
      if (v.exact.retainReadEvidence !== undefined && v.exact.retainReadEvidence !== true)
        throw new Error("retainReadEvidence must be true when declared");
    }
    if (!["on-touch", "each-block"].includes(v.pricing.refreshPolicy)) throw new Error("invalid declared refresh policy");
    for (const p of Object.values(v.readPrograms)) shape(p as Data, ["requests", "decode"], [], "read program declaration");
    if (!v.execution || typeof v.execution.settlement?.directOutput !== "boolean")
      throw new Error("variant requires settlement declarations");
    if (Object.hasOwn(v.execution, "quoteOutput"))
      throw new Error("quoteOutput must be declared in modules, not execution");
    if (typeof v.id !== "string" || typeof v.lineageId !== "string") throw new Error("invalid declarative variant identity");
    const modules = readFamilyModules(document.modules, v.modules, options.math, options.executionMath);
    if (Object.keys(modules.blocks.quoteOutput!).length && v.execution.version !== 2)
      throw new Error("quoteOutput requires execution version 2");
    const { modules: _moduleDefinitions, ...valueDefinition } = v;
    const values = compileDeclarativeValues(valueDefinition, {}, modules.get<DeclarativeMathFunctions>("math"));
    if (!v.readPrograms.quote && (!Object.keys(modules.blocks.pricingFlow!).length ||
        (!v.exact.unavailableReason && !Object.keys(modules.blocks.quoteFlow!).length)))
      throw new Error("variant requires quote for legacy pricing/exact");
    if (v.exact.unavailableReason && Object.keys(modules.blocks.quoteFlow!).length)
      throw new Error("exact cannot be both unavailable and defined");
    if (v.exact.retainReadEvidence && !Object.keys(modules.blocks.quoteFlow!).length)
      throw new Error("read evidence requires a quote flow");
    const compileFlow = (name: string) => {
      const block = modules.get<Data>(name);
      if (!block) return undefined;
      const { sourceKind: _source, localStateUnsupportedReason: _reason, chainQuote: _proof, ...flow } = block;
      return compileDeclarativeReadFlow(flow as any, values, (requests, env) => materializeRequests(v, values, modules, requests, env));
    };
    const variant: Variant = { document: v, execution: frozen(executionDefinition(v, modules)), values, modules,
      quoteFlow: compileFlow("quoteFlow"), pricingFlow: compileFlow("pricingFlow") };
    const trial = modules.get<Data>("trialState");
    if (trial && v.exact.retainReadEvidence) throw new Error("trial state does not support retained read evidence");
    if (trial) variant.trialState = compileDeclarativeTrialState<Descriptor, Route, Data>(trial, {
      values, models: modules.require<DeclarativeMathFunctions>("math"),
      environment: input => environment(variant, input), evidence,
    });
    const quote = modules.blocks.quoteFlow as DeclarativeQuoteFlow;
    if (v.exact.stateOnlyReads === true && quote.sourceKind !== "local-math")
      throw new Error("stateOnlyReads requires a local-math quote flow");
    if (quote.sourceKind === "local-math" && !Object.keys(modules.blocks.trialState!).length && !quote.localStateUnsupportedReason)
      throw new Error("local math must explicitly declare its unsupported sequential trial state");
    if (variant.trialState && quote.localStateUnsupportedReason)
      throw new Error("trial state cannot be both implemented and unsupported");
    return variant;
  });
  validateDeclarativeStatements(document.routes.assertions ?? []);
  validateDeclarativeStatements(document.routes.descriptorChecks ?? []);
  validateDeclarativeStatements(document.pricing.static.decode);
  validateDeclarativeStatements(document.pricing.finalizeChecks ?? []);
  for (const { document: v } of variants) {
    for (const list of [v.assertions, v.pricing.finalizeChecks, v.exact.checks, v.exact.outputChecks])
      validateDeclarativeStatements(list ?? []);
    for (const program of Object.values(v.readPrograms) as Data[]) validateDeclarativeStatements(program.decode);
  }
  const primary = variants[0]!;
  if (domain === "credit" && children.length) throw new Error("declarative Credit currently requires one risk-proof variant");
  if (domain !== "protocol" && primary.modules.get("oracleVictim")) throw new Error("oracleVictim is a Protocol capability");
  const evalRoot = (expression: any, env: Data) => primary.values.evaluate(expression, env);
  const rootRun = (statements: any[] | undefined, env: Data) => primary.values.run(statements ?? [], env);
  function select(descriptor: Data): Variant {
    const matches = variants.filter(v => v.values.evaluate(v.document.match, { descriptor }));
    if (matches.length !== 1) throw new Error("descriptor must match exactly one declared variant");
    return matches[0]!;
  }
  function environment(v: Variant, input: Data): Data {
    const descriptor = input.descriptor;
    const env = { ...input, routes: input.routes ?? descriptor?.routes ?? [], direction: input.direction ?? input.route?.direction };
    return { ...env, ...v.values.evaluate(v.document.context ?? {}, env),
      binding: v.values.evaluate(v.document.boundState, env),
      target: evalRoot(document.routes.target, { descriptor }) };
  }
  function program(v: Variant, name: string, env: Data, mode: "requests" | "decode"): any {
    const p = v.document.readPrograms?.[name];
    if (!p) throw new Error(`undefined declarative read program: ${name}`);
    return mode === "requests" ? v.values.evaluate(p.requests, env) : v.values.run(p.decode, env);
  }
  const projection = (descriptor: Descriptor) => evalRoot(document.instance.bindingProjection, { descriptor });
  function directions(descriptor: Descriptor): Data[] {
    const value = document.routes.directions;
    const rows = Array.isArray(value) ? value : evalRoot(value, { descriptor });
    if (!Array.isArray(rows)) throw new Error("declared direction projection must return a list");
    validateDirections(rows);
    return rows;
  }
  const routeCache = new WeakMap<Descriptor, { routes: readonly Route[]; byKey: ReadonlyMap<string, Route> }>();
  function deeplyFrozen(value: unknown, seen = new WeakSet<object>()): boolean {
    if (value === null || typeof value !== "object") return typeof value !== "function";
    if (seen.has(value)) return true;
    if (!Object.isFrozen(value) || (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype)) return false;
    seen.add(value);
    return Object.values(Object.getOwnPropertyDescriptors(value)).every(field => "value" in field && deeplyFrozen(field.value, seen));
  }
  function projectRoutes(descriptor: Descriptor): readonly Route[] {
    const cached = routeCache.get(descriptor);
    if (cached) return cached.routes;
    const v = select(descriptor), env = environment(v, { descriptor });
    rootRun(document.routes.descriptorChecks, env);
    const fingerprint = hashCanonical(projection(descriptor));
    const projected = directions(descriptor).filter(d => evalRoot(d.enabled, env)).map(d => {
      const route = {
        familyId: descriptor.familyId, lineageId: descriptor.lineageId, instanceKey: descriptor.instanceKey,
        tokenIn: getAddress(evalRoot(d.tokenIn, env)), tokenOut: getAddress(evalRoot(d.tokenOut, env)), taxonomy: d.taxonomy,
        bindingRef: { bindingKey: evalRoot(document.routes.bindingKey, env), fingerprint },
        runtimeRequirements: descriptor.runtimeRequirements, target: env.target, direction: d.id,
        adapterId: evalRoot(d.adapterId, env),
        ...(d.executionAssets === undefined ? {} : { executionAssets: executionAssets(d, env) }),
        ...(d.fields === undefined ? {} : evalRoot(d.fields, env)),
      };
      if (sameAddress(route.tokenIn, route.tokenOut)) throw new Error("declared route requires distinct tokens");
      return frozen({ ...route, routeKey: routeKey(document.routes.key === undefined
        ? [descriptor.familyId, route.bindingRef.bindingKey, d.id].join("\u001f")
        : evalRoot(document.routes.key, { ...env, route })) }) as Route;
    });
    if (new Set(projected.map(route => route.routeKey)).size !== projected.length) throw new Error("duplicate declared route key");
    const routes = Object.freeze(projected);
    if (deeplyFrozen(descriptor)) routeCache.set(descriptor, { routes, byKey: new Map(routes.map(route => [route.routeKey, route])) });
    return routes;
  }
  function executionAssets(d: Data, env: Data): FamilyRouteDescriptor["executionAssets"] {
    if (d.executionAssets === undefined) return undefined;
    const assets = evalRoot(d.executionAssets, env);
    shape(assets, ["input", "output"], [], "execution assets");
    if (![assets.input, assets.output].every(v => v === "erc20" || v === "native")) throw new Error("invalid raw execution asset");
    return frozen(assets) as FamilyRouteDescriptor["executionAssets"];
  }
  function assertInvocation(descriptor: Descriptor, route: Route): void {
    const v = select(descriptor), env = environment(v, { descriptor, route });
    const projected = projectRoutes(descriptor);
    const expected = routeCache.get(descriptor)?.byKey.get(route.routeKey) ?? projected.find(candidate => candidate.routeKey === route.routeKey);
    if (!expected || hashCanonical(expected) !== hashCanonical(route)) throw new Error("declarative route binding mismatch");
    rootRun(document.routes.assertions, env);
    v.values.run(v.document.assertions ?? [], env);
  }
  // Pseudo requests exist only inside the Family compiler. The ordinary issuer
  // sees the same authenticated request type as hand-authored Families.
  function executionDefinition(definition: Data, modules: ReturnType<typeof readFamilyModules>) {
    const quoteOutput = modules.get("quoteOutput");
    if (quoteOutput) return { ...definition.execution, quoteOutput };
    // A declared but blocked quote program cannot silently become an unchecked
    // direct-recipient path. Default executor receipt remains independently usable.
    if (Object.keys(modules.blocks.quoteOutput!).length)
      return { ...definition.execution, settlement: { ...definition.execution.settlement, directOutput: false } };
    return definition.execution;
  }
  function materializeRequests(definition: Data, values: Values, modules: ReturnType<typeof readFamilyModules>,
    requests: readonly Data[], env: Data): readonly AdapterRequest[] {
    if (!Array.isArray(requests)) throw new Error("declaration requests must be a list");
    return requests.map(request => {
      if (request.kind !== "declarative-execution-simulation") return request as AdapterRequest;
      const allowed = ["kind", "id", "amountIn", "protectedTokens", "observe", "required", "context"];
      if (Object.keys(request).some(key => !allowed.includes(key))) throw new Error("unknown execution simulation field");
      if (request.context !== undefined && env.descriptor !== undefined)
        throw new Error("quote simulation cannot replace its issued invocation");
      // Identity has no admitted descriptor yet; its context is declared from
      // prior observed facts. The transport still validates the executor actor.
      const input = request.context === undefined ? env : request.context;
      data(input, "execution simulation context");
      assertDeclarativeExecutionSource(input.source);
      if (env.source !== undefined) assertSource(input.source, env.source);
      const invocation = { ...input, direction: input.direction ?? input.route?.direction };
      const context = { ...invocation, ...values.evaluate(definition.context, invocation),
        binding: values.evaluate(definition.boundState, invocation), target: evalRoot(document.routes.target, invocation),
        simulationAmount: request.amountIn, simulationProtectedTokens: request.protectedTokens ?? [] };
      return buildDeclarativeExecutionSimulation({ kind: "declarative-execution-simulation", id: request.id,
        amountIn: "$simulationAmount", protectedTokens: "$simulationProtectedTokens",
        ...(request.observe === undefined ? {} : { observe: request.observe }),
        ...(request.required === undefined ? {} : { required: request.required }) }, context, values, executionDefinition(definition, modules),
        { math: modules.get<BoundRuntimeMath>("executionMath") });
    });
  }
  const discovery = compileDeclarativeDiscovery<Candidate>(document.discovery.definition, primary.values);
  const identity: IdentitySemantics<Candidate, Identity> = {
    memoReuse: document.identity.memoReuse,
    identityKey: identity => evalRoot(document.identity.key, { identity }),
    variants: variants.map((v, index) => {
      const declaredIdentity = index === 0 ? document.identity.definition : undefined;
      const id = declaredIdentity?.workflow ? expandConversionDefinition(declaredIdentity) : {
        version: 1 as const, abi: v.document.abi, constants: v.document.constants,
        expressions: v.document.expressions,
        ...(v.document.programs === undefined ? {} : { programs: v.document.programs }),
        ...(v.document.inputs === undefined ? {} : { inputs: v.document.inputs }),
        ...(v.document.identity === undefined ? {} : { identity: v.document.identity }), ...(declaredIdentity ?? {}),
      };
      return compileDeclarativeIdentity<Candidate, Identity>(id, {
        id: v.document.id, familyId: document.manifest.familyId, lineageId: v.document.lineageId,
        parameters: v.document.identityParameters, kind: v.document.identityKind,
      }, {}, v.modules.get<DeclarativeMathFunctions>("math"), (requests, env) => materializeRequests(v.document, v.values, v.modules, requests, env));
    }),
  };
  requireAvailableExtension(primary, "instanceEvidence");
  const instanceEvidence = primary.modules.get<Data>("instanceEvidence");
  const instance: InstanceSemantics<Identity, Descriptor> = {
    instanceKey: identity => instanceKey(evalRoot(document.instance.key, { identity })),
    compileDraft: identity => frozen(evalRoot(document.instance.draft, { identity })),
    ...(instanceEvidence ? { staticEvidence: compileInstanceEvidence(instanceEvidence, primary.values) } : {}),
    finalizeDescriptor(input) {
      if (!instanceEvidence) return input.draft;
      if (input.staticEvidence === undefined) throw new Error("declared instance evidence is missing");
      primary.values.run(instanceEvidence.checks, input);
      return frozen(primary.values.evaluate(instanceEvidence.finalize, input));
    },
    staticBindingProjection: projection,
  };
  const routes: RouteProjectionSemantics<Descriptor, Route> = {
    project: ({ descriptor }) => projectRoutes(descriptor),
    projectGraph({ descriptor, route }) {
      assertInvocation(descriptor, route);
      return frozen({ routeActionAdapterId: route.adapterId, executionTarget: route.target,
        venueIdentity: evalRoot(document.routes.graphVenue, { descriptor, route }), centralScoreKey: route.routeKey });
    },
  };
  function readEnvironment(v: Variant, input: Data, exact: boolean): Data {
    const policy = v.document[exact ? "exact" : "pricing"];
    return environment(v, { ...input, prefix: policy.guardPrefix, actor: exact ? input.executor : undefined,
      caller: exact && policy.caller ? policy.caller : undefined });
  }
  function quoteRequests(v: Variant, input: Data, requestId: string): readonly AdapterRequest[] {
    const env = environment(v, { ...input, requestId });
    const result = program(v, "quote", env, "requests");
    if (!Array.isArray(result)) throw new Error("declarative quote must produce requests");
    return result;
  }
  function guard(v: Variant, input: Data, exact: boolean, results?: readonly AdapterRequestResult[]) {
    const p = v.document[exact ? "exact" : "pricing"];
    if (!p.guardProgram) return results ? undefined : [];
    return program(v, p.guardProgram, { ...readEnvironment(v, input, exact), results }, results ? "decode" : "requests");
  }
  function requirements(a: RequestRequirements, b?: RequestRequirements): RequestRequirements {
    if (!b) return a;
    if (a.caller && b.caller && a.caller !== b.caller) throw new Error("incompatible declared flow callers");
    return frozen({ transports: [...new Set([...a.transports, ...b.transports])],
      ...(a.caller || b.caller ? { caller: a.caller ?? b.caller } : {}),
      ...(a.completions || b.completions ? { completions: [...new Set([...(a.completions ?? []), ...(b.completions ?? [])])] } : {}),
      ...(a.effects || b.effects ? { effects: [...new Set([...(a.effects ?? []), ...(b.effects ?? [])])] } : {}),
    });
  }
  function requireAvailableExtension(v: Variant, key: string): void {
    const row = v.modules.coverage.find(row => row.key === key)!;
    if (row.state === "blocked") throw new Error(`declarative module unavailable: ${key} requires ${row.missingDependencies.join(",")}`);
  }
  function flowEnvironment(v: Variant, input: Data) {
    return environment(v, input) as import("./declarative-read-flow.js").ReadFlowInput;
  }
  function initialFlowResults(flow: NonNullable<Variant["quoteFlow"]>, env: ReturnType<typeof flowEnvironment>, results: readonly AdapterRequestResult[]) {
    const ids = new Set(flow.program.buildRequests(env).map(request => request.id));
    return results.filter(result => ids.has(result.id));
  }
  function checkedRequests(requests: readonly AdapterRequest[]): readonly AdapterRequest[] {
    if (new Set(requests.map(request => request.id)).size !== requests.length) throw new Error("flow/guard request id collision");
    return frozen(requests);
  }
  function acceptsMutation(input: Data): boolean {
    const v = select(input.descriptor), predicate = v.document.pricing.mutationPredicate;
    return predicate === undefined || v.values.evaluate(predicate, environment(v, input)) === true;
  }
  if (!Array.isArray(document.pricing.mutationKinds) || document.pricing.mutationKinds.some((kind: string) => !["log", "call"].includes(kind)))
    throw new Error("invalid declaration mutation kinds");
  function pricingStateKey(route: Route): string {
    const value = document.pricing.stateKey === undefined ? route.instanceKey : evalRoot(document.pricing.stateKey, { route });
    if (typeof value !== "string" || !value.trim()) throw new Error("invalid pricing state key");
    return value;
  }
  function classifyUnavailable(v: Variant, input: Data): ReadonlyMap<any, string> {
    const declaration = v.document.pricing.classifyUnavailable;
    if (declaration === undefined) return new Map();
    const rows = v.values.evaluate(declaration, environment(v, input));
    if (!Array.isArray(rows)) throw new Error("unavailable prices must be declared key/reason pairs");
    const map = new Map<any, string>();
    for (const row of rows) {
      if (!Array.isArray(row) || row.length !== 2 || !input.routes.some((route: Route) => route.routeKey === row[0]) ||
          map.has(row[0]) || typeof row[1] !== "string" || !row[1].trim()) throw new Error("invalid unavailable price classification");
      map.set(row[0], row[1]);
    }
    return map;
  }
  function validateSnapshot(v: Variant, descriptor: Data, snapshot: ProtocolPricingSnapshot, context: Data) {
    requireAvailableExtension(v, "pricingProjection");
    const pricingProjection = v.modules.get<Data>("pricingProjection");
    if (pricingProjection) {
      v.values.run(pricingProjection.checks, environment(v, { ...context, descriptor, snapshot, routes: descriptor.routes }));
      return;
    }
    data(snapshot.quotes, "pricing flow quotes");
    const routes = descriptor.routes as Route[];
    const unavailable = classifyUnavailable(v, { descriptor, snapshot, routes });
    if (Object.keys(snapshot.quotes).some(key => !routes.some(route => route.routeKey === key)))
      throw new Error("pricing flow quote coverage mismatch");
    for (const route of routes) {
      const quote = snapshot.quotes[route.routeKey];
      if (!quote && unavailable.has(route.routeKey)) continue;
      const amountIn = evalRoot(document.pricing.sampleAmount, { ...context, descriptor, route, snapshot });
      if (!quote || typeof amountIn !== "bigint" || amountIn <= 0n || quote.amountIn !== amountIn ||
          typeof quote.amountOut !== "bigint" || quote.amountOut < 0n || (quote.amountOut === 0n && !unavailable.has(route.routeKey)))
        throw new Error("pricing flow returned incompatible quote");
    }
  }
  const hasLiveProjection = variants.some(v => v.modules.get("liveStateProjection"));
  const pricing: PricingSemantics<Descriptor, Route, Data, ProtocolPricingSnapshot, Data, Data> = {
    ...(hasLiveProjection ? { liveStateProjection: { project(input: any) {
      const v = select(input.descriptor), module = v.modules.get<Data>("liveStateProjection");
      if (!module) throw new Error("live state projection undefined for this variant");
      return frozen(v.values.evaluate(module.result, environment(v, input)));
    } } } : {}),
    refreshPolicyForInstance: ({ descriptor }) => select(descriptor).document.pricing.refreshPolicy,
    stateKey: route => pricingStateKey(route),
    staticBindingProjection: input => document.pricing.bindingProjection === undefined
      ? projection(input.descriptor) : evalRoot(document.pricing.bindingProjection, input),
    snapshotCompatibilityProjection: input => evalRoot(document.pricing.compatibility, input),
    compileDraft(input) {
      if (!input.routes.length || input.routes.some(route => input.stateKey !== pricingStateKey(route)))
        throw new Error("pricing requires one behavior-proven state group");
      input.routes.forEach(r => assertInvocation(input.descriptor, r));
      return frozen(evalRoot(document.pricing.draft, input));
    },
    staticEvidence: {
      // An explicitly dependency-free static stage still needs central source
      // sealing, but cannot issue a dependency proof with no dependency keys.
      reusePolicy: Array.isArray(document.pricing.static.dependencies) && document.pricing.static.dependencies.length === 0
        ? { kind: "source-local" }
        : { kind: "dependency-proof", dependencyKeys: draft => uniqueAddresses(evalRoot(document.pricing.static.dependencies, { draft })) },
      requirements: () => document.pricing.static.requirements,
      buildRequests: draft => evalRoot(document.pricing.static.requests, { draft }),
      decode: input => rootRun(document.pricing.static.decode, input),
    },
    finalizePricingDescriptor(input) {
      if (!input.staticEvidence) throw new Error("pricing lacks static evidence");
      rootRun(document.pricing.finalizeChecks, input);
      const descriptor = evalRoot(document.pricing.finalize, input);
      const v = select(descriptor);
      v.values.run(v.document.pricing.finalizeChecks ?? [], { descriptor });
      return frozen(descriptor);
    },
    current: {
      requirements: input => {
        const v = select(input.descriptor);
        requireAvailableExtension(v, "pricingFlow");
        requireAvailableExtension(v, "pricingProjection");
        return requirements(v.document.pricing.requirements, v.pricingFlow?.program.requirements(flowEnvironment(v, input)));
      },
      buildRequests(input) {
        const v = select(input.descriptor);
        requireAvailableExtension(v, "pricingFlow");
        requireAvailableExtension(v, "pricingProjection");
        if (v.pricingFlow) return checkedRequests([...guard(v, input, false),
          ...v.pricingFlow.program.buildRequests(flowEnvironment(v, input))]);
        return frozen([...guard(v, { ...input, direction: undefined }, false), ...input.descriptor.routes.flatMap((route: Route) => {
          const amountIn = evalRoot(document.pricing.sampleAmount, { descriptor: input.descriptor, route });
          return quoteRequests(v, { ...input, route, amountIn }, `current:${route.direction}`);
        })]);
      },
      buildDependentProgram(input) {
        const v = select(input.current.descriptor);
        requireAvailableExtension(v, "pricingFlow");
        requireAvailableExtension(v, "pricingProjection");
        if (!v.pricingFlow) return null;
        guard(v, input.current, false, input.initialResults);
        const env = flowEnvironment(v, input.current);
        return v.pricingFlow.program.buildDependentProgram!({ programInput: env, completedRound: input.completedRound,
          initialResults: initialFlowResults(v.pricingFlow, env, input.initialResults), priorEvidence: input.priorEvidence });
      },
      decodeSnapshot(input) {
        const v = select(input.descriptor), results = input.initialResults;
        requireAvailableExtension(v, "pricingFlow");
        requireAvailableExtension(v, "pricingProjection");
        if (v.pricingFlow) {
          // Pricing decode has no caller-supplied source: derive it exclusively
          // from the issuer's actual initial observations, not the JSON output.
          if (!results.length) throw new Error("pricing flow needs an observed source in its first round");
          const source = results[0]!.source;
          assertDeclarativeExecutionSource(source);
          results.forEach(result => assertSource(result.source, source));
          const env = flowEnvironment(v, { ...input, source });
          guard(v, env, false, results);
          const snapshot = v.pricingFlow.program.decode({ programInput: env,
            initialResults: initialFlowResults(v.pricingFlow, env, results), dependentEvidence: input.dependentEvidence }) as ProtocolPricingSnapshot;
          data(snapshot, "pricing flow snapshot"); assertSource(snapshot.source, source);
          const context = v.pricingFlow.completedEnvironment(env, initialFlowResults(v.pricingFlow, env, results), input.dependentEvidence);
          validateSnapshot(v, input.descriptor, snapshot, context);
          return frozen(snapshot);
        }
        guard(v, { ...input, routes: input.descriptor.routes }, false, results);
        const quotes: ProtocolPricingSnapshot["quotes"] & Data = {};
        const source = assertSameSource(input.descriptor.routes.map((route: Route) => returnedResult(results, `current:${route.direction}`)));
        for (const route of input.descriptor.routes as Route[]) {
          const amountIn = evalRoot(document.pricing.sampleAmount, { descriptor: input.descriptor, route });
          const env = environment(v, { ...input, route, results, source, amountIn, requestId: `current:${route.direction}` });
          const amountOut = program(v, "quote", env, "decode");
          if (typeof amountOut !== "bigint" || amountOut < 0n) throw new Error("declarative quote returned invalid output");
          quotes[route.routeKey] = { amountIn, amountOut };
        }
        const snapshot = { source, quotes };
        validateSnapshot(v, input.descriptor, snapshot, {});
        return frozen(snapshot);
      },
      deriveMids({ descriptor, snapshot, routes }) {
        const v = select(descriptor);
        const unavailable = classifyUnavailable(v, { descriptor, snapshot, routes });
        requireAvailableExtension(v, "pricingProjection");
        const projection = v.modules.get<Data>("pricingProjection");
        if (projection) return projectDeclarativePrices({ domain, routes, unavailable,
          rows: v.values.evaluate(projection.rows, environment(v, { descriptor, snapshot, routes })) });
        return new Map(routes.filter(route => !unavailable.has(route.routeKey)).map(route => {
          const quote = snapshot.quotes[route.routeKey];
          if (!quote || quote.amountOut <= 0n) throw new Error("current quote missing");
          return [route.routeKey, protocolMid({ route, adapterId: route.adapterId, target: route.target, quote })];
        }));
      },
      classifyUnavailable: input => classifyUnavailable(select(input.descriptor), input),
    },
    dependencies(input) {
      const v = select(input.descriptor);
      return uniqueAddresses(v.values.evaluate(v.document.pricing.dependencies, environment(v, input)));
    },
    mutation: {
      compile: ({ entries }) => {
        // The address index normalizes its keys; pricing state keys are opaque.
        // Use local canonical IDs and return the original keys without folding.
        const indexed = entries.map((entry, index) => {
          const keys = [...new Set(entry.routes.map(pricingStateKey))];
          const stateKey = entry.stateKey ?? (keys.length === 1 ? keys[0] : undefined);
          if (!stateKey || keys.some(key => key !== stateKey)) throw new Error("mutation entry must identify one pricing state group");
          return { ...entry, stateKey, mutationKey: `group:${index}` };
        });
        const byKey = new Map(indexed.map(entry => [entry.mutationKey, entry]));
        const indexKeys = new Map(indexed.map(entry => [entry.stateKey, entry.mutationKey]));
        const index = compileAddressMutations(indexed, input => ({
          addresses: uniqueAddresses(select(input.descriptor).values.evaluate(select(input.descriptor).document.pricing.mutationAddresses, environment(select(input.descriptor), input))), keys: [indexKeys.get(input.stateKey)!],
        }), { kinds: document.pricing.mutationKinds });
        return { dependencies: index.dependencies, affectedStateKeys: ({ observation }) =>
          index.affectedStateKeys({ observation }).map(key => byKey.get(key)!)
            .filter(entry => acceptsMutation({ ...entry, observation })).map(entry => entry.stateKey) };
      },
      affectedStateKeys(input) {
        const observation = input.observation;
        if (!document.pricing.mutationKinds.includes(observation.kind)) return [];
        const target = observation.kind === "log" ? observation.address : observation.kind === "call" ? observation.target : undefined;
        if (!target || !acceptsMutation(input)) return [];
        const v = select(input.descriptor), env = environment(v, input);
        const dependencies = uniqueAddresses(v.values.evaluate(v.document.pricing.dependencies, env));
        return dependencies.some(a => sameAddress(a, target)) &&
          uniqueAddresses(v.values.evaluate(v.document.pricing.mutationAddresses, env)).some(a => sameAddress(a, target))
          ? [...new Set(input.routes.map(pricingStateKey))] : [];
      },
    },
  };
  function evidence(input: Data, amountOut: bigint) {
    const v = select(input.descriptor);
    const declaration = input.amountIn === 0n && amountOut === 0n && v.document.exact.zeroEvidence !== undefined ? v.document.exact.zeroEvidence : v.document.exact.evidence;
    const value = v.values.evaluate(declaration, environment(v, { ...input, amountOut }));
    if (value && Object.hasOwn(value, "readProof")) throw new Error("exact evidence cannot replace framework read proof");
    return frozen(v.trialState ? { ...value, executor: getAddress(input.executor) } : value);
  }
  const exact: ExactQuoteSemantics<Descriptor, Route, Data> = {
    methods: invocation => {
      const selected = invocation ? select(invocation.descriptor) : primary;
      if (selected.document.exact.unavailableReason) return Object.freeze([]);
      requireAvailableExtension(selected, "quoteFlow");
      requireAvailableExtension(selected, "trialState");
      const provenance = selected.modules.get<DeclarativeQuoteFlow>("quoteFlow");
      return Object.freeze([
      localZeroExactMethod("local-zero", input => {
        assertInvocation(input.descriptor, input.route);
        const v = select(input.descriptor);
        const env = environment(v, input);
        assertDeclarativeExecutionSource(input.source);
        v.values.run(v.document.exact.checks ?? [], env);
        if (v.document.exact.protectedAddresses) runtimeExecutor(input.executor, ...v.values.evaluate(v.document.exact.protectedAddresses, env));
        return { amountOut: 0n, evidence: evidence(input, 0n) };
      }),
      { id: selected.document.exact.methodId, kind: "request-program" as const,
        ...(provenance?.sourceKind === "local-math"
          ? { ...(selected.document.exact.stateOnlyReads === true ? { stateOnlyReads: true as const } : {}),
              trialState: selected.trialState && selected.trialState.isAvailable(invocation) ? { quote(input: ExactQuoteInput<Descriptor, Route>) {
              assertInvocation(input.descriptor, input.route);
              const v = select(input.descriptor), env = environment(v, input);
              requireAvailableExtension(v, "trialState");
              if (!v.trialState) throw new Error("trial-state method/variant mismatch");
              v.values.run(v.document.exact.checks ?? [], env);
              if (v.document.exact.protectedAddresses) runtimeExecutor(input.executor, ...v.values.evaluate(v.document.exact.protectedAddresses, env));
              // A guard requiring chain results cannot be skipped by a local hit.
              if (v.document.exact.guardProgram && guard(v, input, true).length) return { status: "not-applicable" as const, reason: "declared guard requires source reads" };
              const guardResult = guard(v, input, true, []);
              const attempt = v.trialState.model.quote(input);
              if (attempt.status === "quoted") v.values.run(v.document.exact.outputChecks ?? [], { ...env, amountOut: attempt.result.amountOut, guardResult });
              return attempt;
            } } : { unsupportedReason: selected.trialState?.unsupportedReason ?? provenance.localStateUnsupportedReason! } }
          : { chainAmountQuote: true as const }),
        program: {
          requirements(input) {
            assertInvocation(input.descriptor, input.route);
            const v = select(input.descriptor);
            requireAvailableExtension(v, "quoteFlow");
            requireAvailableExtension(v, "trialState");
            v.values.run(v.document.exact.checks ?? [], environment(v, input));
            return requirements(v.document.exact.requirements, v.quoteFlow?.program.requirements(flowEnvironment(v, input)));
          },
          buildRequests(input) {
            assertInvocation(input.descriptor, input.route);
            if (input.amountIn < 0n) throw new Error("exact input cannot be negative");
            if (input.amountIn === 0n) return [];
            const v = select(input.descriptor), env = environment(v, input);
            requireAvailableExtension(v, "quoteFlow");
            requireAvailableExtension(v, "trialState");
            v.values.run(v.document.exact.checks ?? [], env);
            if (v.document.exact.protectedAddresses) runtimeExecutor(input.executor, ...v.values.evaluate(v.document.exact.protectedAddresses, env));
            return checkedRequests([...guard(v, input, true), ...(v.quoteFlow
              ? v.quoteFlow.program.buildRequests(flowEnvironment(v, input)) : quoteRequests(v, input, "exact-preview"))]);
          },
          buildDependentProgram(input) {
            const v = select(input.programInput.descriptor);
            requireAvailableExtension(v, "quoteFlow");
            requireAvailableExtension(v, "trialState");
            if (!v.quoteFlow || input.programInput.amountIn === 0n) return null;
            assertInvocation(input.programInput.descriptor, input.programInput.route);
            guard(v, input.programInput, true, input.initialResults);
            const env = flowEnvironment(v, input.programInput);
            return v.quoteFlow.program.buildDependentProgram!({ ...input, programInput: env,
              initialResults: initialFlowResults(v.quoteFlow, env, input.initialResults) });
          },
          decode: decodeExact,
        },
      },
    ]);
    },
    cacheCompatibilityProjection: input => evalRoot(document.pricing.exactCompatibility, input),
  };
  function decodeExact({ programInput: input, initialResults: results, dependentEvidence }: {
    programInput: ExactQuoteInput<Descriptor, Route>; initialResults: readonly AdapterRequestResult[]; dependentEvidence: readonly unknown[];
  }) {
            assertInvocation(input.descriptor, input.route);
            select(input.descriptor).values.run(select(input.descriptor).document.exact.checks ?? [], environment(select(input.descriptor), input));
            if (input.amountIn === 0n) return { amountOut: 0n, evidence: evidence(input, 0n) };
            const v = select(input.descriptor), env = environment(v, { ...input, results, requestId: "exact-preview" });
            requireAvailableExtension(v, "quoteFlow");
            requireAvailableExtension(v, "trialState");
            if (!v.quoteFlow) assertSource(returnedResult(results, "exact-preview").source, input.source);
            const flowInput = flowEnvironment(v, input);
            const output = v.quoteFlow ? v.quoteFlow.program.decode({ programInput: flowInput,
              initialResults: initialFlowResults(v.quoteFlow, flowInput, results), dependentEvidence }) : program(v, "quote", env, "decode");
            const transition = v.trialState?.isAvailable(input) ? v.trialState.fromReadFlow(input, output, v.quoteFlow!.observedResults(flowInput,
              initialFlowResults(v.quoteFlow!, flowInput, results), dependentEvidence)) : undefined;
            const amountOut = transition ? transition.amountOut : v.document.exact.amountOut === undefined ? output
              : v.values.evaluate(v.document.exact.amountOut, { ...env, quoteResult: output });
            if (typeof amountOut !== "bigint" || amountOut < 0n) throw new Error("exact quote returned invalid output");
            const declaration = v.modules.get<DeclarativeQuoteFlow>("quoteFlow");
            if (v.quoteFlow && declaration && declaration.sourceKind !== "local-math") {
              verifyDeclarativeQuoteChain({ proof: declaration.chainQuote, sourceKind: declaration.sourceKind,
                observation: proof => v.quoteFlow!.requestEvidence(flowInput,
                  initialFlowResults(v.quoteFlow!, flowInput, results), dependentEvidence, proof.step, proof.requestId),
                source: input.source, amountIn: input.amountIn, amountOut,
                tokenIn: input.route.tokenIn, tokenOut: input.route.tokenOut, executor: input.executor });
            }
            const guardResult = guard(v, input, true, results);
            v.values.run(v.document.exact.outputChecks ?? [], { ...env, amountOut, guardResult });
            if (transition) return frozen(transition);
            const context = v.quoteFlow ? v.quoteFlow.completedEnvironment(flowInput,
              initialFlowResults(v.quoteFlow, flowInput, results), dependentEvidence) : env;
            const fields = evidence({ ...context, ...input, quoteResult: output }, amountOut);
            if (amountOut === 0n && (typeof fields?.unavailableReason !== "string" || !fields.unavailableReason.trim()))
              throw new Error("zero exact output requires an unavailableReason");
            return frozen({ amountOut, evidence: v.document.exact.retainReadEvidence
              ? { ...fields, readProof: { initialResults: results, dependentEvidence } } : fields });
  }
  function executionProgram(input: Data) {
    const v = select(input.descriptor), env = environment(v, input);
    const spec = v.execution;
    if (!spec) throw new Error("missing declared execution direction");
    return buildDeclarativeExecutionProgram(spec, env, v.values, { math: v.modules.get<BoundRuntimeMath>("executionMath") });
  }
  const credit = domain === "credit" ? compileDeclarativeCreditDomain(document.credit, primary.values, {
    assertInvocation: input => assertInvocation(input.descriptor, input.route),
    environment: input => environment(select(input.descriptor), input),
    materializeRequests: (requests, env) => materializeRequests(primary.document, primary.values, primary.modules, requests, env),
  }) : undefined;
  const execution: ExecutionSemantics<Descriptor, Route, Data> = {
    runtimeProjection(input) {
      const module = primary.modules.get<Data>("executionProjection");
      return module ? executionProjection(primary.values.evaluate(module.result, input)) : NO_EXECUTION_RUNTIME_PROJECTION;
    },
    ...(domain === "credit" ? {} : { buildRuntimeLeg(input: Parameters<NonNullable<ExecutionSemantics<Descriptor, Route, Data>["buildRuntimeLeg"]>>[0]) {
      assertInvocation(input.descriptor, input.route);
      const v = select(input.descriptor);
      const env = environment(v, { descriptor: input.descriptor, route: input.route, executor: input.executor,
        source: input.source, transactionOrigin: input.transactionOrigin,
        runtimeEvidence: input.runtimeEvidence, settlement: input.settlement });
      return buildDeclarativeRuntimeLeg(v.execution, env, v.values,
        { math: v.modules.get<BoundRuntimeMath>("executionMath") });
    } }),
    buildFragment(input) {
      assertInvocation(input.descriptor, input.route);
      const e = input.exactEvidence, v = select(input.descriptor);
      const creditProof = credit?.verifyExecutionEvidence(input, e) === true;
      if (domain === "credit" && !creditProof) throw new Error("Credit execution requires issuer-bound risk proof");
      if (!creditProof && v.document.exact.unavailableReason) throw new Error(v.document.exact.unavailableReason);
      let expected: Data;
      if (creditProof) expected = e;
      else if (v.document.exact.retainReadEvidence) {
        data(e.readProof, "execution read proof");
        shape(e.readProof, ["initialResults", "dependentEvidence"], [], "execution read proof");
        const decoded = decodeExact({ programInput: { ...input, source: e.source } as any,
          initialResults: e.readProof.initialResults, dependentEvidence: e.readProof.dependentEvidence });
        if (decoded.amountOut !== input.quotedAmountOut) throw new Error("execution read proof amount mismatch");
        expected = decoded.evidence;
      } else expected = evidence({ ...input, source: e.source }, input.quotedAmountOut);
      if (e.executor !== undefined && !sameAddress(e.executor, input.executor)) throw new Error("execution actor/evidence mismatch");
      if (input.amountIn <= 0n || input.quotedAmountOut <= 0n || input.minAmountOut <= 0n || input.minAmountOut > input.quotedAmountOut ||
          hashCanonical(e) !== hashCanonical(expected))
        throw new Error("execution received incompatible exact evidence");
      const program = executionProgram({ ...input, source: e.source, recipient: input.executor, settlementRequested: false,
        // Debt is fixed only after the issuer-bound quote proof above. Credit
        // intentionally has no runtime leg; this field never enters Swap.
        ...(domain === "credit" ? { creditQuote: { amountOut: input.quotedAmountOut } } : {}) });
      return { requirements: [], nodes: [{ adapterId: input.route.adapterId, target: input.route.target,
        tokenIn: input.route.tokenIn, tokenOut: input.route.tokenOut, amount: input.amountIn,
        params: { runtimeAmountProgram: hexlify(program.bytes()) }, children: [] }] };
    },
    expectedEffects: input => evalRoot(document.routes.effects, input),
  };
  const actionAdapters = document.actionAdapters.map((action: Data) => createDeclarativeProgramAction(action.descriptor, action.traces));
  const definition = {
    manifest: document.manifest as FamilyManifest<"protocol">,
    capture: (domain === "credit" ? createCreditCaptureMaterialization : createRouteCaptureMaterialization)({ familyId: document.manifest.familyId, discovery }),
    discovery, identity, instance, routes, pricing, exact, execution,
    ...(domain === "protocol"
      ? { protocol: compileDeclarativeProtocolDomain(document.protocol, primary.values, primary.modules.get("oracleVictim")) }
      : domain === "swap"
        ? { swap: compileDeclarativeSwap(document.swap, primary.values, document.manifest) }
        : { credit: credit!.definition }),
    actionAdapters,
  };
  return { definition, assertInvocation, projection, executionProgram, variants, select, program, environment,
    moduleCoverage: variants.map(v => ({ variant: v.document.id, modules: v.modules.coverage })),
    moduleViews: variants.map(v => ({ variant: v.document.id, modules: v.modules.blocks })),
  };
}
