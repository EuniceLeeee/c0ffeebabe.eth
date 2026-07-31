import assert from "node:assert/strict";
import test from "node:test";
import type {
  FamilyOwnershipManifest,
  FamilyOwnershipManifestEntry,
} from "../../../listener/src/searcher/test/family-ownership-manifest.js";
import {
  evaluateAdapterFamilyBoundary,
} from "../adapter-family-boundary.js";

const REGISTRY = "listener/src/searcher/venues/production-registry.ts";
const ACTION_INDEX = "listener/src/adapters/index.ts";

test("family boundary accepts one manifest-owned family plus thin registration", () => {
  const base = manifest([family("swap:a", ["src/searcher/venues/swaps/a.ts"])]);
  const candidate = manifest([
    family("swap:a", ["src/searcher/venues/swaps/a.ts"]),
    family("swap:beta", [
      "src/adapters/beta.ts",
      "src/searcher/venues/swaps/beta.ts",
    ]),
  ]);
  const source = sources({
    [`base:${REGISTRY}`]: registry(["a"]),
    [`candidate:${REGISTRY}`]: registry(["a", "beta"]),
    [`base:${ACTION_INDEX}`]: actions(["aAction"]),
    [`candidate:${ACTION_INDEX}`]: actions(["aAction", "betaAction"]),
    "base:listener/src/searcher/venues/swaps/a.ts": "export const a = 1;",
    "candidate:listener/src/searcher/venues/swaps/a.ts": "export const a = 1;",
    "candidate:listener/src/searcher/venues/swaps/beta.ts": "export const beta = 1;",
    "candidate:listener/src/adapters/beta.ts": "export const betaAction = 1;",
  });
  const result = evaluateAdapterFamilyBoundary({
    baseCommit: "base",
    candidateCommit: "candidate",
    changedPaths: [
      REGISTRY,
      ACTION_INDEX,
      "listener/src/searcher/venues/swaps/beta.ts",
      "listener/src/adapters/beta.ts",
      "listener/src/searcher/test/beta.ts",
      "docs/research/beta.md",
    ],
    baseManifest: base,
    candidateManifest: candidate,
    sourceAt: source,
  });
  assert.equal(result.classification, "family_local", result.reasons.join("; "));
  assert.deepEqual(result.impactedFamilyIds, ["swap:beta"]);
  assert.deepEqual(result.reasons, []);
});

test("family boundary rejects repo code/config outside the family closure", () => {
  const familyA = family("swap:alpha", [
    "src/searcher/venues/swaps/alpha.ts",
  ]);
  const source = sources({
    "base:listener/src/searcher/venues/swaps/alpha.ts": "alpha",
    "candidate:listener/src/searcher/venues/swaps/alpha.ts": "alpha2",
    "candidate:analysis/src/cli/alpha-shortcut.ts": "alpha",
    "candidate:listener/package.json": "{\"alpha\":true}",
  });
  const result = evaluateAdapterFamilyBoundary({
    baseCommit: "base",
    candidateCommit: "candidate",
    changedPaths: [
      "listener/src/searcher/venues/swaps/alpha.ts",
      "analysis/src/cli/alpha-shortcut.ts",
      "listener/package.json",
    ],
    baseManifest: manifest([familyA]),
    candidateManifest: manifest([familyA]),
    sourceAt: source,
  });
  assert.equal(result.classification, "framework");
  assert.match(
    result.reasons.join("\n"),
    /outside the family boundary: analysis\/src\/cli\/alpha-shortcut\.ts/,
  );
  assert.match(
    result.reasons.join("\n"),
    /outside the family boundary: listener\/package\.json/,
  );
});

