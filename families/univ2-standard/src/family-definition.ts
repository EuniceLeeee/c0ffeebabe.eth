import {
  defineFamily,
  familyAuthoringDigest,
  type FamilyAuthoringDefinitionV1,
} from "../../../packages/family-sdk/authoring/index.ts";
import { FAMILY_SEARCH_RUNTIME_ADAPTER_ROLE_V1 } from "../../../packages/family-sdk/search-runtime/index.ts";
import {
  asCapabilityId,
  asCapabilityVersion,
  asOwnerRef,
  asSchemaRef,
  type CapabilityAuthoringDeclarationV1,
  type FamilyFactContractRefV1,
} from "../../../packages/capability-contracts/src/index.ts";
import { hashDomain, type Hash } from "../../../packages/canonical-codec/src/index.ts";
import {
  UNIV2_STANDARD_COARSE_CAPABILITY_ID,
  UNIV2_STANDARD_COARSE_INTERPRETER_HASH,
  UNIV2_STANDARD_COARSE_SCHEMA_HASH,
  UNIV2_STANDARD_EXACT_CAPABILITY_ID,
  UNIV2_STANDARD_EXACT_INTERPRETER_HASH,
  UNIV2_STANDARD_EXACT_SCHEMA_HASH,
  UNIV2_STANDARD_STATE_CAPABILITY_ID,
  UNIV2_STANDARD_STATE_INTERPRETER_HASH,
  UNIV2_STANDARD_STATE_SCHEMA_HASH,
  UNIV2_STANDARD_SWAP_ACTION_IMPLEMENTATION_HASH,
  UNIV2_STANDARD_SWAP_ACTION_OWNER_ID,
  UNIV2_STANDARD_SWAP_ACTION_SCHEMA_HASH,
} from "./capabilities/metadata.ts";
import {
  UNIV2_STANDARD_HISTORY_SOURCE_PLAN_ID,
  UNIV2_STANDARD_HISTORY_SOURCE_PLAN_SCHEMA_HASH,
  UNIV2_STANDARD_SOURCE_PLAN_ID,
  UNIV2_STANDARD_SOURCE_PLAN_SCHEMA_HASH,
} from "./source-plan.ts";

/**
 * This is the build-time family definition.  Runtime stages import only the
 * resulting hashes and stage identifiers; they never receive this object.
 * Keeping this object here makes the stable five-stage template explicit
 * without turning it into a runtime Family god object.
 */
export const UNIV2_STANDARD_FAMILY_ID = "univ2-standard" as const;
export const UNIV2_STANDARD_FAMILY_VERSION = "1.0.0" as const;

const moduleRoot = "families/univ2-standard/src";
const version = asCapabilityVersion(UNIV2_STANDARD_FAMILY_VERSION);
const ownerRef = asOwnerRef(hashDomain("aloha/univ2-standard/owner/v1", {
  familyId: UNIV2_STANDARD_FAMILY_ID,
  version: UNIV2_STANDARD_FAMILY_VERSION,
}));

function stage(
  stageName: "nomination" | "identity" | "materialization" | "projection" | "rehydration",
  artifactKind: "nomination" | "identity" | "materialization" | "projection" | "rehydration",
  exportName: string,
): CapabilityAuthoringDeclarationV1 {
  const capabilityId = asCapabilityId(`family.${UNIV2_STANDARD_FAMILY_ID}.${stageName}`);
  // The catalog must bind the executable runtime definition, not the pure
  // stage kernel.  The runtime definition is where returned transport facts
  // are decoded and where the five-stage owner boundary is enforced.
  const modulePath = `${moduleRoot}/runtime/definitions.ts`;
  const schemaHash = asSchemaRef(hashDomain("aloha/univ2-standard/stage-schema/v1", {
    capabilityId,
    version,
    stageName,
  }));
  return Object.freeze({
    capabilityId,
    version,
    schemaHash,
    interpreterHash: hashDomain("aloha/univ2-standard/stage-interpreter/v1", {
      capabilityId,
      modulePath,
      exportName,
    }),
    dependencyIds: Object.freeze([]),
    artifactKinds: Object.freeze([artifactKind]),
    modulePath,
    exportName,
  });
}

