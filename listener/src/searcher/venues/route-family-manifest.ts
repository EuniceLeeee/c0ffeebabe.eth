import type {
  ExecutionFamilyId,
  ProtocolConversionAdapter,
  RouteCandidateSourceKind,
  RouteLegAdapter,
  RouteLegKind,
} from "./route-leg-adapter.js";
import { PRODUCTION_ADAPTER_FAMILIES } from "./production-registry.js";
import { PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG } from
  "./production-family-composition.js";

export type RouteFamilyCandidateSource = RouteCandidateSourceKind;

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
 * Project a compatibility manifest from the actual high-level adapter objects.
 * The adapter registry remains the sole registration source; this function must
 * never grow a second hand-maintained family table.
 */
export function deriveRouteFamilyManifest(
  adapters: readonly RouteLegAdapter[],
): readonly RouteFamilyManifestEntry[] {
  return Object.freeze(adapters.map((adapter) => {
    // F8: dynamic candidate sources are projected from the strict catalog
    // (plugin-declared discovery semantics), never from a legacy adapter
    // discovery object. The registry remains the sole registration source for
    // the static surface; this function never grows a second family table.
    const dynamicSources =
      PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG
        .discoverableFamilySources()
        .find((entry) => entry.familyId === adapter.id)?.sourceIds ?? [];
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
      executionFamilyId: adapter.id,
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
      declaredVenueCount: adapter.kind === "protocol-conversion"
        ? (adapter as ProtocolConversionAdapter).declaredVenues.length
        : 0,
      staticRequiresProtocolEdgesFlag: adapter.requiresProtocolEdgesFlag,
      dynamicAdmission,
    });
  }));
}

export const PRODUCTION_ROUTE_FAMILY_MANIFEST = deriveRouteFamilyManifest(
  PRODUCTION_ADAPTER_FAMILIES.routes().list(),
);
