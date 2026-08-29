import assert from "node:assert/strict";
import test from "node:test";
import { hashDomain } from "../../../packages/canonical-codec/src/index.ts";
import { CURRENT_AUDIT_ENTRY_COUNT, CURRENT_REUSE_DECLARATIONS, REQUIRED_AUDIT_ENTRY_COUNT, REQUIRED_AUDIT_ENTRY_IDS, REQUIRED_AUDIT_ENTRY_SET_DOMAIN, REQUIRED_AUDIT_ENTRY_SET_ROOT } from "../src/current-ledger.ts";
import { entryIdFor, REFERENCE_COMMIT, REUSE_AUTHORITY_SCHEMA_VERSION, type AuthorityManifestV2 } from "../src/index.ts";
import * as requirements from "../src/evidence-requirements.ts";

test("current denominator is 27 exact, unique, hard-cut declarations", () => {
  assert.equal(CURRENT_AUDIT_ENTRY_COUNT, REQUIRED_AUDIT_ENTRY_COUNT);
  assert.equal(new Set(REQUIRED_AUDIT_ENTRY_IDS).size, REQUIRED_AUDIT_ENTRY_COUNT);
  assert.equal(hashDomain(REQUIRED_AUDIT_ENTRY_SET_DOMAIN, REQUIRED_AUDIT_ENTRY_IDS), REQUIRED_AUDIT_ENTRY_SET_ROOT);
  assert.deepEqual(CURRENT_REUSE_DECLARATIONS.map(item => item.entryId).sort(), REQUIRED_AUDIT_ENTRY_IDS);
  assert.equal(CURRENT_REUSE_DECLARATIONS.every(item => item.creditStatus === "credited" && item.nonCreditReason === null), true);
  assert.equal(CURRENT_REUSE_DECLARATIONS.every(item => item.adoptionMode === "invariant-only-rewrite"), true);
  assert.equal(JSON.stringify(CURRENT_REUSE_DECLARATIONS).match(/future|pending/gi), null);
});

test("entry identity binds the old path and ordered symbol set", () => {
  const first = CURRENT_REUSE_DECLARATIONS[0]!;
  assert.equal(first.entryId, entryIdFor(first.sourcePath, first.sourceSymbols.map(symbol => symbol.name)));
  assert.notEqual(first.entryId, entryIdFor(first.sourcePath, [...first.sourceSymbols].reverse().map(symbol => symbol.name)));
  assert.equal(REFERENCE_COMMIT.length, 40);
});

test("reuse authority manifest schema version is owned by the canonical ledger spec", () => {
  const schemaVersion: AuthorityManifestV2["schemaVersion"] = REUSE_AUTHORITY_SCHEMA_VERSION;
  assert.equal(schemaVersion, 2);
});

test("every evidence declaration resolves a named requirement-only export", () => {
  for (const declaration of CURRENT_REUSE_DECLARATIONS) {
    const value = (requirements as Record<string, unknown>)[declaration.evidence.requirementExportName] as { authority?: unknown; productionOraclePass?: unknown; testModulePath?: unknown; testCaseName?: unknown } | undefined;
    assert.ok(value, declaration.evidence.requirementExportName);
    assert.equal(value.authority, "requirement-only");
    assert.equal(value.productionOraclePass, false);
    assert.equal(value.testModulePath, declaration.evidence.testModulePath);
    assert.equal(value.testCaseName, declaration.evidence.testCaseName);
  }
});
