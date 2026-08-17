import type {
  ExecutionFamilyId,
  RouteLegKind,
} from "./route-leg-adapter.js";
import type { DiscoveryCandidateSourceKind } from
  "./adapter-family-plugin.js";
import {
  PRODUCTION_STRICT_FAMILY_DECLARATIONS,
  type StrictRouteFamilyDeclaration,
} from "../strict-production-family-declarations.js";

export type RouteFamilyCandidateSource = DiscoveryCandidateSourceKind;

export interface RouteFamilyDynamicAdmissionManifest {
  readonly candidateSources: readonly RouteFamilyCandidateSource[];
  /** Dynamic instances always remain behind protocol-edge admission. */
  readonly requiresProtocolEdgesFlag: true;
}

/**
 * Dependency-neutral description of the route-family wiring that exists today.
 * It deliberately contains no executable callbacks and no instance addresses.
 */
export interface RouteFamilyManifestEntry {
  readonly executionFamilyId: ExecutionFamilyId;
  readonly familyKind: RouteLegKind;
  readonly poolAdapters: readonly string[];
  readonly edgeAdapterIds: readonly string[];
  readonly ownedActionAdapterIds: readonly string[];
  readonly requiredInfraActionAdapterIds: readonly string[];
  /** Compatibility projection for report consumers; never a registration source. */
  readonly actionAdapterIds: readonly string[];
  readonly declaredVenueCount: number;
  /** Current static/legacy wiring policy; kept separate from dynamic admission. */
  readonly staticRequiresProtocolEdgesFlag: boolean;
  readonly dynamicAdmission: RouteFamilyDynamicAdmissionManifest | null;
}

/**
 * Project a compatibility manifest from strict catalog declarations. This is
 * metadata only: it cannot admit an instance or issue an execution handle.
 */
export function deriveRouteFamilyManifest(
  adapters: readonly StrictRouteFamilyDeclaration[],
): readonly RouteFamilyManifestEntry[] {
  return Object.freeze(adapters.map((adapter) => {
    const dynamicSources = adapter.candidateSources;
    if (
      dynamicSources.length > 0 &&
      adapter.kind === "protocol-conversion" &&
      !adapter.requiresProtocolEdgesFlag
    ) {
      throw new Error(
        `route family manifest: ${adapter.id} dynamic admission must require protocol edges`,
      );
    }

    const dynamicAdmission = dynamicSources.length > 0
      ? Object.freeze({
          candidateSources: Object.freeze([...dynamicSources]),
          requiresProtocolEdgesFlag: true as const,
        })
      : null;

    return Object.freeze({
      executionFamilyId: adapter.id as ExecutionFamilyId,
      familyKind: adapter.kind,
      poolAdapters: Object.freeze([...adapter.poolAdapters]),
      edgeAdapterIds: Object.freeze([...adapter.edgeAdapterIds]),
      ownedActionAdapterIds: Object.freeze([...adapter.ownedActionAdapterIds]),
      requiredInfraActionAdapterIds: Object.freeze([
        ...adapter.requiredInfraActionAdapterIds,
      ]),
      actionAdapterIds: Object.freeze([
        ...adapter.ownedActionAdapterIds,
        ...adapter.requiredInfraActionAdapterIds,
      ]),
      declaredVenueCount: 0,
      staticRequiresProtocolEdgesFlag: adapter.requiresProtocolEdgesFlag,
      dynamicAdmission,
    });
  }));
}

export const PRODUCTION_ROUTE_FAMILY_MANIFEST = deriveRouteFamilyManifest(
  PRODUCTION_STRICT_FAMILY_DECLARATIONS.routeFamilies,
);