test("family boundary fails closed on a manifest-owned missing source", () => {
  const families = manifest([
    family("swap:alpha", ["src/searcher/venues/swaps/alpha.ts"]),
    family("swap:beta", ["src/searcher/venues/swaps/beta.ts"]),
  ]);
  const result = evaluateAdapterFamilyBoundary({
    baseCommit: "base",
    candidateCommit: "candidate",
    changedPaths: ["listener/src/searcher/venues/swaps/alpha.ts"],
    baseManifest: families,
    candidateManifest: families,
    sourceAt: sources({
      "base:listener/src/searcher/venues/swaps/alpha.ts": "alpha",
      "candidate:listener/src/searcher/venues/swaps/alpha.ts": "alpha2",
      "candidate:listener/src/searcher/venues/swaps/beta.ts": "beta",
    }),
  });
  assert.equal(result.classification, "framework");
  assert.match(
    result.reasons.join("\n"),
    /manifest-owned source missing at baseline.*beta\.ts/,
  );
});

test("family boundary rejects a central behavior edit", () => {
  const familyA = family("swap:a", ["src/searcher/venues/swaps/a.ts"]);
  const result = evaluateAdapterFamilyBoundary({
    baseCommit: "base",
    candidateCommit: "candidate",
    changedPaths: [REGISTRY, "listener/src/searcher/venues/swaps/a.ts"],
    baseManifest: manifest([familyA]),
    candidateManifest: manifest([familyA]),
    sourceAt: sources({
      [`base:${REGISTRY}`]: registry(["a"]),
      [`candidate:${REGISTRY}`]:
        `${registry(["a"])}\nexport const centralPolicy = false;`,
      "base:listener/src/searcher/venues/swaps/a.ts": "export const a = 1;",
      "candidate:listener/src/searcher/venues/swaps/a.ts": "export const a = 2;",
    }),
  });
  assert.equal(result.classification, "framework");
  assert.match(result.reasons.join("\n"), /central registration behavior/);
});

test("family boundary rejects unowned and shared runtime paths", () => {
  const shared = "src/searcher/venues/swaps/shared.ts";
  const families = manifest([
    family("swap:a", ["src/searcher/venues/swaps/a.ts", shared]),
    family("swap:b", ["src/searcher/venues/swaps/b.ts", shared]),
  ]);
  const source = sources({
    "base:listener/src/searcher/venues/swaps/a.ts": "a",
    "candidate:listener/src/searcher/venues/swaps/a.ts": "a",
    "base:listener/src/searcher/venues/swaps/b.ts": "b",
    "candidate:listener/src/searcher/venues/swaps/b.ts": "b",
    "base:listener/src/searcher/venues/swaps/shared.ts": "shared-a",
    "candidate:listener/src/searcher/venues/swaps/shared.ts": "shared-b",
  });
  const sharedResult = evaluateAdapterFamilyBoundary({
    baseCommit: "base",
    candidateCommit: "candidate",
    changedPaths: ["listener/src/searcher/venues/swaps/shared.ts"],
    baseManifest: families,
    candidateManifest: families,
    sourceAt: source,
  });
  assert.equal(sharedResult.classification, "framework");
  assert.match(sharedResult.reasons.join("\n"), /shared family runtime/);

  const centralResult = evaluateAdapterFamilyBoundary({
    baseCommit: "base",
    candidateCommit: "candidate",
    changedPaths: ["listener/src/searcher/planner/planner.ts"],
    baseManifest: families,
    candidateManifest: families,
    sourceAt: source,
  });
  assert.equal(centralResult.classification, "framework");
  assert.match(centralResult.reasons.join("\n"), /no family owner/);
});

