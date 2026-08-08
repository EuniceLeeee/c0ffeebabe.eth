import type {
  ActionAdapter,
} from "../../../types.js";
import type {
  AdapterDescriptor,
} from "../../../adapters/adapter-descriptors.js";
import type {
  AdapterFamily,
} from "../route-leg-adapter.js";
import { hashCanonical } from "../canonical-value.js";

export type FamilyOwnedActionAdapter = ActionAdapter & {
  readonly descriptor: AdapterDescriptor;
};

/**
 * The only activation surface for a newly added production family. A module
 * placed beside this contract with the suffix `.production.ts` is discovered
 * automatically; the family and every action it owns must travel together.
 */
export interface ProductionFamilyActivation {
  readonly contractKind: "legacy-production-module";
  readonly activationContractHash: string;
  readonly family: AdapterFamily;
  readonly actionAdapters: readonly FamilyOwnedActionAdapter[];
}

declare const legacyProductionModuleTypeBrand: unique symbol;

export interface ProductionFamilyModule extends ProductionFamilyActivation {
  readonly [legacyProductionModuleTypeBrand]: true;
}

export interface LegacyProductionFamilyContractSummary {
  readonly contractKind: "legacy-production-module";
  readonly familyId: string;
  readonly familyKind: AdapterFamily["kind"];
  readonly ownedActionAdapterIds: readonly string[];
  readonly requiredInfraActionAdapterIds: readonly string[];
  readonly suppliedActions: readonly {
    readonly id: string;
    readonly edgeKind: string;
  }[];
}

const legacyProductionModules = new WeakMap<
  object,
  LegacyProductionFamilyContractSummary
>();

export function defineProductionFamilyModule(
  input: Omit<
    ProductionFamilyActivation,
    "contractKind" | "activationContractHash"
  >,
): ProductionFamilyModule {
  assertExactKeys(input, ["actionAdapters", "family"]);
  const summary = validateLegacyContract(input.family, input.actionAdapters);
  const module: ProductionFamilyActivation = Object.freeze({
    contractKind: "legacy-production-module" as const,
    activationContractHash: hashCanonical({
      contractKind: summary.contractKind,
      familyId: summary.familyId,
      familyKind: summary.familyKind,
      ownedActionAdapterIds: summary.ownedActionAdapterIds,
      requiredInfraActionAdapterIds: summary.requiredInfraActionAdapterIds,
      suppliedActions: summary.suppliedActions.map((action) => ({
        id: action.id,
        edgeKind: action.edgeKind,
      })),
    }),
    family: input.family,
    actionAdapters: Object.freeze([...input.actionAdapters]),
  });
  legacyProductionModules.set(module, summary);
  return module as ProductionFamilyModule;
}

export function assertLegacyProductionFamilyModule(
  value: unknown,
): asserts value is ProductionFamilyModule {
  if (
    value === null ||
    typeof value !== "object" ||
    !legacyProductionModules.has(value)
  ) {
    throw new Error(
      "productionFamilyModule must come from defineProductionFamilyModule",
    );
  }
}

export function legacyProductionFamilyContractSummary(
  module: ProductionFamilyModule,
): LegacyProductionFamilyContractSummary {
  assertLegacyProductionFamilyModule(module);
  return legacyProductionModules.get(module)!;
}

function validateLegacyContract(
  family: AdapterFamily,
  actionAdapters: readonly FamilyOwnedActionAdapter[],
): LegacyProductionFamilyContractSummary {
  if (
    family === null ||
    typeof family !== "object" ||
    typeof family.id !== "string" ||
    family.id.length === 0
  ) {
    throw new Error("legacy production family must expose a non-empty id");
  }
  if (!Array.isArray(actionAdapters)) {
    throw new Error("legacy production family actionAdapters must be an array");
  }
  const owned = [...family.ownedActionAdapterIds].sort();
  const supplied = actionAdapters.map((adapter) => adapter.id).sort();
  if (
    owned.length !== supplied.length ||
    owned.some((id, index) => supplied[index] !== id)
  ) {
    throw new Error(
      `${family.id} must supply exactly its owned ActionAdapters ` +
        `(owned=${owned.join(",")} supplied=${supplied.join(",")})`,
    );
  }
  if (new Set(supplied).size !== supplied.length) {
    throw new Error(`${family.id} supplies duplicate ActionAdapters`);
  }
  const expectedEdgeKind = edgeKindForFamily(family);
  const suppliedActions = actionAdapters.map((action) => {
    if (
      !action ||
      typeof action.id !== "string" ||
      typeof action.encode !== "function" ||
      typeof action.matchTrace !== "function"
    ) {
      throw new Error(`${family.id} supplies an invalid ActionAdapter`);
    }
    if (
      action.descriptor === undefined ||
      action.descriptor.adapterId !== action.id
    ) {
      throw new Error(
        `${family.id} ActionAdapter ${action.id} must own a matching descriptor`,
      );
    }
    if (action.descriptor.edgeKind !== expectedEdgeKind) {
      throw new Error(
        `${family.id} ActionAdapter ${action.id} descriptor edgeKind ` +
          `${String(action.descriptor.edgeKind)} does not match family kind ` +
          `${family.kind} (${expectedEdgeKind})`,
      );
    }
    return Object.freeze({
      id: action.id,
      edgeKind: action.descriptor.edgeKind,
    });
  }).sort((a, b) => a.id.localeCompare(b.id));

  return Object.freeze({
    contractKind: "legacy-production-module",
    familyId: family.id,
    familyKind: family.kind,
    ownedActionAdapterIds: Object.freeze(owned),
    requiredInfraActionAdapterIds: Object.freeze(
      [...family.requiredInfraActionAdapterIds].sort(),
    ),
    suppliedActions: Object.freeze(suppliedActions),
  });
}

function edgeKindForFamily(
  family: AdapterFamily,
): "swap" | "protocol" | "flash" | "credit" {
  switch (family.kind) {
    case "swap":
      return "swap";
    case "protocol-conversion":
      return "protocol";
    case "flash-loan":
      return "flash";
    case "credit":
      return "credit";
    case "liquidity":
      throw new Error(
        `${family.id} uses unsupported automatic family kind liquidity; ` +
          "runtime liquidity taxonomy requires a protocol-neutral framework upgrade",
      );
  }
}

function assertExactKeys(
  value: object,
  expected: readonly string[],
): void {
  const actual = Object.keys(value).sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    throw new Error(
      `legacy production module keys must be exactly ${expected.join(",")}`,
    );
  }
}
