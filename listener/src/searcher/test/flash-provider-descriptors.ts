import "../../shared/adapters/index.js";

import { descriptorFor } from "../../adapters/adapter-descriptors.js";
import {
  DEFAULT_FLASH_ADAPTER_ID,
  findFlashProviderDescriptor,
  FLASH_PLANNING_ADAPTER_IDS,
  FLASH_PROVIDER_DESCRIPTORS,
} from "../../adapters/flash-providers.js";
import { get } from "../../adapters/registry.js";
import { ADDR } from "../../shared/constants/addresses.js";
import { DEFAULT_FLASH_PROVIDERS } from "../solver/flash-liquidity.js";
import {
  FLASH_LEND_SWAP_REPAY,
  FLASH_SWAP_REPAY,
} from "../templates/path-template.js";

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`FAIL: ${message}`);
}

const ids = FLASH_PROVIDER_DESCRIPTORS.map((descriptor) => descriptor.adapterId);
assert(ids.length === 2 && new Set(ids).size === ids.length, "flash provider ids must be unique");
for (const provider of FLASH_PROVIDER_DESCRIPTORS) {
  assert(provider.actionAdapter.id === provider.adapterId, `${provider.adapterId} action adapter id`);
  assert(get(provider.adapterId) === provider.actionAdapter, `${provider.adapterId} action registration`);
  const actionDescriptor = descriptorFor(provider.adapterId);
  assert(actionDescriptor?.lineage === provider.lineage, `${provider.adapterId} lineage projection`);
  assert(actionDescriptor?.edgeKind === "flash", `${provider.adapterId} action taxonomy`);
}

const morpho = findFlashProviderDescriptor("morpho-flash");
const balancer = findFlashProviderDescriptor("balancer-flash");
assert(morpho?.target === ADDR.MORPHO && morpho.liquidityHolder === ADDR.MORPHO, "Morpho target");
assert(morpho.repayment === "approve-pull" && morpho.paramShape === "none", "Morpho semantics");
assert(
  balancer?.target === ADDR.BALANCER_VAULT && balancer.liquidityHolder === ADDR.BALANCER_VAULT,
  "Balancer target",
);
assert(
  balancer.repayment === "transfer" && balancer.paramShape === "tokens-and-amounts",
  "Balancer semantics",
);
assert(findFlashProviderDescriptor("synthetic-flash") === null, "unknown provider must fail closed");

assert(DEFAULT_FLASH_ADAPTER_ID === "morpho-flash", "planning default must preserve Morpho");
assert(
  FLASH_PLANNING_ADAPTER_IDS.join(",") === "morpho-flash,balancer-flash",
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
    flashSlot?.adapters.join(",") === FLASH_PLANNING_ADAPTER_IDS.join(","),
    `${template.name} flash provider derivation`,
  );
}

console.log("flash-provider-descriptors PASS (2/2 providers)");
