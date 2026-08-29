import type {
  CoarseEdgeProjectionV1,
  CoarseProjectionCapabilityV1,
  CoarseProjectionServiceV1,
} from "../../../coarse-economics/src/index.ts";
import type {
  FamilyRuntimeCompositionV1,
  GeneratedFamilyCoarseProjectionOwnerInstallationV1,
} from "../index.ts";

const installers = new WeakMap<object, (value: GeneratedFamilyCoarseProjectionOwnerInstallationV1) => void>();
const results = new WeakMap<object, Readonly<{
  readonly composition: FamilyRuntimeCompositionV1;
  readonly service: CoarseProjectionServiceV1;
  readonly assertCurrent: () => void;
  readonly projection: CoarseEdgeProjectionV1;
}>>();

export function registerGeneratedFamilyCoarseProjectionInstallerV1(
  composition: FamilyRuntimeCompositionV1,
  install: (value: GeneratedFamilyCoarseProjectionOwnerInstallationV1) => void,
): void {
  if (installers.has(composition)) throw new TypeError("generated Family coarse owner installer already registered");
  installers.set(composition, install);
}

/** Runtime-release-authority is the only production importer of this module. */
export function installGeneratedFamilyCoarseProjectionOwnerV1(
  composition: FamilyRuntimeCompositionV1,
  value: GeneratedFamilyCoarseProjectionOwnerInstallationV1,
): void {
  const install = installers.get(composition);
  if (install === undefined) throw new TypeError("generated Family coarse owner installer is unavailable");
  install(value);
}

export function registerGeneratedFamilyCoarseProjectionResultV1(
  capability: CoarseProjectionCapabilityV1,
  value: Readonly<{
    readonly composition: FamilyRuntimeCompositionV1;
    readonly service: CoarseProjectionServiceV1;
    readonly assertCurrent: () => void;
    readonly projection: CoarseEdgeProjectionV1;
  }>,
): void {
  if (results.has(capability)) throw new TypeError("generated Family coarse projection capability already registered");
  results.set(capability, value);
}

/** Owner service read; raw projection DTOs and cross-composition capabilities fail closed. */
export function readGeneratedFamilyCoarseProjectionCapabilityV1(
  composition: FamilyRuntimeCompositionV1,
  capability: CoarseProjectionCapabilityV1,
): Readonly<{ readonly projection: CoarseEdgeProjectionV1; readonly boundProofCapability: null }> {
  if (capability === null || typeof capability !== "object") throw new TypeError("generated Family coarse projection capability is invalid");
  const result = results.get(capability);
  if (result === undefined || result.composition !== composition) {
    throw new TypeError("generated Family coarse projection capability was not issued by this composition");
  }
  result.assertCurrent();
  return Object.freeze({ projection: result.projection, boundProofCapability: null });
}
