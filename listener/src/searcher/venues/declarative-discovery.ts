import { id, getAddress, Interface, FunctionFragment, EventFragment, MaxUint256 } from "ethers";
import type { CallPattern, DiscoverySemantics, FamilyCandidate, UnifiedObservation } from "./adapter-family-plugin.js";
import { explicitReverseBindingUnsupported } from "./adapter-family-plugin.js";
import { compileAddressDiscovery } from "./address-discovery.js";
import { createAddressSurfaceNomination } from "./address-surface-nomination.js";
import { createTxEvidenceNomination } from "./tx-evidence-nomination.js";
import { compileDeclarativeValues, validateDeclarativeValue } from "./declarative-values.js";
import type { DeclarativeReadFlow, ReadFlowValues } from "./declarative-read-flow.js";
import { compileDeclarativeNominationReadFlow } from "./declarative-nomination.js";

interface AddressDiscoveryDefinition {
  readonly version?: 1;
  readonly sources: readonly string[];
  readonly candidateSources: readonly string[];
  readonly candidate: { readonly kind: string; readonly addressField: string };
  readonly calls: readonly { readonly id: string; readonly signature: string }[];
  readonly events: readonly { readonly id: string; readonly signature: string }[];
  readonly surface: { readonly id: string; readonly fingerprint: string };
  readonly labels: readonly string[];
  readonly txSeedNominations?: boolean;
}
type FieldType = "address" | "uint" | "bytes32" | "bool" | "string" | "number";
type FieldSource =
  | { readonly from: "argument"; readonly index: number }
  | { readonly from: "target" | "sender" | "emitter" }
  | { readonly from: "opaque" | "observation"; readonly path: string }
  | { readonly from: "literal"; readonly value: string | boolean | null };
interface MappedPattern {
  readonly id: string;
  /** Full ABI fragment accepted; indexed event arguments must be specified. */
  readonly signature: string;
  readonly fields: Readonly<Record<string, FieldSource>>;
  readonly predicates?: readonly unknown[];
  /** A real log may nominate its transaction without carrying a complete candidate. */
  readonly nominationOnly?: boolean;
}
export interface DeclarativeMappedDiscovery {
  readonly version: 2;
  readonly sources: readonly string[];
  readonly candidateSources: readonly string[];
  readonly candidate: {
    readonly kind: string;
    readonly addressField: string;
    readonly fields: Readonly<Record<string, FieldType>>;
    readonly optionalFields?: readonly string[];
    readonly nullableFields?: readonly string[];
    readonly key: readonly string[];
    /** Pre-partition nomination grouping; evidence candidate keys stay distinct. */
    readonly instanceKey?: readonly string[];
  };
  readonly calls: readonly MappedPattern[];
  readonly events: readonly MappedPattern[];
  readonly labels: readonly string[];
  readonly nomination: "tx-evidence" | "address-surface";
  /** Recent-call seeding is independent of how retained nominations resolve. */
  readonly txSeedNominations?: boolean;
  /** Read-only enrichment of retained nomination data, never identity admission. */
  readonly nominationReadFlow?: DeclarativeReadFlow;
  readonly surface?: {
    readonly id: string;
    readonly fingerprint: string;
    readonly fields: Readonly<Record<string, FieldSource>>;
    readonly predicates?: readonly unknown[];
  };
}
type Definition = AddressDiscoveryDefinition | DeclarativeMappedDiscovery;

/** The legacy address-only format is deliberately unchanged. Mapping opts in
 * explicitly; the resulting observations still enter ordinary strict identity. */
