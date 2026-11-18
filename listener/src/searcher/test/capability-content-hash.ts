import { capabilityManifestHash, FAMILY_CAPABILITY_NAMES } from "../venues/family-capability-catalog.js";
import { hashCanonical } from "../venues/canonical-value.js";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { familyId } from "../venues/adapter-family-identifiers.js";
import {
  FAMILY_CAPABILITY_CONTRACT_VERSIONS,
  generateAbsentCapabilityIdentity,
  generateCapabilityClosure,
  generateCapabilityClosures,
  type GeneratedCapabilityClosure,
} from "../venues/capability-content-hash.js";

const root = await mkdtemp(resolve(tmpdir(), "family-capability-hash-"));
try {
  assert.equal(
    FAMILY_CAPABILITY_CONTRACT_VERSIONS.routes,
    "s1-routes-v2",
    "Graph projection is part of the routes capability contract",
  );
  assert.equal(
    FAMILY_CAPABILITY_CONTRACT_VERSIONS.exact,
    "s1-exact-v2",
    "sealed exact handles are part of the exact capability contract",
  );
  assert.equal(
    FAMILY_CAPABILITY_CONTRACT_VERSIONS.execution,
    "s1-execution-v2",
    "handle-only execution is part of the execution capability contract",
  );
  await writeFile(resolve(root, "package-lock.json"), JSON.stringify({
    packages: {
      "node_modules/example": {
        version: "1.2.3",
        integrity: "sha512-fixture",
      },
    },
  }));
  await writeFile(resolve(root, "shared.ts"), `
    // A comment and formatting are deliberately not semantic.
    export const SCALE = 7n;
  `);
  await writeFile(resolve(root, "types.ts"), `
    export interface LocalType { readonly value: bigint }
  `);
  await writeFile(resolve(root, "pricing.ts"), `
    import { SCALE } from "./shared.js";
    import { runtimeScale } from "example";
    import type { LocalType } from "./types.js";
    export function price(input: bigint): bigint {
      const checked: LocalType = { value: input };
      return checked.value * SCALE * BigInt(runtimeScale);
    }
  `);
  await writeFile(resolve(root, "exact.ts"), `
    import { SCALE } from "./shared.js";
    export const exact = (input: bigint) => input + SCALE;
  `);
  await writeFile(resolve(root, "manifest.ts"), `
    export const manifest = { familyId: "protocol:fixture" } as const;
  `);

  const base = await generateCapabilityClosure({
    familyId: familyId("protocol:fixture"),
    capability: "pricing",
    rootDirectory: root,
    entryFile: resolve(root, "pricing.ts"),
    additionalEntryFiles: [resolve(root, "manifest.ts")],
    provenanceCommit: "a".repeat(40),
  });
  assert.equal(base.identity.contractVersion, FAMILY_CAPABILITY_CONTRACT_VERSIONS.pricing);
  assert.equal(base.entryLogicalId, "pricing.ts");
  assert(base.identity.semanticDependencies.includes("shared.ts"));
  assert(base.identity.semanticDependencies.includes("manifest.ts"));
  assert(base.identity.semanticDependencies.includes("package:example@1.2.3"));
  assert(
    !base.identity.semanticDependencies.includes("types.ts"),
    "type-only local imports must not enter the runtime closure",
  );

  await writeFile(resolve(root, "pricing.ts"), `
import { SCALE } from './shared.js'
import { runtimeScale } from 'example'
import type { LocalType } from './types.js'

// Formatting-only rewrite.
export function price(input: bigint): bigint {
  const checked: LocalType = { value: input }
  return checked.value * SCALE * BigInt(runtimeScale)
}
  `);
  await writeFile(resolve(root, "types.ts"), `
    export interface CompletelyDifferentCompileTimeShape {
      readonly ignored: string;
    }
  `);
  const reformatted = await generateCapabilityClosure({
    familyId: familyId("protocol:fixture"),
    capability: "pricing",
    rootDirectory: root,
    entryFile: resolve(root, "pricing.ts"),
    additionalEntryFiles: [resolve(root, "manifest.ts")],
    provenanceCommit: "b".repeat(40),
  });
  assert.equal(
    reformatted.identity.contentHash,
    base.identity.contentHash,
    "format, comments, type-only source and provenance must not change contentHash",
  );

  const exactBefore = await generateCapabilityClosure({
    familyId: familyId("protocol:fixture"),
    capability: "exact",
    rootDirectory: root,
    entryFile: resolve(root, "exact.ts"),
    provenanceCommit: null,
  });
  await writeFile(resolve(root, "exact.ts"), `
    import { SCALE } from "./shared.js";
    export const exact = (input: bigint) => input + SCALE + 1n;
  `);
  const exactAfter = await generateCapabilityClosure({
    familyId: familyId("protocol:fixture"),
    capability: "exact",
    rootDirectory: root,
    entryFile: resolve(root, "exact.ts"),
    provenanceCommit: null,
  });
  const pricingAfterExactEdit = await generateCapabilityClosure({
    familyId: familyId("protocol:fixture"),
    capability: "pricing",
    rootDirectory: root,
    entryFile: resolve(root, "pricing.ts"),
    additionalEntryFiles: [resolve(root, "manifest.ts")],
    provenanceCommit: null,
  });
  assert.notEqual(exactAfter.identity.contentHash, exactBefore.identity.contentHash);
  assert.equal(
    pricingAfterExactEdit.identity.contentHash,
    base.identity.contentHash,
    "an exact-only entry edit must not invalidate pricing",
  );

  await writeFile(resolve(root, "action.ts"), `
    export const action = { encode: () => new Uint8Array([1]) };
  `);
  await writeFile(resolve(root, "execution.ts"), `
    export const execution = { buildFragment: () => [] };
  `);
  const executionBefore = await generateCapabilityClosure({
    familyId: familyId("protocol:fixture"),
    capability: "execution",
    rootDirectory: root,
    entryFile: resolve(root, "execution.ts"),
    additionalEntryFiles: [resolve(root, "action.ts")],
    provenanceCommit: null,
  });
  assert(
    executionBefore.identity.semanticDependencies.some((item) =>
      item.startsWith("contract:action-adapter@")
    ),
  );
  await writeFile(resolve(root, "action.ts"), `
    export const action = { encode: () => new Uint8Array([2]) };
  `);
  const executionAfter = await generateCapabilityClosure({
    familyId: familyId("protocol:fixture"),
    capability: "execution",
    rootDirectory: root,
    entryFile: resolve(root, "execution.ts"),
    additionalEntryFiles: [resolve(root, "action.ts")],
    provenanceCommit: null,
  });
  assert.notEqual(
    executionAfter.identity.contentHash,
    executionBefore.identity.contentHash,
    "owned ActionAdapter runtime code must invalidate execution",
  );

  const absentA = generateAbsentCapabilityIdentity({
    familyId: familyId("protocol:fixture"),
    capability: "victim",
    provenanceCommit: "a".repeat(40),
  });
  const absentB = generateAbsentCapabilityIdentity({
    familyId: familyId("protocol:fixture"),
    capability: "victim",
    provenanceCommit: "b".repeat(40),
  });
  assert.equal(absentA.contentHash, absentB.contentHash);
  assert(absentA.semanticDependencies[0]?.startsWith("contract:adapter-family/victim@"));

  // Catalog identity uses code-unit order. Locale order differs for node:fs
  // and node:fs/promises; preserve the existing closure hash projection.
  await writeFile(resolve(root, "builtin-order.ts"), `
    import { readFileSync } from "node:fs";
    import { readFile } from "node:fs/promises";
    export const reads = [readFileSync, readFile];
  `);
  const builtinOrder = await generateCapabilityClosure({
    familyId: familyId("protocol:fixture"), capability: "pricing", rootDirectory: root,
    entryFile: resolve(root, "builtin-order.ts"), provenanceCommit: null,
  });
  assert.deepEqual(builtinOrder.identity.semanticDependencies,
    [...new Set(builtinOrder.identity.semanticDependencies)].sort());
  assert.doesNotThrow(() => capabilityManifestHash([builtinOrder.identity]));
  assert.equal(builtinOrder.identity.contentHash, hashCanonical({
    contractVersion: builtinOrder.identity.contractVersion,
    entry: builtinOrder.entryContentHash,
    dependencies: builtinOrder.dependencyArtifacts.map(artifact => [artifact.logicalId, artifact.contentHash]),
  }), "identity ordering must not alter the closure content hash algorithm");

  // Declarative Families share one runtime closure across present capabilities.
  // Their contract identities remain distinct, and reuse never spans calls.
  const optionalDirectory = resolve(root, "src/searcher/venues");
  await mkdir(optionalDirectory, { recursive: true });
  const optionalFile = resolve(optionalDirectory, "declarative-trial-state.ts");
  const optionalDependency = resolve(optionalDirectory, "optional-dependency.ts");
  await writeFile(optionalDependency, "export const value = 1n;\n");
  await writeFile(optionalFile, `
    import { value } from "./optional-dependency.js";
    export function optional(): bigint { return value; }
  `);
  await writeFile(resolve(root, "batch.ts"), `
    import { optional } from "./src/searcher/venues/declarative-trial-state.js";
    import { runtimeScale } from "example";
    export const run = () => optional() * BigInt(runtimeScale);
  `);
  const batchJson = resolve(root, "batch.json");
  await writeFile(batchJson, JSON.stringify({ value: "1" }));
  const batchInput = {
    familyId: familyId("protocol:fixture"), capabilities: FAMILY_CAPABILITY_NAMES,
    rootDirectory: root, entryFile: resolve(root, "batch.ts"),
    additionalEntryFiles: [batchJson], provenanceCommit: null,
  };
  const initialBatch = await generateCapabilityClosures(batchInput);
  assert.equal(initialBatch.length, FAMILY_CAPABILITY_NAMES.length);
  assert.equal(Object.isFrozen(initialBatch), true);
  for (const [index, capability] of FAMILY_CAPABILITY_NAMES.entries()) {
    assert.deepEqual(initialBatch[index], await generateCapabilityClosure({ ...batchInput, capability }),
      `batch ${capability} must preserve the complete single-capability receipt`);
  }
  assert.equal(new Set(initialBatch.map(item => item.identity.contentHash)).size, FAMILY_CAPABILITY_NAMES.length,
    "shared runtime roots must retain per-capability contracts");
  for (const item of initialBatch) {
    assert.equal(item.identity.semanticDependencies.some(id => id.startsWith("contract:action-adapter@")),
      item.identity.capability === "execution", "the execution contract must not leak into another capability");
  }
  const assertAllChanged = (before: readonly GeneratedCapabilityClosure[], after: readonly GeneratedCapabilityClosure[], message: string) => {
    assert.equal(after.length, before.length);
    after.forEach((item, index) => assert.notEqual(item.identity.contentHash, before[index]!.identity.contentHash,
      `${message}: ${item.identity.capability}`));
  };
  await writeFile(batchJson, JSON.stringify({ value: "2" }));
  const changedJson = await generateCapabilityClosures(batchInput);
  assertAllChanged(initialBatch, changedJson, "a later batch must reread owned JSON");
  const withoutAdditional = await generateCapabilityClosures({ ...batchInput, additionalEntryFiles: [] });
  assertAllChanged(changedJson, withoutAdditional, "additional roots must remain part of the closure");
  const changedEntry = await generateCapabilityClosures({ ...batchInput, entryFile: resolve(root, "shared.ts") });
  assertAllChanged(changedJson, changedEntry, "entry roots must not share a cached receipt");

  const inactiveInput = { ...batchInput, inactiveRuntimeModules: ["declarative-trial-state.ts"] };
  const dormantBatch = await generateCapabilityClosures(inactiveInput);
  assertAllChanged(changedJson, dormantBatch, "inactive module policy must remain part of source normalization");
  await writeFile(optionalFile, `
    import { value } from "./optional-dependency.js";
    export function optional(): bigint { return value + 1n; }
  `);
  assert.deepEqual(await generateCapabilityClosures(inactiveInput), dormantBatch,
    "dormant function-body edits must preserve the existing sentinel hash");
  assertAllChanged(changedJson, await generateCapabilityClosures(batchInput),
    "a later active batch must reread the changed module source");
  await writeFile(optionalDependency, "export const value = 2n;\n");
  const changedDependency = await generateCapabilityClosures(inactiveInput);
  assertAllChanged(dormantBatch, changedDependency, "dormant modules must still traverse actual runtime imports");
  await writeFile(optionalFile, `
    import { value } from "./optional-dependency.js";
    export const topLevel = Number("1");
    export function optional(): bigint { return value; }
  `);
  const unsafeDormant = await generateCapabilityClosures(inactiveInput);
  assertAllChanged(changedDependency, unsafeDormant, "top-level execution must restore full module hashing");
  assert.deepEqual(unsafeDormant, await generateCapabilityClosures(batchInput),
    "an inactive module with top-level execution must hash exactly like an active module");
  await writeFile(resolve(root, "package-lock.json"), JSON.stringify({ packages: {
    "node_modules/example": { version: "1.2.4", integrity: "sha512-changed-fixture" },
  } }));
  assertAllChanged(unsafeDormant, await generateCapabilityClosures(inactiveInput),
    "a later batch must reread external dependency metadata");

  await writeFile(resolve(root, "bad.test.ts"), "export const BAD = true;\n");
  await writeFile(
    resolve(root, "bad.ts"),
    "export { BAD } from './bad.test.js';\n",
  );
  await assert.rejects(
    generateCapabilityClosure({
      familyId: familyId("protocol:fixture"),
      capability: "identity",
      rootDirectory: root,
      entryFile: resolve(root, "bad.ts"),
      provenanceCommit: null,
    }),
    /imports non-semantic source/,
  );
  await assert.rejects(generateCapabilityClosures({ ...batchInput, entryFile: resolve(root, "bad.ts") }),
    /imports non-semantic source/, "a failed shared closure must reject the entire batch");
  await assert.rejects(generateCapabilityClosures({ ...batchInput, provenanceCommit: "invalid" }),
    /provenance/, "batching must retain provenance validation");

  console.log(
    "capability-content-hash PASS " +
      "(runtime JS closure + type/format isolation + action/contract binding + fresh batch reuse)",
  );
} finally {
  await rm(root, { recursive: true, force: true });
}
