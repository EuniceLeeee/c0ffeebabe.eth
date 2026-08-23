import { assertCapabilityRef, type CapabilityRefV1 } from "../../../capability-contracts/src/index.ts";
import { assertHash, assertNonEmptyString, deepFreeze, hashDomain, type Hash } from "../../../canonical-codec/src/index.ts";
import type { CapabilityInterpreterPortV1, TransportFactSetCapabilityV1 } from "../index.ts";
import {
  registerInterpreterRegistry,
  registerTransportFactSet,
  type CapabilityInterpreterDeclarationV1,
  type InterpreterRegistryStateV1,
} from "./registry-state.ts";

export interface CapabilityInterpreterRegistryOwnerV1 {
  readonly port: CapabilityInterpreterPortV1;
  issueFactSet(input: {
    readonly programRequestFingerprint: Hash;
    readonly facts: readonly unknown[];
  }): TransportFactSetCapabilityV1;
  revoke(): void;
}

export function createCapabilityInterpreterRegistryOwner(input: {
  readonly capabilityRefs: readonly CapabilityRefV1[];
  readonly declarations: readonly CapabilityInterpreterDeclarationV1[];
  readonly releaseAuthorityRoot: Hash;
  readonly programAuthorityHash: Hash;
  readonly executorAuthorityRoot: Hash;
  readonly workerEpoch: string;
  readonly executorSessionHash: Hash;
}): CapabilityInterpreterRegistryOwnerV1 {
  const releaseAuthorityRoot = assertHash(input.releaseAuthorityRoot, "releaseAuthorityRoot");
  const programAuthorityHash = assertHash(input.programAuthorityHash, "programAuthorityHash");
  const executorAuthorityRoot = assertHash(input.executorAuthorityRoot, "executorAuthorityRoot");
  const workerEpoch = assertNonEmptyString(input.workerEpoch, "workerEpoch");
  const executorSessionHash = assertHash(input.executorSessionHash, "executorSessionHash");
  const capabilityRefs = input.capabilityRefs.map((ref, index) => assertCapabilityRef(ref, `capabilityRefs[${index}]`));
  const refById = new Map(capabilityRefs.map(ref => [ref.capabilityId, ref] as const));
  if (refById.size !== capabilityRefs.length) throw new TypeError("duplicate registry capability ref");
  const declarations = new Map<string, CapabilityInterpreterDeclarationV1>();
  for (const [index, declaration] of input.declarations.entries()) {
    const ref = assertCapabilityRef(declaration.capabilityRef, `declarations[${index}].capabilityRef`);
    const released = refById.get(ref.capabilityId);
    if (released === undefined || JSON.stringify(released) !== JSON.stringify(ref)) throw new TypeError(`interpreter declaration is not exact release capability ${ref.capabilityId}`);
    if (declarations.has(ref.capabilityId)) throw new TypeError(`duplicate interpreter declaration ${ref.capabilityId}`);
    const dependencies = [...declaration.dependencyIds].sort();
    if (new Set(dependencies).size !== dependencies.length || dependencies.some(id => !refById.has(id))) throw new TypeError(`invalid interpreter dependency closure ${ref.capabilityId}`);
    if (typeof declaration.interpret !== "function" || typeof declaration.outputCodec?.decodeExact !== "function") throw new TypeError(`interpreter implementation missing ${ref.capabilityId}`);
    declarations.set(ref.capabilityId, Object.freeze({
      capabilityRef: ref,
      dependencyIds: Object.freeze(dependencies),
      outputSchemaRef: assertHash(declaration.outputSchemaRef, `declarations[${index}].outputSchemaRef`),
      implementationClosureHash: assertHash(declaration.implementationClosureHash, `declarations[${index}].implementationClosureHash`),
      outputCodecHash: assertHash(declaration.outputCodecHash, `declarations[${index}].outputCodecHash`),
      outputCodec: Object.freeze({ decodeExact: declaration.outputCodec.decodeExact }),
      interpret: declaration.interpret,
    }));
  }
  const port = Object.freeze({ registryRoot: hashDomain("aloha/capability-interpreter-registry/v2", {
    releaseAuthorityRoot,
    programAuthorityHash,
    executorAuthorityRoot,
    workerEpoch,
    executorSessionHash,
    declarations: [...declarations.values()].map(declaration => ({
      capabilityRef: declaration.capabilityRef,
      dependencyIds: declaration.dependencyIds,
      outputSchemaRef: declaration.outputSchemaRef,
      implementationClosureHash: declaration.implementationClosureHash,
      outputCodecHash: declaration.outputCodecHash,
    })).sort((left, right) => left.capabilityRef.capabilityId.localeCompare(right.capabilityRef.capabilityId)),
  }) }) as CapabilityInterpreterPortV1;
  const state: InterpreterRegistryStateV1 = {
    declarations,
    capabilityRefs: refById,
    releaseAuthorityRoot,
    programAuthorityHash,
    executorAuthorityRoot,
    workerEpoch,
    executorSessionHash,
    active: true,
  };
  registerInterpreterRegistry(port, state);
  return Object.freeze({
    port,
    issueFactSet(factInput: {
      readonly programRequestFingerprint: Hash;
      readonly facts: readonly unknown[];
    }) {
      if (!state.active) throw new TypeError("interpreter registry is revoked");
      const programRequestFingerprint = assertHash(factInput.programRequestFingerprint, "programRequestFingerprint");
      if (!Array.isArray(factInput.facts) || factInput.facts.length === 0) throw new TypeError("transport facts must be non-empty");
      const facts = Object.freeze([...factInput.facts]);
      const token = deepFreeze({
        factSetHash: hashDomain("aloha/transport-fact-set/v1", { programRequestFingerprint, facts }),
      });
      registerTransportFactSet(token, port, programRequestFingerprint, facts);
      return token;
    },
    revoke: () => { state.active = false; },
  });
}

export type { CapabilityInterpreterDeclarationV1 } from "./registry-state.ts";
