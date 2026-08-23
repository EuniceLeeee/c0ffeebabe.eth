import {
  assertHash,
  assertNonEmptyString,
  decodeExactObject,
  fieldArray,
  type Hash,
} from "../../../packages/canonical-codec/src/index.ts";

/**
 * A compiler closure observation supplied by the qualified source boundary.
 * Catalog generation may join this fact to a named module export, but it may
 * not build a compiler Program or derive authority from a local source walk.
 */
export interface CatalogCompilerClosureFactV1 {
  readonly modulePath: string;
  readonly exportName: string;
  readonly entrypointId: string;
  readonly closureDigest: Hash;
  readonly programInputSetRoot: Hash;
}

function staticModulePath(value: unknown, path: string): string {
  const result = assertNonEmptyString(value, path);
  if (
    result.startsWith(".")
    || result.startsWith("/")
    || result.startsWith("@")
    || result.includes("..")
    || result.includes("\\")
    || result.includes("?")
    || result.includes("#")
  ) throw new TypeError(`catalog compiler module path must be static at ${path}`);
  return result;
}

function staticExportName(value: unknown, path: string): string {
  const result = assertNonEmptyString(value, path);
  if (!/^[$A-Z_a-z][$\w]*$/.test(result)) throw new TypeError(`catalog compiler export name must be static at ${path}`);
  return result;
}

function normalizeFact(value: unknown, path: string): CatalogCompilerClosureFactV1 {
  return decodeExactObject(value, {
    modulePath: (item, itemPath) => staticModulePath(item, itemPath),
    exportName: (item, itemPath) => staticExportName(item, itemPath),
    entrypointId: (item, itemPath) => assertNonEmptyString(item, itemPath),
    closureDigest: (item, itemPath) => assertHash(item, itemPath),
    programInputSetRoot: (item, itemPath) => assertHash(item, itemPath),
  }, path);
}

function factKey(fact: Pick<CatalogCompilerClosureFactV1, "modulePath" | "exportName">): string {
  return `${fact.modulePath}#${fact.exportName}`;
}

/** Decode and sort an exact set of externally observed compiler facts. */
export function sealCatalogCompilerClosureFacts(value: readonly CatalogCompilerClosureFactV1[]): readonly CatalogCompilerClosureFactV1[] {
  const normalized = value.map((item, index) => normalizeFact(item, `catalogCompilerClosures[${index}]`));
  const keys = normalized.map(factKey);
  if (new Set(keys).size !== keys.length) throw new TypeError("duplicate catalog compiler closure fact");
  const entrypointIds = normalized.map(item => item.entrypointId);
  if (new Set(entrypointIds).size !== entrypointIds.length) throw new TypeError("duplicate catalog compiler entrypoint id");
  return Object.freeze([...normalized].sort((left, right) => factKey(left).localeCompare(factKey(right))));
}

export function decodeCatalogCompilerClosureFacts(value: unknown, path = "catalogCompilerClosures"): readonly CatalogCompilerClosureFactV1[] {
  return sealCatalogCompilerClosureFacts(fieldArray(value, (item, itemPath) => normalizeFact(item, itemPath), path));
}

export function catalogCompilerClosureFactKey(fact: Pick<CatalogCompilerClosureFactV1, "modulePath" | "exportName">): string {
  return factKey(fact);
}
