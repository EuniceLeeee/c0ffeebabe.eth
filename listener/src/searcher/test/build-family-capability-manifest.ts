import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  buildFamilyCapabilityShadowArtifact,
  checkFamilyCapabilityShadowArtifact,
  checkProductionFamilyStaticImports,
  serializeProductionFamilyStaticImports,
  writeFamilyCapabilityShadowArtifact,
  writeProductionFamilyStaticImports,
} from "../build-family-capability-manifest.js";
import { familyId } from "../venues/adapter-family-identifiers.js";
import { FAMILY_CAPABILITY_NAMES } from
  "../venues/family-capability-catalog.js";
import {
  createFamilyCapabilityShadowArtifact,
  generatedCapabilityManifestFromShadowArtifact,
} from "../venues/family-capability-shadow.js";
import {
  trackedProductionSourceFiles,
} from "../venues/production-families/tracked-sources.js";

const execFileAsync = promisify(execFile);

await verifyTrackedProductionSourceContract();

const fixtureRoot = await mkdtemp(resolve(tmpdir(), "capability-manifest-build-"));
try {
  await writeFixtureFile("package-lock.json", JSON.stringify({ packages: {} }));
  await writeFixtureFile("tsconfig.json", JSON.stringify({
    compilerOptions: {
      target: "ES2022",
      module: "Node16",
      moduleResolution: "Node16",
      strict: true,
    },
    include: ["src"],
  }));
  await writeFixtureFile("src/framework.ts", `
    export function defineSwapFamily<T>(input: T): T { return input; }
    export function defineFundingFamily<T>(input: T): T { return input; }
    export function defineCreditFamily<T>(input: T): T { return input; }
  `);
  await writeFixtureFile("src/manifest.ts", `
    export const manifest = { familyId: "swap:fixture" } as const;
  `);
  for (const capability of [
    "discovery",
    "identity",
    "instance",
    "routes",
    "pricing",
    "exact",
    "execution",
  ]) {
    await writeFixtureFile(`src/${capability}.ts`, `
      export const ${capability} = { run: () => "${capability}-v1" };
    `);
  }
  await writeFixtureFile("src/swap-domain.ts", `
    export const swap = {
      victimSupport: "none",
      landedEvents: {},
      observation: {},
    } as const;
  `);
  await writeFixtureFile("src/action.ts", `
    export const action = { id: "fixture-swap", encode: () => 1 };
  `);
  await writeFixtureFile("src/registry.ts", `
    export const LEGACY_PRODUCTION_ADAPTER_FAMILIES = Object.freeze([]);
  `);
  await writeStrictProductionEntry();

  const productionDirectory = resolve(fixtureRoot, "src/production");
  const registryFile = resolve(fixtureRoot, "src/registry.ts");
  const base = await buildFamilyCapabilityShadowArtifact({
    rootDirectory: fixtureRoot,
    productionDirectory,
    productionRegistryFile: registryFile,
    provenanceCommit: "a".repeat(40),
  });
  assert.equal(base.complete, true, JSON.stringify(base.issues));
  assert.equal(base.issues.length, 0);
  assert.equal(base.exact.length, FAMILY_CAPABILITY_NAMES.length);
  assert.equal(base.legacy.length, 0);
  assert(base.exact.every((record) => record.precision === "capability-exact"));
  const victim = base.exact.find((record) =>
    record.identity.capability === "victim"
  );
  assert.equal(victim?.root.absence, "declared-absent");
  for (const capability of ["funding", "credit"] as const) {
    assert.equal(
      base.exact.find((record) =>
        record.identity.capability === capability
      )?.root.absence,
      "declared-absent",
      `swap Families must declare ${capability} absent instead of faking it`,
    );
  }
  const execution = base.exact.find((record) =>
    record.identity.capability === "execution"
  );
  assert(
    execution?.identity.semanticDependencies.includes("src/action.ts"),
    "execution must include the owned ActionAdapter root",
  );

  await writeFixtureFile("src/manifest.ts", `
    export const manifest = { familyId: "flash-loan:fixture" } as const;
  `);
  await writeFixtureFile("src/funding.ts", `
    export const funding = { liquidity: {}, repayment: {} } as const;
  `);
  await writeFundingProductionEntry();
  const fundingArtifact = await buildFamilyCapabilityShadowArtifact({
    rootDirectory: fixtureRoot,
    productionDirectory,
    productionRegistryFile: registryFile,
  });
  assert.equal(
    fundingArtifact.complete,
    true,
    JSON.stringify(fundingArtifact.issues),
  );
  assert.deepEqual(
    fundingArtifact.exact
      .filter((record) => record.root.absence === null)
      .map((record) => record.identity.capability),
    ["funding"],
    "Funding must hash its own semantics without fake route/pricing roots",
  );
  assert(
    fundingArtifact.exact.find((record) =>
      record.identity.capability === "funding"
    )?.identity.semanticDependencies.includes("src/action.ts"),
    "Funding capability hash must include the flash ActionAdapter",
  );

  await writeFixtureFile("src/manifest.ts", `
    export const manifest = { familyId: "credit:fixture" } as const;
  `);
  await writeFixtureFile("src/credit.ts", `
    export const credit = { position: {}, risk: {} } as const;
  `);
  await writeCreditProductionEntry();
  const creditArtifact = await buildFamilyCapabilityShadowArtifact({
    rootDirectory: fixtureRoot,
    productionDirectory,
    productionRegistryFile: registryFile,
  });
  assert.equal(
    creditArtifact.complete,
    true,
    JSON.stringify(creditArtifact.issues),
  );
  assert.deepEqual(
    creditArtifact.exact
      .filter((record) => record.root.absence === null)
      .map((record) => record.identity.capability)
      .sort(),
    ["credit", "discovery", "execution", "identity", "instance", "routes"],
    "Credit must omit fake pricing/exact while preserving route and risk roots",
  );

  await writeFixtureFile("src/manifest.ts", `
    export const manifest = { familyId: "swap:fixture" } as const;
  `);
  await writeStrictProductionEntry();

  const strictFamily = familyId("swap:fixture");
  const generatedManifest = generatedCapabilityManifestFromShadowArtifact({
    artifact: base,
    strictFamilyIds: [strictFamily],
  });
  assert.equal(
    generatedManifest.entries.length,
    FAMILY_CAPABILITY_NAMES.length,
  );
  assert.match(generatedManifest.manifestHash, /^[0-9a-f]{64}$/);
  assert(generatedManifest.entries.every((entry) =>
    entry.familyId === strictFamily
  ));

  const missingExactArtifact = createFamilyCapabilityShadowArtifact({
    exact: base.exact.filter((record) =>
      record.identity.capability !== "exact"
    ),
    legacy: [],
  });
  await assert.rejects(
    async () => generatedCapabilityManifestFromShadowArtifact({
      artifact: missingExactArtifact,
      strictFamilyIds: [strictFamily],
    }),
    /missing exact capabilities: exact/,
  );

  const issueArtifact = createFamilyCapabilityShadowArtifact({
    exact: base.exact,
    legacy: [],
    issues: [{
      sourceFile: "src/production/fixture.production.ts",
      code: "capability_generation_failed",
      message: "synthetic incomplete shadow",
    }],
  });
  assert.throws(
    () => generatedCapabilityManifestFromShadowArtifact({
      artifact: issueArtifact,
      strictFamilyIds: [strictFamily],
    }),
    /shadow is incomplete \(1 issues\)/,
  );
  assert.throws(
    () => generatedCapabilityManifestFromShadowArtifact({
      artifact: { ...base, artifactHash: "0".repeat(64) },
      strictFamilyIds: [strictFamily],
    }),
    /artifact hash is stale or invalid/,
  );
  assert.throws(
    () => generatedCapabilityManifestFromShadowArtifact({
      artifact: base,
      strictFamilyIds: [strictFamily, strictFamily],
    }),
    /selection duplicates swap:fixture/,
  );

  const extraFamily = familyId("swap:extra-fixture");
  const extraExactArtifact = createFamilyCapabilityShadowArtifact({
    exact: [
      ...base.exact,
      ...base.exact.map((record) => Object.freeze({
        ...record,
        identity: Object.freeze({
          ...record.identity,
          familyId: extraFamily,
        }),
      })),
    ],
    legacy: [],
  });
  assert.throws(
    () => generatedCapabilityManifestFromShadowArtifact({
      artifact: extraExactArtifact,
      strictFamilyIds: [strictFamily],
    }),
    /contains unselected exact Family swap:extra-fixture/,
  );

  const generatedFile = resolve(fixtureRoot, "generated/shadow.json");
  await writeFamilyCapabilityShadowArtifact({
    artifact: base,
    outputFile: generatedFile,
  });
  await checkFamilyCapabilityShadowArtifact({
    artifact: base,
    outputFile: generatedFile,
  });
  await writeFile(generatedFile, "{}\n");
  await assert.rejects(
    checkFamilyCapabilityShadowArtifact({
      artifact: base,
      outputFile: generatedFile,
    }),
    /artifact is stale/,
  );

  const generatedImportsFile = resolve(
    fixtureRoot,
    "generated/production-family-entries.generated.ts",
  );
  const generatedEntryNames = ["fixture.production.ts"];
  await writeProductionFamilyStaticImports({
    productionEntryFiles: generatedEntryNames,
    outputFile: generatedImportsFile,
  });
  await checkProductionFamilyStaticImports({
    productionEntryFiles: generatedEntryNames,
    outputFile: generatedImportsFile,
  });
  assert.match(
    serializeProductionFamilyStaticImports(generatedEntryNames),
    /import \* as entry0 from "\.\.\/venues\/production-families\/fixture\.production\.js";/,
  );
  await writeFile(generatedImportsFile, "// stale\n");
  await assert.rejects(
    checkProductionFamilyStaticImports({
      productionEntryFiles: generatedEntryNames,
      outputFile: generatedImportsFile,
    }),
    /imports are stale/,
  );

  const hashesBefore = new Map(base.exact.map((record) => [
    record.identity.capability,
    record.identity.contentHash,
  ]));
  await writeFixtureFile("src/exact.ts", `
    export const exact = { run: () => "exact-v2" };
  `);
  const exactChanged = await buildFamilyCapabilityShadowArtifact({
    rootDirectory: fixtureRoot,
    productionDirectory,
    productionRegistryFile: registryFile,
    provenanceCommit: "b".repeat(40),
  });
  for (const record of exactChanged.exact) {
    if (record.identity.capability === "exact") {
      assert.notEqual(
        record.identity.contentHash,
        hashesBefore.get("exact"),
      );
    } else {
      assert.equal(
        record.identity.contentHash,
        hashesBefore.get(record.identity.capability),
        `${record.identity.capability} must ignore an exact-only edit`,
      );
    }
  }

  await writeFixtureFile("src/victim.ts", `
    export const victim = { apply: () => "victim-v1" };
  `);
  await writeFixtureFile("src/swap-domain.ts", `
    import { victim } from "./victim.js";
    export const swap = {
      victimSupport: "replay",
      landedEvents: {},
      observation: {},
      replay: victim,
    } as const;
  `);
  const presentVictim = await buildFamilyCapabilityShadowArtifact({
    rootDirectory: fixtureRoot,
    productionDirectory,
    productionRegistryFile: registryFile,
  });
  assert.equal(presentVictim.complete, true, JSON.stringify(presentVictim.issues));
  const presentVictimRecord = presentVictim.exact.find((record) =>
    record.identity.capability === "victim"
  );
  assert.equal(presentVictimRecord?.root.entrySourceFile, "src/victim.ts");
  assert.equal(presentVictimRecord?.root.entryExport, "victim");
  assert.equal(presentVictimRecord?.root.absence, null);
  assert.deepEqual(
    presentVictimRecord?.root.additionalSourceFiles,
    ["src/manifest.ts", "src/swap-domain.ts"],
    "present victim identity must bind both Family manifest and selected replay mode",
  );
  const presentHashes = new Map(presentVictim.exact.map((record) => [
    record.identity.capability,
    record.identity.contentHash,
  ]));
  await writeFixtureFile("src/victim.ts", `
    export const victim = { apply: () => "victim-v2" };
  `);
  const victimChanged = await buildFamilyCapabilityShadowArtifact({
    rootDirectory: fixtureRoot,
    productionDirectory,
    productionRegistryFile: registryFile,
  });
  for (const record of victimChanged.exact) {
    if (record.identity.capability === "victim") {
      assert.notEqual(record.identity.contentHash, presentHashes.get("victim"));
    } else {
      assert.equal(
        record.identity.contentHash,
        presentHashes.get(record.identity.capability),
        `${record.identity.capability} must ignore a victim-only edit`,
      );
    }
  }

  await writeFixtureFile("src/swap-domain.ts", `
    export const swap = {
      victimSupport: "replay",
      landedEvents: {},
      observation: {},
      replay: { apply: () => "inline" },
    } as const;
  `);
  const inlineVictim = await buildFamilyCapabilityShadowArtifact({
    rootDirectory: fixtureRoot,
    productionDirectory,
    productionRegistryFile: registryFile,
  });
  assert.equal(inlineVictim.complete, false);
  assert(
    inlineVictim.issues.some((item) =>
      item.code === "strict_root_not_direct_import" &&
      item.message.includes("replay victim semantics")
    ),
  );

  await writeFixtureFile("src/shared.ts", `
    export const pricing = {};
    export const exact = {};
  `);
  await writeStrictProductionEntry({ sharedPricingExact: true });
  const sharedRoot = await buildFamilyCapabilityShadowArtifact({
    rootDirectory: fixtureRoot,
    productionDirectory,
    productionRegistryFile: registryFile,
  });
  assert.equal(sharedRoot.complete, false);
  assert(
    sharedRoot.issues.some((item) => item.code === "strict_root_shared_module"),
  );
  assert.equal(sharedRoot.exact.length, 0);

  await writeFixtureFile("src/preassembled.ts", `
    export const preassembled = {};
  `);
  await writeFixtureFile("src/production/fixture.production.ts", `
    import { preassembled } from "../preassembled.js";
    export const plugin = preassembled;
  `);
  const preassembled = await buildFamilyCapabilityShadowArtifact({
    rootDirectory: fixtureRoot,
    productionDirectory,
    productionRegistryFile: registryFile,
  });
  assert.equal(preassembled.complete, false);
  assert(
    preassembled.issues.some((item) =>
      item.code === "strict_root_not_direct_import"
    ),
  );

  await writeFixtureFile("src/legacy.ts", `
    export const legacy = {
      id: "swap:legacy-fixture",
      ownedActionAdapterIds: ["legacy-action"],
      adapterSchemaRevision: "legacy-v1",
    } as const;
  `);
  await writeFixtureFile("src/registry.ts", `
    import { legacy } from "./legacy.js";
    export const LEGACY_PRODUCTION_ADAPTER_FAMILIES = Object.freeze([legacy]);
  `);
  await rm(resolve(fixtureRoot, "src/production/fixture.production.ts"));
  const legacy = await buildFamilyCapabilityShadowArtifact({
    rootDirectory: fixtureRoot,
    productionDirectory,
    productionRegistryFile: registryFile,
  });
  assert.equal(legacy.exact.length, 0);
  assert.equal(legacy.legacy.length, 1);
  assert.equal(legacy.legacy[0]?.precision, "legacy-whole-family");
  assert.equal(legacy.legacy[0]?.manualAdapterSchemaRevision, "legacy-v1");
  assert.equal(legacy.legacy[0]?.closureCompleteness, "family-source-only");
  assert(
    legacy.issues.some((item) =>
      item.code === "legacy_action_closure_incomplete"
    ),
  );
  assert.throws(
    () => generatedCapabilityManifestFromShadowArtifact({
      artifact: legacy,
      strictFamilyIds: [familyId("swap:legacy-fixture")],
    }),
    /shadow is incomplete/,
  );
  assert.throws(
    () => generatedCapabilityManifestFromShadowArtifact({
      artifact: {
        ...base,
        legacy: [{
          ...legacy.legacy[0]!,
          familyId: strictFamily,
        }],
      },
      strictFamilyIds: [strictFamily],
    }),
    /cannot be both capability-exact and legacy/,
  );

  const listenerRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
  const current = await buildFamilyCapabilityShadowArtifact({
    rootDirectory: listenerRoot,
  });
  assert.equal(current.exact.length, 22 * FAMILY_CAPABILITY_NAMES.length);
  assert.equal(current.legacy.length, 0);
  assert.equal(current.issues.length, 0);
  assert.equal(current.complete, true);
  const strictFamilyIds = [...new Set(
    current.exact.map((record) => record.identity.familyId),
  )].sort();
  assert.equal(strictFamilyIds.length, 22);
  const completeManifest = generatedCapabilityManifestFromShadowArtifact({
    artifact: current,
    strictFamilyIds,
  });
  assert.equal(
    completeManifest.entries.length,
    22 * FAMILY_CAPABILITY_NAMES.length,
  );

  console.log(
    "build-family-capability-manifest PASS " +
      "(static roots + exact promotion + fail-closed legacy shadow + current 22x10)",
  );
} finally {
  await rm(fixtureRoot, { recursive: true, force: true });
}

