import {
  assertCapabilityRef,
  asCapabilityId,
  type CapabilityRefV1,
} from "../../../capability-contracts/src/index.ts";
import {
  assertHash,
  assertNonEmptyString,
  decodeCanonicalJson,
  decodeExactObject,
  deepFreeze,
  encodeCanonicalJson,
  hashDomain,
  type CanonicalJson,
  type Hash,
} from "../../../canonical-codec/src/index.ts";
import {
  createCapabilityInterpreterRegistryOwner,
  type CapabilityInterpreterDeclarationV1,
} from "../../../capability-interpreters/src/internal/registry-owner.ts";
import {
  issueFrozenProgram,
  persistFrozenProgram,
} from "../../../request-program/src/index.ts";
import { createProgramIssuerOwner } from "../../../request-program/src/internal/issuer-owner.ts";
import {
  decodeFamilyStageProgram,
  familyStageProgramFingerprint,
  mapFamilyProgramInterpretation,
  type FamilyIssuedRouteHandleV1,
  type FamilyLifecycleOutcomeV1,
  type FamilyRouteHandleBindingV1,
  type FamilyRouteHandleIssuerPortV1,
  type FamilyRoutePublicationV1,
  type FamilyRouteProjectionV1,
  type FamilyRouteRehydrationRefV1,
  type FamilyRuntimeAuthorityBindingV1,
  type FamilyRuntimeOwnerV1,
  type FamilyRuntimeStageV1,
  type FamilyStageIssueInputV1,
  type FamilyStageGenericInvocationV1,
  type FamilyStageProgramV1,
  type FamilyStageDefinitionV1,
  type RuntimeStageDefinitionBindingV1,
  type RuntimeStageBindingV1,
  type FamilyStageRuntimePortV1,
  type FamilyStageExecuteInputV1,
  type FamilyRuntimePortV1,
} from "../index.ts";
import {
  asFamilyId,
  asFamilyInstanceKey,
  assertStageCapabilityRef,
  type StageCapabilityRefV1,
} from "../../runtime-refs/index.ts";
import {
  interpretCapabilityProgram,
  type TransportFactSetCapabilityV1,
} from "../../../capability-interpreters/src/index.ts";

function exactRef(left: unknown, right: unknown): boolean {
  return encodeCanonicalJson(left) === encodeCanonicalJson(right);
}

function authorityBinding(input: FamilyRuntimeAuthorityBindingV1): FamilyRuntimeAuthorityBindingV1 {
  const familyId = asFamilyId(input.familyId, "familyId");
  return deepFreeze({
    familyId,
    familyDefinitionHash: assertHash(input.familyDefinitionHash, "familyDefinitionHash"),
    releaseAuthorityRoot: assertHash(input.releaseAuthorityRoot, "releaseAuthorityRoot"),
    programAuthorityHash: assertHash(input.programAuthorityHash, "programAuthorityHash"),
    executorAuthorityRoot: assertHash(input.executorAuthorityRoot, "executorAuthorityRoot"),
    workerEpoch: typeof input.workerEpoch === "string" && input.workerEpoch.length > 0
      ? input.workerEpoch
      : (() => { throw new TypeError("workerEpoch must be non-empty"); })(),
    executorSessionHash: assertHash(input.executorSessionHash, "executorSessionHash"),
  });
}

function stageRefKey(ref: StageCapabilityRefV1): string {
  return encodeCanonicalJson(ref);
}

function capabilityRefFromStage(ref: StageCapabilityRefV1): CapabilityRefV1 {
  return assertCapabilityRef({
    capabilityId: ref.capabilityId,
    version: ref.version,
    schemaHash: ref.schemaHash,
    interpreterHash: ref.interpreterHash,
    ownerRef: ref.ownerRef,
  });
}

interface RuntimeStageDefinitionBindingStateV1 {
  readonly stageRef: StageCapabilityRefV1;
  readonly definition: FamilyStageDefinitionV1;
  readonly prepareIssueValue: FamilyStageDefinitionV1["prepareIssueValue"];
  readonly descriptorClosureHash: Hash;
  readonly bindingHash: Hash;
}