const nomination = stage("nomination", "nomination", "UNIV2_STANDARD_NOMINATION_DEFINITION");
const identity = stage("identity", "identity", "UNIV2_STANDARD_IDENTITY_DEFINITION");
const materialization = stage("materialization", "materialization", "UNIV2_STANDARD_MATERIALIZATION_DEFINITION");
const projection = stage("projection", "projection", "UNIV2_STANDARD_PROJECTION_DEFINITION");
const rehydration = stage("rehydration", "rehydration", "UNIV2_STANDARD_REHYDRATION_DEFINITION");

function extension(
  capabilityId: typeof UNIV2_STANDARD_STATE_CAPABILITY_ID | typeof UNIV2_STANDARD_COARSE_CAPABILITY_ID | typeof UNIV2_STANDARD_EXACT_CAPABILITY_ID,
  artifactKind: "state" | "coarse" | "exact",
  schemaHash: typeof UNIV2_STANDARD_STATE_SCHEMA_HASH | typeof UNIV2_STANDARD_COARSE_SCHEMA_HASH | typeof UNIV2_STANDARD_EXACT_SCHEMA_HASH,
  interpreterHash: Hash,
  modulePath: string,
  exportName: string,
  dependencyIds: readonly typeof capabilityId[] = [],
): CapabilityAuthoringDeclarationV1 {
  return Object.freeze({
    capabilityId,
    version,
    schemaHash,
    interpreterHash,
    dependencyIds: Object.freeze([...dependencyIds]),
    artifactKinds: Object.freeze([artifactKind]),
    modulePath,
    exportName,
  });
}

const stateExtension = extension(
  UNIV2_STANDARD_STATE_CAPABILITY_ID,
  "state",
  UNIV2_STANDARD_STATE_SCHEMA_HASH,
  UNIV2_STANDARD_STATE_INTERPRETER_HASH,
  "families/univ2-standard/src/capabilities/state.ts",
  "UNIV2_STANDARD_STATE_PORT",
);
const coarseExtension = extension(
  UNIV2_STANDARD_COARSE_CAPABILITY_ID,
  "coarse",
  UNIV2_STANDARD_COARSE_SCHEMA_HASH,
  UNIV2_STANDARD_COARSE_INTERPRETER_HASH,
  "families/univ2-standard/src/capabilities/coarse.ts",
  "UNIV2_STANDARD_COARSE_PORT",
  [UNIV2_STANDARD_STATE_CAPABILITY_ID],
);
const exactExtension = extension(
  UNIV2_STANDARD_EXACT_CAPABILITY_ID,
  "exact",
  UNIV2_STANDARD_EXACT_SCHEMA_HASH,
  UNIV2_STANDARD_EXACT_INTERPRETER_HASH,
  "families/univ2-standard/src/capabilities/exact.ts",
  "UNIV2_STANDARD_EXACT_PORT",
  [UNIV2_STANDARD_STATE_CAPABILITY_ID],
);

export const UNIV2_STANDARD_EXTENSION_CAPABILITY_IDS = Object.freeze({
  state: UNIV2_STANDARD_STATE_CAPABILITY_ID,
  coarse: UNIV2_STANDARD_COARSE_CAPABILITY_ID,
  exact: UNIV2_STANDARD_EXACT_CAPABILITY_ID,
});

export const UNIV2_STANDARD_EXTENSION_SCHEMA_HASHES = Object.freeze({
  state: UNIV2_STANDARD_STATE_SCHEMA_HASH,
  coarse: UNIV2_STANDARD_COARSE_SCHEMA_HASH,
  exact: UNIV2_STANDARD_EXACT_SCHEMA_HASH,
});

/** Exactly one executable owner is declared for the Family's swap action. */
export const UNIV2_STANDARD_SWAP_ACTION_OWNER = Object.freeze({
  ownerId: UNIV2_STANDARD_SWAP_ACTION_OWNER_ID,
  version,
  schemaHash: UNIV2_STANDARD_SWAP_ACTION_SCHEMA_HASH,
  implementationHash: UNIV2_STANDARD_SWAP_ACTION_IMPLEMENTATION_HASH,
  actionKinds: Object.freeze(["swap"]),
  modulePath: "families/univ2-standard/src/capabilities/action.ts",
  exportName: "UNIV2_STANDARD_SWAP_ACTION_PORT",
});

export const UNIV2_STANDARD_SEARCH_ADAPTER_DECLARATION = Object.freeze({
  modulePath: "families/univ2-standard/src/search/adapter.ts",
  exportName: "UNIV2_STANDARD_SEARCH_ADAPTER_FACTORY",
  capabilityIds: Object.freeze({
    state: UNIV2_STANDARD_STATE_CAPABILITY_ID,
    coarse: UNIV2_STANDARD_COARSE_CAPABILITY_ID,
    exact: UNIV2_STANDARD_EXACT_CAPABILITY_ID,
  }),
  actionOwnerIds: Object.freeze({ swap: UNIV2_STANDARD_SWAP_ACTION_OWNER_ID }),
});

