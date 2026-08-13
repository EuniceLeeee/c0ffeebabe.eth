import { readFile, writeFile } from "node:fs/promises";
import { ethers } from "ethers";
import type {
  AdapterFamilyDiscoveryCheckpointSnapshot,
} from "./adapter-family-discovery-checkpoint.js";
import type {
  FamilyCaptureDescriptor,
} from "./venues/adapter-family-plugin.js";
import type { CanonicalValue } from "./venues/canonical-value.js";
import type { CaptureInventoryFile } from
  "./materialize-s1-capture-inventory.js";
import {
  PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG,
} from "./venues/production-family-composition.js";

interface DescriptorFile {
  readonly sourceBlock: number;
  readonly sourceBlockHash: string;
  readonly captureId: string;
  readonly cases: readonly Omit<
    FamilyCaptureDescriptor,
    "source"
  >[];
}

export function descriptorFromInventory(input: {
  readonly inventory: CaptureInventoryFile;
  readonly assets: readonly string[];
  readonly executor: string;
  readonly amount: bigint;
  readonly minProfit: bigint;
}): DescriptorFile {
  const catalog = PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG;
  if (input.inventory.catalogHash !== catalog.catalogHash) {
    throw new Error("capture inventory catalogHash does not match generated catalog");
  }
  if (input.inventory.unresolved.length !== 0) {
    throw new Error(
      `capture inventory cannot cover generated catalog: ${input.inventory.unresolved
        .map((item) => `${item.familyId}:incumbent`).sort().join(",")}`,
    );
  }
  const executor = ethers.getAddress(input.executor).toLowerCase();
  const assets = canonicalAddresses(input.assets, "capture asset inventory");
  const byFamily = new Map(input.inventory.entries.map((entry) => [
    entry.familyId,
    entry,
  ]));
  const cases: Omit<FamilyCaptureDescriptor, "source">[] = [];
  const missing: string[] = [];
  for (const family of catalog.listAll()) {
    if (family.plugin.capture === undefined) {
      missing.push(`${family.plugin.manifest.familyId}:capture`);
      continue;
    }
    if (family.plugin.manifest.domain === "funding") {
      if (!("funding" in family.plugin) || family.plugin.funding === undefined) {
        throw new Error("Funding manifest has no Funding capability");
      }
      cases.push(Object.freeze({
        familyId: family.plugin.manifest.familyId,
        candidateIdentity: family.plugin.funding.repayment.target,
        opaqueBinding: Object.freeze({
          amount: input.amount.toString(),
          assets,
          minProfit: input.minProfit.toString(),
        }),
      }));
      continue;
    }
    const incumbent = byFamily.get(family.plugin.manifest.familyId);
    if (incumbent === undefined) {
      missing.push(`${family.plugin.manifest.familyId}:incumbent`);
      continue;
    }
    const common = {
      executor,
      minAmountOut: input.minProfit.toString(),
      observation: incumbent.observation as unknown as CanonicalValue,
      runtimeEvidence: Object.freeze([]),
    };
    cases.push(Object.freeze({
      familyId: family.plugin.manifest.familyId,
      candidateIdentity: incumbent.candidateIdentity,
      opaqueBinding: family.plugin.manifest.domain === "credit"
        ? Object.freeze({
            ...common,
            collateralAmount: input.amount.toString(),
            debtBps: "5000",
          })
        : Object.freeze({ ...common, amountIn: input.amount.toString() }),
    }));
  }
  if (missing.length !== 0) {
    throw new Error(
      `capture inventory cannot cover generated catalog: ${missing.sort().join(",")}`,
    );
  }
  cases.sort((left, right) => left.familyId.localeCompare(right.familyId));
  return Object.freeze({
    sourceBlock: input.inventory.source.number,
    sourceBlockHash: input.inventory.source.hash,
    captureId: `catalog-inventory-${input.inventory.source.number}`,
    cases: Object.freeze(cases),
  });
}

/**
 * Projects the durable catalog-owned inventory into generic capture
 * descriptors. No protocol or Family names are interpreted: each plugin owns
 * observation parsing while this tool supplies one real incumbent surface and
 * a common source/execution policy envelope.
 */
