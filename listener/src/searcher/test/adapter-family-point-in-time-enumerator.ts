import assert from "node:assert/strict";
import { ethers } from "ethers";
import {
  adapterFamilySnapshotInventoryHash,
  enumeratePointInTimeInventory,
} from "../adapter-family-snapshot-inventory-closure.js";
import {
  familyId,
  type FamilyId,
} from "../venues/adapter-family-identifiers.js";
import type {
  CanonicalSource,
} from "../venues/adapter-request-program.js";

const FAMILY_A = familyId("swap:enumerator-a");
const FAMILY_B = familyId("protocol:enumerator-b");
const SOURCE: CanonicalSource = Object.freeze({
  number: 25_700_444,
  hash: `0x${"51".repeat(32)}`,
  generation: 44,
});

function surface(address: string) {
  return Object.freeze({
    kind: "address-surface" as const,
    source: SOURCE,
    address,
    codeHash: `0x${"ab".repeat(32)}`,
    implementationWord: `0x${"cd".repeat(32)}`,
  });
}

function incumbent(
  inventoryKey: string,
  address: string,
) {
  return Object.freeze({
    inventoryKey,
    address,
    currentSurface: surface(address),
  });
}

function testEnumeratesSortedUniqueFamiliesAndIncumbents(): void {
  const addressA = ethers.getAddress(`0x${"11".repeat(20)}`);
  const addressB = ethers.getAddress(`0x${"22".repeat(20)}`);
  const output = enumeratePointInTimeInventory({
    source: SOURCE,
    families: [
      {
        familyId: FAMILY_B,
        incumbents: [
          incumbent("pool:b2", addressB),
          incumbent("pool:b1", addressB),
        ],
      },
      {
        familyId: FAMILY_A,
        incumbents: [
          incumbent("pool:a2", addressA),
          incumbent("pool:a1", addressA),
        ],
      },
    ],
  });
  assert.deepEqual(output.source, SOURCE);
  assert(Object.isFrozen(output));
  assert.deepEqual(
    output.families.map((family) => family.familyId),
    [FAMILY_B, FAMILY_A],
  );
  const familyB = output.families[0]!;
  assert.equal(familyB.familyId, FAMILY_B);
  assert.deepEqual(familyB.inventoryKeys, ["pool:b1", "pool:b2"]);
  assert.equal(familyB.inventoryCount, 2);
  assert.equal(
    familyB.inventoryHash,
    adapterFamilySnapshotInventoryHash({
      familyId: FAMILY_B,
      source: SOURCE,
      incumbents: [
        {
          inventoryKey: "pool:b1",
          address: addressB,
          currentSurface: surface(addressB),
        },
        {
          inventoryKey: "pool:b2",
          address: addressB,
          currentSurface: surface(addressB),
        },
      ],
    }),
  );
  assert(Object.isFrozen(familyB));
  assert(Object.isFrozen(familyB.incumbents));
  assert.equal(familyB.incumbents[0]!.address, addressB);
  assert(Object.isFrozen(familyB.incumbents[0]!.currentSurface));
}

function testRejectsDuplicateInventoryKeysWithinFamily(): void {
  const address = ethers.getAddress(`0x${"11".repeat(20)}`);
  assert.throws(() => enumeratePointInTimeInventory({
    source: SOURCE,
    families: [
      {
        familyId: FAMILY_A,
        incumbents: [
          incumbent("pool:dup", address),
          incumbent("pool:dup", address),
        ],
      },
    ],
  }), /duplicate|unique/);
}

function testRejectsDuplicateFamilies(): void {
  const address = ethers.getAddress(`0x${"11".repeat(20)}`);
  assert.throws(() => enumeratePointInTimeInventory({
    source: SOURCE,
    families: [
      { familyId: FAMILY_A, incumbents: [incumbent("pool:a", address)] },
      { familyId: FAMILY_A, incumbents: [incumbent("pool:b", address)] },
    ],
  }), /duplicate|unique/);
}

function testRejectsForeignSurfaceSourceOrAddressMismatch(): void {
  const address = ethers.getAddress(`0x${"11".repeat(20)}`);
  const otherAddress = ethers.getAddress(`0x${"22".repeat(20)}`);
  assert.throws(() => enumeratePointInTimeInventory({
    source: SOURCE,
    families: [
      {
        familyId: FAMILY_A,
        incumbents: [{
          inventoryKey: "pool:a",
          address,
          currentSurface: Object.freeze({
            ...surface(otherAddress),
            address: otherAddress,
          }),
        }],
      },
    ],
  }), /snapshot inventory/);
  assert.throws(() => enumeratePointInTimeInventory({
    source: SOURCE,
    families: [
      {
        familyId: FAMILY_A,
        incumbents: [{
          inventoryKey: "pool:a",
          address,
          currentSurface: Object.freeze({
            ...surface(address),
            source: Object.freeze({
              number: SOURCE.number + 1,
              hash: SOURCE.hash,
              generation: SOURCE.generation,
            }),
          }),
        }],
      },
    ],
  }), /snapshot inventory/);
}

