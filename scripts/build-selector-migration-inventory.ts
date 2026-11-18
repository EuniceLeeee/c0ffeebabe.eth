/** Reproducible coverage receipt. The archived source inventory is data only;
 * production modules never import a retired implementation. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeSelectorFamilyDefinition, selectorFamilySemanticHash } from "../listener/src/searcher/venues/selector-family-definition.js";
import { selectorNativeFamilyId, selectorNativeProgramKey } from "../listener/src/searcher/venues/selector-native-definition.js";
import { selectorNativeCreditExecutionDefinition } from "../listener/src/searcher/venues/selector-native-credit-definition.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), ".."), read = (file: string) => JSON.parse(readFileSync(resolve(root, file), "utf8"));
const base = read("reference/base-family-inventory.json"), original = read("scripts/selector-family-v2-migration.json");
const lineage = read("listener/src/searcher/generated/selector-native-migration.generated.json");
const baseIds: string[] = base.families.map((family: any) => family.familyId);
const sourceId = (name: string): string => {
  const matches = baseIds.filter(id => id === name || id.endsWith(`:${name}`));
  assert.equal(matches.length, 1, `ambiguous source Family ${name}`); return matches[0]!;
};
const directory = "listener/src/searcher/venues/selector-native";
const definitions = readdirSync(resolve(root, directory)).filter(name => /^selector-[0-9a-f]{8}-family$/.test(name)).sort().map(name => {
  const file = `${directory}/${name}/${name.slice(0, -7)}.json`, text = readFileSync(resolve(root, file), "utf8"), author = JSON.parse(text);
  const definition = normalizeSelectorFamilyDefinition(author);
  const programs = definition.domain === "funding" ? [] : definition.domain === "credit"
    ? selectorNativeCreditExecutionDefinition(definition).programs : definition.programs;
  const originals = author.programs ?? [author];
  return { file, author, definition, programKeys: programs.map(selectorNativeProgramKey),
    row: { selector: definition.selector, familyId: selectorNativeFamilyId(definition), signature: definition.signature,
      domain: definition.domain, file, sha256: createHash("sha256").update(text).digest("hex"),
      semanticHash: selectorFamilySemanticHash(definition), enabled: definition.activation?.enabled ?? true,
      status: definition.domain === "funding" ? "funding-template" : definition.domain === "credit" ? "credit-position-program"
        : programs.length ? "execution-programs" : "observation-only",
      ...("unsupportedReason" in definition ? { unsupportedReason: definition.unsupportedReason } : {}),
      programs: programs.map((program, index) => ({ programKey: selectorNativeProgramKey(program),
        mode: program.execution === undefined ? "parameters-and-payment" : "execution-extension",
        ...(originals[index]?.meta?.migrationKey ? { migrationKey: originals[index].meta.migrationKey } : {}) })) } };
});
const bySelector = new Map(definitions.map(row => [row.definition.selector, row]));
const coverage = new Map(baseIds.map(id => [id, { familyId: id, destinations: [] as any[] }]));
function add(familyId: string, selector: string, programKey?: string, origin?: string) {
  const family = coverage.get(familyId), target = bySelector.get(selector); assert(family && target, `${familyId} ${selector}`);
  if (programKey !== undefined) assert(target.programKeys.includes(programKey), `missing migrated execution ${familyId} ${selector} ${programKey}`);
  const entry = { selector, file: target.file, ...(programKey ? { programKey } : {}), ...(origin ? { origin } : {}) };
  if (!family.destinations.some(old => old.selector === selector && old.programKey === programKey)) family.destinations.push(entry);
}
for (const row of lineage.migrations) {
  const transformed = original.migrations.find((item: any) => item.selector === row.selector && item.oldProgramKey === row.programKey);
  assert(transformed, `missing original-program migration ${row.source}`);
  add(base.legacyRootJsonFamilies[row.source], row.selector, transformed.newProgramKey, "declarative-base-execution");
}
const typedReports = ["listener/src/searcher/generated/selector-typed-a-migration.generated.json",
  "listener/src/searcher/generated/selector-typed-root-migration.generated.json",
  "listener/src/searcher/generated/selector-typed-set-migration.generated.json",
  "scripts/selector-typed-c-migration.json", "scripts/selector-typed-aqua-migration.json"];
for (const file of typedReports) {
  const report = read(file);
  for (const row of report.entries ?? report.rows) {
    const target = bySelector.get(row.selector); assert(target, row.selector);
    const authors = target.author.programs ?? [target.author];
    const index = authors.findIndex((program: any) => program.meta?.migrationKey === row.recipe);
    assert(index >= 0, `missing typed recipe ${row.recipe}`);
    add(sourceId(row.sourceFamily), row.selector, target.programKeys[index], file);
  }
}
add("credit:fluid", "0x032d2276", bySelector.get("0x032d2276")!.programKeys[0], "selector-credit-v2-migration");
add("flash-loan:balancer-v2", "0x5c38449e", undefined, "selector-funding-template");
add("flash-loan:morpho", "0xe0232b42", undefined, "selector-funding-template");
for (const family of coverage.values()) assert(family.destinations.length, `unmigrated base Family ${family.familyId}`);
const rows = definitions.map(item => item.row), ordinary = rows.filter(row => row.domain !== "credit" && row.domain !== "funding");
const capability = read("listener/src/searcher/generated/family-capability-shadow.generated.json");
const retiredImports = [...new Set(capability.exact.flatMap((entry: any) => entry.identity.semanticDependencies as string[]))]
  .filter((file: any) => /(?:^|\/)venues\/(?:protocols|swaps|funding|credit)\/.*\.(?:ts|json)$/.test(file));
assert.deepEqual(retiredImports, [], "production capability closure imports a retired Family");
const report = {
  format: "selector-family-v2-complete-migration/v1", baseCommit: base.baseCommit,
  counts: { baseFamilies: baseIds.length, coveredBaseFamilies: coverage.size, selectorFamilies: rows.length,
    ordinaryExecutableFamilies: ordinary.filter(row => row.programs.length).length,
    ordinaryPrograms: ordinary.reduce((total, row) => total + row.programs.length, 0),
    automaticParameterPrograms: ordinary.reduce((total, row) => total + row.programs.filter(program => program.mode === "parameters-and-payment").length, 0),
    creditFamilies: rows.filter(row => row.domain === "credit").length, fundingFamilies: rows.filter(row => row.domain === "funding").length,
    observationOnlyFamilies: rows.filter(row => row.status === "observation-only").length,
    enabledSelectorFamilies: rows.filter(row => row.enabled).length },
  boundary: { sourceFamilyCoverage: "Every installed fdb859a Family, including disabled typed entries, maps to a standalone v2 execution declaration.",
    observationOnly: "Historical observation/callback/internal selectors without an implemented standalone entry remain visible; they are not claimed executable.",
    acceptance: "Coverage is an inventory assertion. Local EVM regressions and source-bound historical transaction acceptance are reported separately.",
    retiredRuntimeImports: retiredImports.length },
  families: [...coverage.values()].map(row => ({ ...row, destinations: row.destinations.sort((a, b) => `${a.selector}:${a.programKey}`.localeCompare(`${b.selector}:${b.programKey}`)) })),
  declarations: rows,
};
const output = "listener/src/searcher/generated/selector-family-v2-migration-inventory.generated.json";
const text = JSON.stringify(report, null, 2) + "\n";
if (process.argv.includes("--check")) assert.equal(readFileSync(resolve(root, output), "utf8"), text, "selector migration inventory is stale");
else writeFileSync(resolve(root, output), text);
console.log(JSON.stringify({ output, ...report.counts }));
