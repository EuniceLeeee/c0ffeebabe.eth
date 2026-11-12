import { withRecentCallNomination } from "./declarative-recent-call-nomination.js";
import { id, getAddress, Interface, FunctionFragment, EventFragment, MaxUint256, type ParamType } from "ethers";
import type { CallPattern, LogPattern, DiscoverySemantics, FamilyCandidate, UnifiedObservation } from "./adapter-family-plugin.js";
import { hashCanonical, type CanonicalScalar } from "./canonical-value.js";
import { explicitReverseBindingUnsupported } from "./adapter-family-plugin.js";
import { compileAddressDiscovery } from "./address-discovery.js";
import { createAddressSurfaceNomination, matchesOpaqueLabel } from "./address-surface-nomination.js";
import { createTxEvidenceNomination, matchAllCalls } from "./tx-evidence-nomination.js";
import { compileDeclarativeValues, validateDeclarativeValue } from "./declarative-values.js";
import type { DeclarativeReadFlow, ReadFlowValues } from "./declarative-read-flow.js";
import { compileDeclarativeNominationReadFlow } from "./declarative-nomination.js";
import { normalizeCandidatePoolIdentity, type CandidatePoolIdentity } from "./candidate-pool-identity.js";

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
  | { readonly from: "argument"; readonly index: number; readonly path?: readonly number[] }
  | { readonly from: "item"; readonly path?: readonly number[] }
  | { readonly from: "expression"; readonly value: unknown }
  | { readonly from: "target" | "sender" | "emitter" }
  | { readonly from: "opaque" | "observation"; readonly path: string }
  | { readonly from: "literal"; readonly value: string | boolean | null };
interface MappedPattern {
  readonly id: string;
  /** Full ABI fragment accepted; indexed event arguments must be specified. */
  readonly signature?: string;
  /** Trigger-only log identity when no canonical event ABI is known. */
  readonly topic?: string;
  readonly fields: Readonly<Record<string, FieldSource>>;
  readonly predicates?: readonly unknown[];
  /** A real log may nominate its transaction without carrying a complete candidate. */
  readonly nominationOnly?: boolean;
  readonly emitter?: { readonly mode: "singleton-indexed-bytes32"; readonly address: string; readonly topicIndex: number; readonly fromBlock: number };
  /** One existing catalog match per bounded array element. No multi-result
   * central interface or synthetic observation is introduced. */
  readonly fanOut?: { readonly argument: number; readonly path?: readonly number[]; readonly maxItems: number };
}
type CompiledCall = { declaration: MappedPattern; pattern: CallPattern; itemIndex?: number;
  decode: (observation: Extract<UnifiedObservation, { kind: "call" }>) => unknown[] };
type CompiledLog = { declaration: MappedPattern; pattern: LogPattern; itemIndex?: number;
  decode: (observation: Extract<UnifiedObservation, { kind: "log" }>) => unknown[] };
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
    /** Stable durable keys can consist of canonical addresses plus an evidence digest. */
    readonly durableKey?: { readonly addresses: readonly string[]; readonly evidence?: readonly string[] };
    /** Pre-partition nomination grouping; evidence candidate keys stay distinct. */
    readonly instanceKey?: readonly string[];
    /** Overrides an ambiguous instance projection, e.g. a router candidate
     * whose physical pool belongs to a separately declared singleton. */
    readonly poolIdentity?:
      | { readonly kind: "address-pool"; readonly addressField: string }
      | { readonly kind: "singleton-pool"; readonly namespace: { readonly field: string } | { readonly address: string };
          readonly poolIdField: string }
      | null;
    /** Additive pool capabilities use a distinct scope. Ordinary pool swaps
     * share the default and do not need to opt into a replacement group. */
    readonly coverageScope?: string | null;
    /** Legacy grouping for candidates without a physical pool projection.
     * New ordinary pool declarations do not need this opt-in. */
    readonly coverage?: { readonly group: string; readonly key: readonly string[] };
  };
  readonly calls: readonly MappedPattern[];
  readonly events: readonly MappedPattern[];
  readonly labels: readonly string[];
  readonly nomination: "tx-evidence" | "address-surface";
  /** Recent-call seeding is independent of how retained nominations resolve. */
  readonly txSeedNominations?: boolean;
  /** Read-only enrichment of retained nomination data, never identity admission. */
  readonly nominationReadFlow?: DeclarativeReadFlow;
  readonly reverseBinding?: "address-surface";
  readonly reverseBindingTraceFallback?: boolean;
  readonly recentCallNomination?: { readonly emitter: string; readonly topic: string; readonly when: unknown; readonly nominationKey: unknown; readonly candidateKey: unknown };
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
    candidatePoolIdentity(value) {
      if (!value || typeof value !== "object" || Array.isArray(value)) return null;
      const row = value as Record<string, unknown>;
      if (row.candidateKind !== undefined && row.candidateKind !== d.candidate.kind) return null;
      return normalizeCandidatePoolIdentity({ kind: "address-pool",
        address: (row[d.candidate.addressField] ?? row.address) as string });
    },
    candidateKey: candidate => getAddress((candidate as unknown as Record<string, string>)[d.candidate.addressField]).toLowerCase(),
    nominate: createAddressSurfaceNomination({ opaqueLabels: d.labels, interfaceFingerprints: [d.surface.fingerprint] }),
    reverseBinding: explicitReverseBindingUnsupported("no reverse-binding registry declared (explicit unsupported)"),
  });
}

