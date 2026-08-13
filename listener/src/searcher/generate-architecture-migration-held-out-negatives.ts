import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import {
  ARCHITECTURE_MIGRATION_STAGES,
  type RawArchitectureMigrationSideCapture,
  type RawFamilyMigrationCaseCapture,
  type RawMigrationSemanticItem,
} from "./architecture-migration-parity-runner.js";
import {
  hashCanonical,
  type CanonicalValue,
} from "./venues/canonical-value.js";

export interface GeneratedHeldOutNegative {
  readonly familyId: string;
  readonly reason: string;
  readonly baselinePath: string;
  readonly challengerPath: string;
}

/**
 * Generates one schema-valid canonical semantic mutation per captured Family.
 * Selection uses only the migration capture schema and canonical value types;
 * it has no production Family, protocol, selector, topic or field-name table.
 */
export async function generateHeldOutNegatives(input: {
  readonly baselinePath: string;
  readonly challengerPath: string;
  readonly outputDirectory: string;
}): Promise<readonly GeneratedHeldOutNegative[]> {
  const baselinePath = resolve(input.baselinePath);
  const challengerPath = resolve(input.challengerPath);
  if (baselinePath === challengerPath) {
    throw new Error("held-out source sides must be independent files");
  }
  const baseline = await readSide(baselinePath);
  const challenger = await readSide(challengerPath);
  const baselineFamilies = new Set(baseline.familyCases.map((item) =>
    item.familyId
  ));
  const families = [...new Set(challenger.familyCases.map((item) =>
    item.familyId
  ))].sort();
  if (families.length === 0) {
    throw new Error("held-out generation requires captured Families");
  }
  await mkdir(input.outputDirectory, { recursive: true });
  const generated: GeneratedHeldOutNegative[] = [];
  for (const familyId of families) {
    if (!baselineFamilies.has(familyId)) {
      throw new Error(`held-out baseline is missing captured Family ${familyId}`);
    }
    const mutated = structuredClone(challenger);
    const selected = selectMutableItem(mutated.familyCases, familyId);
    selected.item.value = mutateCanonicalValue(selected.item.value);
    hashCanonical(selected.item.value);
    const path = resolve(
      input.outputDirectory,
      `${generated.length.toString().padStart(3, "0")}-challenger.json`,
    );
    await writeFile(path, `${JSON.stringify(mutated, null, 2)}\n`);
    generated.push(Object.freeze({
      familyId,
      reason: `canonical-value mutation at ${selected.stage}/${selected.item.id}`,
      baselinePath,
      challengerPath: path,
    }));
  }
  return Object.freeze(generated);
}

function selectMutableItem(
  cases: readonly RawFamilyMigrationCaseCapture[],
  familyId: string,
): { readonly stage: string; readonly item: MutableSemanticItem } {
  const familyCases = cases.filter((item) => item.familyId === familyId)
    .sort((left, right) => left.caseId.localeCompare(right.caseId));
  for (const stage of [...ARCHITECTURE_MIGRATION_STAGES].reverse()) {
    for (const familyCase of familyCases) {
      const capture = familyCase.stages[stage];
      if (capture?.status !== "exercised") continue;
      for (const item of [...capture.items].sort((left, right) =>
        left.id.localeCompare(right.id)
      )) {
        if (canMutate(item.value)) {
          return { stage, item: item as MutableSemanticItem };
        }
      }
    }
  }
  throw new Error(`captured Family ${familyId} has no mutable semantic item`);
}

interface MutableSemanticItem extends Omit<RawMigrationSemanticItem, "value"> {
  value: CanonicalValue;
}

function canMutate(value: CanonicalValue): boolean {
  if (typeof value === "boolean" || typeof value === "number") return true;
  if (typeof value === "string") return value.length > 0;
  if (Array.isArray(value)) return value.some(canMutate);
  if (isCanonicalRecord(value)) {
    return Object.keys(value).sort().some((key) => canMutate(value[key]!));
  }
  return false;
}

function mutateCanonicalValue(value: CanonicalValue): CanonicalValue {
  if (typeof value === "boolean") return !value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("canonical number is not finite");
    return Object.is(value, -0) ? 1 : value + 1;
  }
  if (typeof value === "string") {
    if (value.length === 0) throw new Error("empty canonical string is immutable");
    return `${value}:held-out`;
  }
  if (Array.isArray(value)) {
    const copy = [...value];
    const index = copy.findIndex(canMutate);
    if (index < 0) throw new Error("canonical array is immutable");
    copy[index] = mutateCanonicalValue(copy[index]!);
    return copy;
  }
  if (isCanonicalRecord(value)) {
    const copy: Record<string, CanonicalValue> = { ...value };
    const key = Object.keys(copy).sort().find((candidate) =>
      canMutate(copy[candidate]!)
    );
    if (key === undefined) throw new Error("canonical record is immutable");
    copy[key] = mutateCanonicalValue(copy[key]!);
    return copy;
  }
  throw new Error("canonical value is immutable");
}

function isCanonicalRecord(
  value: CanonicalValue,
): value is { readonly [key: string]: CanonicalValue } {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function readSide(path: string): Promise<RawArchitectureMigrationSideCapture> {
  const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
  if (
    parsed === null || typeof parsed !== "object" ||
    !("closure" in parsed) || !("familyCases" in parsed)
  ) {
    throw new Error(`${basename(path)} is not a migration side capture`);
  }
  return parsed as RawArchitectureMigrationSideCapture;
}

async function main(): Promise<void> {
  const [baselinePath, challengerPath, outputDirectory, manifestPath] =
    process.argv.slice(2);
  if (
    baselinePath === undefined || challengerPath === undefined ||
    outputDirectory === undefined || manifestPath === undefined
  ) {
    throw new Error(
      "usage: generate-architecture-migration-held-out-negatives.ts " +
        "<baseline-side.json> <challenger-side.json> <output-dir> " +
        "<manifest.json>",
    );
  }
  const generated = await generateHeldOutNegatives({
    baselinePath,
    challengerPath,
    outputDirectory,
  });
  await writeFile(resolve(manifestPath), `${JSON.stringify(generated, null, 2)}\n`);
  process.stdout.write(
    `held-out canonical mutations written: ${generated.length} ` +
      `${join(resolve(outputDirectory), "*.json")}\n`,
  );
}

if (process.argv[1]?.endsWith("generate-architecture-migration-held-out-negatives.ts")) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
