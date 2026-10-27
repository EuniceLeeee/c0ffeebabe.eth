import { getAddress, hexlify } from "ethers";
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
import type { FamilyCandidate, VerifiedIdentity, CompiledInstanceDescriptor, FamilyRouteDescriptor,
  IdentitySemantics, InstanceSemantics, RouteProjectionSemantics, PricingSemantics, ExactQuoteSemantics,
  ExecutionSemantics, FamilyManifest, ProtocolDomainSemantics, ProtocolFamilyPlugin } from "./adapter-family-plugin.js";
import type { AdapterRequest, AdapterRequestResult } from "./adapter-request-program.js";
import { assertSameSource, assertSource, protocolMid, returnedResult, sameAddress,
  type ProtocolPricingSnapshot } from "./protocols/standard-family/common.js";
import { runtimeExecutor, runtimeLeg } from "./runtime-execution.js";
import { buildDeclarativeExecutionProgram, createDeclarativeProgramAction } from "./declarative-execution.js";

type Data = Record<string, any>;
type Descriptor = CompiledInstanceDescriptor & Data;
type Route = FamilyRouteDescriptor & Data;
type Identity = VerifiedIdentity & Data;
type Candidate = FamilyCandidate & Data;
type Values = ReturnType<typeof compileDeclarativeValues>;
type Variant = { document: Data; values: Values };
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
export function createDeclarativeProtocolRuntime(raw: Data, children: readonly Data[] = []) {
  json(raw); children.forEach(json);
  validateDeclarativeValue(raw); children.forEach(v => validateDeclarativeValue(v));
  if (raw.version !== 2 || raw.production?.domain !== "protocol") throw new Error("unsupported declarative protocol version/domain");
  const allowed = new Set(["version", "scope", "production", "manifest", "discovery", "identity", "instance", "routes", "pricing", "protocol", "standard", "variantFiles", "actionAdapters", "types"]);
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
  for (const d of raw.routes.directions) shape(d, ["id", "enabled", "tokenIn", "tokenOut", "adapterId", "taxonomy"], [], "direction declaration");
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
      ["version", "identity", "identityParameters", "assertions", "programs", "inputs", "types"], "variant declaration");
    shape(v.pricing, ["refreshPolicy", "requirements", "dependencies", "mutationAddresses"],
      ["guardProgram", "guardPrefix", "finalizeChecks"], "variant pricing declaration");
    shape(v.exact, ["methodId", "requirements", "evidence"],
      ["guardProgram", "guardPrefix", "caller", "checks", "outputChecks", "protectedAddresses"], "exact declaration");
    if (!["on-touch", "each-block"].includes(v.pricing.refreshPolicy)) throw new Error("invalid declared refresh policy");
    for (const p of Object.values(v.readPrograms)) shape(p as Data, ["requests", "decode"], [], "read program declaration");
    if (!v.readPrograms.quote || !v.execution || typeof v.execution.settlement?.directOutput !== "boolean")
      throw new Error("variant requires quote and settlement declarations");
    if (typeof v.id !== "string" || typeof v.lineageId !== "string") throw new Error("invalid declarative variant identity");
    return { document: v, values: compileDeclarativeValues(v) };
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
  function assertInvocation(descriptor: Descriptor, route: Route): void {
    const v = select(descriptor), env = environment(v, { descriptor, route });
    const d = direction(descriptor, route.direction);
    if (descriptor.familyId !== route.familyId || descriptor.lineageId !== route.lineageId ||
        descriptor.lineageId !== v.document.lineageId || route.instanceKey !== descriptor.instanceKey ||
        !sameAddress(route.target, env.target) || route.bindingRef.fingerprint !== hashCanonical(projection(descriptor)) ||
        route.bindingRef.bindingKey !== evalRoot(document.routes.bindingKey, env) ||
        !sameAddress(route.tokenIn, evalRoot(d.tokenIn, env)) || !sameAddress(route.tokenOut, evalRoot(d.tokenOut, env)) ||
        route.adapterId !== evalRoot(d.adapterId, env)) throw new Error("declarative route binding mismatch");
    rootRun(document.routes.assertions, env);
    v.values.run(v.document.assertions ?? [], env);
  }
  const discovery = compileDeclarativeDiscovery<Candidate>(document.discovery.definition);
  const identity: IdentitySemantics<Candidate, Identity> = {
    memoReuse: document.identity.memoReuse,
    identityKey: identity => evalRoot(document.identity.key, { identity }),
    variants: variants.map((v, index) => {
      const id = index === 0 ? expandConversionDefinition(document.identity.definition) : {
        version: 1 as const, abi: v.document.abi, constants: v.document.constants,
        expressions: v.document.expressions, programs: v.document.programs, inputs: v.document.inputs, identity: v.document.identity,
      };
      return compileDeclarativeIdentity<Candidate, Identity>(id, {
        id: v.document.id, familyId: document.manifest.familyId, lineageId: v.document.lineageId,
        parameters: v.document.identityParameters,
      });
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
      requirements: input => select(input.descriptor).document.pricing.requirements,
      buildRequests(input) {
        const v = select(input.descriptor);
        return frozen([...guard(v, { ...input, direction: undefined }, false), ...input.descriptor.routes.flatMap((route: Route) => {
          const amountIn = evalRoot(document.pricing.sampleAmount, { descriptor: input.descriptor, route });
          return quoteRequests(v, { ...input, route, amountIn }, `current:${route.direction}`);
        })]);
      },
      decodeSnapshot(input) {
        const v = select(input.descriptor), results = input.initialResults;
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
      compile: ({ entries }) => compileAddressMutations(entries, input => ({
        addresses: uniqueAddresses(select(input.descriptor).values.evaluate(select(input.descriptor).document.pricing.mutationAddresses, environment(select(input.descriptor), input))), keys: [input.descriptor.instanceKey],
      }), { kinds: document.pricing.mutationKinds }),
      affectedStateKeys(input) {
        const observation = input.observation;
        if (!document.pricing.mutationKinds.includes(observation.kind)) return [];
        return observation.kind === "log" && uniqueAddresses(select(input.descriptor).values.evaluate(select(input.descriptor).document.pricing.mutationAddresses, environment(select(input.descriptor), input))).some(a => sameAddress(a, observation.address))
          ? [input.descriptor.instanceKey] : [];
      },
    },
  };
  function evidence(input: Data, amountOut: bigint) {
    const v = select(input.descriptor);
    return frozen(v.values.evaluate(v.document.exact.evidence, environment(v, { ...input, amountOut })));
  }
  const exact: ExactQuoteSemantics<Descriptor, Route, Data> = {
    methods: () => Object.freeze([
      localZeroExactMethod("local-zero", input => ({ amountOut: 0n, evidence: evidence(input, 0n) })),
      { id: document.standard.exact.methodId, kind: "request-program" as const, chainAmountQuote: true,
        program: {
          requirements(input) { assertInvocation(input.descriptor, input.route); return select(input.descriptor).document.exact.requirements; },
          buildRequests(input) {
            assertInvocation(input.descriptor, input.route);
            if (input.amountIn < 0n) throw new Error("exact input cannot be negative");
            if (input.amountIn === 0n) return [];
            const v = select(input.descriptor), env = environment(v, input);
            v.values.run(v.document.exact.checks ?? [], env);
            if (v.document.exact.protectedAddresses) runtimeExecutor(input.executor, ...v.values.evaluate(v.document.exact.protectedAddresses, env));
            return frozen([...guard(v, input, true), ...quoteRequests(v, input, "exact-preview")]);
          },
          decode({ programInput: input, initialResults: results }) {
            if (input.amountIn === 0n) return { amountOut: 0n, evidence: evidence(input, 0n) };
            const v = select(input.descriptor), env = environment(v, { ...input, results, requestId: "exact-preview" });
            assertSource(returnedResult(results, "exact-preview").source, input.source);
            const amountOut = program(v, "quote", env, "decode");
            if (typeof amountOut !== "bigint" || amountOut <= 0n) throw new Error("exact quote returned no output");
            const guardResult = guard(v, input, true, results);
            v.values.run(v.document.exact.outputChecks ?? [], { ...env, amountOut, guardResult });
            return frozen({ amountOut, evidence: evidence(input, amountOut) });
          },
        },
      },
    ]),
    cacheCompatibilityProjection: input => evalRoot(document.pricing.exactCompatibility, input),
  };
  function executionProgram(input: Data) {
    const v = select(input.descriptor), env = environment(v, input);
    const spec = v.document.execution;
    if (!spec) throw new Error("missing declared execution direction");
    return buildDeclarativeExecutionProgram(spec, env, v.values);
  }
  const execution: ExecutionSemantics<Descriptor, Route, Data> = {
    runtimeProjection: () => NO_EXECUTION_RUNTIME_PROJECTION,
    buildRuntimeLeg(input) {
      assertInvocation(input.descriptor, input.route);
      const settlement = select(input.descriptor).document.execution.settlement;
      if (input.settlement && (input.settlement.kind !== "direct-output" || !settlement.directOutput)) return null;
      const recipient = input.settlement?.recipient ?? input.executor;
      const program = executionProgram({ descriptor: input.descriptor, route: input.route, executor: input.executor,
        source: input.source, runtimeEvidence: input.runtimeEvidence, settlement: input.settlement,
        recipient, minAmountOut: 1n, settlementRequested: input.settlement !== undefined });
      return { ...runtimeLeg(input.route.adapterId, program), settlement: { directOutput: settlement.directOutput },
        ...(input.settlement ? { settlementRequest: input.settlement } : {}) };
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
  return { definition, assertInvocation, projection, executionProgram, variants, select, program, environment };
}

export function compileDeclarativeProtocol(raw: Data, children?: readonly Data[]): ReturnType<typeof createDeclarativeProtocolRuntime>["definition"];
export function compileDeclarativeProtocol<T extends DeclarativeFamilyTypes>(raw: Data, children?: readonly Data[]): TypedDeclarativeProtocol<T>;
export function compileDeclarativeProtocol(raw: Data, children: readonly Data[] = []): unknown {
  // The only dynamic-to-declared type boundary. JSON registration validates the
  // shared runtime contract; generated field contracts retain consumer checks.
  return createDeclarativeProtocolRuntime(raw, children).definition as unknown as TypedDeclarativeProtocol<DeclarativeFamilyTypes>;
}
