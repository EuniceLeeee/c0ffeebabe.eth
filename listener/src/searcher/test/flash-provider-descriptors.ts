import "../../shared/adapters/index.js";

import { descriptorFor } from "../../adapters/adapter-descriptors.js";
import { get } from "../../adapters/registry.js";
import { ADDR } from "../../shared/constants/addresses.js";
import { DEFAULT_FLASH_PROVIDERS } from "../solver/flash-liquidity.js";
import {
  FLASH_LEND_SWAP_REPAY,
  FLASH_SWAP_REPAY,
} from "../templates/path-template.js";
import { PRODUCTION_ADAPTER_FAMILIES } from "../venues/production-registry.js";

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`FAIL: ${message}`);
}

const families = PRODUCTION_ADAPTER_FAMILIES.funding();
const ids = families.map((family) => family.funding.actionAdapterId);
assert(ids.length === 2 && new Set(ids).size === ids.length, "flash provider ids must be unique");
for (const family of families) {
  const provider = family.funding;
  assert(
    get(provider.actionAdapterId).id === provider.actionAdapterId,
    `${provider.actionAdapterId} action registration`,
  );
  const actionDescriptor = descriptorFor(provider.actionAdapterId);
  assert(
    actionDescriptor?.lineage === provider.lineage,
    `${provider.actionAdapterId} lineage projection`,
  );
  assert(
    actionDescriptor?.edgeKind === "flash",
    `${provider.actionAdapterId} action taxonomy`,
  );
}

const morpho = PRODUCTION_ADAPTER_FAMILIES.findFundingByAction("morpho-flash")?.funding;
const balancer = PRODUCTION_ADAPTER_FAMILIES.findFundingByAction("balancer-flash")?.funding;
assert(
  morpho?.target === ADDR.MORPHO && morpho.liquidityHolder === ADDR.MORPHO,
  "Morpho target",
);
assert(
  morpho.repayment === "approve-pull" && morpho.paramShape === "none",
  "Morpho semantics",
);
assert(
  balancer?.target === ADDR.BALANCER_VAULT && balancer.liquidityHolder === ADDR.BALANCER_VAULT,
  "Balancer target",
);
assert(
  balancer.repayment === "transfer" && balancer.paramShape === "tokens-and-amounts",
  "Balancer semantics",
);
assert(
  PRODUCTION_ADAPTER_FAMILIES.findFundingByAction("synthetic-flash") === null,
  "unknown provider must fail closed",
);

assert(
  PRODUCTION_ADAPTER_FAMILIES.defaultFunding().funding.actionAdapterId === "morpho-flash",
  "planning default must preserve Morpho",
);
const planningAdapterIds = PRODUCTION_ADAPTER_FAMILIES.fundingActionIds();
assert(
  planningAdapterIds.join(",") === "morpho-flash,balancer-flash",
  "template priority must remain stable",
);
assert(
  DEFAULT_FLASH_PROVIDERS.map((provider) => provider.adapterId).join(",") ===
    "balancer-flash,morpho-flash",
  "liquidity tie-break order must remain stable",
);
for (const template of [FLASH_LEND_SWAP_REPAY, FLASH_SWAP_REPAY]) {
  const flashSlot = template.slots.find((slot) => slot.kind === "flash");
  assert(
    flashSlot?.adapters.join(",") === planningAdapterIds.join(","),
    `${template.name} flash provider derivation`,
  );
}

console.log("flash-provider-descriptors PASS (2/2 providers)");
