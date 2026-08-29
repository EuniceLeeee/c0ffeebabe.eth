import { decodeCanonicalBytes } from "../../../../packages/canonical-codec/src/index.ts";
import {
  decodeFullFamilyFactLocator,
  decodeFullFamilyFactBundleStorageV1,
  decodeFullFamilyStoredItemV1,
  materializeFullFamilyFactBundleStorageV1,
  referencedFullFamilyArtifactDigests,
} from "../../../../specs/full-family-facts/src/index.ts";
import { readProductionPredicateMaterialSourceStateV1 } from "../internal/predicate-material-source-owner.ts";
import {
  assertProductionTerminalPhaseDurableDiscoveryV1,
  type ProductionTerminalPhaseDurableDiscoveryV1,
} from "../terminal-phase-locator-index.ts";
import { available, defineProvider, unavailable } from "./shared.ts";

const PREDICATE_ID = "aloha.full-family.facts";

function candidateReleaseCommit(discovery: ProductionTerminalPhaseDurableDiscoveryV1): string {
  const value = decodeCanonicalBytes(discovery.fullFamilyTerminalBindingArtifact.bytes);
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Full-Family terminal binding artifact is invalid");
  }
  const commit = (value as Record<string, unknown>).candidateReleaseCommit;
  if (typeof commit !== "string" || !/^[0-9a-f]{40}$/.test(commit)) {
    throw new TypeError("Full-Family terminal binding candidate commit is invalid");
  }
  return commit;
}

export const FULL_FAMILY_MATERIAL_PROVIDER = defineProvider(PREDICATE_ID, async source => {
  const state = readProductionPredicateMaterialSourceStateV1(source);
  if (state.readDurableTerminalDiscovery === null) {
    return unavailable(PREDICATE_ID, "missing", "owner-port-missing", "durable-terminal-discovery");
  }
  try {
    const discovery = state.readDurableTerminalDiscovery() as ProductionTerminalPhaseDurableDiscoveryV1;
    assertProductionTerminalPhaseDurableDiscoveryV1(discovery);
    if (discovery.fullFamilyProjection.status !== "observed"
      || discovery.fullFamilyBundleArtifact === null
      || discovery.fullFamilyLocatorArtifact === null) {
      return unavailable(
        PREDICATE_ID,
        discovery.fullFamilyProjection.status === "missing" ? "missing" : "invalid",
        "owner-material-missing",
        discovery.fullFamilyProjection.missing,
      );
    }
    const storage = decodeFullFamilyFactBundleStorageV1(discovery.fullFamilyBundleArtifact.bytes);
    const locator = decodeFullFamilyFactLocator(discovery.fullFamilyLocatorArtifact.bytes);
    const observedByRef = new Map(discovery.fullFamilyPredicateArtifacts.map(artifact => [artifact.ref.artifactRefId, artifact]));
    const used = new Set<`0x${string}`>();
    const bundle = materializeFullFamilyFactBundleStorageV1(storage, (artifactRefId, contentSha256) => {
      const artifact = observedByRef.get(artifactRefId);
      if (artifact === undefined || artifact.contentSha256 !== contentSha256) {
        throw new TypeError(`missing stored Full-Family artifact ${artifactRefId}`);
      }
      used.add(artifactRefId);
      return artifact.bytes;
    }, decodeFullFamilyStoredItemV1);
    const expected = new Map(referencedFullFamilyArtifactDigests(bundle));
    for (const artifactRefId of used) {
      const artifact = observedByRef.get(artifactRefId)!;
      expected.set(artifactRefId, artifact.contentSha256);
    }
    const predicateArtifacts = [];
    for (const [artifactRefId, contentSha256] of expected) {
      const artifact = observedByRef.get(artifactRefId);
      if (artifact === undefined || artifact.contentSha256 !== contentSha256) {
        return unavailable(PREDICATE_ID, "invalid", "owner-material-invalid", `missing referenced artifact ${artifactRefId}`);
      }
      predicateArtifacts.push(artifact);
    }
    if (locator.bundleArtifactRefId !== discovery.fullFamilyBundleArtifact.ref.artifactRefId
      || locator.bundleContentSha256 !== discovery.fullFamilyBundleArtifact.contentSha256) {
      return unavailable(PREDICATE_ID, "invalid", "owner-material-invalid", "bundle locator splice");
    }
    predicateArtifacts.push(discovery.fullFamilyBundleArtifact);
    return available(
      PREDICATE_ID,
      candidateReleaseCommit(discovery),
      predicateArtifacts,
      [state.sink.resolverPolicy],
      [locator],
    );
  } catch (error) {
    return unavailable(PREDICATE_ID, "invalid", "owner-material-invalid", error instanceof Error ? error.message : "full-family-owner");
  }
});
