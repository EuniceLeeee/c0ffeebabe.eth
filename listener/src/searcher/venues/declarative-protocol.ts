import { getAddress, hexlify } from "ethers";
import { readProtocolModules, type DeclarativeQuoteFlow } from "./declarative-protocol-modules.js";
import { verifyDeclarativeQuoteProof } from "./declarative-quote-proof.js";
import { compileDeclarativeTrialState } from "./declarative-trial-state.js";
import { compileDeclarativeReadFlow } from "./declarative-read-flow.js";
import type { BoundRuntimeMath, createDeclarativeRuntimeMathRegistry } from "./declarative-runtime-math.js";
import type { DeclarativeMathFunctions, createDeclarativeMathRegistry } from "./declarative-math.js";
import { normalizeDeclarativeVariant, normalizeDeclarativeChecks, normalizeDeclarativeFieldModel } from "./declarative-variant.js";
import { validateDeclarativeTypeMetadata } from "./declarative-types.js";
import { compileDeclarativeDiscovery } from "./declarative-discovery.js";
import { compileDeclarativeIdentity } from "./declarative-identity.js";
import { expandConversionDefinition } from "./declarative-definition.js";
import { compileDeclarativeValues, validateDeclarativeValue, validateDeclarativeStatements } from "./declarative-values.js";
import { createRouteCaptureMaterialization } from "./capture-materialization.js";
import { compileAddressMutations } from "./mutation-index.js";
import { hashCanonical } from "./canonical-value.js";
import { instanceKey, routeKey } from "./adapter-family-identifiers.js";
import { localZeroExactMethod, NO_EXECUTION_RUNTIME_PROJECTION } from "./adapter-family-plugin.js";
import type { ExactQuoteInput, FamilyCandidate, VerifiedIdentity, CompiledInstanceDescriptor, FamilyRouteDescriptor,
  IdentitySemantics, InstanceSemantics, RouteProjectionSemantics, PricingSemantics, ExactQuoteSemantics,
  ExecutionSemantics, FamilyManifest, ProtocolDomainSemantics, ProtocolFamilyPlugin } from "./adapter-family-plugin.js";
import type { AdapterRequest, AdapterRequestResult, RequestRequirements } from "./adapter-request-program.js";
import { assertSameSource, assertSource, protocolMid, returnedResult, sameAddress,
  type ProtocolPricingSnapshot } from "./protocols/standard-family/common.js";
import { runtimeExecutor } from "./runtime-execution.js";
import { buildDeclarativeExecutionProgram, createDeclarativeProgramAction, assertDeclarativeExecutionSource, buildDeclarativeRuntimeLeg } from "./declarative-execution.js";