async function writeStrictProductionEntry(input?: {
  readonly sharedPricingExact?: boolean;
}): Promise<void> {
  const pricingImports = input?.sharedPricingExact
    ? `import { pricing, exact } from "../shared.js";`
    : `import { pricing } from "../pricing.js";\n` +
      `import { exact } from "../exact.js";`;
  await writeFixtureFile("src/production/fixture.production.ts", `
    import { defineSwapFamily } from "../framework.js";
    import { manifest } from "../manifest.js";
    import { discovery } from "../discovery.js";
    import { identity } from "../identity.js";
    import { instance } from "../instance.js";
    import { routes } from "../routes.js";
    ${pricingImports}
    import { execution } from "../execution.js";
    import { swap } from "../swap-domain.js";
    import { action } from "../action.js";
    export const plugin = defineSwapFamily({
      manifest,
      discovery,
      identity,
      instance,
      routes,
      pricing,
      exact,
      execution,
      swap,
      actionAdapters: [action],
    });
  `);
}

async function writeFundingProductionEntry(): Promise<void> {
  await writeFixtureFile("src/production/fixture.production.ts", `
    import { defineFundingFamily } from "../framework.js";
    import { manifest } from "../manifest.js";
    import { funding } from "../funding.js";
    import { action } from "../action.js";
    export const plugin = defineFundingFamily({
      manifest,
      funding,
      actionAdapters: [action],
    });
  `);
}

