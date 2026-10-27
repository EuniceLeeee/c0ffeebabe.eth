import { validateDeclarativeValue } from "./declarative-values.js";

// A fixed Family admission lifecycle. Protocol definitions provide view/function
// names, source relationships, direction samples and expected effects, never
// executable stages or callbacks. Its expanded form is an internal compiler IR.
type V = any;
const o = (op: string, ...args: V[]) => ({ op, args });
const letValue = (name: string, value: V) => ({ let: name, value });
const check = (assert: V, error: V) => ({ assert, error });
const result = (value: V, when?: V) => ({ return: value, ...(when === undefined ? {} : { when }) });
const run = (value: V) => ({ evaluate: value });
const eq = (a: V, b: V) => o("eq", a, b);
const not = (a: V) => o("not", a);
const choose = (condition: V, yes: V, no: V) => o("if", condition, yes, no);
const join = (...values: V[]) => o("join", values, "");
const call = (name: string, args: V = {}) => o("program", name, args);
const expression = (name: string, args: V = {}) => o("expression", name, args);
const input = (name: string) => `$evidence.${name}`;
const source = () => o("source", o("map", "$results", "row", o("successful", "$row.id")));
const returnedData = (id: V) => o("get", o("returned", id), "data");
const zero = o("uint", "0");

interface ObservedBalance {
  readonly token: V;
  readonly account: V;
  readonly delta: V;
}
interface ConversionAdmission {
  readonly version: 1;
  readonly requestPrefix: string;
  readonly retryPrefix: string;
  readonly match: {
    readonly phase: string;
    readonly kind: "runtime-template" | "registry-pointer";
    readonly requirements: V;
    readonly requests: V;
    readonly sourceFailure: "retry" | "propagate";
    readonly templateProgram?: string;
    readonly codeRequestId: string;
    readonly valueRequestId?: string;
    readonly abi?: string;
    readonly function?: string;
    readonly candidateValue: V;
    readonly noCodeReason?: string;
    readonly mismatchReason: string;
    readonly malformedReason?: string;
  };
  readonly surface: {
    readonly requirements: V;
    readonly requests: V;
    readonly decode: V;
    readonly sourceFailure: "retry" | "propagate";
    readonly forbiddenActor?: V;
    readonly forbiddenActorReason?: string;
  };
  readonly dependencies: {
    readonly requirements: V;
    readonly requests: V;
    readonly decode: V;
    readonly sourceFailure: "retry" | "propagate";
    readonly permission: V;
  };
  readonly samples: {
    readonly stage: "surface" | "dependencies";
    readonly directions: readonly string[];
    readonly select: V;
    readonly usable?: V;
    readonly shape?: V;
    readonly quote: V;
    readonly quoteUsable?: V;
    readonly unavailableReason?: string;
    readonly capacityReason?: string;
  };
  readonly active: {
    readonly requirements: V;
    readonly requests: V;
    readonly sourceFailure: "retry" | "propagate";
    readonly source: V;
    readonly binding: V;
    readonly carriedSurface: boolean;
    readonly bindingField: string;
    readonly unavailableReason: string;
    readonly requestId: V;
    readonly expectedReturn: V;
    readonly returnValue: V;
    readonly returnError: string;
    readonly tokenDeltas: readonly ObservedBalance[];
    readonly supplyDeltas: readonly { token: V; delta: V }[];
    readonly events: readonly { abi: string; address: V; name: V; fields: V; error: string }[];
    readonly proofHash: V;
  };
  readonly identity: {
    readonly bindingField: string;
    readonly subject: V;
    readonly provenanceKind: string;
  };
}

function recovery(body: readonly V[], spec: ConversionAdmission, sourceFailure: "retry" | "propagate", includeSource = false): V[] {
  const readSource = letValue("observedSource", source());
  const attempt = { attempt: [...(includeSource && sourceFailure === "retry" ? [readSource] : []), ...body],
    catch: [result({ phase: "retry", reason: join(spec.retryPrefix, "$error.message") })] };
  return [...(includeSource && sourceFailure === "propagate" ? [readSource] : []), attempt];
}

function makeSamples(spec: ConversionAdmission): V {
  let samples = o("map", spec.samples.directions, "direction", spec.samples.select);
  if (spec.samples.usable !== undefined) samples = o("filter", samples, "sample", spec.samples.usable);
  if (spec.samples.shape !== undefined) samples = o("map", samples, "sample", spec.samples.shape);
  return samples;
}

