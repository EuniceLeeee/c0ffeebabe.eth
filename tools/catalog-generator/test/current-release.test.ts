import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { hashDomain } from "../../../packages/canonical-codec/src/index.ts";
import {
  sealReleaseQualifiedCapabilitySetV1,
  type ReleaseQualifiedCapabilityRefV1,
} from "../../../specs/capability-index/src/index.ts";
import {
  currentCatalogCapabilityProposalSpecs,
  currentCatalogCompilerEntrypointSpecs,
  currentCatalogInput,
  currentReleaseFamilyDecisions,
  initializeCurrentCatalogImpactGenesis,
  readCurrentCatalogInput,
  selectCatalogCompilerClosureCandidates,
} from "../src/current-release.ts";
import { assertCatalogCompilerAuthorityExact } from "../src/compiler-authority.ts";
import { assertCurrentCatalogImpactObservationExactV1 } from "../src/current-impact-analysis-owner.ts";
import { assertStaticEntrypoint, generateCatalog } from "../src/index.ts";
import {
  catalogImpactGenesisPriorV1,
  decodeCatalogImpactSnapshotV1,
  sealCatalogImpactPriorV1,
} from "../src/impact-receipt.ts";

const repositoryRoot = resolve(new URL("../../..", import.meta.url).pathname);

function reviewedProposedSet() {
  const available = readCurrentCatalogInput(repositoryRoot).proposedCapabilitySet.refs;
  const refs = currentCatalogCapabilityProposalSpecs().map(spec => {
    const ref = available.find(candidate => candidate.capabilityId === spec.capabilityId && candidate.version === spec.version);
    assert.ok(ref, `missing proposed capability ${spec.capabilityId}`);
    return ref;
  });
  return sealReleaseQualifiedCapabilitySetV1(refs);
}

function releaseInput() {
  return currentCatalogInput(repositoryRoot, reviewedProposedSet());
}

function proposedRefs(): readonly ReleaseQualifiedCapabilityRefV1[] {
  return releaseInput().proposedCapabilityRefs.map(ref => Object.freeze({
    capabilityId: ref.capabilityId,
    version: ref.version,
    schemaHash: ref.schemaHash,
    interpreterHash: ref.interpreterHash,
    ownerRef: ref.ownerRef,
  }));
}