async function writeCreditProductionEntry(): Promise<void> {
  await writeFixtureFile("src/production/fixture.production.ts", `
    import { defineCreditFamily } from "../framework.js";
    import { manifest } from "../manifest.js";
    import { discovery } from "../discovery.js";
    import { identity } from "../identity.js";
    import { instance } from "../instance.js";
    import { routes } from "../routes.js";
    import { execution } from "../execution.js";
    import { credit } from "../credit.js";
    import { action } from "../action.js";
    export const plugin = defineCreditFamily({
      manifest,
      discovery,
      identity,
      instance,
      routes,
      execution,
      credit,
      actionAdapters: [action],
    });
  `);
}

async function writeFixtureFile(path: string, content: string): Promise<void> {
  const file = resolve(fixtureRoot, path);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, content);
}

async function verifyTrackedProductionSourceContract(): Promise<void> {
  const regularRoot = await trackedFixtureRoot("regular");
  try {
    const listenerRoot = resolve(regularRoot, "listener");
    const sourceDirectory = resolve(
      listenerRoot,
      "src/searcher/venues/production-families",
    );
    await writeFile(resolve(sourceDirectory, "tracked.production.ts"), "");
    await writeFile(resolve(sourceDirectory, "untracked.production.ts"), "");
    await git(regularRoot, [
      "add",
      "listener/src/searcher/venues/production-families/tracked.production.ts",
    ]);
    assert.deepEqual(
      await trackedProductionSourceFiles(listenerRoot),
      ["tracked.production.ts"],
      "untracked production files must not alter runtime or artifact discovery",
    );
  } finally {
    await rm(regularRoot, { recursive: true, force: true });
  }

  const missingRoot = await trackedFixtureRoot("missing");
  try {
    const listenerRoot = resolve(missingRoot, "listener");
    const sourceFile = resolve(
      listenerRoot,
      "src/searcher/venues/production-families/missing.production.ts",
    );
    await writeFile(sourceFile, "");
    await git(missingRoot, [
      "add",
      "listener/src/searcher/venues/production-families/missing.production.ts",
    ]);
    await rm(sourceFile);
    await assert.rejects(
      trackedProductionSourceFiles(listenerRoot),
      /ENOENT|no such file/i,
    );
  } finally {
    await rm(missingRoot, { recursive: true, force: true });
  }

  const symlinkRoot = await trackedFixtureRoot("symlink");
  try {
    const listenerRoot = resolve(symlinkRoot, "listener");
    const sourceDirectory = resolve(
      listenerRoot,
      "src/searcher/venues/production-families",
    );
    await writeFile(resolve(sourceDirectory, "target.ts"), "");
    await symlink("target.ts", resolve(sourceDirectory, "linked.production.ts"));
    await git(symlinkRoot, [
      "add",
      "listener/src/searcher/venues/production-families/linked.production.ts",
    ]);
    await assert.rejects(
      trackedProductionSourceFiles(listenerRoot),
      /must be a regular file/,
    );
  } finally {
    await rm(symlinkRoot, { recursive: true, force: true });
  }
}

async function trackedFixtureRoot(label: string): Promise<string> {
  const root = await mkdtemp(resolve(tmpdir(), `tracked-production-${label}-`));
  await mkdir(
    resolve(root, "listener/src/searcher/venues/production-families"),
    { recursive: true },
  );
  await git(root, ["init", "--quiet"]);
  return root;
}

async function git(cwd: string, args: readonly string[]): Promise<void> {
  await execFileAsync("git", [...args], { cwd });
}
