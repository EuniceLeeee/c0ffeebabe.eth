import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { familyId } from "../venues/adapter-family-identifiers.js";
import {
  FAMILY_CAPABILITY_CONTRACT_VERSIONS,
  generateAbsentCapabilityIdentity,
  generateCapabilityClosure,
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

  console.log(
    "capability-content-hash PASS " +
      "(runtime JS closure + type/format isolation + action/contract binding)",
  );
} finally {
  await rm(root, { recursive: true, force: true });
}