function effectPrograms(spec: ConversionAdmission) {
  const active = spec.active;
  const exactRows = (kind: "tokenDeltas" | "totalSupplyDeltas", expected: V): V[] => [
    letValue("rows", o("filter", o("coalesce", `$result.effects.${kind}`, []), "row",
      kind === "tokenDeltas" ? o("and", o("sameAddress", "$row.token", "$token"), o("sameAddress", "$row.account", "$account")) : o("sameAddress", "$row.token", "$token"))),
    check(o("and", eq(o("length", "$rows"), 1), eq(o("get", o("at", "$rows", 0), "delta"), expected)),
      kind === "tokenDeltas" ? "independent token effect mismatch" : "independent total supply effect mismatch"),
    result(true),
  ];
  return {
    exactTokenDelta: exactRows("tokenDeltas", "$delta"),
    exactSupplyDelta: exactRows("totalSupplyDeltas", "$delta"),
    verifyEffects: [
      letValue("deposit", eq("$sample.direction", spec.samples.directions[0])),
      check(eq(active.returnValue, active.expectedReturn), active.returnError),
      ...active.tokenDeltas.map(delta => run(call("exactTokenDelta", { result: "$result", ...delta }))),
      ...active.supplyDeltas.map(delta => run(call("exactSupplyDelta", { result: "$result", ...delta }))),
      ...active.events.map(event => check(o("event", { result: "$result", abi: event.abi, address: event.address, name: event.name, fields: event.fields }), event.error)),
      result(true),
    ],
    verifySample: [
      letValue("result", o("successful", active.requestId)),
      result(false, o("ne", "$result.completion", "returned")),
      result(call("verifyEffects", { result: "$result", sample: "$sample", ...(active.carriedSurface ? { surface: "$surface" } : { binding: "$binding" }) })),
    ],
  };
}