function authoringModule(declaration: CapabilityAuthoringDeclarationV1): {
  readonly modulePath: string;
  readonly exportName: string;
  readonly artifactKind: "nomination" | "identity" | "materialization" | "projection" | "rehydration";
  readonly capabilityIds: readonly typeof declaration.capabilityId[];
  readonly schemaRefs: readonly typeof declaration.schemaHash[];
  readonly sourcePlanIds?: readonly string[];
} {
  const artifactKind = declaration.artifactKinds[0];
  if (artifactKind !== "nomination" && artifactKind !== "identity" && artifactKind !== "materialization" && artifactKind !== "projection" && artifactKind !== "rehydration") {
    throw new TypeError("univ2 core stage declaration has invalid artifact kind");
  }
  return Object.freeze({
    modulePath: declaration.modulePath,
    exportName: declaration.exportName,
    artifactKind,
    capabilityIds: Object.freeze([declaration.capabilityId]),
    schemaRefs: Object.freeze([declaration.schemaHash]),
    ...(artifactKind === "nomination" ? { sourcePlanIds: Object.freeze([UNIV2_STANDARD_SOURCE_PLAN_ID, UNIV2_STANDARD_HISTORY_SOURCE_PLAN_ID].sort()) } : {}),
  });
}

const factContracts: readonly FamilyFactContractRefV1[] = Object.freeze([
  Object.freeze({
    factContractId: "family.univ2-standard.identity-reads",
    version,
    schemaHash: asSchemaRef(hashDomain("aloha/univ2-standard/fact-schema/v1", "identity-reads")),
  }),
  Object.freeze({
    factContractId: "family.univ2-standard.reserves-read",
    version,
    schemaHash: asSchemaRef(hashDomain("aloha/univ2-standard/fact-schema/v1", "reserves-read")),
  }),
]);

const pluginCodeHash = hashDomain("aloha/univ2-standard/plugin-code/v1", {
  moduleRoot,
  stages: [nomination, identity, materialization, projection, rehydration],
  extensions: [stateExtension, coarseExtension, exactExtension],
  runtimeAdapters: { [FAMILY_SEARCH_RUNTIME_ADAPTER_ROLE_V1]: UNIV2_STANDARD_SEARCH_ADAPTER_DECLARATION },
  actionOwners: [UNIV2_STANDARD_SWAP_ACTION_OWNER],
  factContracts,
});

export const UNIV2_STANDARD_AUTHORITY_DECLARATION_HASH: Hash = hashDomain(
  "aloha/univ2-standard/authority-declaration/v1",
  { ownerRef, familyId: UNIV2_STANDARD_FAMILY_ID, version: UNIV2_STANDARD_FAMILY_VERSION },
);