const RUNTIME_STAGE_DEFINITION_BINDINGS = new WeakMap<object, RuntimeStageDefinitionBindingStateV1>();

function assertFrozenDefinition(definition: FamilyStageDefinitionV1): void {
  if (!Object.isFrozen(definition) || !Object.isFrozen(definition.payloadCodec) || !Object.isFrozen(definition.outputCodec) || !Object.isFrozen(definition.dependencyIds)) {
    throw new TypeError("Family stage definition must be deeply frozen before release binding");
  }
}

function definitionBindingHash(
  stageRef: StageCapabilityRefV1,
  definition: FamilyStageDefinitionV1,
  descriptorClosureHash: Hash,
): Hash {
  return hashDomain("aloha/family-stage-definition-binding/v1", {
    stageRef,
    descriptorClosureHash,
    stage: definition.stage,
    capabilityId: definition.capabilityId,
    version: definition.version,
    schemaHash: definition.schemaHash,
    dependencyIds: definition.dependencyIds,
    payloadSchemaRef: definition.payloadCodec.schemaRef,
    outputSchemaRef: definition.outputSchemaRef,
    implementationClosureHash: definition.implementationClosureHash,
    outputCodecHash: definition.outputCodecHash,
  });
}

/**
 * Owner-only hand-off used by generated/release composition. The descriptor
 * closure is supplied by the generator and must equal the generated ref's
 * interpreterHash; Family code cannot construct a usable binding token.
 */
export function issueRuntimeStageDefinitionBinding(input: {
  readonly stageRef: StageCapabilityRefV1;
  readonly definition: FamilyStageDefinitionV1;
  readonly descriptorClosureHash: Hash;
}): RuntimeStageDefinitionBindingV1 {
  assertStageCapabilityRef(input.stageRef, "stageRef");
  assertFrozenDefinition(input.definition);
  const descriptorClosureHash = assertHash(input.descriptorClosureHash, "descriptorClosureHash");
  if (descriptorClosureHash !== input.stageRef.interpreterHash) throw new TypeError("runtime descriptor closure does not match stage ref interpreter hash");
  if (
    input.definition.stage !== input.stageRef.stage
    || input.definition.capabilityId !== input.stageRef.capabilityId
    || input.definition.version !== input.stageRef.version
    || input.definition.schemaHash !== input.stageRef.schemaHash
  ) throw new TypeError("runtime definition does not match generated stage identity");
  const token = Object.create(null) as RuntimeStageDefinitionBindingV1;
  Object.defineProperty(token, "opaque", {
    value: Object.freeze(Object.create(null)),
    enumerable: false,
    writable: false,
    configurable: false,
  });
  RUNTIME_STAGE_DEFINITION_BINDINGS.set(token, {
    stageRef: deepFreeze(decodeCanonicalJson(encodeCanonicalJson(input.stageRef))) as unknown as StageCapabilityRefV1,
    definition: input.definition,
    prepareIssueValue: input.definition.prepareIssueValue,
    descriptorClosureHash,
    bindingHash: definitionBindingHash(input.stageRef, input.definition, descriptorClosureHash),
  });
  return Object.freeze(token);
}

function requireRuntimeStageDefinitionBinding(
  token: RuntimeStageDefinitionBindingV1,
  stageRef: StageCapabilityRefV1,
  definition: FamilyStageDefinitionV1,
): void {
  if (token === null || typeof token !== "object") throw new TypeError("runtime definition binding is not an object");
  const state = RUNTIME_STAGE_DEFINITION_BINDINGS.get(token);
  if (state === undefined) throw new TypeError("runtime definition binding was not issued by release composition");
  if (state.definition !== definition || state.prepareIssueValue !== definition.prepareIssueValue || !exactRef(state.stageRef, stageRef)) throw new TypeError("runtime definition binding does not match exact stage definition/ref/prepare");
  if (state.descriptorClosureHash !== stageRef.interpreterHash || definitionBindingHash(stageRef, definition, state.descriptorClosureHash) !== state.bindingHash) {
    throw new TypeError("runtime definition binding closure mismatch");
  }
}

