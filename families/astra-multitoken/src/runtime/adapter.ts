import { hashDomain, type Hash } from "../../../../packages/canonical-codec/src/index.ts";
import { ASTRA_ACTION_OWNER_ID, ASTRA_EFFECT_OBLIGATIONS, ASTRA_FAMILY_ID, ASTRA_FAMILY_VERSION, ASTRA_SOURCE_CONTRACT_SCHEMA_HASH } from "../manifest.ts";
import { astraSourcePlans } from "../capture.ts";
import { buildAstraEffectSimulation } from "../execution.ts";

export interface AstraCurrentSourceExactDeclarationV1 {
  readonly kind: "current-source-exact";
  readonly sourcePlans: ReturnType<typeof astraSourcePlans>;
  readonly effectProgram: typeof buildAstraEffectSimulation;
  readonly obligations: readonly string[];
}

export interface AstraRuntimeAdapterV1 {
  readonly familyId: typeof ASTRA_FAMILY_ID;
  readonly version: typeof ASTRA_FAMILY_VERSION;
  readonly stages: readonly ["nomination", "identity", "materialization", "projection", "rehydration"];
  readonly currentSourceExact: AstraCurrentSourceExactDeclarationV1;
  readonly actionOwnerId: typeof ASTRA_ACTION_OWNER_ID;
  readonly factContracts: readonly { readonly factContractId: string; readonly schemaHash: Hash }[];
  readonly sourcePlans: ReturnType<typeof astraSourcePlans>;
}

export const ASTRA_CURRENT_SOURCE_EXACT = Object.freeze({
  kind: "current-source-exact" as const,
  sourcePlans: astraSourcePlans(),
  effectProgram: buildAstraEffectSimulation,
  obligations: ASTRA_EFFECT_OBLIGATIONS,
});

export const ASTRA_RUNTIME_ADAPTER: AstraRuntimeAdapterV1 = Object.freeze({
  familyId: ASTRA_FAMILY_ID,
  version: ASTRA_FAMILY_VERSION,
  stages: ["nomination", "identity", "materialization", "projection", "rehydration"] as const,
  currentSourceExact: ASTRA_CURRENT_SOURCE_EXACT,
  actionOwnerId: ASTRA_ACTION_OWNER_ID,
  factContracts: Object.freeze([
    "identity-reads",
    "active-effect-observation",
    "exact-effect-observation",
  ].map(factContractId => Object.freeze({
    factContractId: `family.${ASTRA_FAMILY_ID}.${factContractId}`,
    schemaHash: hashDomain("aloha/astra-multitoken/fact-schema/v1", factContractId),
  })).concat([Object.freeze({ factContractId: `family.${ASTRA_FAMILY_ID}.source-completeness`, schemaHash: ASTRA_SOURCE_CONTRACT_SCHEMA_HASH })])),
  sourcePlans: astraSourcePlans(),
});

export const ASTRA_RUNTIME_ADAPTER_FACTORY = Object.freeze((input: unknown) => {
  if (input === null || typeof input !== "object") throw new TypeError("Astra runtime composition input required");
  return ASTRA_RUNTIME_ADAPTER;
});
