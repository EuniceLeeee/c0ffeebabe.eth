import { EventFragment } from "ethers";
import { instanceKey, lineageId } from "./adapter-family-identifiers.js";
import type { DiscoverySemantics, FamilyManifest, FamilyCandidate, LogPattern } from "./adapter-family-plugin.js";
import type { ReadySelectorCensusTransaction } from "../ready-selector-census.js";
import { hashCanonical, type CanonicalValue } from "./canonical-value.js";
import { selectorObservedCallResources, type SelectorObservedCallScope } from "./selector-execution-observation.js";
import type { SelectorAbiValue, SelectorImmutableParameter } from "./selector-execution-keys.js";
import { freezeSelectorNative, normalizeSelectorNativeExecutionDefinition, selectorNativeFamilyId, selectorNativeProgramKey,
  type SelectorNativeExecutionDefinition } from "./selector-native-definition.js";

export interface SelectorNativeCandidate extends FamilyCandidate {
  readonly candidateKind: "selector-native-execution";
  readonly target: string;
  readonly arguments: readonly SelectorAbiValue[];
  readonly scope: SelectorObservedCallScope;
  readonly immutableParameters: readonly SelectorImmutableParameter[];
  readonly observedAmountIn?: string;
  readonly programKeys: readonly string[];
  readonly programKey: string;
  readonly census: ReadySelectorCensusTransaction;
  readonly callId: string;
  readonly declarationFingerprint: string;
}
const hash = (value: unknown): string => hashCanonical(value as CanonicalValue);

/** Each call pattern selects one execution recipe. A caller must not silently
 * choose the first recipe when several share a selector or resource scope. */
export function selectorNativeCandidateFromCensus(
  definition: SelectorNativeExecutionDefinition,
  census: ReadySelectorCensusTransaction,
  callId: string,
  programKey?: string,
): SelectorNativeCandidate | null {
  try {
    const entries = definition.programs.length
      ? definition.programs.map(program => ({ program, key: selectorNativeProgramKey(program) }))
      : [{ program: undefined, key: "observed" }];
    const selected = programKey === undefined ? entries : entries.filter(entry => entry.key === programKey);
    if (selected.length !== 1) return null;
    const { program, key } = selected[0]!;
    const declared = program?.binding?.nomination ?? {};
    const rolePath = (role: string, explicit: readonly number[] | undefined): readonly number[] | undefined => {
      const paths = program?.parameters?.filter(parameter => parameter.role === role).map(parameter => parameter.path) ?? [];
      if (explicit && paths.length && !paths.some(path => JSON.stringify(path) === JSON.stringify(explicit)))
        throw new Error("selector nomination path disagrees with its parameter role");
      return explicit ?? (paths.length === 1 ? paths[0] : undefined);
    };
    const tokenInPath = rolePath("tokenIn", declared.tokenInPath);
    const tokenOutPath = rolePath("tokenOut", declared.tokenOutPath);
    const tokenInIdPath = rolePath("tokenInId", declared.tokenInIdPath);
    const tokenOutIdPath = rolePath("tokenOutId", declared.tokenOutIdPath);
    const poolIdPath = rolePath("poolId", declared.poolIdPath);
    const nomination = { ...declared,
      parameterPaths: [...(declared.parameterPaths ?? []), ...(program?.parameters?.filter(parameter =>
        ["bound", "poolId", "tokenInId", "tokenOutId"].includes(parameter.role)).map(parameter => parameter.path) ?? [])],
      ...(tokenInPath === undefined ? {} : { tokenInPath }), ...(tokenOutPath === undefined ? {} : { tokenOutPath }),
      ...(tokenInIdPath === undefined ? {} : { tokenInIdPath }), ...(tokenOutIdPath === undefined ? {} : { tokenOutIdPath }),
      ...(poolIdPath === undefined ? {} : { poolIdPath }) };
    const data = selectorObservedCallResources({ signature: definition.signature, selector: definition.selector,
      census, callId, nomination });
    if (!data) return null;
    return freezeSelectorNative({ candidateKind: "selector-native-execution", target: data.scope.target,
      arguments: data.arguments, scope: data.scope, immutableParameters: data.immutableParameters,
      ...(data.observedAmountIn === undefined ? {} : { observedAmountIn: data.observedAmountIn }),
      programKeys: [key], programKey: key, census: JSON.parse(JSON.stringify(census)), callId,
      declarationFingerprint: hash(definition) });
  } catch { return null; }
}

export function selectorNativeCandidateKey(candidate: SelectorNativeCandidate, definition: SelectorNativeExecutionDefinition) {
  assertSelectorNativeCandidate(candidate, definition);
  return instanceKey(`selector-nomination:${hash({ familyId: selectorNativeFamilyId(definition), scope: candidate.scope,
    immutableParameters: candidate.immutableParameters, programKey: candidate.programKey })}`);
}

export function assertSelectorNativeCandidate(candidate: SelectorNativeCandidate, definition: SelectorNativeExecutionDefinition): void {
  const rebuilt = selectorNativeCandidateFromCensus(definition, candidate?.census, candidate?.callId, candidate?.programKey);
  const owned = { candidateKind: candidate?.candidateKind, target: candidate?.target, arguments: candidate?.arguments, scope: candidate?.scope,
    immutableParameters: candidate?.immutableParameters,
    ...(candidate?.observedAmountIn === undefined ? {} : { observedAmountIn: candidate.observedAmountIn }),
    programKeys: candidate?.programKeys, programKey: candidate?.programKey, census: candidate?.census,
    callId: candidate?.callId, declarationFingerprint: candidate?.declarationFingerprint };
  if (!rebuilt || hash(rebuilt) !== hash(owned)) throw new Error("selector-native candidate binding changed");
}

