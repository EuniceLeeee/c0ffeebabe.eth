import type { CapabilityId, CapabilityRefV1 } from "../../../capability-contracts/src/index.ts";
import type { CanonicalJson, Hash } from "../../../canonical-codec/src/index.ts";
import type {
  CapabilityInterpreterPortV1,
  FrameworkFactSetCapabilityV1,
  ProgramInterpretationDraftV1,
  TransportFactSetCapabilityV1,
  TransportFactV1,
} from "../index.ts";
import type { FrozenProgramEnvelopeV1 } from "../../../request-program/src/index.ts";

export interface CapabilityInterpreterDeclarationV1 {
  readonly capabilityRef: CapabilityRefV1;
  readonly dependencyIds: readonly CapabilityId[];
  readonly outputSchemaRef: Hash;
  readonly implementationClosureHash: Hash;
  readonly outputCodecHash: Hash;
  readonly outputCodec: { readonly decodeExact: (value: unknown) => CanonicalJson };
  readonly interpret: (input: {
    readonly program: FrozenProgramEnvelopeV1;
    readonly payload: CanonicalJson;
    readonly facts: readonly TransportFactV1[];
    readonly dependencyRefs: readonly CapabilityRefV1[];
    readonly factSet: FrameworkFactSetCapabilityV1;
  }) => ProgramInterpretationDraftV1;
}

export interface InterpreterRegistryStateV1 {
  readonly declarations: ReadonlyMap<string, CapabilityInterpreterDeclarationV1>;
  readonly capabilityRefs: ReadonlyMap<string, CapabilityRefV1>;
  readonly releaseAuthorityRoot: Hash;
  readonly programAuthorityHash: Hash;
  readonly executorAuthorityRoot: Hash;
  readonly workerEpoch: string;
  readonly executorSessionHash: Hash;
  active: boolean;
}

const REGISTRIES = new WeakMap<object, InterpreterRegistryStateV1>();
const FACT_SETS = new WeakMap<object, { readonly registry: object; readonly factSetHash: Hash }>();
const TRANSPORT_FACT_SETS = new WeakMap<object, {
  readonly registry: object;
  readonly programRequestFingerprint: Hash;
  readonly facts: readonly unknown[];
}>();

export function registerInterpreterRegistry(port: CapabilityInterpreterPortV1, state: InterpreterRegistryStateV1): void {
  REGISTRIES.set(port, state);
}

export function requireInterpreterRegistry(port: CapabilityInterpreterPortV1): InterpreterRegistryStateV1 {
  const state = REGISTRIES.get(port);
  if (state === undefined) throw new TypeError("capability interpreter port was not issued");
  if (!state.active) throw new TypeError("capability interpreter registry is revoked");
  return state;
}

export function registerFactSet(token: FrameworkFactSetCapabilityV1, registry: object, factSetHash: Hash): void {
  FACT_SETS.set(token, { registry, factSetHash });
}

export function isExactFactSet(token: FrameworkFactSetCapabilityV1, registry: object, factSetHash: Hash): boolean {
  const state = FACT_SETS.get(token);
  return state?.registry === registry && state.factSetHash === factSetHash;
}

export function registerTransportFactSet(
  token: TransportFactSetCapabilityV1,
  registry: object,
  programRequestFingerprint: Hash,
  facts: readonly unknown[],
): void {
  if (TRANSPORT_FACT_SETS.has(token)) throw new TypeError("transport fact-set token already registered");
  TRANSPORT_FACT_SETS.set(token, { registry, programRequestFingerprint, facts });
}

export function requireTransportFactSet(
  token: TransportFactSetCapabilityV1,
  registry: object,
): { readonly programRequestFingerprint: Hash; readonly facts: readonly unknown[] } {
  const state = TRANSPORT_FACT_SETS.get(token);
  if (state === undefined || state.registry !== registry) {
    throw new TypeError("transport fact-set capability was not issued by this registry owner");
  }
  return state;
}