export function compileDeclarativeDiscovery<C extends FamilyCandidate>(definition: Definition, values?: ReadFlowValues): DiscoverySemantics<C> {
  if (definition.txSeedNominations !== undefined && typeof definition.txSeedNominations !== "boolean")
    throw new Error("invalid discovery txSeedNominations");
  if (definition.version === 2) return compileMappedDiscovery<C>(definition, values);
  if (definition.version !== undefined && definition.version !== 1) throw new Error("unsupported discovery declaration version");
  const d = JSON.parse(JSON.stringify(definition)) as AddressDiscoveryDefinition;
  if (!/^[a-zA-Z][a-zA-Z0-9]*$/.test(d.candidate.addressField) || ["constructor", "prototype", "__proto__"].includes(d.candidate.addressField))
    throw new Error("invalid candidate address field");
  const patterns = [...d.calls, ...d.events, d.surface];
  if (new Set(patterns.map(p => p.id)).size !== patterns.length) throw new Error("duplicate discovery pattern");
  return compileAddressDiscovery<C>({
    evidenceChannel: "nominate", sources: d.sources as DiscoverySemantics<C>["sources"],
    ...(d.txSeedNominations === undefined ? {} : { txSeedNominations: d.txSeedNominations }),
    ...(Array.isArray(d.candidateSources) && d.candidateSources.length === 0 ? {}
      : { candidateSources: d.candidateSources as DiscoverySemantics<C>["candidateSources"] }),
    callPatterns: d.calls.map(c => ({ ...c, selector: id(c.signature).slice(0, 10) as `0x${string}`,
      candidateAddress: { from: "call-target" as const } })),
    logPatterns: d.events.map(e => ({ ...e, topic: id(e.signature) as `0x${string}` })),
    addressSurfaces: [{ ...d.surface, kind: "interface" }],
    candidate: address => ({ candidateKind: d.candidate.kind, [d.candidate.addressField]: address } as unknown as C),
    candidateKey: candidate => getAddress((candidate as unknown as Record<string, string>)[d.candidate.addressField]).toLowerCase(),
    nominate: createAddressSurfaceNomination({ opaqueLabels: d.labels, interfaceFingerprints: [d.surface.fingerprint] }),
    reverseBinding: explicitReverseBindingUnsupported("no reverse-binding registry declared (explicit unsupported)"),
  });
}