function validateDefinition(
  registration: FamilyStageDefinitionV1,
  binding: FamilyRuntimeAuthorityBindingV1,
): FamilyRuntimeStageV1 {
  if (!registration || typeof registration !== "object") throw new TypeError("Family stage definition is required");
  if (registration.stage !== "nomination" && registration.stage !== "identity" && registration.stage !== "materialization" && registration.stage !== "projection" && registration.stage !== "rehydration") throw new TypeError("unknown Family stage definition stage");
  if (typeof registration.payloadCodec?.decodeExact !== "function" || typeof registration.outputCodec?.decodeExact !== "function") {
    throw new TypeError("Family stage codecs are required");
  }
  if (registration.payloadCodec.schemaRef !== registration.schemaHash) throw new TypeError("Family stage payload schema mismatch");
  if (!Array.isArray(registration.dependencyIds)) throw new TypeError("Family stage dependencies are required");
  const dependencies = registration.dependencyIds.map((id, index) => asCapabilityId(id, `dependencyIds[${index}]`));
  if (new Set(dependencies).size !== dependencies.length || dependencies.includes(registration.capabilityId)) throw new TypeError("invalid Family stage dependency closure");
  asCapabilityId(registration.capabilityId, "capabilityId");
  if (typeof registration.version !== "string" || registration.version.length === 0) throw new TypeError("Family stage version is required");
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(registration.version)) throw new TypeError("Family stage version is invalid");
  assertHash(registration.schemaHash, "schemaHash");
  assertHash(registration.outputSchemaRef, "outputSchemaRef");
  assertHash(registration.implementationClosureHash, "implementationClosureHash");
  assertHash(registration.outputCodecHash, "outputCodecHash");
  if (typeof registration.interpret !== "function") throw new TypeError("Family stage definition callbacks are required");
  if (typeof registration.prepareIssueValue !== "function") throw new TypeError("Family stage prepare callback is required");
  return registration.stage;
}

function canonical(value: unknown, path: string): CanonicalJson {
  try {
    return decodeCanonicalJson(encodeCanonicalJson(value));
  } catch (error) {
    throw new TypeError(`${path} must be canonical JSON`, { cause: error });
  }
}

function cutoff(value: unknown, path: string): FamilyStageGenericInvocationV1["cutoff"] {
  return deepFreeze(decodeExactObject(value, {
    chainId: (item, itemPath) => assertNonEmptyString(item, itemPath),
    number: (item, itemPath) => assertNonEmptyString(item, itemPath),
    hash: (item, itemPath) => assertHash(item, itemPath),
    stateRoot: (item, itemPath) => assertHash(item, itemPath),
  }, path));
}

function genericInvocation(value: unknown, path = "familyStageInvocation"): FamilyStageGenericInvocationV1 {
  const decoded = decodeExactObject(value, {
    stage: (item, itemPath) => {
      if (!(["nomination", "identity", "materialization", "projection", "rehydration"] as readonly string[]).includes(item as string)) {
        throw new TypeError(`unknown Family invocation stage at ${itemPath}`);
      }
      return item as FamilyRuntimeStageV1;
    },
    candidate: (item, itemPath) => canonical(item, itemPath),
    cutoff: (item, itemPath) => cutoff(item, itemPath),
    identityMemo: (item, itemPath) => item === null ? null : canonical(item, itemPath),
    materializationOutput: (item, itemPath) => item === null ? null : canonical(item, itemPath),
    reusePublication: (item, itemPath) => item === null ? null : canonical(item, itemPath),
  }, path);
  const needsIdentityMemo = decoded.stage === "materialization" || decoded.stage === "projection";
  if (needsIdentityMemo !== (decoded.identityMemo !== null)) {
    throw new TypeError("Family invocation identity memo is only valid and required for materialization/projection");
  }
  if ((decoded.stage === "projection") !== (decoded.materializationOutput !== null)) {
    throw new TypeError("Family invocation materialization output is only valid and required for projection");
  }
  if ((decoded.stage === "rehydration") !== (decoded.reusePublication !== null)) {
    throw new TypeError("Family invocation reuse publication is only valid and required for rehydration");
  }
  return deepFreeze(decoded);
}