/** SQL/Ready projection. It never executes a protocol adapter or requests state. */
export function compileSelectorNativeDiscovery(raw: unknown): { manifest: FamilyManifest<any>; discovery: DiscoverySemantics<SelectorNativeCandidate> } {
  const definition = normalizeSelectorNativeExecutionDefinition(raw), id = selectorNativeFamilyId(definition), callId = `${id}:call`;
  const programKeys = definition.programs.length ? definition.programs.map(selectorNativeProgramKey) : ["observed"];
  const patternPrograms = new Map(programKeys.map(key => [`${callId}:${key}`, key]));
  const events = new Map<string, LogPattern>();
  for (const program of definition.programs) for (const row of program.observations?.events ?? []) {
    if (!row.signature && !row.topic) continue;
    const signatureTopic = row.signature === undefined ? undefined : EventFragment.from(row.signature).topicHash;
    const topic = String(row.topic ?? signatureTopic).toLowerCase();
    if (!/^0x[0-9a-f]{64}$/.test(topic) || signatureTopic !== undefined && signatureTopic !== topic)
      throw new Error("selector-native observation topic differs from ABI");
    // Program-local event labels are annotations, and may repeat across recipes.
    if (!events.has(topic)) events.set(topic, { id: `${callId}:event:${topic}`, signature: row.signature ?? topic, topic: topic as `0x${string}` });
  }
  const allowedTaxonomy = definition.domain === "swap" ? [{ slotKind: "swap" }] : [{ slotKind: "protocol", protocolAction: "convert" },
    ...["wrap", "unwrap", "redeem"].map(protocolAction => ({ slotKind: "protocol", protocolAction }))];
  const manifest: FamilyManifest<any> = { familyId: id, domain: definition.domain,
    supportedLineages: programKeys.map(key => lineageId(`${id}:${key}`)),
    ownedActionAdapterIds: [callId], edgeAdapterIds: [callId], requiredInfraActionAdapterIds: [], allowedTaxonomy: allowedTaxonomy as any };
  const discovery: DiscoverySemantics<SelectorNativeCandidate> = {
    sources: ["observed-call", ...(events.size ? ["landed-log" as const] : [])], candidateSources: ["observed-interaction"], evidenceChannel: "tx-evidence",
    callPatterns: [...patternPrograms].map(([patternId]) => ({ id: patternId, selector: definition.selector as `0x${string}`,
      signature: definition.signature, candidateAddress: { from: "call-target" as const } })),
    ...(events.size ? { logPatterns: [...events.values()] } : {}),
    reverseBinding: { kind: "explicitly-unsupported", reason: "selector census owns nomination; static binding and funded simulation own execution" },
    decodeCandidate({ observation, matchedPatternId }) {
      try {
        if (observation.kind !== "call") return null;
        const key = patternPrograms.get(matchedPatternId);
        if (key === undefined) return null;
        const data = observation.opaque as { selectorCensus?: ReadySelectorCensusTransaction; callId?: string } | undefined;
        if (!data?.selectorCensus || typeof data.callId !== "string") return null;
        const source = observation.evidenceSource ?? observation.source;
        if (!Number.isSafeInteger(source.number) || source.number < 0 || !Number.isSafeInteger(source.generation) || source.generation < 0 ||
            typeof source.hash !== "string" || !/^0x[0-9a-f]{64}$/i.test(source.hash) ||
            data.selectorCensus.blockNumber !== source.number || data.selectorCensus.blockHash?.toLowerCase() !== source.hash.toLowerCase()) return null;
        const candidate = selectorNativeCandidateFromCensus(definition, data.selectorCensus, data.callId, key);
        const call = candidate?.census.calls.find(row => row.id === candidate.callId);
        if (!candidate || !call || typeof observation.target !== "string" || typeof observation.data !== "string" ||
            typeof observation.transactionHash !== "string" || typeof observation.sender !== "string" ||
            call.target !== observation.target.toLowerCase() || call.calldata !== observation.data.toLowerCase() ||
            call.selector !== definition.selector || candidate.census.transactionHash !== observation.transactionHash.toLowerCase() ||
            call.sender !== observation.sender.toLowerCase()) return null;
        if (observation.traceAddress !== undefined && (!Array.isArray(observation.traceAddress) || call.traceAddress === null ||
            observation.traceAddress.length !== call.traceAddress.length || observation.traceAddress.some((step, index) =>
              !Number.isSafeInteger(step) || step < 0 || step !== call.traceAddress![index]))) return null;
        return candidate;
      } catch { return null; }
    },
    candidateKey(candidate) { return selectorNativeCandidateKey(candidate, definition); },
    instanceNominationKey(candidate) { return selectorNativeCandidateKey(candidate as SelectorNativeCandidate, definition); },
    candidateCoverageKey(candidate) { return selectorNativeCandidateKey(candidate as SelectorNativeCandidate, definition); },
  };
  return { manifest, discovery };
}