export function descriptorFromCheckpoint(input: {
  readonly checkpoint: AdapterFamilyDiscoveryCheckpointSnapshot;
  readonly assets: readonly string[];
  readonly executor: string;
  readonly amount: bigint;
  readonly minProfit: bigint;
}): DescriptorFile {
  const catalog = PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG;
  if (input.checkpoint.catalogHash !== catalog.catalogHash) {
    throw new Error("capture checkpoint catalogHash does not match generated catalog");
  }
  const executor = ethers.getAddress(input.executor).toLowerCase();
  const assets = canonicalAddresses(input.assets, "capture asset inventory");
  const cases: Omit<FamilyCaptureDescriptor, "source">[] = [];
  const missing: string[] = [];
  for (const family of catalog.listAll()) {
    if (family.plugin.capture === undefined) {
      missing.push(`${family.plugin.manifest.familyId}:capture`);
      continue;
    }
    if (family.plugin.manifest.domain === "funding") {
      if (!("funding" in family.plugin) || family.plugin.funding === undefined) {
        throw new Error("Funding manifest has no Funding capability");
      }
      const funding = family.plugin.funding;
      cases.push(Object.freeze({
        familyId: family.plugin.manifest.familyId,
        candidateIdentity: funding.repayment.target,
        opaqueBinding: Object.freeze({
          amount: input.amount.toString(),
          assets,
          minProfit: input.minProfit.toString(),
        }),
      }));
      continue;
    }
    const inventory = input.checkpoint.inventoryFamilies.find((candidate) =>
      candidate.familyId === family.plugin.manifest.familyId
    );
    const incumbent = inventory?.incumbents[0];
    if (incumbent === undefined) {
      missing.push(`${family.plugin.manifest.familyId}:incumbent`);
      continue;
    }
    const common = {
      executor,
      minAmountOut: input.minProfit.toString(),
      observation: incumbent.currentSurface as unknown as CanonicalValue,
      runtimeEvidence: Object.freeze([]),
    };
    cases.push(Object.freeze({
      familyId: family.plugin.manifest.familyId,
      candidateIdentity: incumbent.address,
      opaqueBinding: family.plugin.manifest.domain === "credit"
        ? Object.freeze({
            ...common,
            collateralAmount: input.amount.toString(),
            debtBps: "5000",
          })
        : Object.freeze({
            ...common,
            amountIn: input.amount.toString(),
          }),
    }));
  }
  cases.sort((left, right) => left.familyId.localeCompare(right.familyId));
  if (missing.length !== 0) {
    throw new Error(
      `capture checkpoint cannot cover generated catalog: ${missing.sort().join(",")}`,
    );
  }
  return Object.freeze({
    sourceBlock: input.checkpoint.source.number,
    sourceBlockHash: input.checkpoint.source.hash,
    captureId: `catalog-checkpoint-${input.checkpoint.source.number}`,
    cases: Object.freeze(cases),
  });
}

function canonicalAddresses(
  values: readonly string[],
  label: string,
): readonly string[] {
  const normalized = [...new Set(values.map((value) =>
    ethers.getAddress(value).toLowerCase()
  ))].sort();
  if (normalized.length === 0) throw new Error(`${label} must be non-empty`);
  return Object.freeze(normalized);
}

async function main(): Promise<void> {
  const [checkpointPath, assetsPath, outputPath] = process.argv.slice(2);
  if (
    checkpointPath === undefined || assetsPath === undefined ||
    outputPath === undefined
  ) {
    throw new Error(
      "usage: generate-s1-capture-descriptor.ts <checkpoint.json> " +
        "<asset-addresses.json> <descriptor.json>",
    );
  }
  const executor = process.env.S1_CAPTURE_EXECUTOR;
  if (executor === undefined) throw new Error("S1_CAPTURE_EXECUTOR is required");
  const rawInventory = JSON.parse(await readFile(checkpointPath, "utf8")) as
    AdapterFamilyDiscoveryCheckpointSnapshot | CaptureInventoryFile;
  const assetInventory = JSON.parse(await readFile(assetsPath, "utf8")) as
    unknown;
  if (!Array.isArray(assetInventory) || assetInventory.some((item) =>
    typeof item !== "string"
  )) {
    throw new Error("asset inventory must be an array of addresses");
  }
  const common = {
    assets: assetInventory as string[],
    executor,
    amount: positiveBigint(process.env.S1_CAPTURE_AMOUNT, 1n),
    minProfit: nonnegativeBigint(process.env.S1_CAPTURE_MIN_PROFIT, 0n),
  };
  const descriptor = rawInventory.format === "s1-catalog-capture-inventory-v1"
    ? descriptorFromInventory({ inventory: rawInventory, ...common })
    : descriptorFromCheckpoint({ checkpoint: rawInventory, ...common });
  await writeFile(outputPath, `${JSON.stringify(descriptor, null, 2)}\n`);
  process.stdout.write(
    `catalog capture descriptor written: ${descriptor.cases.length} cases\n`,
  );
}

function nonnegativeBigint(value: string | undefined, fallback: bigint): bigint {
  const parsed = value === undefined ? fallback : BigInt(value);
  if (parsed < 0n) throw new Error("capture min profit must be non-negative");
  return parsed;
}

function positiveBigint(value: string | undefined, fallback: bigint): bigint {
  const parsed = value === undefined ? fallback : BigInt(value);
  if (parsed <= 0n) throw new Error("capture amount must be positive");
  return parsed;
}

if (process.argv[1]?.endsWith("generate-s1-capture-descriptor.ts")) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