const forbidden = new Set(["__proto__", "constructor", "prototype", "candidateKind"]);
function shape(value: unknown, required: readonly string[], optional: readonly string[], label: string): asserts value is Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value) || required.some(key => !Object.hasOwn(value, key)) ||
    Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) throw new Error(`invalid discovery ${label}`);
}
function fieldName(name: string): void {
  if (!/^[a-zA-Z][a-zA-Z0-9]*$/.test(name) || forbidden.has(name)) throw new Error("invalid discovery field name");
}
function scalar(type: FieldType, value: unknown): string | bigint | boolean | number {
  if (type === "address") { if (typeof value !== "string") throw new Error("address field"); return getAddress(value); }
  if (type === "uint") {
    if (typeof value !== "bigint" && (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value))) throw new Error("uint field");
    const n = BigInt(value); if (n < 0n || n > MaxUint256) throw new Error("uint field bounds"); return n;
  }
  if (type === "bytes32") { if (typeof value !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(value)) throw new Error("bytes32 field"); return value.toLowerCase(); }
  if (type === "bool") { if (typeof value !== "boolean") throw new Error("bool field"); return value; }
  if (type === "number" && typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return value;
  if (type === "string" && typeof value === "string") return value;
  throw new Error("string field");
}
function compileMappedDiscovery<C extends FamilyCandidate>(raw: DeclarativeMappedDiscovery, readValues?: ReadFlowValues): DiscoverySemantics<C> {
  validateDeclarativeValue(raw);
  const d = JSON.parse(JSON.stringify(raw)) as DeclarativeMappedDiscovery;
  shape(d, ["version", "sources", "candidateSources", "candidate", "calls", "events", "labels", "nomination"], ["surface", "nominationReadFlow", "txSeedNominations"], "mapping");
  shape(d.candidate, ["kind", "addressField", "fields", "key"], ["optionalFields", "nullableFields", "instanceKey"], "candidate");
  if (typeof d.candidate.kind !== "string" || !d.candidate.kind || !["tx-evidence", "address-surface"].includes(d.nomination))
    throw new Error("invalid discovery candidate or nomination kind");
  for (const [field, types] of [["sources", ["landed-log", "observed-call", "address-surface"]],
    ["candidateSources", ["dex-token-domain", "observed-interaction", "canonical-registry"]]] as const) {
    const list = d[field];
    if (!Array.isArray(list) || new Set(list).size !== list.length || list.some(item => !(types as readonly string[]).includes(item)))
      throw new Error(`invalid discovery ${field}`);
  }
  if (!Array.isArray(d.labels) || d.labels.some(label => typeof label !== "string" || !label)) throw new Error("invalid discovery labels");
  if (!d.candidate.fields || typeof d.candidate.fields !== "object" || Array.isArray(d.candidate.fields)) throw new Error("invalid discovery field types");
  const fields = Object.keys(d.candidate.fields);
  for (const field of fields) {
    fieldName(field);
    if (!["address", "uint", "bytes32", "bool", "string", "number"].includes(d.candidate.fields[field]!)) throw new Error("invalid discovery field type");
  }
  const optional = new Set(d.candidate.optionalFields ?? []);
  if (d.candidate.optionalFields !== undefined && (!Array.isArray(d.candidate.optionalFields) ||
      optional.size !== d.candidate.optionalFields.length || [...optional].some(field => !fields.includes(field))))
    throw new Error("invalid discovery optional fields");
  const nullable = new Set(d.candidate.nullableFields ?? []);
  if (d.candidate.nullableFields !== undefined && (!Array.isArray(d.candidate.nullableFields) ||
      nullable.size !== d.candidate.nullableFields.length || [...nullable].some(field => !fields.includes(field))))
    throw new Error("invalid discovery nullable fields");
  if (d.candidate.fields[d.candidate.addressField] !== "address" || !Array.isArray(d.candidate.key) || !d.candidate.key.length ||
    new Set(d.candidate.key).size !== d.candidate.key.length || !d.candidate.key.includes(d.candidate.addressField) ||
    d.candidate.key.some(key => !fields.includes(key) || optional.has(key) || nullable.has(key))) throw new Error("invalid discovery candidate key");
  if (d.candidate.instanceKey !== undefined && (!Array.isArray(d.candidate.instanceKey) || !d.candidate.instanceKey.length ||
    new Set(d.candidate.instanceKey).size !== d.candidate.instanceKey.length || !d.candidate.instanceKey.includes(d.candidate.addressField) ||
    d.candidate.instanceKey.some(key => !fields.includes(key) || optional.has(key) || nullable.has(key))))
    throw new Error("invalid discovery instance key");
  if (!Array.isArray(d.calls) || !Array.isArray(d.events)) throw new Error("invalid discovery patterns");
  const ids = [...d.calls, ...d.events, ...(d.surface ? [d.surface] : [])].map(p => p.id);
  if (new Set(ids).size !== ids.length || ids.some(id => typeof id !== "string" || !id)) throw new Error("duplicate or invalid discovery pattern");
  const values = readValues ?? compileDeclarativeValues({ abi: {}, constants: {}, expressions: {} });
  function validateMap(mapping: Readonly<Record<string, FieldSource>>, kind: "call" | "log" | "surface", argCount: number) {
    shape(mapping, fields.filter(field => !optional.has(field)), [...optional], "field mapping");
    for (const field of Object.keys(mapping)) {
      const source = mapping[field]!;
      if (source?.from === "argument") {
        shape(source, ["from", "index"], [], "argument mapping");
        if (!Number.isSafeInteger(source.index) || source.index < 0 || source.index >= argCount) throw new Error("discovery argument index out of bounds");
      } else if (source?.from === "literal") {
        shape(source, ["from", "value"], [], "literal mapping");
        if (source.value !== null || !nullable.has(field)) scalar(d.candidate.fields[field]!, source.value);
      } else if (source?.from === "opaque" || source?.from === "observation") {
        shape(source, ["from", "path"], [], "data mapping");
        if (typeof source.path !== "string" || !source.path.length || source.path.split(".").some(part =>
            !/^[a-zA-Z0-9_]+$/.test(part) || ["__proto__", "prototype", "constructor"].includes(part)))
          throw new Error("invalid discovery data path");
        if (source.from === "opaque" && kind !== "surface" || source.from === "observation" &&
            !["transactionHash", "source.number", "source.hash", "source.generation"].includes(source.path))
          throw new Error("discovery data source unavailable");
      } else {
        shape(source, ["from"], [], "observation mapping");
        if (!(kind === "call" ? ["target", "sender"] : ["emitter"]).includes(source.from)) throw new Error("discovery observation field unavailable");
      }
    }
  }
  function validatePredicates(predicates: readonly unknown[] | undefined) {
    if (predicates === undefined) return;
    if (!Array.isArray(predicates)) throw new Error("invalid discovery predicates");
    const visit = (value: unknown): void => {
      if (typeof value === "string" && value.startsWith("$")) {
        const [root, field] = value.slice(1).split(".");
        if (!["args", "candidate", "observation"].includes(root!) || root === "candidate" && field !== undefined && !fields.includes(field))
          throw new Error("unknown discovery predicate reference");
      }
      if (value && typeof value === "object") Object.values(value).forEach(visit);
    };
    predicates.forEach(visit);
  }
  const calls = d.calls.map(p => {
    shape(p, ["id", "signature", "fields"], ["predicates"], "call pattern");
    const fn = FunctionFragment.from(p.signature), abi = new Interface([fn]);
    validateMap(p.fields, "call", fn.inputs.length); validatePredicates(p.predicates);
    const candidateAddress = p.fields[d.candidate.addressField]!;
    if (candidateAddress.from !== "target" && candidateAddress.from !== "argument") throw new Error("call candidate address must be target or argument");
    if (candidateAddress.from === "argument" && fn.inputs[candidateAddress.index]!.type !== "address") throw new Error("call candidate argument must be address");
    const pattern: CallPattern = { id: p.id, selector: fn.selector as `0x${string}`, signature: fn.format("sighash"),
      candidateAddress: candidateAddress.from === "target" ? { from: "call-target" } : { from: "argument", index: candidateAddress.index },
      argumentProjection: fields.filter(field => p.fields[field]?.from === "argument").map(field => {
        const index = (p.fields[field] as Extract<FieldSource, { from: "argument" }>).index;
        return { index, type: fn.inputs[index]!.format("sighash"), name: field };
      }) };
    return { declaration: p, pattern, decode: (o: Extract<UnifiedObservation, { kind: "call" }>) => Array.from(abi.decodeFunctionData(fn, o.data)) };
  });
  const events = d.events.map(p => {
    shape(p, ["id", "signature", "fields"], ["predicates", "nominationOnly"], "event pattern");
    if (p.nominationOnly !== undefined && typeof p.nominationOnly !== "boolean") throw new Error("invalid nomination-only pattern");
    const event = EventFragment.from(p.signature), abi = new Interface([event]);
    if (event.anonymous) throw new Error("anonymous discovery events are unsupported");
    if (p.nominationOnly) { shape(p.fields, [], [], "nomination-only fields"); if (p.predicates !== undefined) throw new Error("nomination-only patterns cannot assert candidate predicates"); }
    else { validateMap(p.fields, "log", event.inputs.length); validatePredicates(p.predicates); }
    return { declaration: p, pattern: { id: p.id, topic: event.topicHash as `0x${string}`, signature: event.format("sighash") },
      decode: (o: Extract<UnifiedObservation, { kind: "log" }>) => Array.from(abi.decodeEventLog(event, o.data, [...o.topics])) };
  });
  if (d.surface) {
    shape(d.surface, ["id", "fingerprint", "fields"], ["predicates"], "surface");
    if (typeof d.surface.fingerprint !== "string" || !d.surface.fingerprint) throw new Error("invalid discovery fingerprint");
    validateMap(d.surface.fields, "surface", 0); validatePredicates(d.surface.predicates);
  }
  if (d.nomination === "address-surface" && !d.surface) throw new Error("surface nomination requires a surface");
  if (d.nomination === "tx-evidence" && !calls.length && !events.length) throw new Error("transaction nomination requires patterns");
  if (d.nominationReadFlow !== undefined && d.nomination !== "address-surface")
    throw new Error("nomination read flow requires address-surface nomination");
  if (d.nominationReadFlow !== undefined && !readValues) throw new Error("nomination read flow requires declarative values");
  const resolveOpaque = d.nominationReadFlow === undefined ? undefined : compileDeclarativeNominationReadFlow(d.nominationReadFlow, readValues!);
  function readPath(value: unknown, path: string): unknown {
    for (const part of path.split(".")) {
      if (value === null || typeof value !== "object") return undefined;
      const property = Object.getOwnPropertyDescriptor(value, part);
      if (!property) return undefined;
      if (!("value" in property)) throw new Error("discovery data must not contain accessors");
      value = property.value;
    }
    return value;
  }
  function candidate(mapping: Readonly<Record<string, FieldSource>>, observation: UnifiedObservation, args: readonly unknown[]): C {
    const result: Record<string, unknown> = { candidateKind: d.candidate.kind };
    for (const field of fields) {
      const source = mapping[field];
      if (!source) continue;
      const raw = source.from === "literal" ? source.value : source.from === "argument" ? args[source.index]
        : source.from === "target" && observation.kind === "call" ? observation.target
        : source.from === "sender" && observation.kind === "call" ? observation.sender
        : source.from === "emitter" && (observation.kind === "log" || observation.kind === "address-surface") ? observation.address
        : source.from === "opaque" && observation.kind === "address-surface" ? readPath(observation.opaque, source.path)
        : source.from === "observation" ? readPath(observation, source.path) : undefined;
      if (raw === undefined && optional.has(field)) continue;
      result[field] = raw === null && nullable.has(field) ? null : scalar(d.candidate.fields[field]!, raw);
    }
    return Object.freeze(result) as unknown as C;
  }
  const decodeCandidate: DiscoverySemantics<C>["decodeCandidate"] = ({ observation, matchedPatternId }) => {
      try {
        if (observation.kind === "address-surface") {
          if (!d.surface || matchedPatternId !== d.surface.id || !observation.interfaceFingerprints?.includes(d.surface.fingerprint)) return null;
          const result = candidate(d.surface.fields, observation, []);
          return (d.surface.predicates ?? []).every(predicate => values.evaluate(predicate, { observation, args: [], candidate: result }) === true) ? result : null;
        }
        if (observation.kind !== "call" && observation.kind !== "log") return null;
        const entry = (observation.kind === "call" ? calls : events).find(p => p.pattern.id === matchedPatternId);
        if (!entry || entry.declaration.nominationOnly) return null;
        const args = observation.kind === "call"
          ? calls.find(p => p.pattern.id === matchedPatternId)!.decode(observation)
          : events.find(p => p.pattern.id === matchedPatternId)!.decode(observation);
        const result = candidate(entry.declaration.fields, observation, args);
        if (!(entry.declaration.predicates ?? []).every((predicate: unknown) => values.evaluate(predicate, { observation, args, candidate: result }) === true)) return null;
        return result;
      } catch { return null; }
  };
  const callPatterns = calls.map(p => p.pattern), logPatterns = events.map(p => p.pattern);
  function encodeKey(value: unknown, keys: readonly string[]): string {
    if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid discovery key value");
    const row = value as Readonly<Record<string, unknown>>;
    const parts = keys.map(field => {
      const type = d.candidate.fields[field]!, item = scalar(type, row[field]);
      return type === "address" ? String(item).toLowerCase() : typeof item === "bigint" ? item.toString() : item;
    });
    // A single address keeps the existing lower-address identity. Composite
    // keys use structured encoding; delimiters in scalar strings cannot alias.
    return parts.length === 1 && d.candidate.fields[keys[0]!] === "address" ? String(parts[0]) : JSON.stringify(parts);
  }
  return {
    evidenceChannel: "nominate", sources: d.sources as DiscoverySemantics<C>["sources"],
    ...(Array.isArray(d.candidateSources) && d.candidateSources.length === 0 ? {}
      : { candidateSources: d.candidateSources as DiscoverySemantics<C>["candidateSources"] }),
    callPatterns, logPatterns, ...(d.surface ? { addressSurfaces: [{ id: d.surface.id, kind: "interface" as const, fingerprint: d.surface.fingerprint }] } : {}),
    ...(d.txSeedNominations === undefined
      ? d.nomination === "tx-evidence" ? { txSeedNominations: true } : {}
      : { txSeedNominations: d.txSeedNominations }),
    nominate: d.nomination === "tx-evidence"
      ? createTxEvidenceNomination({ opaqueLabels: d.labels, callPatterns, logPatterns, allMatches: true,
        acceptObservation: observation => (observation.kind === "call" ? calls : observation.kind === "log" ? events : [])
          .some(entry => decodeCandidate({ observation, matchedPatternId: entry.pattern.id }) !== null) })
      : createAddressSurfaceNomination({ opaqueLabels: d.labels, interfaceFingerprints: [d.surface!.fingerprint],
        resolveOpaque: resolveOpaque ?? (async ({ nomination }) => nomination.opaque) }),
    reverseBinding: explicitReverseBindingUnsupported("no reverse-binding registry declared (explicit unsupported)"),
    decodeCandidate,
    ...(d.candidate.instanceKey === undefined ? {} : {
      instanceNominationKey: (value: unknown) => encodeKey(value, d.candidate.instanceKey!),
    }),
    candidateKey(value) {
      if (value.candidateKind !== d.candidate.kind) throw new Error("discovery candidate kind mismatch");
      return encodeKey(value, d.candidate.key);
    },
  };
}
