import { assertHash, assertNonEmptyString, decodeExactObject, type Hash } from "../../canonical-codec/src/index.ts";
import type { CapabilityId, CapabilityRefV1, CapabilityVersion, FamilyFactContractRefV1, OwnerRef, SchemaRef } from "../../capability-contracts/src/index.ts";
import type { SourcePlanRefV1 } from "../../discovery/src/index.ts";

export type FamilyId = string & { readonly __familyId: unique symbol };
export type FamilyCandidateKey = Hash;
export type FamilyInstanceKey = string & { readonly __familyInstanceKey: unique symbol };
export type FamilyIssuerRef = OwnerRef;
export type AuthorityDeclarationRef = Hash & { readonly __authorityDeclarationRef: unique symbol };
export type ActionOwnerRef = OwnerRef;

export interface StageCapabilityRefV1 extends CapabilityRefV1 {
  readonly familyId: FamilyId;
  readonly familyDefinitionHash: Hash;
  readonly stage: "nomination" | "identity" | "materialization" | "projection" | "rehydration" | "capability";
}

export type StageFamilyRefsV1 =
  | { readonly stage: "nomination"; readonly nomination: StageCapabilityRefV1 }
  | { readonly stage: "identity"; readonly identity: StageCapabilityRefV1 }
  | { readonly stage: "materialization"; readonly materialization: StageCapabilityRefV1 }
  | { readonly stage: "projection"; readonly projection: StageCapabilityRefV1 }
  | { readonly stage: "rehydration"; readonly rehydration: StageCapabilityRefV1 }
  | { readonly stage: "capability"; readonly capability: StageCapabilityRefV1 };

export interface GeneratedFamilyEntryV1 {
  readonly familyId: FamilyId;
  readonly familyDefinitionHash: Hash;
  readonly issuerRef: FamilyIssuerRef;
  readonly authorityRef: AuthorityDeclarationRef;
  readonly lifecycleRefs: {
    readonly nomination: StageCapabilityRefV1;
    readonly identity: StageCapabilityRefV1;
    readonly materialization: StageCapabilityRefV1;
    readonly projection: StageCapabilityRefV1;
    readonly rehydration: StageCapabilityRefV1;
  };
  readonly extensionRefs: readonly StageCapabilityRefV1[];
  readonly actionOwnerRefs: readonly ActionOwnerRef[];
  readonly factContractRefs: readonly FamilyFactContractRefV1[];
  /** Exact generated source authority; deployment code cannot replace this set. */
  readonly sourcePlanRefs: readonly SourcePlanRefV1[];
  readonly definitionCatalogLeafDigest: Hash;
  readonly capabilityCatalogRoot: Hash;
}

export interface GeneratedStrategyEntryV1 {
  readonly strategyId: string;
  readonly strategyDefinitionHash: Hash;
  readonly issuerRef: OwnerRef;
  readonly requiredCapabilityRefs: readonly CapabilityRefV1[];
  readonly planningProblemIssuer: OwnerRef;
  readonly constraintSchemaRefs: readonly SchemaRef[];
  readonly factContractRefs: readonly Hash[];
  readonly definitionCatalogLeafDigest: Hash;
}

export function asFamilyId(value: string, path = "familyId"): FamilyId {
  assertNonEmptyString(value, path);
  if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(value)) throw new TypeError(`invalid family id at ${path}`);
  return value as FamilyId;
}

export function asFamilyInstanceKey(value: string, path = "instanceKey"): FamilyInstanceKey {
  assertNonEmptyString(value, path);
  return value as FamilyInstanceKey;
}

export function assertStageCapabilityRef(value: unknown, path = "stageCapabilityRef"): asserts value is StageCapabilityRefV1 {
  decodeExactObject(value, {
    familyId: (item, itemPath) => asFamilyId(item as string, itemPath),
    familyDefinitionHash: (item, itemPath) => assertHash(item, itemPath),
    stage: (item, itemPath) => {
      if (!["nomination", "identity", "materialization", "projection", "rehydration", "capability"].includes(item as string)) throw new TypeError(`${itemPath} unknown`);
      return item as StageCapabilityRefV1["stage"];
    },
    capabilityId: (item, itemPath) => assertNonEmptyString(item, itemPath),
    version: (item, itemPath) => assertNonEmptyString(item, itemPath),
    schemaHash: (item, itemPath) => assertHash(item, itemPath),
    interpreterHash: (item, itemPath) => assertHash(item, itemPath),
    ownerRef: (item, itemPath) => assertHash(item, itemPath),
  }, path);
}

export type { CapabilityId, CapabilityRefV1, CapabilityVersion, FamilyFactContractRefV1, OwnerRef, SchemaRef } from "../../capability-contracts/src/index.ts";
