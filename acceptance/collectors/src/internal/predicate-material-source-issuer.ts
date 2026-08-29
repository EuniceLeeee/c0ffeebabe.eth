import { ContentAddressedObserverSinkV1 } from "../content-addressed-sink.ts";
import {
  registerProductionPredicateMaterialSourceStateV1,
  type ProductionPredicateMaterialSourceOwnerInputV1,
} from "./predicate-material-source-owner.ts";
import type { PredicateMaterialSourcePortV1 } from "../../../gate-core/src/material-provider.ts";

/** Physical collector issuer. The fresh runner imports only the state registry. */
export function issueProductionPredicateMaterialSourcePortV1(
  input: ProductionPredicateMaterialSourceOwnerInputV1,
): PredicateMaterialSourcePortV1 {
  if (input === null || typeof input !== "object") {
    throw new TypeError("predicate material source owner input is required");
  }
  const expected = [
    "sink", "readArtifactLineageStageOne", "readArtifactLineageStageTwoAuthority", "readArtifactLineageStageTwoGit", "readFullFamilyObservation", "observePerformance",
    "readDurableTerminalDiscovery", "observeTerminalSelection", "readRuntimeRestartBoundary",
    "readSourceRepositoryClosureBoundary", "readLegacyAuthorityClosureBoundary",
  ].sort();
  const actual = Reflect.ownKeys(input);
  if (actual.some(key => typeof key !== "string")
    || actual.length !== expected.length
    || [...actual as string[]].sort().some((key, index) => key !== expected[index])) {
    throw new TypeError("predicate material source owner input has non-exact fields");
  }
  if (!(input.sink instanceof ContentAddressedObserverSinkV1)) {
    throw new TypeError("predicate material source requires collector-owned sink");
  }
  for (const key of expected.filter(key => key !== "sink")) {
    const value = input[key as keyof ProductionPredicateMaterialSourceOwnerInputV1];
    if (value !== null && typeof value !== "function") {
      throw new TypeError(`predicate material source ${key} must be a fixed owner reader`);
    }
  }
  return registerProductionPredicateMaterialSourceStateV1(input);
}
