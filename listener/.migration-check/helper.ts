import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { renderDeclarativeProductionEntry } from "../src/searcher/build-declarative-production.js";
import { createDeclarativeProtocolRuntime } from "../src/searcher/venues/declarative-protocol.js";
import { declarativeMathRegistry } from "../src/searcher/venues/declarative-math-models.js";
import { declarativeRuntimeMathRegistry } from "../src/searcher/venues/declarative-runtime-math-models.js";

export const ROOT = resolve(import.meta.dirname, "..");
export const TMP = resolve(ROOT, "src/searcher/venues/.migration-tmp");

export interface Loaded {
  readonly document: any;
  readonly definitionFilePath: string;
  readonly runtime: ReturnType<typeof createDeclarativeProtocolRuntime>;
  readonly plugin: any;
  readonly renderedSource: string;
}

export async function loadFamily(stem: string): Promise<Loaded> {
  const definitionFilePath = resolve(
    ROOT,
    `src/searcher/venues/protocols/${stem}-family/${stem}.json`,
  );
  const document = JSON.parse(readFileSync(definitionFilePath, "utf8"));
  // In-memory compiler path (same public entry the generated plugin uses).
  const runtime = createDeclarativeProtocolRuntime(document, [], {
    math: declarativeMathRegistry,
    executionMath: declarativeRuntimeMathRegistry,
  });
  // Production authoring validation + real defineProtocolFamily import.
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });
  writeFileSync(
    resolve(TMP, "activation.ts"),
    'export { defineFamilyActivation } from "../production-families/activation.js";\n',
  );
  const rendered = renderDeclarativeProductionEntry({
    rootDirectory: ROOT,
    definitionFile: definitionFilePath,
    productionDirectory: TMP,
    document,
  });
  assert.equal(rendered.format, "protocol-json-v2");
  writeFileSync(rendered.entryFile, rendered.source);
  const module = await import(
    `${pathToFileURL(rendered.entryFile).href}?v=${Date.now()}`
  );
  rmSync(TMP, { recursive: true, force: true });
  return {
    document,
    definitionFilePath,
    runtime,
    plugin: module.plugin,
    renderedSource: rendered.source,
  };
}

export function sourceAt(number: number): {
  number: number;
  hash: string;
  generation: number;
} {
  return {
    number,
    hash: `0x${number.toString(16).padStart(64, "0")}`,
    generation: number,
  };
}

export function response(
  id: string,
  data: string,
  source: { number: number; hash: string; generation: number },
  completion: "returned" | "reverted" = "returned",
): any {
  return {
    id,
    data,
    source,
    ok: true,
    completion,
    provenance: { kind: "fixture", fingerprint: "fixture" },
  };
}

export function cleanup(): void {
  rmSync(TMP, { recursive: true, force: true });
}