test("family boundary rejects existing-family registry reorder", () => {
  const familyA = family("swap:a", ["src/searcher/venues/swaps/a.ts"]);
  const familyB = family("swap:b", ["src/searcher/venues/swaps/b.ts"]);
  const base = manifest([familyA, familyB]);
  const candidate = {
    ...manifest([familyA, familyB]),
    registry_order: ["swap:b", "swap:a"],
  };
  const result = evaluateAdapterFamilyBoundary({
    baseCommit: "base",
    candidateCommit: "candidate",
    changedPaths: [REGISTRY, "listener/src/searcher/venues/swaps/a.ts"],
    baseManifest: base,
    candidateManifest: candidate,
    sourceAt: sources({
      [`base:${REGISTRY}`]: registry(["a", "b"]),
      [`candidate:${REGISTRY}`]: registry(["b", "a"]),
      "base:listener/src/searcher/venues/swaps/a.ts": "a",
      "candidate:listener/src/searcher/venues/swaps/a.ts": "a2",
      "base:listener/src/searcher/venues/swaps/b.ts": "b",
      "candidate:listener/src/searcher/venues/swaps/b.ts": "b",
    }),
  });
  assert.equal(result.classification, "framework");
  assert.match(result.reasons.join("\n"), /reorders or replaces/);
});

test("family boundary rejects unowned ActionAdapter catalog additions", () => {
  const familyA = {
    ...family("swap:a", ["src/searcher/venues/swaps/a.ts"]),
    required_action_adapter_ids: ["shared-action"],
  };
  const base = {
    ...manifest([familyA]),
    action_catalog_ids: ["shared-action"],
  };
  const candidate = {
    ...manifest([familyA]),
    action_catalog_ids: ["shared-action", "orphan-action"],
  };
  const result = evaluateAdapterFamilyBoundary({
    baseCommit: "base",
    candidateCommit: "candidate",
    changedPaths: [ACTION_INDEX, "listener/src/searcher/venues/swaps/a.ts"],
    baseManifest: base,
    candidateManifest: candidate,
    sourceAt: sources({
      [`base:${ACTION_INDEX}`]: actions(["sharedAction"]),
      [`candidate:${ACTION_INDEX}`]:
        actions(["sharedAction", "orphanAction"]),
      "base:listener/src/searcher/venues/swaps/a.ts": "a",
      "candidate:listener/src/searcher/venues/swaps/a.ts": "a2",
    }),
  });
  assert.equal(result.classification, "framework");
  assert.match(result.reasons.join("\n"), /outside the impacted family/);
});

test("family boundary rejects reclassifying shared infra as family-owned", () => {
  const sharedConsumer = {
    ...family("swap:a", ["src/searcher/venues/swaps/a.ts"]),
    required_action_adapter_ids: ["erc20-transfer"],
  };
  const candidateFamily = {
    ...family("swap:beta", [
      "src/adapters/beta.ts",
      "src/searcher/venues/swaps/beta.ts",
    ]),
    owned_action_adapter_ids: ["erc20-transfer"],
  };
  const base = {
    ...manifest([sharedConsumer]),
    action_catalog_ids: ["erc20-transfer"],
  };
  const candidate = {
    ...manifest([sharedConsumer, candidateFamily]),
    action_catalog_ids: ["erc20-transfer"],
  };
  const result = evaluateAdapterFamilyBoundary({
    baseCommit: "base",
    candidateCommit: "candidate",
    changedPaths: [
      REGISTRY,
      "listener/src/adapters/beta.ts",
      "listener/src/searcher/venues/swaps/beta.ts",
    ],
    baseManifest: base,
    candidateManifest: candidate,
    sourceAt: sources({
      [`base:${REGISTRY}`]: registry(["a"]),
      [`candidate:${REGISTRY}`]: registry(["a", "beta"]),
      "base:listener/src/searcher/venues/swaps/a.ts": "a",
      "candidate:listener/src/searcher/venues/swaps/a.ts": "a",
      "candidate:listener/src/adapters/beta.ts": "beta-action",
      "candidate:listener/src/searcher/venues/swaps/beta.ts": "beta",
    }),
  });
  assert.equal(result.classification, "framework");
  assert.match(
    result.reasons.join("\n"),
    /both owned .* and shared infra/,
  );
});

