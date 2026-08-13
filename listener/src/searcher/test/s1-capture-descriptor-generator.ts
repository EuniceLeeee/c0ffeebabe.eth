import assert from "node:assert/strict";
import { ethers } from "ethers";
import {
  descriptorFromCheckpoint,
} from "../generate-s1-capture-descriptor.js";
import type {
  AdapterFamilyDiscoveryCheckpointSnapshot,
} from "../adapter-family-discovery-checkpoint.js";
import {
  PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG,
} from "../venues/production-family-composition.js";

const catalog = PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG;
const source = Object.freeze({
  number: 100,
  hash: `0x${"12".repeat(32)}`,
  generation: 100,
});
let addressIndex = 1;
const inventoryFamilies = catalog.listAll()
  .filter((family) => "discovery" in family.plugin)
  .map((family) => {
    const address = ethers.getAddress(
      `0x${(addressIndex++).toString(16).padStart(40, "0")}`,
    ).toLowerCase();
    return Object.freeze({
      familyId: family.plugin.manifest.familyId,
      inventoryKeys: Object.freeze([address]),
      inventoryCount: 1,
      inventoryHash: "a".repeat(64),
      incumbents: Object.freeze([Object.freeze({
        inventoryKey: address,
        address,
        currentSurface: Object.freeze({
          kind: "address-surface" as const,
          source,
          address,
          codeHash: `0x${"34".repeat(32)}`,
          implementationWord: `0x${"00".repeat(32)}`,
          interfaceFingerprints: Object.freeze([]),
        }),
      })]),
    });
  });
const checkpoint = {
  format: "adapter-family-discovery-checkpoint-v2",
  chainId: "1",
  catalogHash: catalog.catalogHash,
  sourceRegistryFingerprint: "synthetic",
  revision: 1,
  source,
  watermarks: Object.freeze([]),
  inventoryFamilies: Object.freeze(inventoryFamilies),
  checkpointFingerprint: "b".repeat(64),
} as AdapterFamilyDiscoveryCheckpointSnapshot;

const descriptor = descriptorFromCheckpoint({
  checkpoint,
  assets: [ethers.getAddress(`0x${"fe".repeat(20)}`)],
  executor: ethers.getAddress(`0x${"ef".repeat(20)}`),
  amount: 1n,
  minProfit: 0n,
});
assert.equal(descriptor.cases.length, catalog.listAll().length);
assert.deepEqual(
  descriptor.cases.map((item) => item.familyId).sort(),
  catalog.listAll().map((family) => family.plugin.manifest.familyId).sort(),
);
assert(descriptor.cases.every((item) =>
  Object.keys(item).sort().join(",") ===
    "candidateIdentity,familyId,opaqueBinding"
));

const missing = {
  ...structuredClone(checkpoint),
  inventoryFamilies: structuredClone(checkpoint.inventoryFamilies).slice(1),
} as AdapterFamilyDiscoveryCheckpointSnapshot;
assert.throws(
  () => descriptorFromCheckpoint({
    checkpoint: missing,
    assets: [ethers.getAddress(`0x${"fe".repeat(20)}`)],
    executor: ethers.getAddress(`0x${"ef".repeat(20)}`),
    amount: 1n,
    minProfit: 0n,
  }),
  /cannot cover generated catalog/,
);
console.log("S1 capture descriptor generator PASS");