function testCrossFamilyKeysMayRepeatAndForeignSurfaceKindFails(): void {
  const address = ethers.getAddress(`0x${"11".repeat(20)}`);
  const output = enumeratePointInTimeInventory({
    source: SOURCE,
    families: [
      { familyId: FAMILY_A, incumbents: [incumbent("pool:dup", address)] },
      { familyId: FAMILY_B, incumbents: [incumbent("pool:dup", address)] },
    ],
  });
  assert.equal(output.families.length, 2);
  assert.throws(() => enumeratePointInTimeInventory({
    source: SOURCE,
    families: [
      {
        familyId: FAMILY_A,
        incumbents: [{
          inventoryKey: "pool:a",
          address,
          currentSurface: Object.freeze({
            kind: "call",
            source: SOURCE,
            target: address,
            data: "0x",
          }) as unknown as ReturnType<typeof surface>,
        }],
      },
    ],
  }), /snapshot inventory requires a current address surface/);
}

function testEmptyFamilyYieldsCanonicalZeroInventory(): void {
  const output = enumeratePointInTimeInventory({
    source: SOURCE,
    families: [{ familyId: FAMILY_A, incumbents: [] }],
  });
  assert.deepEqual(output.source, SOURCE);
  const family = output.families[0]!;
  assert.equal(family.inventoryCount, 0);
  assert.deepEqual(family.inventoryKeys, []);
  assert.equal(
    family.inventoryHash,
    adapterFamilySnapshotInventoryHash({
      familyId: FAMILY_A,
      source: SOURCE,
      incumbents: [],
    }),
  );
}

function testDuplicateAddressAcrossKeysAndEmptyFamilies(): void {
  const address = ethers.getAddress(`0x${"11".repeat(20)}`);
  const output = enumeratePointInTimeInventory({
    source: SOURCE,
    families: [
      {
        familyId: FAMILY_A,
        incumbents: [
          incumbent("pool:a", address),
          incumbent("pool:b", address),
        ],
      },
      { familyId: FAMILY_B, incumbents: [] },
    ],
  });
  assert.equal(output.families.length, 2);
  assert.equal(output.families[0]!.familyId, FAMILY_B);
  assert.equal(output.families[0]!.inventoryCount, 0);
  assert.deepEqual(
    output.families[1]!.incumbents.map((item) => item.inventoryKey),
    ["pool:a", "pool:b"],
  );
  assert.deepEqual(
    enumeratePointInTimeInventory({
      source: SOURCE,
      families: [],
    }).families,
    [],
  );
}

function testInventoryHashIsOrderIndependent(): void {
  const address = ethers.getAddress(`0x${"11".repeat(20)}`);
  const addressSurface = surface(address);
  const unsorted = [
    { inventoryKey: "pool:b", address, currentSurface: addressSurface },
    { inventoryKey: "pool:a", address, currentSurface: addressSurface },
  ];
  const sorted = [unsorted[1]!, unsorted[0]!];
  assert.equal(
    adapterFamilySnapshotInventoryHash({
      familyId: FAMILY_A,
      source: SOURCE,
      incumbents: unsorted,
    }),
    adapterFamilySnapshotInventoryHash({
      familyId: FAMILY_A,
      source: SOURCE,
      incumbents: sorted,
    }),
  );
  assert.throws(() => adapterFamilySnapshotInventoryHash({
    familyId: familyId(""),
    source: SOURCE,
    incumbents: [],
  }), /familyId must be non-empty/);
}

async function main(): Promise<void> {
  testEnumeratesSortedUniqueFamiliesAndIncumbents();
  testRejectsDuplicateInventoryKeysWithinFamily();
  testRejectsDuplicateFamilies();
  testRejectsForeignSurfaceSourceOrAddressMismatch();
  testCrossFamilyKeysMayRepeatAndForeignSurfaceKindFails();
  testEmptyFamilyYieldsCanonicalZeroInventory();
  testDuplicateAddressAcrossKeysAndEmptyFamilies();
  testInventoryHashIsOrderIndependent();
  console.log("adapter-family point-in-time enumerator PASS");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