type Data = Record<string, any>;
type Descriptor = CompiledInstanceDescriptor & Data;
type Route = FamilyRouteDescriptor & Data;
type Identity = VerifiedIdentity & Data;
type Candidate = FamilyCandidate & Data;
type Values = ReturnType<typeof compileDeclarativeValues>;
type Variant = { document: Data; values: Values; modules: ReturnType<typeof readProtocolModules>;
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
export function createDeclarativeProtocolRuntime(raw: Data, children: readonly Data[] = [],
  options: { math?: ReturnType<typeof createDeclarativeMathRegistry>; executionMath?: ReturnType<typeof createDeclarativeRuntimeMathRegistry> } = {}) {
  json(raw); children.forEach(json);
  validateDeclarativeValue(raw); children.forEach(v => validateDeclarativeValue(v));
  if (raw.version !== 2 || raw.production?.domain !== "protocol") throw new Error("unsupported declarative protocol version/domain");
  const allowed = new Set(["version", "scope", "production", "manifest", "discovery", "identity", "instance", "routes", "pricing", "protocol", "standard", "variantFiles", "actionAdapters", "types", "modules"]);
  if (Object.keys(raw).some(key => !allowed.has(key))) throw new Error("unknown declarative protocol field");
  if (Object.hasOwn(raw, "types")) validateDeclarativeTypeMetadata(raw.types);
  for (const key of ["manifest", "discovery", "identity", "instance", "routes", "pricing", "protocol", "standard"]) data(raw[key], key);
  if (raw.manifest.familyId !== raw.scope?.family || raw.manifest.domain !== "protocol") throw new Error("declaration manifest identity mismatch");
  if (!Array.isArray(raw.variantFiles) || raw.variantFiles.length !== children.length) throw new Error("declaration child count mismatch");
  shape(raw.instance, ["key", "draft", "bindingProjection"], [], "instance declaration");
  shape(raw.routes, ["target", "bindingKey", "directions", "graphVenue", "effects"], ["assertions"], "route declaration");
  shape(raw.pricing, ["draft", "compatibility", "static", "finalize", "sampleAmount", "exactCompatibility", "mutationKinds"], ["finalizeChecks"], "pricing declaration");
  shape(raw.pricing.static, ["requirements", "dependencies", "requests", "decode"], [], "static pricing declaration");
  if (!Array.isArray(raw.routes.directions) || !raw.routes.directions.length ||
      new Set(raw.routes.directions.map((d: Data) => d.id)).size !== raw.routes.directions.length)
    throw new Error("declared directions must be unique and nonempty");
  for (const d of raw.routes.directions) shape(d, ["id", "enabled", "tokenIn", "tokenOut", "adapterId", "taxonomy"], ["executionAssets"], "direction declaration");
  const normalized = JSON.parse(JSON.stringify(raw)) as Data;
  normalized.standard = normalizeDeclarativeVariant(normalized.standard);
  normalized.pricing.static.decode = normalizeDeclarativeFieldModel(normalized.pricing.static.decode);
  if (normalized.routes.assertions) normalized.routes.assertions = normalizeDeclarativeChecks(normalized.routes.assertions);
  if (normalized.pricing.finalizeChecks) normalized.pricing.finalizeChecks = normalizeDeclarativeChecks(normalized.pricing.finalizeChecks);
  const document = frozen(normalized);
  const documents = [document.standard, ...children.map(c => frozen(normalizeDeclarativeVariant(c)))];
  if (new Set(documents.map(v => v.id)).size !== documents.length) throw new Error("duplicate declarative variant");
  const variants: Variant[] = documents.map(v => {
    shape(v, ["id", "lineageId", "abi", "constants", "expressions", "match", "context", "boundState", "pricing", "exact", "readPrograms", "execution"],
      ["version", "identity", "identityParameters", "assertions", "programs", "inputs", "types", "modules", "identityKind"], "variant declaration");
    shape(v.pricing, ["refreshPolicy", "requirements", "dependencies", "mutationAddresses"],
      ["guardProgram", "guardPrefix", "finalizeChecks", "mutationPredicate"], "variant pricing declaration");
    shape(v.exact, ["methodId", "requirements", "evidence"],
      ["guardProgram", "guardPrefix", "caller", "checks", "outputChecks", "protectedAddresses"], "exact declaration");
    if (!["on-touch", "each-block"].includes(v.pricing.refreshPolicy)) throw new Error("invalid declared refresh policy");
    for (const p of Object.values(v.readPrograms)) shape(p as Data, ["requests", "decode"], [], "read program declaration");
    if (!v.execution || typeof v.execution.settlement?.directOutput !== "boolean")
      throw new Error("variant requires settlement declarations");
    if (typeof v.id !== "string" || typeof v.lineageId !== "string") throw new Error("invalid declarative variant identity");
    const modules = readProtocolModules(document.modules, v.modules, options.math, options.executionMath);
    const { modules: _moduleDefinitions, ...valueDefinition } = v;
    const values = compileDeclarativeValues(valueDefinition, {}, modules.get<DeclarativeMathFunctions>("math"));
    if (!v.readPrograms.quote && (!Object.keys(modules.blocks.quoteFlow!).length || !Object.keys(modules.blocks.pricingFlow!).length))
      throw new Error("variant requires quote for legacy pricing/exact");
    const compileFlow = (name: string) => {
      const block = modules.get<Data>(name);
      if (!block) return undefined;
      const { sourceKind: _source, localStateUnsupportedReason: _reason, chainQuote: _proof, ...flow } = block;
      return compileDeclarativeReadFlow(flow as any, values);
    };
    const variant: Variant = { document: v, values, modules, quoteFlow: compileFlow("quoteFlow"), pricingFlow: compileFlow("pricingFlow") };
    const trial = modules.get<Data>("trialState");
    if (trial) variant.trialState = compileDeclarativeTrialState<Descriptor, Route, Data>(trial, {
      values, models: modules.require<DeclarativeMathFunctions>("math"),
      environment: input => environment(variant, input), evidence,
    });
    const quote = modules.blocks.quoteFlow as DeclarativeQuoteFlow;
    if (quote.sourceKind === "local-math" && !Object.keys(modules.blocks.trialState!).length && !quote.localStateUnsupportedReason)
      throw new Error("local math must explicitly declare its unsupported sequential trial state");
    if (variant.trialState && quote.localStateUnsupportedReason)
      throw new Error("trial state cannot be both implemented and unsupported");
    return variant;
  });
  validateDeclarativeStatements(document.routes.assertions ?? []);
  validateDeclarativeStatements(document.pricing.static.decode);
  validateDeclarativeStatements(document.pricing.finalizeChecks ?? []);
  for (const { document: v } of variants) {
    for (const list of [v.assertions, v.pricing.finalizeChecks, v.exact.checks, v.exact.outputChecks])
      validateDeclarativeStatements(list ?? []);
    for (const program of Object.values(v.readPrograms) as Data[]) validateDeclarativeStatements(program.decode);
  }
  const primary = variants[0]!;
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
  function direction(descriptor: Descriptor, name: string): Data {
    const matches = document.routes.directions.filter((d: Data) => d.id === name);
    if (matches.length !== 1) throw new Error("unknown declared route direction");
    const spec = matches[0];
    if (!evalRoot(spec.enabled, { descriptor })) throw new Error("route direction was not behavior-proven");
    return spec;
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
    const d = direction(descriptor, route.direction);
    if (descriptor.familyId !== route.familyId || descriptor.lineageId !== route.lineageId ||
        descriptor.lineageId !== v.document.lineageId || route.instanceKey !== descriptor.instanceKey ||
        !sameAddress(route.target, env.target) || route.bindingRef.fingerprint !== hashCanonical(projection(descriptor)) ||
        route.bindingRef.bindingKey !== evalRoot(document.routes.bindingKey, env) ||
        !sameAddress(route.tokenIn, evalRoot(d.tokenIn, env)) || !sameAddress(route.tokenOut, evalRoot(d.tokenOut, env)) ||
        route.adapterId !== evalRoot(d.adapterId, env) ||
        JSON.stringify(route.executionAssets) !== JSON.stringify(executionAssets(d, env))) throw new Error("declarative route binding mismatch");
    rootRun(document.routes.assertions, env);
    v.values.run(v.document.assertions ?? [], env);
  }
  const discovery = compileDeclarativeDiscovery<Candidate>(document.discovery.definition);
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
      }, {}, v.modules.get<DeclarativeMathFunctions>("math"));
    }),
  };
  const instance: InstanceSemantics<Identity, Descriptor> = {
    instanceKey: identity => instanceKey(evalRoot(document.instance.key, { identity })),
    compileDraft: identity => frozen(evalRoot(document.instance.draft, { identity })),
    finalizeDescriptor: ({ draft }) => draft,
    staticBindingProjection: projection,
  };
  const routes: RouteProjectionSemantics<Descriptor, Route> = {
    project({ descriptor }) {
      const v = select(descriptor), env = environment(v, { descriptor });
      const fingerprint = hashCanonical(projection(descriptor));
      return Object.freeze(document.routes.directions.filter((d: Data) => evalRoot(d.enabled, env)).map((d: Data) => frozen({
        routeKey: routeKey([descriptor.familyId, evalRoot(document.routes.bindingKey, env), d.id].join("\u001f")),
        familyId: descriptor.familyId, lineageId: descriptor.lineageId, instanceKey: descriptor.instanceKey,
        tokenIn: evalRoot(d.tokenIn, env), tokenOut: evalRoot(d.tokenOut, env), taxonomy: d.taxonomy,
        bindingRef: { bindingKey: evalRoot(document.routes.bindingKey, env), fingerprint },
        runtimeRequirements: descriptor.runtimeRequirements, target: env.target, direction: d.id,
        adapterId: evalRoot(d.adapterId, env),
        ...(d.executionAssets === undefined ? {} : { executionAssets: executionAssets(d, env) }),
      })));
    },
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
  const pricing: PricingSemantics<Descriptor, Route, Data, ProtocolPricingSnapshot, Data, Data> = {
    refreshPolicyForInstance: ({ descriptor }) => select(descriptor).document.pricing.refreshPolicy,
    stateKey: route => route.instanceKey,
    staticBindingProjection: ({ descriptor }) => projection(descriptor),
    snapshotCompatibilityProjection: input => evalRoot(document.pricing.compatibility, input),
    compileDraft(input) {
      if (input.stateKey !== input.descriptor.instanceKey || !input.routes.length) throw new Error("pricing requires behavior-proven routes");
      input.routes.forEach(r => assertInvocation(input.descriptor, r));
      return frozen(evalRoot(document.pricing.draft, input));
    },
    staticEvidence: {
      reusePolicy: { kind: "dependency-proof", dependencyKeys: draft => uniqueAddresses(evalRoot(document.pricing.static.dependencies, { draft })) },
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
        return requirements(v.document.pricing.requirements, v.pricingFlow?.program.requirements(flowEnvironment(v, input)));
      },
      buildRequests(input) {
        const v = select(input.descriptor);
        requireAvailableExtension(v, "pricingFlow");
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
        if (!v.pricingFlow) return null;
        guard(v, input.current, false, input.initialResults);
        const env = flowEnvironment(v, input.current);
        return v.pricingFlow.program.buildDependentProgram!({ programInput: env, completedRound: input.completedRound,
          initialResults: initialFlowResults(v.pricingFlow, env, input.initialResults), priorEvidence: input.priorEvidence });
      },
      decodeSnapshot(input) {
        const v = select(input.descriptor), results = input.initialResults;
        requireAvailableExtension(v, "pricingFlow");
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
          data(snapshot, "pricing flow snapshot"); data(snapshot.quotes, "pricing flow quotes"); assertSource(snapshot.source, source);
          if (Object.keys(snapshot.quotes).length !== input.descriptor.routes.length) throw new Error("pricing flow quote coverage mismatch");
          for (const route of input.descriptor.routes as Route[]) {
            const quote = snapshot.quotes[route.routeKey];
            if (!quote || quote.amountIn !== evalRoot(document.pricing.sampleAmount, { descriptor: input.descriptor, route }) ||
              typeof quote.amountOut !== "bigint" || quote.amountOut <= 0n) throw new Error("pricing flow returned incompatible quote");
          }
          return frozen(snapshot);
        }
        guard(v, { ...input, routes: input.descriptor.routes }, false, results);
        const quotes: ProtocolPricingSnapshot["quotes"] & Data = {};
        const source = assertSameSource(input.descriptor.routes.map((route: Route) => returnedResult(results, `current:${route.direction}`)));
        for (const route of input.descriptor.routes as Route[]) {
          const amountIn = evalRoot(document.pricing.sampleAmount, { descriptor: input.descriptor, route });
          const env = environment(v, { ...input, route, results, source, amountIn, requestId: `current:${route.direction}` });
          const amountOut = program(v, "quote", env, "decode");
          if (typeof amountOut !== "bigint" || amountOut <= 0n) throw new Error("declarative quote returned no output");
          quotes[route.routeKey] = { amountIn, amountOut };
        }
        return frozen({ source, quotes });
      },
      deriveMids({ descriptor, snapshot, routes }) {
        return new Map(routes.map(route => {
          const quote = snapshot.quotes[route.routeKey];
          if (!quote) throw new Error("current quote missing");
          return [route.routeKey, protocolMid({ route, adapterId: route.adapterId, target: route.target, quote })];
        }));
      },
    },
    dependencies(input) {
      const v = select(input.descriptor);
      return uniqueAddresses(v.values.evaluate(v.document.pricing.dependencies, environment(v, input)));
    },
    mutation: {
      compile: ({ entries }) => {
        const byKey = new Map(entries.map(entry => [entry.descriptor.instanceKey.toLowerCase(), entry]));
        const index = compileAddressMutations(entries, input => ({
          addresses: uniqueAddresses(select(input.descriptor).values.evaluate(select(input.descriptor).document.pricing.mutationAddresses, environment(select(input.descriptor), input))), keys: [input.descriptor.instanceKey],
        }), { kinds: document.pricing.mutationKinds });
        return { dependencies: index.dependencies, affectedStateKeys: ({ observation }) =>
          index.affectedStateKeys({ observation }).filter(key => acceptsMutation({ ...byKey.get(key)!, observation })) };
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
          ? [input.descriptor.instanceKey] : [];
      },
    },
  };
  function evidence(input: Data, amountOut: bigint) {
    const v = select(input.descriptor);
    const value = v.values.evaluate(v.document.exact.evidence, environment(v, { ...input, amountOut }));
    return frozen(v.trialState ? { ...value, executor: getAddress(input.executor) } : value);
  }
  const exact: ExactQuoteSemantics<Descriptor, Route, Data> = {
    methods: invocation => {
      const selected = invocation ? select(invocation.descriptor) : primary;
      requireAvailableExtension(selected, "quoteFlow");
      requireAvailableExtension(selected, "trialState");
      const provenance = selected.modules.get<DeclarativeQuoteFlow>("quoteFlow");
      return Object.freeze([
      localZeroExactMethod("local-zero", input => ({ amountOut: 0n, evidence: evidence(input, 0n) })),
      { id: document.standard.exact.methodId, kind: "request-program" as const,
        ...(provenance?.sourceKind === "local-math"
          ? { trialState: selected.trialState ? { quote(input: ExactQuoteInput<Descriptor, Route>) {
              assertInvocation(input.descriptor, input.route);
              const v = select(input.descriptor), env = environment(v, input);
              requireAvailableExtension(v, "trialState");
              if (!v.trialState) throw new Error("trial-state method/variant mismatch");
              v.values.run(v.document.exact.checks ?? [], env);
              if (v.document.exact.protectedAddresses) runtimeExecutor(input.executor, ...v.values.evaluate(v.document.exact.protectedAddresses, env));
              // A guard requiring chain results cannot be skipped by a local hit.
              if (v.document.exact.guardProgram) return { status: "not-applicable" as const, reason: "declared guard requires source reads" };
              const attempt = v.trialState.model.quote(input);
              if (attempt.status === "quoted") v.values.run(v.document.exact.outputChecks ?? [], { ...env, amountOut: attempt.result.amountOut });
              return attempt;
            } } : { unsupportedReason: provenance.localStateUnsupportedReason! } }
          : { chainAmountQuote: true as const }),
        program: {
          requirements(input) {
            assertInvocation(input.descriptor, input.route);
            const v = select(input.descriptor);
            requireAvailableExtension(v, "quoteFlow");
            requireAvailableExtension(v, "trialState");
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
          decode({ programInput: input, initialResults: results, dependentEvidence }) {
            if (input.amountIn === 0n) return { amountOut: 0n, evidence: evidence(input, 0n) };
            const v = select(input.descriptor), env = environment(v, { ...input, results, requestId: "exact-preview" });
            requireAvailableExtension(v, "quoteFlow");
            requireAvailableExtension(v, "trialState");
            if (!v.quoteFlow) assertSource(returnedResult(results, "exact-preview").source, input.source);
            const flowInput = flowEnvironment(v, input);
            const output = v.quoteFlow ? v.quoteFlow.program.decode({ programInput: flowInput,
              initialResults: initialFlowResults(v.quoteFlow, flowInput, results), dependentEvidence }) : program(v, "quote", env, "decode");
            const transition = v.trialState?.fromReadFlow(input, output, v.quoteFlow!.observedResults(flowInput,
              initialFlowResults(v.quoteFlow!, flowInput, results), dependentEvidence));
            const amountOut = transition ? transition.amountOut : output;
            if (typeof amountOut !== "bigint" || amountOut <= 0n) throw new Error("exact quote returned no output");
            const declaration = v.modules.get<DeclarativeQuoteFlow>("quoteFlow");
            if (v.quoteFlow && declaration && declaration.sourceKind !== "local-math") {
              const proof = declaration.chainQuote as { step: string; requestId: string };
              const observed = v.quoteFlow.requestEvidence(flowInput,
                initialFlowResults(v.quoteFlow, flowInput, results), dependentEvidence, proof.step, proof.requestId);
              verifyDeclarativeQuoteProof({ proof, sourceKind: declaration.sourceKind, ...observed,
                source: input.source, amountIn: input.amountIn, amountOut,
                tokenIn: input.route.tokenIn, tokenOut: input.route.tokenOut, executor: input.executor });
            }
            const guardResult = guard(v, input, true, results);
            v.values.run(v.document.exact.outputChecks ?? [], { ...env, amountOut, guardResult });
            return frozen(transition ?? { amountOut, evidence: evidence(input, amountOut) });
          },
        },
      },
    ]);
    },
    cacheCompatibilityProjection: input => evalRoot(document.pricing.exactCompatibility, input),
  };
  function executionProgram(input: Data) {
    const v = select(input.descriptor), env = environment(v, input);
    const spec = v.document.execution;
    if (!spec) throw new Error("missing declared execution direction");
    return buildDeclarativeExecutionProgram(spec, env, v.values, { math: v.modules.get<BoundRuntimeMath>("executionMath") });
  }
  const execution: ExecutionSemantics<Descriptor, Route, Data> = {
    runtimeProjection: () => NO_EXECUTION_RUNTIME_PROJECTION,
    buildRuntimeLeg(input) {
      assertInvocation(input.descriptor, input.route);
      const v = select(input.descriptor);
      const env = environment(v, { descriptor: input.descriptor, route: input.route, executor: input.executor,
        source: input.source, transactionOrigin: input.transactionOrigin,
        runtimeEvidence: input.runtimeEvidence, settlement: input.settlement });
      return buildDeclarativeRuntimeLeg(v.document.execution, env, v.values,
        { math: v.modules.get<BoundRuntimeMath>("executionMath") });
    },
    buildFragment(input) {
      assertInvocation(input.descriptor, input.route);
      const e = input.exactEvidence;
      if (e.executor !== undefined && !sameAddress(e.executor, input.executor)) throw new Error("execution actor/evidence mismatch");
      if (input.amountIn <= 0n || input.quotedAmountOut <= 0n ||
          hashCanonical(e) !== hashCanonical(evidence({ ...input, source: e.source }, input.quotedAmountOut)))
        throw new Error("execution received incompatible exact evidence");
      const program = executionProgram({ ...input, source: e.source, recipient: input.executor, settlementRequested: false });
      return { requirements: [], nodes: [{ adapterId: input.route.adapterId, target: input.route.target,
        tokenIn: input.route.tokenIn, tokenOut: input.route.tokenOut, amount: input.amountIn,
        params: { runtimeAmountProgram: hexlify(program.bytes()) }, children: [] }] };
    },
    expectedEffects: input => evalRoot(document.routes.effects, input),
  };
  const actionAdapters = document.actionAdapters.map((action: Data) => createDeclarativeProgramAction(action.descriptor, action.traces));
  const definition = {
    manifest: document.manifest as FamilyManifest<"protocol">,
    capture: createRouteCaptureMaterialization({ familyId: document.manifest.familyId, discovery }),
    discovery, identity, instance, routes, pricing, exact, execution,
    protocol: document.protocol as ProtocolDomainSemantics, actionAdapters,
  };
  return { definition, assertInvocation, projection, executionProgram, variants, select, program, environment,
    moduleCoverage: variants.map(v => ({ variant: v.document.id, modules: v.modules.coverage })),
    moduleViews: variants.map(v => ({ variant: v.document.id, modules: v.modules.blocks })),
  };
}

export function compileDeclarativeProtocol(raw: Data, children?: readonly Data[]): ReturnType<typeof createDeclarativeProtocolRuntime>["definition"];
export function compileDeclarativeProtocol<T extends DeclarativeFamilyTypes>(raw: Data, children?: readonly Data[]): TypedDeclarativeProtocol<T>;
export function compileDeclarativeProtocol(raw: Data, children: readonly Data[] = []): unknown {
  // The only dynamic-to-declared type boundary. JSON registration validates the
  // shared runtime contract; generated field contracts retain consumer checks.
  return createDeclarativeProtocolRuntime(raw, children).definition as unknown as TypedDeclarativeProtocol<DeclarativeFamilyTypes>;
}
