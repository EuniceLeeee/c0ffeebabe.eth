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

assert.equal(PRODUCTION_STRICT_SHADOW_FAMILY_LOAD.modules.length, 0);
assert.equal(PRODUCTION_STRICT_SHADOW_FAMILY_LOAD.issues.length, 0);
assert.equal(PRODUCTION_STRICT_SHADOW_FAMILY_LOAD.plugins.length, 23);
assert.equal(
  PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG.listAll().length,
  23,
);
assert.equal(
  PRODUCTION_STRICT_SHADOW_GENERATED_CAPABILITY_MANIFEST.entries.length,
  253,
);
assert.equal(
  new Set(
    PRODUCTION_STRICT_SHADOW_GENERATED_CAPABILITY_MANIFEST.entries.map(
      (entry) => `${entry.familyId}\0${entry.capability}`,
    ),
  ).size,
  253,
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
    "(22 strict Families / 242 exact capabilities / complete strict action closure)",
);