test("family boundary rejects newly claiming a pre-existing central source", () => {
  const baseFamily = family("swap:alpha", [
    "src/searcher/venues/swaps/alpha.ts",
  ]);
  const candidateFamily = family("swap:alpha", [
    "src/searcher/main.ts",
    "src/searcher/venues/swaps/alpha.ts",
  ]);
  const result = evaluateAdapterFamilyBoundary({
    baseCommit: "base",
    candidateCommit: "candidate",
    changedPaths: [
      "listener/src/searcher/main.ts",
      "listener/src/searcher/venues/swaps/alpha.ts",
    ],
    baseManifest: manifest([baseFamily]),
    candidateManifest: manifest([candidateFamily]),
    sourceAt: sources({
      "base:listener/src/searcher/main.ts": "central-main",
      "candidate:listener/src/searcher/main.ts": "changed-central-main",
      "base:listener/src/searcher/venues/swaps/alpha.ts": "alpha",
      "candidate:listener/src/searcher/venues/swaps/alpha.ts": "alpha2",
    }),
  });
  assert.equal(result.classification, "framework");
  assert.match(
    result.reasons.join("\n"),
    /runtime source is outside the family structure.*main\.ts/,
  );
});

test("family boundary never grandfathers a central runtime owner", () => {
  const owned = family("swap:alpha", [
    "src/searcher/main.ts",
    "src/searcher/venues/swaps/alpha.ts",
  ]);
  const result = evaluateAdapterFamilyBoundary({
    baseCommit: "base",
    candidateCommit: "candidate",
    changedPaths: [
      "listener/src/searcher/main.ts",
      "listener/src/searcher/venues/swaps/alpha.ts",
    ],
    baseManifest: manifest([owned]),
    candidateManifest: manifest([owned]),
    sourceAt: sources({
      "base:listener/src/searcher/main.ts": "central-main",
      "candidate:listener/src/searcher/main.ts": "changed-central-main",
      "base:listener/src/searcher/venues/swaps/alpha.ts": "alpha",
      "candidate:listener/src/searcher/venues/swaps/alpha.ts": "alpha2",
    }),
  });
  assert.equal(result.classification, "framework");
  assert.match(
    result.reasons.join("\n"),
    /runtime source is outside the family structure.*main\.ts/,
  );
});

test("family boundary rejects export-token laundering into its trusted producer", () => {
  const baseline = family("swap:alpha", [
    "src/searcher/venues/swaps/alpha.ts",
  ]);
  const candidate = {
    ...baseline,
    root_export: "production_replay",
  };
  const result = evaluateAdapterFamilyBoundary({
    baseCommit: "base",
    candidateCommit: "candidate",
    changedPaths: [
      REGISTRY,
      "listener/src/searcher/venues/swaps/alpha.ts",
      "listener/src/searcher/test/production-replay.ts",
    ],
    baseManifest: manifest([baseline]),
    candidateManifest: manifest([candidate]),
    sourceAt: sources({
      [`base:${REGISTRY}`]: registry(["alpha"]),
      [`candidate:${REGISTRY}`]: registry(["alpha"]),
      "base:listener/src/searcher/venues/swaps/alpha.ts": "alpha",
      "candidate:listener/src/searcher/venues/swaps/alpha.ts": "alpha2",
      "base:listener/src/searcher/test/production-replay.ts": "trusted",
      "candidate:listener/src/searcher/test/production-replay.ts":
        "self-certifying",
    }),
  });
  assert.equal(result.classification, "framework");
  assert.match(
    result.reasons.join("\n"),
    /existing family root identity changed: swap:alpha/,
  );
  assert.match(
    result.reasons.join("\n"),
    /outside the family boundary.*production-replay\.ts/,
  );
});

