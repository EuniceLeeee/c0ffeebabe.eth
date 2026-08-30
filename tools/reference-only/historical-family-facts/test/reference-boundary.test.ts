import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const SOURCE_DIRECTORY = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
const CANONICAL_CODEC = "../../../../packages/canonical-codec/src/index.ts";

function importedSpecifiers(source: string): readonly string[] {
  const specifiers: string[] = [];
  for (const match of source.matchAll(/\bfrom\s+["']([^"']+)["']/g)) specifiers.push(match[1]!);
  for (const match of source.matchAll(/\bimport\s+["']([^"']+)["']/g)) specifiers.push(match[1]!);
  return specifiers;
}

function assertLiteralDynamicImports(source: string, path: string): void {
  for (const match of source.matchAll(/\bimport\s*\(([^)]*)\)/g)) {
    const argument = match[1]!.trim();
    assert.match(argument, /^(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')$/, `${path}: dynamic import must be a literal`);
  }
}

test("reference-only historical sources depend only on local frozen evidence and canonical encoding", () => {
  for (const name of readdirSync(SOURCE_DIRECTORY).filter((candidate) => candidate.endsWith(".ts")).sort()) {
    const path = join(SOURCE_DIRECTORY, name);
    const source = readFileSync(path, "utf8");
    assertLiteralDynamicImports(source, path);
    for (const specifier of importedSpecifiers(source)) {
      assert.ok(
        specifier.startsWith("node:") || specifier.startsWith("./") || specifier === CANONICAL_CODEC,
        `${path}: forbidden reference-only dependency ${specifier}`,
      );
    }
  }
});

test("reference-only boundary rejects non-literal dynamic imports", () => {
  assert.throws(
    () => assertLiteralDynamicImports("const moduleName = './current.ts'; await import(moduleName);", "fixture.ts"),
    /dynamic import must be a literal/,
  );
});
