import assert from "node:assert/strict";
import "../../adapters/index.js";
import { listAll } from "../../adapters/registry.js";
import {
  PRODUCTION_STRICT_SHADOW_ACTION_ADAPTERS,
  PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG,
  PRODUCTION_STRICT_SHADOW_FAMILY_LOAD,
  PRODUCTION_STRICT_SHADOW_FAMILY_OWNED_ACTION_ADAPTERS,
  PRODUCTION_STRICT_SHADOW_GENERATED_CAPABILITY_MANIFEST,
} from "../venues/production-family-composition.js";
import {
  PRODUCTION_INFRA_ACTION_ADAPTERS,
} from "../venues/production-infra-actions.js";
import {
  PRODUCTION_ADAPTER_FAMILIES,
  PRODUCTION_FROZEN_LEGACY_ROUTE_BASELINE,
} from "../venues/production-registry.js";

assert.equal(PRODUCTION_STRICT_SHADOW_FAMILY_LOAD.modules.length, 0);
assert.equal(PRODUCTION_STRICT_SHADOW_FAMILY_LOAD.issues.length, 0);
assert.equal(PRODUCTION_STRICT_SHADOW_FAMILY_LOAD.plugins.length, 22);
assert.equal(
  PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG.listAll().length,
  22,
);
assert.equal(
  PRODUCTION_STRICT_SHADOW_GENERATED_CAPABILITY_MANIFEST.entries.length,
  242,
);
assert.equal(
  new Set(
    PRODUCTION_STRICT_SHADOW_GENERATED_CAPABILITY_MANIFEST.entries.map(
      (entry) => `${entry.familyId}\0${entry.capability}`,
    ),
  ).size,
  242,
);

const familyActionIds = PRODUCTION_STRICT_SHADOW_FAMILY_OWNED_ACTION_ADAPTERS.map(
  (action) => action.id,
);
const infraActionIds = PRODUCTION_INFRA_ACTION_ADAPTERS.map(
  (action) => action.id,
);
assert.equal(new Set(familyActionIds).size, familyActionIds.length);
assert.equal(new Set(infraActionIds).size, infraActionIds.length);
assert(
  familyActionIds.every((id) => !infraActionIds.includes(id)),
  "Family-owned and protocol-neutral infra actions must be disjoint",
);
assert.deepEqual(
  [...PRODUCTION_STRICT_SHADOW_ACTION_ADAPTERS.map((action) => action.id)].sort(),
  [...familyActionIds, ...infraActionIds].sort(),
);
for (const action of PRODUCTION_STRICT_SHADOW_FAMILY_OWNED_ACTION_ADAPTERS) {
  assert.equal(
    PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG.ownerOfAction(action.id),
    PRODUCTION_STRICT_SHADOW_FAMILY_LOAD.plugins.find((module) =>
      module.actionAdapters.some((candidate) => candidate.id === action.id)
    )?.familyId,
  );
}

assert.equal(
  PRODUCTION_ADAPTER_FAMILIES,
  PRODUCTION_FROZEN_LEGACY_ROUTE_BASELINE,
  "legacy route callers receive only the explicitly frozen compatibility view",
);
assert.deepEqual(
  PRODUCTION_FROZEN_LEGACY_ROUTE_BASELINE.list().map((family) => family.id).sort(),
  PRODUCTION_STRICT_SHADOW_FAMILY_LOAD.plugins
    .map((module) => module.familyId)
    .sort(),
  "strict shadow and legacy production must cover the same complete Family cohort",
);

const firstBlockScanFamilies =
  PRODUCTION_ADAPTER_FAMILIES.blockScanStateFamilies();
const nextBlockScanFamilies =
  PRODUCTION_ADAPTER_FAMILIES.blockScanStateFamilies();
assert.equal(
  nextBlockScanFamilies,
  firstBlockScanFamilies,
  "block-scan registrations must remain stable across graph generations",
);
for (let index = 0; index < firstBlockScanFamilies.length; index++) {
  assert.equal(
    nextBlockScanFamilies[index],
    firstBlockScanFamilies[index],
    `block-scan Family registration ${firstBlockScanFamilies[index]?.familyId} ` +
      "must retain its process-local runtime descriptors",
  );
}

const legacyActionClosure = PRODUCTION_ADAPTER_FAMILIES.actionIds();
assert.deepEqual(
  listAll().map((action) => action.id).sort(),
  [...legacyActionClosure.owned, ...legacyActionClosure.requiredInfra].sort(),
  "production bootstrap must register exactly the current legacy route closure",
);

console.log(
  "production-family-composition PASS " +
    "(22 strict shadow Families / 242 exact capabilities / complete legacy production closure)",
);