function issueInput(value: FamilyStageIssueInputV1, path = "familyStageIssue"): FamilyStageIssueInputV1 {
  const decoded = decodeExactObject(value, {
    candidateKey: (item, itemPath) => assertHash(item, itemPath),
    instanceKey: (item, itemPath) => item === null
      ? null
      : asFamilyInstanceKey(typeof item === "string" ? item : (() => { throw new TypeError(`${itemPath} must be a string or null`); })(), itemPath),
    evidenceRoot: (item, itemPath) => assertHash(item, itemPath),
    invocation: (item, itemPath) => genericInvocation(item, itemPath),
  }, path);
  return deepFreeze(decoded);
}

function makeRouteHandle(): FamilyIssuedRouteHandleV1 {
  const handle = {} as FamilyIssuedRouteHandleV1;
  Object.defineProperty(handle, "opaque", {
    value: Object.freeze(Object.create(null)),
    enumerable: false,
    writable: false,
    configurable: false,
  });
  return Object.freeze(handle);
}

function routePublication(value: unknown, path: string): FamilyRoutePublicationV1 {
  const canonical = decodeCanonicalJson(encodeCanonicalJson(value));
  if (canonical === null || typeof canonical !== "object" || Array.isArray(canonical)) throw new TypeError(`${path} must be an object`);
  const record = canonical as Record<string, unknown>;
  const publication = deepFreeze({
    familyId: typeof record.familyId === "string" && record.familyId.length > 0 ? record.familyId : (() => { throw new TypeError(`${path}.familyId`); })(),
    familyDefinitionHash: assertHash(record.familyDefinitionHash, `${path}.familyDefinitionHash`),
    instanceKey: asFamilyInstanceKey(typeof record.instanceKey === "string" ? record.instanceKey : "", `${path}.instanceKey`),
    identityMemo: decodeCanonicalJson(encodeCanonicalJson(record.identityMemo)),
    identityMemoHash: assertHash(record.identityMemoHash, `${path}.identityMemoHash`),
    instancePublicationHash: assertHash(record.instancePublicationHash, `${path}.instancePublicationHash`),
    staticProjectionMemoHash: assertHash(record.staticProjectionMemoHash, `${path}.staticProjectionMemoHash`),
    requestedArtifactDependencyRoot: assertHash(record.requestedArtifactDependencyRoot, `${path}.requestedArtifactDependencyRoot`),
  });
  if (hashDomain("aloha/identity-memo/v1", publication.identityMemo) !== publication.identityMemoHash) {
    throw new TypeError(`${path}.identityMemoHash does not bind identityMemo`);
  }
  return publication;
}

function routeProjection(value: unknown, path: string): FamilyRouteProjectionV1 {
  const canonical = decodeCanonicalJson(encodeCanonicalJson(value));
  if (canonical === null || typeof canonical !== "object" || Array.isArray(canonical)) throw new TypeError(`${path} must be an object`);
  const record = canonical as Record<string, unknown>;
  return deepFreeze({
    staticProjectionHash: assertHash(record.staticProjectionHash, `${path}.staticProjectionHash`),
    projectionHash: assertHash(record.projectionHash, `${path}.projectionHash`),
  });
}

function routeRef(value: unknown, path: string): FamilyRouteRehydrationRefV1 {
  const decoded = decodeExactObject(value, {
    familyDefinitionHash: (item, itemPath) => assertHash(item, itemPath),
    instanceKey: (item, itemPath) => asFamilyInstanceKey(typeof item === "string" ? item : "", itemPath),
    instancePublicationHash: (item, itemPath) => assertHash(item, itemPath),
    staticProjectionMemoHash: (item, itemPath) => assertHash(item, itemPath),
    requestedArtifactDependencyRoot: (item, itemPath) => assertHash(item, itemPath),
  }, path);
  return deepFreeze(decoded);
}