test("family boundary reserves trusted helper prefixes across staged changes", () => {
  const owned = family("swap:production-replay-artifact", [
    "src/searcher/venues/swaps/production-replay-artifact.ts",
  ]);
  const result = evaluateAdapterFamilyBoundary({
    baseCommit: "base",
    candidateCommit: "candidate",
    changedPaths: [
      "listener/src/searcher/venues/swaps/production-replay-artifact.ts",
      "listener/src/searcher/test/production-replay-artifact.ts",
      "listener/src/searcher/test/canonical-route-identity-witness.ts",
    ],
    baseManifest: manifest([owned]),
    candidateManifest: manifest([owned]),
    sourceAt: sources({
      "base:listener/src/searcher/venues/swaps/production-replay-artifact.ts":
        "family",
      "candidate:listener/src/searcher/venues/swaps/production-replay-artifact.ts":
        "family2",
      "base:listener/src/searcher/test/production-replay-artifact.ts":
        "trusted-helper",
      "candidate:listener/src/searcher/test/production-replay-artifact.ts":
        "self-certifying-helper",
      "base:listener/src/searcher/test/canonical-route-identity-witness.ts":
        "trusted-route-identity",
      "candidate:listener/src/searcher/test/canonical-route-identity-witness.ts":
        "self-certifying-route-identity",
    }),
  });
  assert.equal(result.classification, "framework");
  assert.match(
    result.reasons.join("\n"),
    /outside the family boundary.*production-replay-artifact\.ts/,
  );
  assert.match(
    result.reasons.join("\n"),
    /outside the family boundary.*canonical-route-identity-witness\.ts/,
  );
});

test("family boundary preserves an existing generic helper inside its family zone", () => {
  const owned = family("swap:fluid-dex", [
    "src/searcher/venues/swaps/view-quote-blockscan-state.ts",
    "src/searcher/venues/swaps/fluid-dex.ts",
  ]);
  const result = evaluateAdapterFamilyBoundary({
    baseCommit: "base",
    candidateCommit: "candidate",
    changedPaths: [
      "listener/src/searcher/venues/swaps/view-quote-blockscan-state.ts",
      "listener/src/searcher/venues/swaps/fluid-dex.ts",
    ],
    baseManifest: manifest([owned]),
    candidateManifest: manifest([owned]),
    sourceAt: sources({
      "base:listener/src/searcher/venues/swaps/view-quote-blockscan-state.ts":
        "export const helper = 1;",
      "candidate:listener/src/searcher/venues/swaps/view-quote-blockscan-state.ts":
        "export const helper = 2;",
      "base:listener/src/searcher/venues/swaps/fluid-dex.ts":
        "export const fluid = 1;",
      "candidate:listener/src/searcher/venues/swaps/fluid-dex.ts":
        "export const fluid = 2;",
    }),
  });
  assert.equal(result.classification, "family_local", result.reasons.join("; "));
  assert.deepEqual(result.impactedFamilyIds, ["swap:fluid-dex"]);
  assert.deepEqual(result.reasons, []);
});

test("family boundary rejects a new runtime file outside family zones", () => {
  const baseFamily = family("swap:alpha", [
    "src/searcher/venues/swaps/alpha.ts",
  ]);
  const candidateFamily = family("swap:alpha", [
    "src/searcher/alpha-scheduler.ts",
    "src/searcher/venues/swaps/alpha.ts",
  ]);
  const result = evaluateAdapterFamilyBoundary({
    baseCommit: "base",
    candidateCommit: "candidate",
    changedPaths: [
      "listener/src/searcher/alpha-scheduler.ts",
      "listener/src/searcher/venues/swaps/alpha.ts",
    ],
    baseManifest: manifest([baseFamily]),
    candidateManifest: manifest([candidateFamily]),
    sourceAt: sources({
      "base:listener/src/searcher/venues/swaps/alpha.ts": "alpha",
      "candidate:listener/src/searcher/venues/swaps/alpha.ts": "alpha2",
      "candidate:listener/src/searcher/alpha-scheduler.ts":
        "export const scheduler = true;",
    }),
  });
  assert.equal(result.classification, "framework");
  assert.match(
    result.reasons.join("\n"),
    /runtime source is outside the family structure/,
  );
});

