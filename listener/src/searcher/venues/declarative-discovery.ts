import { id, getAddress, Interface, FunctionFragment, EventFragment, MaxUint256 } from "ethers";
import type { CallPattern, DiscoverySemantics, FamilyCandidate, UnifiedObservation } from "./adapter-family-plugin.js";
import { explicitReverseBindingUnsupported } from "./adapter-family-plugin.js";
import { compileAddressDiscovery } from "./address-discovery.js";
import { createAddressSurfaceNomination } from "./address-surface-nomination.js";
import { createTxEvidenceNomination } from "./tx-evidence-nomination.js";
import { compileDeclarativeValues, validateDeclarativeValue } from "./declarative-values.js";

interface AddressDiscoveryDefinition {
  readonly version?: 1;
  readonly sources: readonly string[];
  readonly candidateSources: readonly string[];
  readonly candidate: { readonly kind: string; readonly addressField: string };
  readonly calls: readonly { readonly id: string; readonly signature: string }[];
  readonly events: readonly { readonly id: string; readonly signature: string }[];
  readonly surface: { readonly id: string; readonly fingerprint: string };
  readonly labels: readonly string[];
}
type FieldType = "address" | "uint" | "bytes32" | "bool" | "string";
type FieldSource =
  | { readonly from: "argument"; readonly index: number }
  | { readonly from: "target" | "sender" | "emitter" }
  | { readonly from: "literal"; readonly value: string | boolean };
interface MappedPattern {
  readonly id: string;
  /** Full ABI fragment accepted; indexed event arguments must be specified. */
  readonly signature: string;
  readonly fields: Readonly<Record<string, FieldSource>>;
  readonly predicates?: readonly unknown[];
}
export interface DeclarativeMappedDiscovery {
  readonly version: 2;
  readonly sources: readonly string[];
  readonly candidateSources: readonly string[];
  readonly candidate: {
    readonly kind: string;
    readonly addressField: string;
    readonly fields: Readonly<Record<string, FieldType>>;
    readonly key: readonly string[];
  };
  readonly calls: readonly MappedPattern[];
  readonly events: readonly MappedPattern[];
  readonly labels: readonly string[];
  readonly nomination: "tx-evidence" | "address-surface";
  readonly surface?: {
    readonly id: string;
    readonly fingerprint: string;
    readonly fields: Readonly<Record<string, FieldSource>>;
  };
}
type Definition = AddressDiscoveryDefinition | DeclarativeMappedDiscovery;

/** The legacy address-only format is deliberately unchanged. Mapping opts in
 * explicitly; the resulting observations still enter ordinary strict identity. */