function createRouteHandleAuthority(
  binding: FamilyRuntimeAuthorityBindingV1,
): FamilyRouteHandleIssuerPortV1 {
  let active = true;
  let sessionHash = binding.executorSessionHash;
  const handles = new WeakMap<object, FamilyRouteHandleBindingV1>();

  const assertOwned = (handle: FamilyIssuedRouteHandleV1): FamilyRouteHandleBindingV1 => {
    if (!active) throw new Error("Family route authority revoked");
    if (handle === null || typeof handle !== "object") throw new TypeError("Family route handle is not an object");
    const state = handles.get(handle);
    if (state === undefined) throw new TypeError("Family route handle was not issued by this authority");
    if (state.authoritySessionHash !== sessionHash) throw new Error("Family route handle session is stale");
    return state;
  };

  return Object.freeze({
    issueRouteHandle(publicationInput: FamilyRoutePublicationV1, projectionInput: FamilyRouteProjectionV1, refInput: FamilyRouteRehydrationRefV1) {
      if (!active) throw new Error("Family route authority revoked");
      const publication = routePublication(publicationInput, "publication");
      const projection = routeProjection(projectionInput, "projection");
      const ref = routeRef(refInput, "rehydrationRef");
      if (
        publication.familyId !== binding.familyId
        || publication.familyDefinitionHash !== binding.familyDefinitionHash
        || ref.familyDefinitionHash !== publication.familyDefinitionHash
        || ref.instanceKey !== publication.instanceKey
        || ref.instancePublicationHash !== publication.instancePublicationHash
        || ref.staticProjectionMemoHash !== publication.staticProjectionMemoHash
        || ref.requestedArtifactDependencyRoot !== publication.requestedArtifactDependencyRoot
      ) throw new TypeError("Family route publication/ref mismatch");
      const handle = makeRouteHandle();
      const state = deepFreeze({
        familyId: publication.familyId,
        familyDefinitionHash: publication.familyDefinitionHash,
        instanceKey: publication.instanceKey,
        identityMemo: publication.identityMemo,
        identityMemoHash: publication.identityMemoHash,
        instancePublicationHash: publication.instancePublicationHash,
        staticProjectionMemoHash: publication.staticProjectionMemoHash,
        requestedArtifactDependencyRoot: publication.requestedArtifactDependencyRoot,
        staticProjectionHash: projection.staticProjectionHash,
        projectionHash: projection.projectionHash,
        authoritySessionHash: sessionHash,
      });
      handles.set(handle, state);
      return handle;
    },
    resolveRouteHandle(handle: FamilyIssuedRouteHandleV1) {
      return deepFreeze({ ...assertOwned(handle) });
    },
    assertRouteHandleActive(handle: FamilyIssuedRouteHandleV1) {
      assertOwned(handle);
    },
    rotate(next: { readonly executorSessionHash: Hash }) {
      if (!active) throw new Error("Family route authority revoked");
      sessionHash = assertHash(next.executorSessionHash, "executorSessionHash");
    },
    revoke() {
      active = false;
    },
  });
}

export interface CreateFamilyRuntimeAuthorityInputV1 {
  readonly binding: FamilyRuntimeAuthorityBindingV1;
  readonly stages: readonly RuntimeStageBindingV1[];
}