const definitionInput: FamilyAuthoringDefinitionV1 = {
  manifest: {
    familyId: UNIV2_STANDARD_FAMILY_ID,
    version: UNIV2_STANDARD_FAMILY_VERSION,
    pluginCodeHash,
    authorityDeclarationHash: UNIV2_STANDARD_AUTHORITY_DECLARATION_HASH,
    sourcePlans: [{
      sourcePlanId: UNIV2_STANDARD_SOURCE_PLAN_ID,
      completeness: "nomination-only",
      historyStartBlock: null,
      schemaHash: UNIV2_STANDARD_SOURCE_PLAN_SCHEMA_HASH,
      modulePath: "families/univ2-standard/src/stages/nomination.ts",
      exportName: "UNIV2_STANDARD_SOURCE_PLAN_RUNTIME",
      nominationProgram: { kind: "present", program: {
        modulePath: "families/univ2-standard/src/stages/nomination.ts",
        exportName: "UNIV2_STANDARD_SOURCE_NOMINATION_PROGRAM",
        schemaHash: UNIV2_STANDARD_SOURCE_PLAN_SCHEMA_HASH,
        mutationCorpus: { modulePath: "families/univ2-standard/src/nomination-qualification.ts", exportName: "UNIV2_STANDARD_NOMINATION_MUTATION_CORPUS" },
        independentOracle: { modulePath: "families/univ2-standard/src/nomination-qualification.ts", exportName: "UNIV2_STANDARD_NOMINATION_INDEPENDENT_ORACLE" },
      } },
    }, {
      sourcePlanId: UNIV2_STANDARD_HISTORY_SOURCE_PLAN_ID,
      completeness: "contiguous-history",
      historyStartBlock: "0",
      schemaHash: UNIV2_STANDARD_HISTORY_SOURCE_PLAN_SCHEMA_HASH,
      modulePath: "families/univ2-standard/src/history-source-plan.ts",
      exportName: "UNIV2_STANDARD_HISTORY_SOURCE_PLAN_RUNTIME",
      nominationProgram: { kind: "present", program: {
        modulePath: "families/univ2-standard/src/history-source-plan.ts",
        exportName: "UNIV2_STANDARD_HISTORY_NOMINATION_PROGRAM",
        schemaHash: UNIV2_STANDARD_HISTORY_SOURCE_PLAN_SCHEMA_HASH,
        mutationCorpus: { modulePath: "families/univ2-standard/src/nomination-qualification.ts", exportName: "UNIV2_STANDARD_NOMINATION_MUTATION_CORPUS" },
        independentOracle: { modulePath: "families/univ2-standard/src/nomination-qualification.ts", exportName: "UNIV2_STANDARD_NOMINATION_INDEPENDENT_ORACLE" },
      } },
    }],
  },
  core: {
    nomination: authoringModule(nomination) as never,
    identity: authoringModule(identity) as never,
    materialization: authoringModule(materialization) as never,
    projection: authoringModule(projection) as never,
    rehydration: authoringModule(rehydration) as never,
  },
  extensions: {
    [UNIV2_STANDARD_STATE_CAPABILITY_ID]: { kind: "present", module: stateExtension },
    [UNIV2_STANDARD_COARSE_CAPABILITY_ID]: { kind: "present", module: coarseExtension },
    [UNIV2_STANDARD_EXACT_CAPABILITY_ID]: { kind: "present", module: exactExtension },
  },
  runtimeAdapters: {
    [FAMILY_SEARCH_RUNTIME_ADAPTER_ROLE_V1]: UNIV2_STANDARD_SEARCH_ADAPTER_DECLARATION,
  },
  actionOwners: [UNIV2_STANDARD_SWAP_ACTION_OWNER],
  acceptanceDeclarations: factContracts,
};

export const UNIV2_STANDARD_DEFINITION = defineFamily(definitionInput);
export const UNIV2_STANDARD_FAMILY_DEFINITION_HASH = familyAuthoringDigest(UNIV2_STANDARD_DEFINITION);
export const UNIV2_STANDARD_OWNER_REF = ownerRef;

export const UNIV2_STANDARD_STAGE_IDS = Object.freeze({
  nomination: nomination.capabilityId,
  identity: identity.capabilityId,
  materialization: materialization.capabilityId,
  projection: projection.capabilityId,
  rehydration: rehydration.capabilityId,
});

export const UNIV2_STANDARD_STAGE_SCHEMA_HASHES = Object.freeze({
  nomination: nomination.schemaHash,
  identity: identity.schemaHash,
  materialization: materialization.schemaHash,
  projection: projection.schemaHash,
  rehydration: rehydration.schemaHash,
});

export const UNIV2_STANDARD_STAGE_INTERPRETER_HASHES = Object.freeze({
  nomination: nomination.interpreterHash,
  identity: identity.interpreterHash,
  materialization: materialization.interpreterHash,
  projection: projection.interpreterHash,
  rehydration: rehydration.interpreterHash,
});

export const UNIV2_STANDARD_REQUESTED_ARTIFACT_DEPENDENCY_ROOT = hashDomain(
  "aloha/univ2-standard/requested-artifact-dependencies/v1",
  {
    familyDefinitionHash: UNIV2_STANDARD_FAMILY_DEFINITION_HASH,
    stages: Object.values(UNIV2_STANDARD_STAGE_IDS),
    extensions: Object.values(UNIV2_STANDARD_EXTENSION_CAPABILITY_IDS),
  },
);

/** Static identity validity only. Reserve/state bytes are intentionally
 * excluded because memo reuse always rematerializes at the current cutoff. */
export function uniV2IdentityValidityDependencyRoot(identityFactsHash: Hash): Hash {
  return hashDomain("aloha/univ2-standard/identity-validity-dependencies/v1", {
    identityFactsHash,
    feeBps: "30",
  });
}