export function compileDeclarativeDiscovery<C extends FamilyCandidate>(definition: Definition): DiscoverySemantics<C> {
  if (definition.version === 2) return compileMappedDiscovery<C>(definition);
  if (definition.version !== undefined && definition.version !== 1) throw new Error("unsupported discovery declaration version");
  const d = JSON.parse(JSON.stringify(definition)) as AddressDiscoveryDefinition;
  if (!/^[a-zA-Z][a-zA-Z0-9]*$/.test(d.candidate.addressField) || ["constructor", "prototype", "__proto__"].includes(d.candidate.addressField))
    throw new Error("invalid candidate address field");
  const patterns = [...d.calls, ...d.events, d.surface];
  if (new Set(patterns.map(p => p.id)).size !== patterns.length) throw new Error("duplicate discovery pattern");
  return compileAddressDiscovery<C>({
    evidenceChannel: "nominate", sources: d.sources as DiscoverySemantics<C>["sources"],
    candidateSources: d.candidateSources as DiscoverySemantics<C>["candidateSources"],
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
function scalar(type: FieldType, value: unknown): string | bigint | boolean {
  if (type === "address") { if (typeof value !== "string") throw new Error("address field"); return getAddress(value); }
  if (type === "uint") {
    if (typeof value !== "bigint" && (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value))) throw new Error("uint field");
    const n = BigInt(value); if (n < 0n || n > MaxUint256) throw new Error("uint field bounds"); return n;
  }
  if (type === "bytes32") { if (typeof value !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(value)) throw new Error("bytes32 field"); return value.toLowerCase(); }
  if (type === "bool") { if (typeof value !== "boolean") throw new Error("bool field"); return value; }
  if (type === "string" && typeof value === "string") return value;
  throw new Error("string field");
}
function compileMappedDiscovery<C extends FamilyCandidate>(raw: DeclarativeMappedDiscovery): DiscoverySemantics<C> {
  validateDeclarativeValue(raw);
  const d = JSON.parse(JSON.stringify(raw)) as DeclarativeMappedDiscovery;
  shape(d, ["version", "sources", "candidateSources", "candidate", "calls", "events", "labels", "nomination"], ["surface"], "mapping");
  shape(d.candidate, ["kind", "addressField", "fields", "key"], [], "candidate");
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
    if (!["address", "uint", "bytes32", "bool", "string"].includes(d.candidate.fields[field]!)) throw new Error("invalid discovery field type");
  }
  if (d.candidate.fields[d.candidate.addressField] !== "address" || !Array.isArray(d.candidate.key) || !d.candidate.key.length ||
    new Set(d.candidate.key).size !== d.candidate.key.length || !d.candidate.key.includes(d.candidate.addressField) || d.candidate.key.some(key => !fields.includes(key))) throw new Error("invalid discovery candidate key");
  if (!Array.isArray(d.calls) || !Array.isArray(d.events)) throw new Error("invalid discovery patterns");
  const ids = [...d.calls, ...d.events, ...(d.surface ? [d.surface] : [])].map(p => p.id);
  if (new Set(ids).size !== ids.length || ids.some(id => typeof id !== "string" || !id)) throw new Error("duplicate or invalid discovery pattern");
  const values = compileDeclarativeValues({ abi: {}, constants: {}, expressions: {} });
  function validateMap(mapping: Readonly<Record<string, FieldSource>>, kind: "call" | "log" | "surface", argCount: number) {
    shape(mapping, fields, [], "field mapping");
    for (const field of fields) {
      const source = mapping[field]!;
      if (source?.from === "argument") {
        shape(source, ["from", "index"], [], "argument mapping");
        if (!Number.isSafeInteger(source.index) || source.index < 0 || source.index >= argCount) throw new Error("discovery argument index out of bounds");
      } else if (source?.from === "literal") {
        shape(source, ["from", "value"], [], "literal mapping"); scalar(d.candidate.fields[field]!, source.value);
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
      argumentProjection: fields.filter(field => p.fields[field]!.from === "argument").map(field => {
        const index = (p.fields[field] as Extract<FieldSource, { from: "argument" }>).index;
        return { index, type: fn.inputs[index]!.format("sighash"), name: field };
      }) };
    return { declaration: p, pattern, decode: (o: Extract<UnifiedObservation, { kind: "call" }>) => Array.from(abi.decodeFunctionData(fn, o.data)) };
  });
  const events = d.events.map(p => {
    shape(p, ["id", "signature", "fields"], ["predicates"], "event pattern");
    const event = EventFragment.from(p.signature), abi = new Interface([event]);
    if (event.anonymous) throw new Error("anonymous discovery events are unsupported");
    validateMap(p.fields, "log", event.inputs.length); validatePredicates(p.predicates);
    return { declaration: p, pattern: { id: p.id, topic: event.topicHash as `0x${string}`, signature: event.format("sighash") },
      decode: (o: Extract<UnifiedObservation, { kind: "log" }>) => Array.from(abi.decodeEventLog(event, o.data, [...o.topics])) };
  });
  if (d.surface) {
    shape(d.surface, ["id", "fingerprint", "fields"], [], "surface");
    if (typeof d.surface.fingerprint !== "string" || !d.surface.fingerprint) throw new Error("invalid discovery fingerprint");
    validateMap(d.surface.fields, "surface", 0);
  }
  if (d.nomination === "address-surface" && !d.surface) throw new Error("surface nomination requires a surface");
  if (d.nomination === "tx-evidence" && !calls.length && !events.length) throw new Error("transaction nomination requires patterns");
  function candidate(mapping: Readonly<Record<string, FieldSource>>, observation: UnifiedObservation, args: readonly unknown[]): C {
    const result: Record<string, unknown> = { candidateKind: d.candidate.kind };
    for (const field of fields) {
      const source = mapping[field]!;
      const raw = source.from === "literal" ? source.value : source.from === "argument" ? args[source.index]
        : source.from === "target" && observation.kind === "call" ? observation.target
        : source.from === "sender" && observation.kind === "call" ? observation.sender
        : source.from === "emitter" && (observation.kind === "log" || observation.kind === "address-surface") ? observation.address : undefined;
      result[field] = scalar(d.candidate.fields[field]!, raw);
    }
    return Object.freeze(result) as unknown as C;
  }
  const decodeCandidate: DiscoverySemantics<C>["decodeCandidate"] = ({ observation, matchedPatternId }) => {
      try {
        if (observation.kind === "address-surface") {
          if (!d.surface || matchedPatternId !== d.surface.id || !observation.interfaceFingerprints?.includes(d.surface.fingerprint)) return null;
          return candidate(d.surface.fields, observation, []);
        }
        if (observation.kind !== "call" && observation.kind !== "log") return null;
        const entry = (observation.kind === "call" ? calls : events).find(p => p.pattern.id === matchedPatternId);
        if (!entry) return null;
        const args = observation.kind === "call"
          ? calls.find(p => p.pattern.id === matchedPatternId)!.decode(observation)
          : events.find(p => p.pattern.id === matchedPatternId)!.decode(observation);
        const result = candidate(entry.declaration.fields, observation, args);
        if (!(entry.declaration.predicates ?? []).every((predicate: unknown) => values.evaluate(predicate, { observation, args, candidate: result }) === true)) return null;
        return result;
      } catch { return null; }
  };
  const callPatterns = calls.map(p => p.pattern), logPatterns = events.map(p => p.pattern);
  return {
    evidenceChannel: "nominate", sources: d.sources as DiscoverySemantics<C>["sources"],
    candidateSources: d.candidateSources as DiscoverySemantics<C>["candidateSources"],
    callPatterns, logPatterns, ...(d.surface ? { addressSurfaces: [{ id: d.surface.id, kind: "interface" as const, fingerprint: d.surface.fingerprint }] } : {}),
    ...(d.nomination === "tx-evidence" ? { txSeedNominations: true } : {}),
    nominate: d.nomination === "tx-evidence"
      ? createTxEvidenceNomination({ opaqueLabels: d.labels, callPatterns, logPatterns, allMatches: true,
        acceptObservation: observation => (observation.kind === "call" ? calls : observation.kind === "log" ? events : [])
          .some(entry => decodeCandidate({ observation, matchedPatternId: entry.pattern.id }) !== null) })
      : createAddressSurfaceNomination({ opaqueLabels: d.labels, interfaceFingerprints: [d.surface!.fingerprint] }),
    reverseBinding: explicitReverseBindingUnsupported("no reverse-binding registry declared (explicit unsupported)"),
    decodeCandidate,
    candidateKey(value) {
      if (value.candidateKind !== d.candidate.kind) throw new Error("discovery candidate kind mismatch");
      const row = value as unknown as Record<string, unknown>;
      const parts = d.candidate.key.map(field => {
        const type = d.candidate.fields[field]!, item = scalar(type, row[field]);
        return type === "address" ? String(item).toLowerCase() : typeof item === "bigint" ? item.toString() : item;
      });
      // The one-address key stays compatible with address-only Families. Other
      // keys use structured encoding, avoiding ambiguous string concatenation.
      return parts.length === 1 && d.candidate.fields[d.candidate.key[0]!] === "address" ? String(parts[0]) : JSON.stringify(parts);
    },
  };
}