test("family-local test ownership uses the longest exact family namespace", () => {
  const standard = family("protocol:erc4626", [
    "src/searcher/venues/protocols/erc4626.ts",
  ]);
  const silo = family("protocol:erc4626-silo-redeem", [
    "src/searcher/venues/protocols/erc4626-silo-redeem.ts",
  ]);
  const families = manifest([standard, silo]);
  const sourceAt = sources({
    "base:listener/src/searcher/venues/protocols/erc4626.ts": "standard",
    "candidate:listener/src/searcher/venues/protocols/erc4626.ts":
      "standard2",
    "base:listener/src/searcher/venues/protocols/erc4626-silo-redeem.ts":
      "silo",
    "candidate:listener/src/searcher/venues/protocols/erc4626-silo-redeem.ts":
      "silo2",
  });

  const siloClaimingStandard = evaluateAdapterFamilyBoundary({
    baseCommit: "base",
    candidateCommit: "candidate",
    changedPaths: [
      "listener/src/searcher/venues/protocols/erc4626-silo-redeem.ts",
      "listener/src/searcher/test/erc4626.ts",
    ],
    baseManifest: families,
    candidateManifest: families,
    sourceAt,
  });
  assert.equal(siloClaimingStandard.classification, "framework");
  assert.match(
    siloClaimingStandard.reasons.join("\n"),
    /outside the family boundary.*test\/erc4626\.ts/,
  );

  const standardClaimingSilo = evaluateAdapterFamilyBoundary({
    baseCommit: "base",
    candidateCommit: "candidate",
    changedPaths: [
      "listener/src/searcher/venues/protocols/erc4626.ts",
      "listener/src/searcher/test/erc4626-silo-redeem.ts",
    ],
    baseManifest: families,
    candidateManifest: families,
    sourceAt,
  });
  assert.equal(standardClaimingSilo.classification, "framework");
  assert.match(
    standardClaimingSilo.reasons.join("\n"),
    /outside the family boundary.*test\/erc4626-silo-redeem\.ts/,
  );
});

function manifest(
  families: readonly FamilyOwnershipManifestEntry[],
): FamilyOwnershipManifest {
  return {
    schema_version: 1,
    registry_order: families.map((entry) => entry.id),
    action_catalog_ids: families.flatMap(
      (entry) => entry.owned_action_adapter_ids,
    ),
    registry_skeleton_sha256: "0".repeat(64),
    action_index_skeleton_sha256: "0".repeat(64),
    families,
  };
}

function family(
  id: string,
  sourceFiles: readonly string[],
): FamilyOwnershipManifestEntry {
  return {
    id,
    kind: "swap",
    root_source: sourceFiles.at(-1)!,
    root_export: id.replace(/[^a-z0-9]/g, "_"),
    source_files: sourceFiles,
    pool_adapter_ids: [id],
    edge_adapter_ids: [],
    owned_action_adapter_ids: [],
    owned_action_bindings: [],
    required_action_adapter_ids: [],
    required_action_bindings: [],
    candidate_source_ids: [],
    requires_current_head_execution_evidence: false,
    activation_sha256: "0".repeat(64),
  };
}

function sources(
  values: Readonly<Record<string, string>>,
): (commit: string, path: string) => string | null {
  return (commit, path) => values[`${commit}:${path}`] ?? null;
}

function registry(names: readonly string[]): string {
  return `${names.map((name) =>
    `import { ${name} } from "./swaps/${name}.js";`).join("\n")}\n` +
    `export const PRODUCTION_ADAPTER_FAMILIES = new Registry([` +
    `${names.join(",")}]);\nconst centralPolicy = true;\n`;
}

function actions(names: readonly string[]): string {
  return `${names.map((name) =>
    `import { ${name} } from "./${name}.js";`).join("\n")}\n` +
    `const PRODUCTION_ACTION_CATALOG = new Map([${names.join(",")}]);\n` +
    "registerProductionActions();\n";
}