const MAX_FAN_OUT = 128;
const MAX_EXPANDED_PATTERNS = 1024;
const MAX_FAN_OUT_DATA_BYTES = 65536;
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
  shape(d, ["version", "sources", "candidateSources", "candidate", "calls", "events", "labels", "nomination"], ["surface", "nominationReadFlow", "txSeedNominations", "recentCallNomination", "reverseBinding", "reverseBindingTraceFallback"], "mapping");
  shape(d.candidate, ["kind", "addressField", "fields", "key"], ["optionalFields", "nullableFields", "instanceKey", "durableKey", "coverage", "poolIdentity", "coverageScope"], "candidate");
  if (typeof d.candidate.kind !== "string" || !d.candidate.kind || !["tx-evidence", "address-surface"].includes(d.nomination))
    throw new Error("invalid discovery candidate or nomination kind");
  for (const [field, types] of [["sources", ["factory-log", "landed-log", "observed-call", "address-surface"]],
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
  if (d.candidate.coverageScope !== undefined && d.candidate.coverageScope !== null &&
      (typeof d.candidate.coverageScope !== "string" || !/^[a-z][a-z0-9:._-]*$/.test(d.candidate.coverageScope))) {
    throw new Error("invalid discovery candidate coverage scope");
  }
  const declaredPoolIdentity = d.candidate.poolIdentity;
  const requiredField = (field: string, type: FieldType): boolean =>
    d.candidate.fields[field] === type && !optional.has(field) && !nullable.has(field);
  if (declaredPoolIdentity !== undefined && declaredPoolIdentity !== null) {
    if (declaredPoolIdentity.kind === "address-pool") {
      shape(declaredPoolIdentity, ["kind", "addressField"], [], "candidate pool identity");
      if (!requiredField(declaredPoolIdentity.addressField, "address")) throw new Error("invalid discovery candidate pool identity address");
    } else if (declaredPoolIdentity.kind === "singleton-pool") {
      shape(declaredPoolIdentity, ["kind", "namespace", "poolIdField"], [], "candidate pool identity");
      const namespace = declaredPoolIdentity.namespace;
      if (namespace && typeof namespace === "object" && "field" in namespace) {
        shape(namespace, ["field"], [], "candidate pool identity namespace");
        if (!requiredField(namespace.field, "address")) throw new Error("invalid discovery candidate pool identity namespace");
      } else {
        shape(namespace, ["address"], [], "candidate pool identity namespace");
        try { getAddress(namespace.address); } catch { throw new Error("invalid discovery candidate pool identity namespace"); }
      }
      if (!requiredField(declaredPoolIdentity.poolIdField, "bytes32")) throw new Error("invalid discovery candidate pool identity ID");
    } else throw new Error("invalid discovery candidate pool identity kind");
  }
  // Existing stable instance declarations already specify the physical key.
  // Only the unambiguous address and address+bytes32 shapes get a default.
  const instanceFields = d.candidate.instanceKey ?? d.candidate.key;
  const instanceAddresses = instanceFields.filter(field => requiredField(field, "address"));
  const instanceIds = instanceFields.filter(field => requiredField(field, "bytes32"));
  const automaticPoolIdentity: DeclarativeMappedDiscovery["candidate"]["poolIdentity"] =
    instanceFields.length === 1 && instanceAddresses.length === 1
      ? { kind: "address-pool", addressField: instanceAddresses[0]! }
      : instanceFields.length === 2 && instanceAddresses.length === 1 && instanceIds.length === 1
        ? { kind: "singleton-pool", namespace: { field: instanceAddresses[0]! }, poolIdField: instanceIds[0]! }
        : null;
  const poolIdentity = declaredPoolIdentity === undefined ? automaticPoolIdentity : declaredPoolIdentity;
  const coverage = d.candidate.coverage;
  if (coverage !== undefined) {
    shape(coverage, ["group", "key"], [], "candidate coverage");
    if (typeof coverage.group !== "string" || !/^[a-z][a-z0-9:._-]*$/.test(coverage.group) ||
        !Array.isArray(coverage.key) || !coverage.key.length ||
        new Set(coverage.key).size !== coverage.key.length || !coverage.key.includes(d.candidate.addressField) ||
        coverage.key.some(key => !fields.includes(key) || optional.has(key) || nullable.has(key))) {
      throw new Error("invalid discovery candidate coverage key");
    }
  }
  if (!Array.isArray(d.calls) || !Array.isArray(d.events)) throw new Error("invalid discovery patterns");
  const ids = [...d.calls, ...d.events, ...(d.surface ? [d.surface] : [])].map(p => p.id);
  if (new Set(ids).size !== ids.length || ids.some(id => typeof id !== "string" || !id)) throw new Error("duplicate or invalid discovery pattern");
  const values = readValues ?? compileDeclarativeValues({ abi: {}, constants: {}, expressions: {} });
  function pathType(type: ParamType | undefined, path: readonly number[] = []): ParamType {
    if (!Array.isArray(path) || path.length > 16 || path.some(index => !Number.isSafeInteger(index) || index < 0))
      throw new Error("invalid discovery ABI path");
    for (const index of path) {
      if (type?.baseType === "tuple") type = type.components?.[index];
      else if (type?.baseType === "array" && (type.arrayLength === -1 || index < type.arrayLength!)) type = type.arrayChildren ?? undefined;
      else type = undefined;
    }
    if (!type) throw new Error("discovery ABI path out of bounds");
    return type;
  }
  function nested(value: unknown, path: readonly number[] = []): unknown {
    for (const index of path) {
      if (!Array.isArray(value) || index >= value.length) throw new Error("discovery ABI value out of bounds");
      value = value[index];
    }
    return value;
  }
  function validateExpression(expression: unknown, fanOut: boolean, allowCandidate: boolean): void {
    const roots = new Set(["args", "observation", "constants", ...(allowCandidate ? ["candidate"] : []), ...(fanOut ? ["item", "itemIndex"] : [])]);
    const visit = (value: unknown, allowed: ReadonlySet<string>): void => {
      if (typeof value === "string" && value.startsWith("$")) {
        const [root, field] = value.slice(1).split(".");
        if (!allowed.has(root!) ||
            root === "candidate" && field !== undefined && !fields.includes(field))
          throw new Error("unknown discovery expression reference");
      }
      if (value && typeof value === "object") {
        const operation = value as { op?: string; args?: unknown[] };
        if (["map", "flatMap", "filter", "some", "every"].includes(operation.op ?? "")) {
          const args = operation.args!, name = args[1];
          if (typeof name !== "string") throw new Error("invalid discovery expression binding");
          fieldName(name);
          if (roots.has(name) || name === "index") throw new Error("reserved discovery expression binding");
          visit(args[0], allowed); visit(args[2], new Set([...allowed, name, "index"]));
        } else Object.values(value).forEach(child => visit(child, allowed));
      }
    };
    visit(expression, roots);
  }
  function fanOutType(pattern: MappedPattern, inputs: readonly ParamType[]): ParamType | undefined {
    if (pattern.fanOut === undefined) return undefined;
    const fan = pattern.fanOut;
    shape(fan, ["argument", "maxItems"], ["path"], "fan-out");
    if (!Number.isSafeInteger(fan.argument) || fan.argument < 0 || fan.argument >= inputs.length ||
        !Number.isSafeInteger(fan.maxItems) || fan.maxItems < 1 || fan.maxItems > MAX_FAN_OUT)
      throw new Error("invalid discovery fan-out bounds");
    const array = pathType(inputs[fan.argument], fan.path);
    if (array.baseType !== "array" || array.arrayLength !== -1 && array.arrayLength! > fan.maxItems)
      throw new Error("discovery fan-out must select a bounded ABI array");
    return array.arrayChildren!;
  }
  function validateMap(mapping: Readonly<Record<string, FieldSource>>, kind: "call" | "log" | "surface", inputs: readonly ParamType[], itemType?: ParamType) {
    shape(mapping, fields.filter(field => !optional.has(field)), [...optional], "field mapping");
    for (const field of Object.keys(mapping)) {
      const source = mapping[field]!;
      if (source?.from === "argument") {
        shape(source, ["from", "index"], ["path"], "argument mapping");
        if (!Number.isSafeInteger(source.index) || source.index < 0 || source.index >= inputs.length) throw new Error("discovery argument index out of bounds");
        pathType(inputs[source.index], source.path);
      } else if (source?.from === "item") {
        shape(source, ["from"], ["path"], "item mapping");
        if (!itemType) throw new Error("discovery item requires fan-out");
        pathType(itemType, source.path);
      } else if (source?.from === "expression") {
        shape(source, ["from", "value"], [], "derived mapping");
        validateExpression(source.value, itemType !== undefined, false);
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
  function validatePredicates(predicates: readonly unknown[] | undefined, fanOut = false) {
    if (predicates === undefined) return;
    if (!Array.isArray(predicates)) throw new Error("invalid discovery predicates");
    predicates.forEach(predicate => validateExpression(predicate, fanOut, true));
  }
  function expand<T extends { declaration: MappedPattern; pattern: { id: string } }>(entry: T): (T & { itemIndex?: number })[] {
    if (entry.declaration.fanOut === undefined) return [entry];
    return Array.from({ length: entry.declaration.fanOut.maxItems }, (_, itemIndex) => ({ ...entry, itemIndex,
      pattern: { ...entry.pattern, id: itemIndex === 0 ? entry.pattern.id : `${entry.pattern.id}-${itemIndex}` } }));
  }
  // Expanded pattern IDs revisit the same real observation. Cache canonical ABI
  // decoding by its bytes, not by caller/target or source, which are read afresh.
  function cachedDecode<T extends Extract<UnifiedObservation, { kind: "call" | "log" }>>(pattern: MappedPattern, decode: (observation: T) => unknown[]) {
    const cache = new WeakMap<T, { data: string; topics: readonly string[]; args: unknown[] }>();
    return (observation: T) => {
      if (!pattern.fanOut) return decode(observation);
      if (observation.data.length > 2 + MAX_FAN_OUT_DATA_BYTES * 2) throw new Error("discovery fan-out calldata budget");
      const topics = observation.kind === "log" ? observation.topics : [];
      const previous = cache.get(observation);
      if (previous?.data === observation.data && previous.topics.length === topics.length && previous.topics.every((topic, i) => topic === topics[i]))
        return previous.args;
      const args = decode(observation);
      const items = nested(args[pattern.fanOut.argument], pattern.fanOut.path);
      if (!Array.isArray(items) || items.length === 0 || items.length > pattern.fanOut.maxItems) throw new Error("discovery fan-out item budget");
      cache.set(observation, { data: observation.data, topics: [...topics], args });
      return args;
    };
  }
  const calls = d.calls.flatMap<CompiledCall>((p: MappedPattern) => {
    shape(p, ["id", "signature", "fields"], ["predicates", "fanOut"], "call pattern");
    const fn = FunctionFragment.from(p.signature!), abi = new Interface([fn]);
    const itemType = fanOutType(p, fn.inputs);
    validateMap(p.fields, "call", fn.inputs, itemType); validatePredicates(p.predicates, itemType !== undefined);
    const candidateAddress = p.fields[d.candidate.addressField]!;
    if (candidateAddress.from !== "target" && candidateAddress.from !== "argument") throw new Error("call candidate address must be target or argument");
    if (candidateAddress.from === "argument" && ((candidateAddress.path?.length ?? 0) !== 0 || fn.inputs[candidateAddress.index]!.type !== "address")) throw new Error("call candidate argument must be address");
    const pattern: CallPattern = { id: p.id, selector: fn.selector as `0x${string}`, signature: fn.format("sighash"),
      candidateAddress: candidateAddress.from === "argument" ? { from: "argument", index: candidateAddress.index } : { from: "call-target" },
      argumentProjection: fields.filter(field => p.fields[field]?.from === "argument" && !(p.fields[field] as Extract<FieldSource, { from: "argument" }>).path?.length).map(field => {
        const index = (p.fields[field] as Extract<FieldSource, { from: "argument" }>).index;
        return { index, type: fn.inputs[index]!.format("sighash"), name: field };
      }) };
    return expand({ declaration: p, pattern, decode: cachedDecode(p, (o: Extract<UnifiedObservation, { kind: "call" }>) => {
      const args = abi.decodeFunctionData(fn, o.data);
      if (abi.encodeFunctionData(fn, args).toLowerCase() !== o.data.toLowerCase()) throw new Error("noncanonical discovery calldata");
      return Array.from(args);
    }) });
  });
  const events = d.events.flatMap<CompiledLog>((p: MappedPattern) => {
    shape(p, ["id", "fields"], ["signature", "topic", "predicates", "nominationOnly", "fanOut", "emitter"], "event pattern");
    if (p.emitter !== undefined) {
      shape(p.emitter, ["mode", "address", "topicIndex", "fromBlock"], [], "event emitter");
      if (p.emitter.mode !== "singleton-indexed-bytes32" || !Number.isSafeInteger(p.emitter.topicIndex) ||
          p.emitter.topicIndex < 1 || p.emitter.topicIndex > 3 || !Number.isSafeInteger(p.emitter.fromBlock) || p.emitter.fromBlock < 0 || getAddress(p.emitter.address) === "0x" + "00".repeat(20))
        throw new Error("invalid singleton event emitter");
    }
    if (Object.hasOwn(p, "signature") === Object.hasOwn(p, "topic")) throw new Error("discovery event requires exactly one ABI or topic");
    if (p.nominationOnly !== undefined && typeof p.nominationOnly !== "boolean") throw new Error("invalid nomination-only pattern");
    if (p.topic !== undefined) {
      scalar("bytes32", p.topic);
      if (p.fanOut !== undefined || Object.values(p.fields).some(field => !["emitter", "observation", "literal"].includes(field.from)))
        throw new Error("topic-only discovery cannot decode arguments or expand candidates");
      if (p.nominationOnly) {
        shape(p.fields, [], [], "nomination-only fields");
        if (p.predicates !== undefined) throw new Error("nomination-only patterns cannot assert candidate predicates");
      } else { validateMap(p.fields, "log", []); validatePredicates(p.predicates); }
      const topic = p.topic.toLowerCase();
      return expand({ declaration: p, pattern: { id: p.id, topic: topic as `0x${string}`, signature: `topic:${topic}`, ...(p.emitter ? {emitter:p.emitter} : {}) },
        decode: (o: Extract<UnifiedObservation, { kind: "log" }>) => {
          if (!Array.isArray(o.topics) || o.topics.length < 1 || o.topics.length > 4 ||
              o.topics.some(value => !/^0x[0-9a-fA-F]{64}$/.test(value)) || o.topics[0]!.toLowerCase() !== topic ||
              !/^0x(?:[0-9a-fA-F]{2})*$/.test(o.data) || o.data.length > 2 + MAX_FAN_OUT_DATA_BYTES * 2)
            throw new Error("invalid topic-only discovery log");
          return [];
        } });
    }
    const event = EventFragment.from(p.signature!), abi = new Interface([event]);
    if (p.emitter && event.inputs.filter(i => i.indexed)[p.emitter.topicIndex - 1]?.type !== "bytes32")
      throw new Error("event emitter must select an indexed bytes32");
    if (event.anonymous) throw new Error("anonymous discovery events are unsupported");
    const itemType = fanOutType(p, event.inputs);
    if (p.nominationOnly) { shape(p.fields, [], [], "nomination-only fields"); if (p.predicates !== undefined || p.fanOut !== undefined) throw new Error("nomination-only patterns cannot assert candidate predicates or fan out"); }
    else { validateMap(p.fields, "log", event.inputs, itemType); validatePredicates(p.predicates, itemType !== undefined); }
    return expand({ declaration: p, pattern: { id: p.id, topic: event.topicHash as `0x${string}`, signature: event.format("sighash"), ...(p.emitter ? {emitter:p.emitter} : {}) },
      decode: cachedDecode(p, (o: Extract<UnifiedObservation, { kind: "log" }>) => {
        const args = abi.decodeEventLog(event, o.data, [...o.topics]);
        const encoded = abi.encodeEventLog(event, args);
        if (encoded.data.toLowerCase() !== o.data.toLowerCase() || encoded.topics.length !== o.topics.length ||
            encoded.topics.some((topic, i) => topic.toLowerCase() !== o.topics[i].toLowerCase())) throw new Error("noncanonical discovery event");
        return Array.from(args);
      }) });
  });
  const expandedIds = [...calls, ...events].map(entry => entry.pattern.id);
  if (([...d.calls, ...d.events].some(pattern => pattern.fanOut) && expandedIds.length > MAX_EXPANDED_PATTERNS) ||
      new Set([...expandedIds, ...(d.surface ? [d.surface.id] : [])]).size !== expandedIds.length + (d.surface ? 1 : 0))
    throw new Error("duplicate or excessive expanded discovery patterns");
  if (d.surface) {
    shape(d.surface, ["id", "fingerprint", "fields"], ["predicates"], "surface");
    if (typeof d.surface.fingerprint !== "string" || !d.surface.fingerprint) throw new Error("invalid discovery fingerprint");
    validateMap(d.surface.fields, "surface", []); validatePredicates(d.surface.predicates);
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
  function candidate(mapping: Readonly<Record<string, FieldSource>>, observation: UnifiedObservation, args: readonly unknown[], item?: unknown, itemIndex?: number): C {
    const result: Record<string, unknown> = { candidateKind: d.candidate.kind };
    for (const field of fields) {
      const source = mapping[field];
      if (!source) continue;
      const raw = source.from === "literal" ? source.value : source.from === "argument" ? nested(args[source.index], source.path)
        : source.from === "item" ? nested(item, source.path)
        : source.from === "expression" ? values.evaluate(source.value, { args, observation, item, itemIndex })
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
        const fan = entry.declaration.fanOut;
        const items = fan ? nested(args[fan.argument], fan.path) as unknown[] : undefined;
        if (fan && entry.itemIndex! >= items!.length) return null;
        const item = items?.[entry.itemIndex!];
        const result = candidate(entry.declaration.fields, observation, args, item, entry.itemIndex);
        if (!(entry.declaration.predicates ?? []).every((predicate: unknown) => values.evaluate(predicate, { observation, args, item, itemIndex: entry.itemIndex, candidate: result }) === true)) return null;
        return result;
      } catch { return null; }
  };
  const callPatterns = calls.map(p => p.pattern), logPatterns = events.map(p => p.pattern);
  const durable = d.candidate.durableKey;
  if (durable !== undefined) {
    shape(durable, ["addresses"], ["evidence"], "durable candidate key");
    const { addresses, evidence = [] } = durable;
    if (!Array.isArray(addresses) || !addresses.length || !Array.isArray(evidence) ||
        addresses.some(key => !d.candidate.key.includes(key) || d.candidate.fields[key] !== "address") ||
        evidence.some(key => !fields.includes(key)) ||
        new Set([...addresses, ...evidence]).size !== addresses.length + evidence.length ||
        d.candidate.key.some(key => !addresses.includes(key) && !evidence.includes(key)))
      throw new Error("invalid durable candidate key projection");
  }
  function durableCandidateKey(value: unknown): string {
    if (!durable) return encodeKey(value, d.candidate.key);
    const row = value as Readonly<Record<string, unknown>>;
    const parts = durable.addresses.map(key => String(scalar("address", row[key])).toLowerCase());
    if (durable.evidence?.length) {
      const projection: Record<string, CanonicalScalar> = {};
      for (const key of durable.evidence) {
        const type = d.candidate.fields[key]!, item = row[key];
        const v = item === null && nullable.has(key) || item === undefined && optional.has(key) ? null : scalar(type, item);
        projection[key] = type === "address" && typeof v === "string" ? v.toLowerCase() : v;
      }
      parts.push(hashCanonical(projection));
    }
    return parts.join(":");
  }
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
  const baseNomination = d.nomination === "tx-evidence"
      ? createTxEvidenceNomination({ opaqueLabels: d.labels, callPatterns, logPatterns, allMatches: true,
        acceptObservation: observation => (observation.kind === "call" ? calls : observation.kind === "log" ? events : [])
          .some(entry => decodeCandidate({ observation, matchedPatternId: entry.pattern.id }) !== null) })
      : createAddressSurfaceNomination({ opaqueLabels: d.labels, interfaceFingerprints: [d.surface!.fingerprint],
        resolveOpaque: resolveOpaque ?? (async ({ nomination }) => nomination.opaque) });
  if (d.recentCallNomination) shape(d.recentCallNomination, ["emitter","topic","when","nominationKey","candidateKey"], [], "recent call nomination");
  if (d.reverseBinding !== undefined && (d.reverseBinding !== "address-surface" || d.nomination !== "address-surface" || !d.surface))
    throw new Error("reverse binding requires a declared address-surface nomination");
  if (d.reverseBindingTraceFallback !== undefined && (typeof d.reverseBindingTraceFallback !== "boolean" ||
      d.reverseBinding !== "address-surface" || !d.candidate.instanceKey))
    throw new Error("trace fallback requires reverse binding and an instance key");
  const reverseLabels = new Set(d.labels.map(label => label.toLowerCase()));
  const surfaceId = d.surface?.id;
  const recent = d.recentCallNomination && withRecentCallNomination({
    base: baseNomination, declaration: d.recentCallNomination, labels:d.labels, values, callPatterns,
    decode: observation => {
      if (observation.kind === "address-surface" && d.surface) return decodeCandidate({observation, matchedPatternId:d.surface.id});
      if (observation.kind !== "call") return null;
      for (const c of calls) {
        const decoded = decodeCandidate({observation,matchedPatternId:c.pattern.id});
        if(decoded) return decoded;
      }
      return null;
    },
  });
  return {
    evidenceChannel: "nominate", sources: d.sources as DiscoverySemantics<C>["sources"],
    ...(Array.isArray(d.candidateSources) && d.candidateSources.length === 0 ? {}
      : { candidateSources: d.candidateSources as DiscoverySemantics<C>["candidateSources"] }),
    callPatterns, logPatterns, ...(d.surface ? { addressSurfaces: [{ id: d.surface.id, kind: "interface" as const, fingerprint: d.surface.fingerprint }] } : {}),
    ...(d.txSeedNominations === undefined
      ? d.nomination === "tx-evidence" ? { txSeedNominations: true } : {}
      : { txSeedNominations: d.txSeedNominations }),
    nominate: recent ?? baseNomination,
    reverseBinding: d.reverseBinding === "address-surface" ? {
      kind: "implementation",
      async reverseBinding({ nominations, source, provider }) {
        const outcomes = [];
        for (const nomination of nominations) {
          if (!matchesOpaqueLabel(nomination.opaque, reverseLabels)) {
            outcomes.push({ status: "unsupported" as const, reason: "foreign nomination label" });
            continue;
          }
          const emitters = events.flatMap(e => e.declaration.emitter ? [e.declaration.emitter.address.toLowerCase()] : []);
          if (emitters.length && !emitters.includes(nomination.address.toLowerCase())) {
            outcomes.push({status: "unsupported" as const, reason: "foreign event emitter"}); continue;
          }
          const observations = await baseNomination.nominate({ nominations: [nomination], source, provider });
          let observation = observations.length === 1 ? observations[0] : undefined;
          if (!observation || !surfaceId || !decodeCandidate({ observation, matchedPatternId: surfaceId })) {
            observation = undefined;
            const tx = nomination.evidence?.transactionHash;
            if (d.reverseBindingTraceFallback && provider.traceTransaction && typeof tx === "string" && /^0x[0-9a-fA-F]{64}$/.test(tx)) {
              try {
                const opaque = nomination.opaque as Record<string, unknown>;
                const key = encodeKey({...opaque, [d.candidate.addressField]: nomination.address}, d.candidate.instanceKey!);
                const trace = await provider.traceTransaction(tx);
                for (const frame of matchAllCalls(callPatterns, trace)) {
                  if (frame.target.toLowerCase() !== nomination.address.toLowerCase()) continue;
                  const call = {kind: "call" as const, source, target: frame.target, data: frame.data,
                    ...(frame.sender ? {sender:frame.sender} : {}), transactionHash:tx.toLowerCase()};
                  const matches = calls.some(entry => {
                    const decoded = decodeCandidate({observation:call,matchedPatternId:entry.pattern.id});
                    return decoded !== null && encodeKey(decoded,d.candidate.instanceKey!) === key;
                  });
                  if (matches) { observation = call; break; }
                }
              } catch { /* Exact evidence unavailable: keep this nomination unresolved. */ }
            }
          }
          outcomes.push(observation ? {status: "verified" as const, observation}
            : {status: "failed" as const, reason: "source-bound surface and exact transaction could not be verified"});
        }
        return Object.freeze(outcomes);
      },
    } : explicitReverseBindingUnsupported("no reverse-binding registry declared (explicit unsupported)"),
    decodeCandidate,
    ...(d.candidate.coverageScope === undefined ? {} : { candidateCoverageScope: d.candidate.coverageScope }),
    candidatePoolIdentity(value: unknown): CandidatePoolIdentity | null {
      if (poolIdentity === null || !value || typeof value !== "object" || Array.isArray(value)) return null;
      const row = value as Readonly<Record<string, unknown>>;
      if (row.candidateKind !== undefined && row.candidateKind !== d.candidate.kind) return null;
      // An envelope address can fill only the Family's declared address field.
      // It cannot replace a distinct manager/core/vault field with a router.
      const address = (field: string): string => (row[field] ??
        (field === d.candidate.addressField ? row.address : undefined)) as string;
      return normalizeCandidatePoolIdentity(poolIdentity.kind === "address-pool"
        ? { kind: "address-pool", address: address(poolIdentity.addressField) }
        : { kind: "singleton-pool", namespace: "field" in poolIdentity.namespace
            ? address(poolIdentity.namespace.field) : poolIdentity.namespace.address,
          poolId: row[poolIdentity.poolIdField] as string });
    },
    ...(coverage === undefined ? {} : {
      candidateCoverageKey(value: unknown): string | null {
        // A partial/legacy nomination remains ordinary work. It cannot cover
        // another Family until every declared identity component is present.
        if (!value || typeof value !== "object" || Array.isArray(value)) return null;
        const row = value as Readonly<Record<string, unknown>>;
        if (row.candidateKind !== undefined && row.candidateKind !== d.candidate.kind) return null;
        try {
          if (row[d.candidate.addressField] === undefined && row.address !== undefined)
            value = { ...row, [d.candidate.addressField]: row.address };
          return JSON.stringify([coverage.group, encodeKey(value, coverage.key)]);
        } catch { return null; }
      },
    }),
    ...(d.candidate.instanceKey === undefined ? {} : {
      instanceNominationKey(value: unknown) {
        // Retained Ready nominations use the shared address envelope. It can
        // supply only the declared address field for grouping; this does not
        // decode a candidate or grant identity/behavior proof.
        if (value && typeof value === "object" && !Array.isArray(value)) {
          const row = value as Record<string, unknown>;
          if (row[d.candidate.addressField] === undefined && row.address !== undefined)
            value = { ...row, [d.candidate.addressField]: row.address };
        }
        return encodeKey(value, d.candidate.instanceKey!);
      },
    }),
    candidateKey(value) {
      if (value.candidateKind !== d.candidate.kind) throw new Error("discovery candidate kind mismatch");
      return durableCandidateKey(value);
    },
  };
}