export function expandConversionAdmission(raw: ConversionAdmission) {
  validateDeclarativeValue(raw);
  if (raw.version !== 1 || !["runtime-template", "registry-pointer"].includes(raw.match.kind)
      || !["surface", "dependencies"].includes(raw.samples.stage) || raw.samples.directions.length !== 2
      || new Set(raw.samples.directions).size !== 2) throw new Error("invalid conversion admission definition");
  const exact = (value: V, fields: readonly string[], label: string): void => {
    if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !fields.includes(key)))
      throw new Error(`invalid conversion ${label}`);
  };
  exact(raw, ["version", "requestPrefix", "retryPrefix", "match", "surface", "dependencies", "samples", "active", "identity"], "admission");
  exact(raw.match, ["phase", "kind", "requirements", "requests", "sourceFailure", "templateProgram", "codeRequestId", "valueRequestId", "abi", "function", "candidateValue", "noCodeReason", "mismatchReason", "malformedReason"], "match");
  exact(raw.surface, ["requirements", "requests", "decode", "sourceFailure", "forbiddenActor", "forbiddenActorReason"], "surface");
  exact(raw.dependencies, ["requirements", "requests", "decode", "sourceFailure", "permission"], "dependencies");
  exact(raw.samples, ["stage", "directions", "select", "usable", "shape", "quote", "quoteUsable", "unavailableReason", "capacityReason"], "samples");
  exact(raw.active, ["requirements", "requests", "sourceFailure", "source", "binding", "carriedSurface", "bindingField", "unavailableReason", "requestId", "expectedReturn", "returnValue", "returnError", "tokenDeltas", "supplyDeltas", "events", "proofHash"], "active proof");
  exact(raw.identity, ["bindingField", "subject", "provenanceKind"], "identity projection");
  for (const stage of [raw.match, raw.surface, raw.dependencies, raw.active])
    if (!["retry", "propagate"].includes(stage.sourceFailure)) throw new Error("invalid source failure policy");
  if (!/^[a-zA-Z][a-zA-Z0-9]*$/.test(raw.match.phase) || ["base", "surface", "probe"].includes(raw.match.phase)
      || raw.samples.directions.some(name => !/^[a-zA-Z][a-zA-Z0-9]*$/.test(name))
      || typeof raw.active.carriedSurface !== "boolean" || raw.active.tokenDeltas.length < 2 || raw.active.events.length < 1)
    throw new Error("incomplete conversion behavior proof");
  for (const delta of raw.active.tokenDeltas) exact(delta, ["token", "account", "delta"], "token delta");
  for (const delta of raw.active.supplyDeltas) exact(delta, ["token", "delta"], "supply delta");
  for (const event of raw.active.events) exact(event, ["abi", "address", "name", "fields", "error"], "event proof");
  const spec = JSON.parse(JSON.stringify(raw)) as ConversionAdmission;
  const m = spec.match;
  let matchBody: V[];
  if (m.kind === "runtime-template") {
    matchBody = [{ attempt: [run(call(m.templateProgram!, { code: o("code", m.codeRequestId) })),
      result({ phase: m.phase, source: "$observedSource" })], catch: [result({ phase: "other",
      reason: m.mismatchReason, evidenceRequestIds: [m.codeRequestId] })] }];
  } else {
    matchBody = [
      result({ phase: "other", reason: m.noCodeReason, evidenceRequestIds: [m.codeRequestId] }, eq(returnedData(m.codeRequestId), "0x")),
      letValue("data", returnedData(m.valueRequestId)),
      check(o("matches", "$data", "^0x[0-9a-fA-F]{64}$"), m.malformedReason),
      letValue("value", o("decode", m.abi, m.function, "$data", 0)),
      result({ phase: "other", reason: m.mismatchReason, evidenceRequestIds: [m.valueRequestId] }, not(o("sameAddress", "$value", m.candidateValue))),
      result({ phase: m.phase, source: "$observedSource" }),
    ];
  }
  const surfaceBody: V[] = [run(o("assertSource", "$observedSource", "$evidence.source")), letValue("surface", spec.surface.decode)];
  if (spec.surface.forbiddenActor !== undefined) surfaceBody.push(check(not(o("sameAddress", spec.surface.forbiddenActor, o("address", "$constants.actor"))), spec.surface.forbiddenActorReason));
  if (spec.samples.stage === "surface") surfaceBody.push(letValue("samples", makeSamples(spec)),
    result({ phase: "retry", reason: spec.samples.capacityReason }, eq(o("length", "$samples"), 0)),
    result({ phase: "surface", surface: "$surface", samples: "$samples" }));
  else surfaceBody.push(result({ phase: "surface", surface: "$surface" }));
  const dependenciesBody: V[] = [letValue("binding", spec.dependencies.decode), letValue("reason", spec.dependencies.permission),
    result({ phase: "retry", reason: "$reason" }, o("ne", "$reason", null))];
  let quoted: V = spec.samples.stage === "surface" ? "$evidence.samples" : makeSamples(spec);
  quoted = o("map", quoted, "sample", o("merge", "$sample", { expected: spec.samples.quote }));
  if (spec.samples.quoteUsable !== undefined) quoted = o("filter", quoted, "sample", spec.samples.quoteUsable);
  dependenciesBody.push(letValue("samples", quoted));
  if (spec.samples.unavailableReason !== undefined) dependenciesBody.push(result({ phase: "retry", reason: spec.samples.unavailableReason }, eq(o("length", "$samples"), 0)));
  dependenciesBody.push(result({ phase: "probe", ...(spec.active.carriedSurface ? { surface: "$evidence.surface" } : {}),
    [spec.active.bindingField]: "$binding", samples: "$samples" }));
  const directions = Object.fromEntries(spec.samples.directions.map(direction => [direction, false]));
  const activeBody: V[] = [run(o("assertSource", "$observedSource", spec.active.source)), letValue("binding", spec.active.binding),
    letValue("directions", o("merge", directions, o("objectFromEntries", o("map", "$evidence.samples", "sample",
      ["$sample.direction", call("verifySample", { sample: "$sample", ...(spec.active.carriedSurface ? { surface: "$evidence.surface" } : { binding: "$binding" }) })])))),
    result({ phase: "retry", reason: spec.active.unavailableReason }, not(o("or", ...spec.samples.directions.map(d => `$directions.${d}`)))),
    result({ phase: "verified", binding: "$binding", directions: "$directions", proofHash: spec.active.proofHash })];
  const stage = (requirements: V, requests: V, decode: V[]) => ({ requirements, requests, decode });
  const identity = { select: [result("base", not(o("defined", "$evidence"))), result("$evidence.phase")],
    stages: {
      base: stage(m.requirements, m.requests, recovery(matchBody, spec, m.sourceFailure, true)),
      [m.phase]: stage(spec.surface.requirements, spec.surface.requests, recovery(surfaceBody, spec, spec.surface.sourceFailure, true)),
      surface: stage(spec.dependencies.requirements, spec.dependencies.requests, recovery(dependenciesBody, spec, spec.dependencies.sourceFailure, true)),
      probe: stage(spec.active.requirements, spec.active.requests, recovery(activeBody, spec, spec.active.sourceFailure, true)),
    },
    decide: [
      result({ status: "chain-proven-rejected", reasonCode: "$evidence.reason", evidenceRequestIds: "$evidence.evidenceRequestIds" }, eq("$evidence.phase", "other")),
      result({ status: "retryable", reasonCode: "$evidence.reason" }, eq("$evidence.phase", "retry")),
      result({ status: "continue" }, o("ne", "$evidence.phase", "verified")),
      result({ status: "verified", identity: { familyId: "$profile.familyId", lineageId: "$profile.lineageId", subject: spec.identity.subject,
        asset: "$evidence.binding.asset", [spec.identity.bindingField]: "$evidence.binding", verifiedDirections: "$evidence.directions",
        provenance: [{ kind: spec.identity.provenanceKind, subject: spec.identity.subject, evidenceHash: "$evidence.proofHash" }] } }),
    ],
  };
  return { identity, programs: effectPrograms(spec) };
}
