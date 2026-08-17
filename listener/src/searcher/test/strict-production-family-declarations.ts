import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ethers } from "ethers";
import {
  PRODUCTION_STRICT_FAMILY_DECLARATIONS,
  StrictProductionFamilyDeclarations,
} from "../strict-production-family-declarations.js";
import { PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG } from
  "../venues/production-family-composition.js";
import type { FamilyCapabilityCatalog } from
  "../venues/family-capability-catalog.js";
import {
  ANGSTROM_ADAPTER_SWAP_ABI,
  ANGSTROM_MAINNET_ADAPTER,
  ANGSTROM_MAINNET_CHAIN_ID,
  ANGSTROM_MAINNET_HOOK,
} from "../venues/swaps/angstrom-attestation.js";
import {
  BLOCKSCAN_MULTICALL3,
  blockScanMulticallIface,
} from "../venues/swaps/blockscan-state-shared.js";
import { UNIV2_SWAP_TOPIC } from
  "../venues/swaps/univ2-family/codec.js";

const HEAD = Object.freeze({
  number: 25_900_001,
  hash: `0x${"91".repeat(32)}`,
});
const TX_HASH = `0x${"92".repeat(32)}`;
const TOKEN0 = "0x1000000000000000000000000000000000000001";
const TOKEN1 = "0x2000000000000000000000000000000000000002";
const CONTROLLER = "0x3000000000000000000000000000000000000003";
const RECIPIENT = "0x4000000000000000000000000000000000000004";
const signer = new ethers.Wallet(`0x${"51".repeat(32)}`);
const hookStateIface = new ethers.Interface([
  "function extsload(uint256 slot) view returns (uint256 value)",
]);
const controllerIface = new ethers.Interface([
  "function ANGSTROM() view returns (address)",
]);

assert.equal(
  PRODUCTION_STRICT_FAMILY_DECLARATIONS.familyIdForEdge("univ2-swap"),
  "univ2-standard",
);
assert.equal(
  PRODUCTION_STRICT_FAMILY_DECLARATIONS.familyIdForPool("erc4626"),
  "protocol:erc4626",
);
assert.equal(
  PRODUCTION_STRICT_FAMILY_DECLARATIONS
    .requiresProtocolEdgesForPool("erc4626"),
  true,
);
assert.equal(
  PRODUCTION_STRICT_FAMILY_DECLARATIONS
    .livePoolStateKindForEdge("univ2-swap"),
  "constant-product-v2",
);
assert.equal(
  PRODUCTION_STRICT_FAMILY_DECLARATIONS
    .livePoolStateKindForEdge("univ3-swap"),
  "concentrated-v3",
);
assert.equal(
  PRODUCTION_STRICT_FAMILY_DECLARATIONS
    .livePoolStateKindForEdge("univ4-unlock"),
  "singleton-v4",
);
assert.equal(
  PRODUCTION_STRICT_FAMILY_DECLARATIONS
    .currentHeadEvidenceFamilyForEdge("angstrom-v4-swap"),
  "custom-swap:angstrom-v4",
);
assert.equal(
  PRODUCTION_STRICT_FAMILY_DECLARATIONS
    .currentHeadEvidenceScopeKeyForEdge({
      adapterId: "angstrom-v4-swap",
    } as never),
  "family-wide",
);

const targets = new Set(
  PRODUCTION_STRICT_FAMILY_DECLARATIONS.canonicalIntakeTargets.map(
    (address) => address.toLowerCase(),
  ),
);
for (const target of [
  "0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D",
  "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45",
  "0xe592427a0aece92de3edee1f18e0157c05861564",
  "0x3fc91a3afd70395cd496c647d5a6cc9d4b2b7fad",
  "0x66a9893cc07d91d95644aedd05d03f95e1dba8af",
  "0xa356867fDCEa8e71AEaF87805808803806231FdC",
  "0x99a58482bd75cbab83b27ec03ca68ff489b5788f",
  "0x16c6521dff6bab339122a0fe25a9116693265353",
  ANGSTROM_MAINNET_ADAPTER,
  ANGSTROM_MAINNET_HOOK,
]) {
  assert(targets.has(target.toLowerCase()), `missing strict intake ${target}`);
}

assert.equal(PRODUCTION_STRICT_FAMILY_DECLARATIONS.isSwapLog({
  address: "0x5000000000000000000000000000000000000005",
  topics: [UNIV2_SWAP_TOPIC],
  data: "0x",
  blockNumber: HEAD.number,
  blockHash: HEAD.hash,
  transactionHash: TX_HASH,
}), true);
assert.equal(PRODUCTION_STRICT_FAMILY_DECLARATIONS.isSwapLog({
  address: "0x5000000000000000000000000000000000000005",
  topics: [`0x${"93".repeat(32)}`],
  data: "0x",
  blockNumber: HEAD.number,
  blockHash: HEAD.hash,
  transactionHash: TX_HASH,
}), false);