test("current first-release input requires exact genesis and rejects a self-advanced current snapshot", () => {
  const root = mkdtempSync(join(tmpdir(), "aloha-current-impact-prior-"));
  try {
    const generated = join(root, "generated");
    mkdirSync(generated, { recursive: true });
    const source = JSON.parse(readFileSync(join(repositoryRoot, "generated", "catalog-generation.inputs.json"), "utf8")) as Record<string, unknown>;
    const preImpact = { compilerClosures: source.compilerClosures, proposedCapabilitySet: source.proposedCapabilitySet };
    const inputPath = join(generated, "catalog-generation.inputs.json");
    writeFileSync(inputPath, `${JSON.stringify(preImpact, null, 2)}\n`);
    assert.throws(() => readCurrentCatalogInput(root), /exact fields|priorCatalogImpact/);

    const genesis = initializeCurrentCatalogImpactGenesis(root);
    assert.deepEqual(genesis, catalogImpactGenesisPriorV1());
    assert.deepEqual(readCurrentCatalogInput(root).priorCatalogImpact, genesis);
    assert.throws(() => initializeCurrentCatalogImpactGenesis(root), /exact pre-impact/);

    const forged = JSON.parse(readFileSync(inputPath, "utf8")) as Record<string, unknown>;
    forged.priorCatalogImpact = { ...(forged.priorCatalogImpact as object), pinnedSnapshotRoot: hashDomain("test/forged-prior", "pin") };
    writeFileSync(inputPath, `${JSON.stringify(forged, null, 2)}\n`);
    assert.throws(() => readCurrentCatalogInput(root), /prior pin mismatch/);

    const currentSnapshot = decodeCatalogImpactSnapshotV1(JSON.parse(readFileSync(
      join(repositoryRoot, "generated", "catalog-impact.snapshot.json"),
      "utf8",
    )) as object);
    const advanced = sealCatalogImpactPriorV1("aloha.catalog-impact-advance/v1", currentSnapshot);
    assert.equal(advanced.origin, "aloha.catalog-impact-advance/v1");
    assert.equal(advanced.pinnedSnapshotRoot, currentSnapshot.snapshotRoot);
    writeFileSync(inputPath, `${JSON.stringify({ ...preImpact, priorCatalogImpact: advanced }, null, 2)}\n`);
    assert.throws(() => readCurrentCatalogInput(root), /exact greenfield genesis/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("current CLI exposes only the impact-aware generate/check path", () => {
  const cliPath = resolve(repositoryRoot, "tools/catalog-generator/src/cli.ts");
  const source = readFileSync(cliPath, "utf8");
  assert.match(source, /generateCatalogWithImpact/);
  assert.match(source, /verifyCurrentCatalogGeneration/);
  assert.match(source, /encodeCanonicalJson/);
  assert.match(source, /--initialize-impact-genesis/);
  assert.doesNotMatch(source, /--advance-impact-prior/);
  assert.doesNotMatch(source, /\bgenerateCatalog\(/);
  assert.doesNotMatch(source, /\bcheckGeneratedCatalog\(/);
  assert.doesNotMatch(source, /catalog-generator: exact/);
  const removedAdvance = spawnSync(process.execPath, ["--experimental-strip-types", cliPath, "--advance-impact-prior"], {
    encoding: "utf8",
  });
  assert.notEqual(removedAdvance.status, 0);
  assert.match(removedAdvance.stderr, /usage: generate-catalog/);
});

test("persisted compiler facts and owner proposal cannot be jointly forged away from the fresh boundary observation", () => {
  const current = readCurrentCatalogInput(repositoryRoot);
  assert.doesNotThrow(() => assertCatalogCompilerAuthorityExact(current, current));
  const [first, ...rest] = current.compilerClosures;
  assert.ok(first);
  assert.throws(() => assertCatalogCompilerAuthorityExact({
    compilerClosures: [{ ...first, closureDigest: hashDomain("aloha/test/catalog-compiler-authority/v1", "changed") }, ...rest],
    proposedCapabilitySet: current.proposedCapabilitySet,
  }, current), /not match/);
  const firstRef = current.proposedCapabilitySet.refs[0];
  assert.ok(firstRef);
  assert.throws(() => assertCatalogCompilerAuthorityExact({
    compilerClosures: [{ ...first, closureDigest: hashDomain("aloha/test/catalog-compiler-authority/v1", "jointly-forged") }, ...rest],
    proposedCapabilitySet: sealReleaseQualifiedCapabilitySetV1([
      { ...firstRef, ownerRef: hashDomain("aloha/test/catalog-capability-authority/v1", "changed") },
      ...current.proposedCapabilitySet.refs.slice(1),
    ]),
  }, current), /not match/);
});

test("current impact owner rejects every verify-then-regenerate identity change before issuance", () => {
  const exact = Object.freeze({
    semanticLedgerHash: hashDomain("aloha/test/current-impact-owner/v1", "ledger"),
    semanticOutputRoot: hashDomain("aloha/test/current-impact-owner/v1", "output"),
    proposedCapabilitySetRoot: hashDomain("aloha/test/current-impact-owner/v1", "capabilities"),
    impactSnapshotRoot: hashDomain("aloha/test/current-impact-owner/v1", "snapshot"),
    impactReceiptRoot: hashDomain("aloha/test/current-impact-owner/v1", "receipt"),
  });
  assert.doesNotThrow(() => assertCurrentCatalogImpactObservationExactV1(exact, exact));
  for (const field of Object.keys(exact) as readonly (keyof typeof exact)[]) {
    assert.throws(
      () => assertCurrentCatalogImpactObservationExactV1(exact, {
        ...exact,
        [field]: hashDomain("aloha/test/current-impact-owner/mutation/v1", field),
      }),
      /verified regeneration changed before owner issuance/,
      field,
    );
  }
});

test("current release derives one exact capability set from the reviewed Family BOM", () => {
  const input = releaseInput();
  const declared = input.families.flatMap(family => Object.values(family.definition.extensions).flatMap(slot =>
    slot.kind === "present" ? [`${slot.module.capabilityId}\u001f${slot.module.version}`] : [],
  )).sort();
  const indexed = input.capabilityIndex.entries.map(entry => `${entry.capabilityId}\u001f${entry.version}`).sort();
  const proposed = input.proposedCapabilityRefs.map(ref => `${ref.capabilityId}\u001f${ref.version}`).sort();
  assert.deepEqual(indexed, declared);
  assert.deepEqual(proposed, declared);
  assert.deepEqual(input.releaseIntent.families.map(entry => entry.familyId), input.families.map(family => family.definition.manifest.familyId));
  assert.deepEqual(input.releaseIntent.strategies.map(entry => entry.strategyId), ["route-cycle"]);
  assert.deepEqual(input.strategies.map(strategy => strategy.definition.strategyId), ["route-cycle"]);
});

test("current release BOM contains no LP authoring asset", () => {
  const identities = [
    ...currentReleaseFamilyDecisions().filter(entry => entry.decision === "include").map(entry => entry.familyId),
    ...currentCatalogCapabilityProposalSpecs().flatMap(spec => [spec.capabilityId, spec.modulePath, spec.exportName]),
    ...currentCatalogCompilerEntrypointSpecs().flatMap(spec => [spec.modulePath, spec.exportName]),
  ];
  const lpIdentity = /(?:^|[./_-])(?:lp|liquidity)(?:$|[./_-])/i;
  const assertLpZero = (values: readonly string[]): void => {
    assert.deepEqual(values.filter(value => lpIdentity.test(value)), []);
  };

  assert.doesNotThrow(() => assertLpZero(identities));
  assert.throws(() => assertLpZero([...identities, "family.lp.position"]));
});

test("current release records exclusions without importing them into the production BOM", () => {
  const decisions = currentReleaseFamilyDecisions();
  assert.deepEqual(decisions.map(item => item.familyId), [
    "angstrom-v4",
    "astra-multitoken",
    "balancer-flash",
    "curve-underlying",
    "dodo-v2",
    "eigenpie",
    "erc4626",
    "erc4626-silo-redeem",
    "ethertoken-native-redeem",
    "fluid-credit",
    "fluid-dex",
    "goldx",
    "metronome-hgusdc",
    "metronome-synth",
    "morpho-flash",
    "psm",
    "rocksolid",
    "self-burn-native",
    "univ2-standard",
    "univ3-standard",
    "univ4",
    "wsteth",
  ]);
  assert.deepEqual(decisions.filter(item => item.decision === "include").map(item => item.familyId), [
    "curve-underlying",
    "dodo-v2",
    "fluid-dex",
    "univ2-standard",
  ]);
  assert.deepEqual(releaseInput().families.map(item => item.definition.manifest.familyId), [
    "curve-underlying",
    "dodo-v2",
    "fluid-dex",
    "univ2-standard",
  ]);
  for (const item of decisions.filter(candidate => candidate.decision === "include")) assert.deepEqual(item.exclusionReasons, []);
  for (const item of decisions.filter(candidate => candidate.decision === "exclude")) assert.ok(item.exclusionReasons.length > 0);
  for (const familyId of ["erc4626", "metronome-hgusdc", "metronome-synth"]) {
    assert.ok(decisions.find(item => item.familyId === familyId)?.exclusionReasons.includes("exact-capability-absent"));
  }
  for (const familyId of ["erc4626-silo-redeem", "ethertoken-native-redeem"]) {
    assert.ok(decisions.find(item => item.familyId === familyId)?.exclusionReasons.includes("exact-effect-observation-absent"));
    assert.ok(decisions.find(item => item.familyId === familyId)?.exclusionReasons.includes("execution-program-blocked"));
  }
  for (const familyId of ["astra-multitoken", "eigenpie"]) {
    assert.ok(decisions.find(item => item.familyId === familyId)?.exclusionReasons.includes("exact-effect-observation-absent"));
    assert.ok(decisions.find(item => item.familyId === familyId)?.exclusionReasons.includes("final-simulation-blocked"));
  }
  for (const familyId of ["balancer-flash", "morpho-flash"]) {
    assert.ok(decisions.find(item => item.familyId === familyId)?.exclusionReasons.includes("qualified-funding-authority-absent"));
  }
  for (const familyId of ["angstrom-v4", "univ3-standard", "univ4"]) {
    assert.ok(decisions.find(item => item.familyId === familyId)?.exclusionReasons.includes("execution-program-blocked"));
    assert.ok(decisions.find(item => item.familyId === familyId)?.exclusionReasons.includes("final-simulation-blocked"));
  }
  assert.ok(decisions.find(item => item.familyId === "fluid-credit")?.exclusionReasons.includes("qualified-credit-authority-absent"));
});

test("a self-consistent proposed set with changed semantics or an extra capability fails closed", () => {
  const refs = proposedRefs();
  const first = refs[0];
  assert.ok(first);
  const changed = sealReleaseQualifiedCapabilitySetV1(refs.map((ref, index) => index === 0
    ? { ...ref, schemaHash: hashDomain("aloha/test/current-release/schema-mutation/v1", ref.capabilityId) }
    : ref));
  assert.throws(() => currentCatalogInput(repositoryRoot, changed), /binding mismatch/);

  const extra = sealReleaseQualifiedCapabilitySetV1([...refs, {
    capabilityId: "family.unrelated.future",
    version: "1.0.0",
    schemaHash: hashDomain("aloha/test/current-release/extra/v1", "schema"),
    interpreterHash: hashDomain("aloha/test/current-release/extra/v1", "interpreter"),
    ownerRef: hashDomain("aloha/test/current-release/extra/v1", "owner"),
  }]);
  assert.throws(() => currentCatalogInput(repositoryRoot, extra), /does not equal/);
});

test("compiler entrypoint BOM is derived from every included public definition and SourcePlan runtime", () => {
  const specs = currentCatalogCompilerEntrypointSpecs();
  const keys = specs.map(spec => `${spec.modulePath}#${spec.exportName}`);
  assert.equal(new Set(keys).size, keys.length);
  assert.ok(keys.includes("families/curve-underlying/src/public.ts#CURVE_UNDERLYING_DEFINITION"));
  assert.ok(keys.includes("families/dodo-v2/src/public.ts#DODO_V2_DEFINITION"));
  assert.ok(keys.includes("families/dodo-v2/src/history-source-plan.ts#DODO_V2_HISTORY_SOURCE_PLAN_RUNTIME"));
  assert.ok(keys.includes("families/dodo-v2/src/history-source-plan.ts#DODO_V2_HISTORY_NOMINATION_PROGRAM"));
  assert.ok(keys.includes("families/fluid-dex/src/public.ts#FLUID_DEX_DEFINITION"));
  assert.ok(keys.includes("families/univ2-standard/src/stages/nomination.ts#UNIV2_STANDARD_SOURCE_PLAN_RUNTIME"));
  assert.ok(keys.includes("strategies/route-cycle/src/index.ts#ROUTE_CYCLE_STRATEGY"));
  assert.ok(keys.includes("strategies/route-cycle/src/index.ts#ROUTE_CYCLE_PLANNING_PROBLEM_ISSUER"));
  assert.ok(keys.includes("valuation-owners/native-equivalent/src/runtime.ts#createNativeEquivalentValuationOwnerV1"));
  assert.ok(keys.includes("valuation-owners/native-equivalent/src/qualification.ts#NATIVE_EQUIVALENT_VALUATION_QUALIFICATION_SPEC_V1"));
  assert.ok(keys.includes("valuation-owners/native-equivalent/src/qualification.ts#NATIVE_EQUIVALENT_VALUATION_MUTATION_CORPUS_V1"));
  assert.ok(keys.includes("valuation-owners/native-equivalent/src/qualification.ts#NATIVE_EQUIVALENT_VALUATION_INDEPENDENT_ORACLE_CASES_V1"));
  assert.ok(keys.includes("tools/catalog-generator/src/index.ts#generateCatalogWithImpact"));
  for (const excluded of currentReleaseFamilyDecisions().filter(item => item.decision === "exclude")) {
    assert.equal(specs.some(spec => spec.modulePath.startsWith(`families/${excluded.familyId}/`)), false);
  }
  assert.equal(specs.find(spec => spec.exportName === "UNIV2_STANDARD_DEFINITION")?.preferredKind, "package-entrypoint");
  assert.equal(specs.find(spec => spec.exportName === "UNIV2_STANDARD_SOURCE_PLAN_RUNTIME")?.preferredKind, "compiler-root");
  assert.equal(specs.find(spec => spec.exportName === "ROUTE_CYCLE_STRATEGY")?.preferredKind, "package-entrypoint");
  assert.equal(specs.find(spec => spec.exportName === "ROUTE_CYCLE_PLANNING_PROBLEM_ISSUER")?.preferredKind, "compiler-root");
});

test("execution-incomplete Families are absent from the release compiler import closure", () => {
  const source = readFileSync(resolve(repositoryRoot, "tools/catalog-generator/src/current-release.ts"), "utf8");
  for (const familyId of ["angstrom-v4", "univ3-standard", "univ4"]) {
    assert.doesNotMatch(source, new RegExp(`from [^\\n]*families/${familyId}/`));
  }
});

test("every current release compiler entrypoint directly exports its declared symbol", () => {
  for (const spec of currentCatalogCompilerEntrypointSpecs()) {
    assert.equal(assertStaticEntrypoint(repositoryRoot, spec), spec.modulePath);
  }
});

test("package entrypoint binding is stable when consumer contexts add duplicate closures", () => {
  const spec = currentCatalogCompilerEntrypointSpecs().find(entry => entry.exportName === "UNIV2_STANDARD_DEFINITION");
  assert.ok(spec);
  const packageOwned = {
    entrypoint: spec.modulePath,
    entrypointId: "package-entrypoint:families/univ2-standard:families/univ2-standard/tsconfig.json",
    kind: "package-entrypoint" as const,
    configPath: "families/univ2-standard/tsconfig.json",
    packageManifestPath: "families/univ2-standard/package.json",
  };
  const consumer = {
    ...packageOwned,
    entrypointId: "package-entrypoint:consumer/tsconfig.json",
    configPath: "apps/searcher-runtime/tsconfig.json",
  };
  const reordered = selectCatalogCompilerClosureCandidates([consumer, packageOwned], spec);
  const reversed = selectCatalogCompilerClosureCandidates([packageOwned, consumer], spec);
  assert.deepEqual(reordered, [packageOwned]);
  assert.deepEqual(reversed, [packageOwned]);
});

test("compiler-root selection remains exact and does not guess among duplicate roots", () => {
  const spec = currentCatalogCompilerEntrypointSpecs().find(entry => entry.exportName === "generateCatalogWithImpact");
  assert.ok(spec);
  const root = {
    entrypoint: spec.modulePath,
    entrypointId: "compiler-root:tools/catalog-generator/tsconfig.json:tools/catalog-generator/src/index.ts",
    kind: "compiler-root" as const,
    configPath: "tools/catalog-generator/tsconfig.json",
    packageManifestPath: null,
  };
  const consumer = { ...root, entrypointId: "compiler-root:consumer/tsconfig.json:tools/catalog-generator/src/index.ts", configPath: "apps/searcher-runtime/tsconfig.json" };
  assert.deepEqual(selectCatalogCompilerClosureCandidates([consumer, root], spec), [consumer, root]);
});

test("a compiler input without the SourcePlan fact is rejected by fresh generation", () => {
  const input = releaseInput();
  const stale = {
    ...input,
    compilerClosures: input.compilerClosures.filter(fact =>
      !(fact.modulePath === "families/univ2-standard/src/stages/nomination.ts" && fact.exportName === "UNIV2_STANDARD_SOURCE_PLAN_RUNTIME"),
    ),
  };
  assert.throws(() => generateCatalog(stale), /qualified catalog compiler closure missing/);
});
