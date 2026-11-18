import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG as catalog } from "../venues/production-family-composition.js";
import { inspectAcceptanceEntry } from "./protocol-json-acceptance-context.js";

for (const [sourceFile, format] of [
  ["selector-013efd8b.production.ts", "selector-execution-family-v2"],
  ["selector-6e553f65.production.ts", "selector-execution-family-v3"],
] as const) {
  test(`installed ${format} entry retains its source metadata without inventing a standard variant`, async () => {
    const family = catalog.listAll().find(row => row.sourceFile === sourceFile);
    assert(family, "actual installed selector family required");
    const source = readFileSync(new URL(`../venues/production-families/${sourceFile}`, import.meta.url), "utf8");
    const reference = /^\/\/ Definition: (.+)$/m.exec(source);
    assert(reference);
    const bytes = readFileSync(new URL(reference[1]!, new URL("../../../", import.meta.url)));
    assert.equal(JSON.parse(bytes.toString()).format, format);
    const record = await inspectAcceptanceEntry(family);
    assert.equal(record.kind, "selector-execution-json", "the legacy declarative maintenance path must not take over a selector owner");
    if (record.kind !== "selector-execution-json") throw new Error("selector entry classification required");
    assert.equal(record.format, format);
    assert.equal(record.sourceFile, sourceFile);
    assert.equal(record.definitionBoundaryHash, family.definitionBoundaryHash);
    assert.equal(record.definitionFile, reference[1]);
    assert.equal(record.definitionSha256, createHash("sha256").update(bytes).digest("hex"));
    assert.equal("variants" in record, false);
  });
}