const signature = await signer.signTypedData(
  {
    name: "Angstrom",
    version: "v1",
    chainId: ANGSTROM_MAINNET_CHAIN_ID,
    verifyingContract: ANGSTROM_MAINNET_HOOK,
  },
  {
    AttestAngstromBlockEmpty: [{
      name: "block_number",
      type: "uint64",
    }],
  },
  { block_number: BigInt(HEAD.number) },
);
const calldata = new ethers.Interface(ANGSTROM_ADAPTER_SWAP_ABI)
  .encodeFunctionData("swap", [
    {
      currency0: TOKEN0,
      currency1: TOKEN1,
      fee: 0x80_0000,
      tickSpacing: 10,
      hooks: ANGSTROM_MAINNET_HOOK,
    },
    true,
    1_000_000n,
    900_000n,
    [{
      blockNumber: BigInt(HEAD.number),
      unlockData: ethers.concat([signer.address, signature]),
    }],
    RECIPIENT,
    (1n << 256n) - 1n,
  ]);
const tx = Object.freeze({
  hash: TX_HASH,
  to: ANGSTROM_MAINNET_ADAPTER,
  data: calldata,
});
assert.deepEqual(
  PRODUCTION_STRICT_FAMILY_DECLARATIONS.pendingEvidence.candidateFamilyIds(tx),
  ["custom-swap:angstrom-v4"],
);
let authorityReads = 0;
const observed = await PRODUCTION_STRICT_FAMILY_DECLARATIONS.pendingEvidence
  .observe(tx, {
    head: HEAD,
    async call(read) {
      authorityReads++;
      if (ethers.getAddress(read.to) === ethers.getAddress(ANGSTROM_MAINNET_HOOK)) {
        return hookStateIface.encodeFunctionResult(
          "extsload",
          [BigInt(CONTROLLER)],
        );
      }
      if (ethers.getAddress(read.to) === ethers.getAddress(CONTROLLER)) {
        return controllerIface.encodeFunctionResult(
          "ANGSTROM",
          [ANGSTROM_MAINNET_HOOK],
        );
      }
      assert.equal(
        ethers.getAddress(read.to),
        ethers.getAddress(BLOCKSCAN_MULTICALL3),
      );
      const calls = blockScanMulticallIface.decodeFunctionData(
        "aggregate3",
        read.data,
      )[0] as readonly unknown[];
      return blockScanMulticallIface.encodeFunctionResult("aggregate3", [[
        ...calls.map(() => ({
          success: true,
          returnData: hookStateIface.encodeFunctionResult("extsload", [1n]),
        })),
      ]]);
    },
  });
assert.equal(authorityReads, 3);
assert.equal(observed.failures.length, 0);
assert.equal(observed.evidence.length, 1);
const evidence = observed.evidence[0]!;
assert.equal(evidence.familyId, "custom-swap:angstrom-v4");
assert.equal(evidence.txHash, TX_HASH);
assert.equal(evidence.headBlockNumber, HEAD.number);
assert.equal(evidence.headHash, HEAD.hash);
assert.equal(evidence.payloadHash, ethers.keccak256(evidence.canonicalPayload));
assert.equal(evidence.evidenceHash, ethers.keccak256(
  ethers.AbiCoder.defaultAbiCoder().encode(
    ["string", "bytes32", "uint256", "bytes32", "bytes32"],
    [
      evidence.familyId,
      evidence.txHash,
      evidence.headBlockNumber,
      evidence.headHash,
      evidence.payloadHash,
    ],
  ),
));

const catalog = PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG;
const modules = catalog.listAll();
const angstromIndex = modules.findIndex((loaded) =>
  loaded.plugin.manifest.familyId === "custom-swap:angstrom-v4"
);
assert(angstromIndex >= 0);
const angstrom = modules[angstromIndex]!;
const discovery = (angstrom.plugin as typeof angstrom.plugin & {
  readonly discovery: {
    readonly canonicalIntakeTargets: readonly string[];
  };
}).discovery;
const duplicateModules = [...modules];
duplicateModules[angstromIndex] = Object.freeze({
  ...angstrom,
  plugin: Object.freeze({
    ...angstrom.plugin,
    discovery: Object.freeze({
      ...discovery,
      canonicalIntakeTargets: Object.freeze([
        discovery.canonicalIntakeTargets[0],
        discovery.canonicalIntakeTargets[0],
      ]),
    }),
  }),
}) as typeof angstrom;
const duplicateCatalog = Object.create(catalog) as FamilyCapabilityCatalog;
Object.defineProperty(duplicateCatalog, "listAll", {
  value: () => Object.freeze(duplicateModules),
});
assert.throws(
  () => new StrictProductionFamilyDeclarations(duplicateCatalog),
  /duplicates\/zeros intake target/,
);

for (const relative of ["../main.ts", "../solver/pool-state-updater.ts"]) {
  const source = readFileSync(new URL(relative, import.meta.url), "utf8");
  assert.equal(
    source.includes("PRODUCTION_ADAPTER_FAMILIES"),
    false,
    `${relative} must not restore central legacy Family authority`,
  );
}

console.log("strict production family declarations PASS");