export function createFamilyRuntimeAuthority(input: CreateFamilyRuntimeAuthorityInputV1): FamilyRuntimeOwnerV1 {
  const binding = authorityBinding(input.binding);
  if (!Array.isArray(input.stages) || input.stages.length !== 5) throw new TypeError("Family runtime requires exactly five lifecycle stages");
  const refs = input.stages.map((stageBinding, index) => {
    if (stageBinding === null || typeof stageBinding !== "object") throw new TypeError(`runtime stage binding ${index} is required`);
    const ref = stageBinding.stageRef;
    assertStageCapabilityRef(ref, `stages[${index}].stageRef`);
    const stage = validateDefinition(stageBinding.definition, binding);
    if (
      ref.familyId !== binding.familyId
      || ref.familyDefinitionHash !== binding.familyDefinitionHash
      || ref.stage !== stage
      || ref.capabilityId !== stageBinding.definition.capabilityId
      || ref.version !== stageBinding.definition.version
      || ref.schemaHash !== stageBinding.definition.schemaHash
    ) throw new TypeError("generated stage ref does not match Family stage definition");
    requireRuntimeStageDefinitionBinding(stageBinding.definitionBinding, ref, stageBinding.definition);
    if (typeof stageBinding.executor?.execute !== "function") throw new TypeError("runtime stage executor is required");
    return ref;
  });
  const stageSet = new Set(refs.map(ref => ref.stage));
  if (stageSet.size !== 5 || refs.some(ref => !["nomination", "identity", "materialization", "projection", "rehydration"].includes(ref.stage))) {
    throw new TypeError("Family runtime stage set is incomplete");
  }
  const capabilityRefs = refs.map(ref => capabilityRefFromStage(ref));
  const capabilityIds = new Set(capabilityRefs.map(ref => ref.capabilityId));
  if (capabilityIds.size !== capabilityRefs.length) throw new TypeError("duplicate Family stage capability");

  const programOwners = new Map<string, ReturnType<typeof createProgramIssuerOwner>>();
  for (const stageBinding of input.stages) {
    const definition = stageBinding.definition;
    const ref = stageBinding.stageRef;
    programOwners.set(stageRefKey(ref), createProgramIssuerOwner({
      issuerRef: ref.ownerRef,
      capabilityRef: capabilityRefFromStage(ref),
      authorityHash: binding.programAuthorityHash,
      codec: definition.payloadCodec,
    }));
  }

  const refByCapability = new Map<string, StageCapabilityRefV1>();
  for (const stageBinding of input.stages) refByCapability.set(stageBinding.definition.capabilityId, stageBinding.stageRef);
  const declarations: CapabilityInterpreterDeclarationV1[] = input.stages.map(stageBinding => {
    const definition = stageBinding.definition;
    const ref = stageBinding.stageRef;
    return {
      capabilityRef: capabilityRefFromStage(ref),
      dependencyIds: definition.dependencyIds.map((id: string, index: number) => asCapabilityId(id, `dependencyIds[${index}]`)),
      outputSchemaRef: definition.outputSchemaRef,
      implementationClosureHash: definition.implementationClosureHash,
      outputCodecHash: definition.outputCodecHash,
      outputCodec: definition.outputCodec,
      interpret: ({ program, payload, facts, dependencyRefs, factSet }) => definition.interpret({
        program,
        payload,
        facts,
        dependencyRefs: dependencyRefs.map(ref => refByCapability.get(ref.capabilityId) ?? (() => { throw new TypeError(`missing Family dependency ${ref.capabilityId}`); })()),
        factSet,
      }),
    };
  });
  const registryOwner = createCapabilityInterpreterRegistryOwner({
    capabilityRefs,
    declarations,
    releaseAuthorityRoot: binding.releaseAuthorityRoot,
    programAuthorityHash: binding.programAuthorityHash,
    executorAuthorityRoot: binding.executorAuthorityRoot,
    workerEpoch: binding.workerEpoch,
    executorSessionHash: binding.executorSessionHash,
  });
  let active = true;
  const stagePorts = new Map<string, FamilyStageRuntimePortV1>();

  for (const stageBinding of input.stages) {
    const definition = stageBinding.definition;
    const ref = stageBinding.stageRef;
    const issuer = programOwners.get(stageRefKey(ref))!;
    const port: FamilyStageRuntimePortV1 = Object.freeze({
      stageRef: deepFreeze(decodeCanonicalJson(encodeCanonicalJson(ref))) as unknown as StageCapabilityRefV1,
      issue(rawInput: FamilyStageIssueInputV1): FamilyStageProgramV1 {
        if (!active) throw new Error("Family runtime authority revoked");
        const issueValue = issueInput(rawInput);
        if (issueValue.invocation.stage !== ref.stage) throw new TypeError("Family invocation stage does not match stage port");
        const preparedValue = definition.prepareIssueValue(issueValue.invocation);
        const exactPayload = definition.payloadCodec.decodeExact(preparedValue);
        const frozenProgram = issueFrozenProgram(issuer.capability, { source: issueValue.invocation.cutoff, value: exactPayload });
        const frozenProgramRecord = persistFrozenProgram(frozenProgram);
        const base = {
          kind: "aloha.family-stage-program" as const,
          version: 1 as const,
          familyId: binding.familyId,
          familyDefinitionHash: binding.familyDefinitionHash,
          stage: ref.stage,
          stageRef: ref,
          candidateKey: issueValue.candidateKey,
          instanceKey: issueValue.instanceKey,
          source: issueValue.invocation.cutoff,
          evidenceRoot: issueValue.evidenceRoot,
          frozenProgram,
          frozenProgramRef: {
            requestFingerprint: frozenProgramRecord.requestFingerprint,
            recordHash: frozenProgramRecord.recordHash,
          },
        };
        return decodeFamilyStageProgram({ ...base, requestFingerprint: familyStageProgramFingerprint(base) });
      },
      async execute(executeInput: FamilyStageExecuteInputV1): Promise<TransportFactSetCapabilityV1> {
        if (!active) throw new Error("Family runtime authority revoked");
        const program = decodeFamilyStageProgram(executeInput.program);
        if (!exactRef(program.stageRef, ref)) throw new TypeError("Family stage program resolved by wrong stage port");
        const attemptId = executeInput.attemptId ?? program.requestFingerprint;
        const signal = executeInput.signal ?? new AbortController().signal;
        const facts = await stageBinding.executor.execute({ program, attemptId, signal });
        if (!Array.isArray(facts) || facts.length === 0) throw new TypeError("Family executor returned no transport facts");
        const factSet = registryOwner.issueFactSet({
          programRequestFingerprint: program.frozenProgram.requestFingerprint,
          facts,
        });
        return factSet;
      },
      interpret(interpretInput: { readonly program: FamilyStageProgramV1; readonly factSet: TransportFactSetCapabilityV1 }): FamilyLifecycleOutcomeV1 {
        if (!active) throw new Error("Family runtime authority revoked");
        const program = decodeFamilyStageProgram(interpretInput.program);
        if (!exactRef(program.stageRef, ref)) throw new TypeError("Family stage program interpreted by wrong stage port");
        const interpretation = interpretCapabilityProgram(registryOwner.port, {
          program: program.frozenProgram,
          factSet: interpretInput.factSet,
        });
        return mapFamilyProgramInterpretation(program, interpretation);
      },
    });
    stagePorts.set(stageRefKey(ref), port);
  }

  const routeHandles = createRouteHandleAuthority(binding);
  const port: FamilyRuntimePortV1 = Object.freeze({
    getStage(stageRef: StageCapabilityRefV1): FamilyStageRuntimePortV1 {
      if (!active) throw new Error("Family runtime authority revoked");
      assertStageCapabilityRef(stageRef, "stageRef");
      const resolved = stagePorts.get(stageRefKey(stageRef));
      if (resolved === undefined) throw new TypeError("Family stage ref is not in this runtime composition");
      return resolved;
    },
  });
  return Object.freeze({
    port,
    routeHandles,
    revoke() {
      if (!active) return;
      active = false;
      for (const owner of programOwners.values()) owner.revoke();
      registryOwner.revoke();
      routeHandles.revoke();
    },
    rotate(next: { readonly executorSessionHash: Hash }) {
      if (!active) throw new Error("Family runtime authority revoked");
      const executorSessionHash = assertHash(next.executorSessionHash, "executorSessionHash");
      routeHandles.rotate({ executorSessionHash });
    },
  });
}
