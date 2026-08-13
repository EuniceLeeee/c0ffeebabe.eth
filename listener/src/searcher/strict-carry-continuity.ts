import { hashCanonical } from "./venues/canonical-value.js";
import type { CanonicalSource } from
  "./venues/adapter-request-program.js";
import type { FamilyId } from
  "./venues/adapter-family-identifiers.js";
import type { FamilyCapabilityCatalog } from
  "./venues/family-capability-catalog.js";
import type { UnifiedObservation } from
  "./venues/adapter-family-plugin.js";
import type {
  CentralAdapterRuntime,
} from "./adapter-work-intent.js";
import type {
  PreparedFamilyInstance,
} from "./venues/adapter-family-runtime.js";
import { runStrictFamilyLifecycle } from
  "./strict-family-lifecycle-runner.js";

/**
 * F2-a: central state-continuity re-verification for a committed instance
 * that its Family did not re-stage at the current source. The caller supplies
 * the current address surface read (code hash + EIP-1967 implementation
 * word); this module re-runs the strict Family lifecycle at the current
 * source and only returns an evidence ref when the same instance identity is
 * re-issued. Any failure, foreign identity, or unreadable surface returns
 * null, so the live publisher stays fail-closed.
 */
export async function reverifyCarriedInstanceContinuity(input: {
  readonly catalog: FamilyCapabilityCatalog;
  readonly familyId: FamilyId;
  readonly instance: PreparedFamilyInstance;
  readonly current: CanonicalSource;
  readonly runtime: CentralAdapterRuntime;
  readonly readAddressSurface: (
    address: string,
    at: CanonicalSource,
  ) => Promise<{
    readonly codeHash: string;
    readonly implementationWord: string;
  } | null>;
}): Promise<string | null> {
  const address = extractInstanceAddress(input.instance);
  if (address === null) return null;
  const surface = await input.readAddressSurface(address, input.current);
  if (surface === null) return null;
  const family = input.catalog.forStrictFamily(input.familyId);
  const interfaceFingerprints = "discovery" in family.plugin
    ? family.plugin.discovery.addressSurfaces?.filter(
        (pattern) => pattern.kind === "interface",
      ).map((pattern) => pattern.fingerprint)
    : undefined;
  const observation: UnifiedObservation = Object.freeze({
    kind: "address-surface",
    source: input.current,
    address,
    codeHash: surface.codeHash,
    implementationWord: surface.implementationWord,
    ...(interfaceFingerprints === undefined ||
        interfaceFingerprints.length === 0
      ? {}
      : { interfaceFingerprints: Object.freeze(interfaceFingerprints) }),
  });
  try {
    const publication = await runStrictFamilyLifecycle({
      catalog: input.catalog,
      familyId: input.familyId,
      source: input.current,
      observations: Object.freeze([observation]),
      runtime: input.runtime,
    });
    const continuity = publication.instances.some(
      (instance) =>
        instance.instanceKey === input.instance.instanceKey &&
        instance.lineageId === input.instance.lineageId,
    );
    if (!continuity) return null;
    return `central:state-continuity:${hashCanonical({
      format: "strict-carry-continuity-evidence-v1",
      familyId: input.familyId,
      instanceKey: input.instance.instanceKey,
      current: {
        number: input.current.number,
        hash: input.current.hash,
        generation: input.current.generation,
      },
      address,
      codeHash: surface.codeHash,
      implementationWord: surface.implementationWord,
    })}`;
  } catch {
    return null;
  }
}

/**
 * Recover the instance address from its compiled identity provenance. The
 * first 40-byte hex subject is the address-surface re-verification target;
 * families that cannot expose one keep the carry fail-closed (null).
 */
export function extractInstanceAddress(
  instance: PreparedFamilyInstance,
): string | null {
  for (const provenance of instance.descriptor.provenance) {
    if (/^0x[0-9a-fA-F]{40}$/.test(provenance.subject)) {
      return provenance.subject.toLowerCase();
    }
  }
  return null;
}
