import assert from "node:assert/strict";
import { GENERATED_PRODUCTION_FAMILY_ENTRIES } from "../generated/production-family-entries.generated.js";
import { FAMILY_CAPABILITY_NAMES } from "../venues/family-capability-catalog.js";
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

assert.equal(PRODUCTION_STRICT_SHADOW_FAMILY_LOAD.modules.length, 0);
assert.equal(PRODUCTION_STRICT_SHADOW_FAMILY_LOAD.issues.length, 0);
const expectedFamilyCount = GENERATED_PRODUCTION_FAMILY_ENTRIES.length;
const expectedCapabilityCount = expectedFamilyCount * FAMILY_CAPABILITY_NAMES.length;
assert(expectedFamilyCount > 0);
assert.deepEqual(
  PRODUCTION_STRICT_SHADOW_FAMILY_LOAD.plugins.map((entry) => entry.sourceFile).sort(),
  GENERATED_PRODUCTION_FAMILY_ENTRIES.map((entry) => entry.sourceFile).sort(),
  "every generated production entry must load exactly once",
);
assert.equal(PRODUCTION_STRICT_SHADOW_FAMILY_LOAD.plugins.length, expectedFamilyCount);
assert.equal(
  PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG.listAll().length,
  expectedFamilyCount,
);
assert.equal(
  PRODUCTION_STRICT_SHADOW_GENERATED_CAPABILITY_MANIFEST.entries.length,
  expectedCapabilityCount,
);
assert.equal(
  new Set(
    PRODUCTION_STRICT_SHADOW_GENERATED_CAPABILITY_MANIFEST.entries.map(
      (entry) => `${entry.familyId}\0${entry.capability}`,
    ),
  ).size,
  expectedCapabilityCount,
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

assert.deepEqual(
  listAll().map((action) => action.id).sort(),
  PRODUCTION_STRICT_SHADOW_ACTION_ADAPTERS.map((action) => action.id).sort(),
  "production bootstrap must register exactly the strict action closure",
);

console.log(
  "production-family-composition PASS " +
    `(${expectedFamilyCount} strict Families / ${expectedCapabilityCount} exact capabilities / complete strict action closure)`,
);
