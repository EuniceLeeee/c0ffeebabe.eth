import type {
  ExecutionFamilyId,
  ProtocolConversionAdapter,
  RouteCandidateSourceKind,
  RouteLegAdapter,
  RouteLegKind,
} from "./route-leg-adapter.js";
import { PRODUCTION_ADAPTER_FAMILIES } from "./production-registry.js";

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
    const protocolAdapter = adapter.kind === "protocol-conversion"
      ? adapter as ProtocolConversionAdapter
      : null;
    const discovery = protocolAdapter?.discovery;
    if (discovery && !adapter.requiresProtocolEdgesFlag) {
      throw new Error(
        `route family manifest: ${adapter.id} dynamic admission must require protocol edges`,
      );
    }

    const dynamicAdmission = discovery
      ? Object.freeze({
          candidateSources: Object.freeze([...discovery.candidateSources]),
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
      declaredVenueCount: protocolAdapter?.declaredVenues.length ?? 0,
      staticRequiresProtocolEdgesFlag: adapter.requiresProtocolEdgesFlag,
      dynamicAdmission,
    });
  }));
}

export const PRODUCTION_ROUTE_FAMILY_MANIFEST = deriveRouteFamilyManifest(
  PRODUCTION_ADAPTER_FAMILIES.routes().list(),
);
