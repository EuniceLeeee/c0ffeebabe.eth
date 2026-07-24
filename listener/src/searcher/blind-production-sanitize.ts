import { blindProductionAuditHash } from "./blind-production-audit.js";

/**
 * Normalize the semantic SEARCHER_/MEV_LIVE_/BLIND_ environment without
 * leaking credentials or allowing target-specific producer hints.
 *
 * Runtime leases (commit paths, loopback ports and local endpoints) are bound
 * separately by the blind manifest, so they deliberately do not affect the
 * shared baseline/challenger config hash.
 */
export function blindResolvedRuntimeEnvironment(
  env: NodeJS.ProcessEnv,
): Readonly<Record<string, unknown>> {
  const values: Record<string, string> = {};
  const redactedBindings: Array<{
    readonly nameSha256: string;
    readonly valueSha256: string;
  }> = [];
  for (const [name, value] of Object.entries(env).sort(([a], [b]) =>
    a.localeCompare(b)
  )) {
    if (
      !value ||
      (!name.startsWith("SEARCHER_") &&
        !name.startsWith("MEV_LIVE_") &&
        !name.startsWith("BLIND_"))
    ) continue;
    if (/(?:expected|target|winner|search_center)/i.test(name)) {
      throw new Error(
        `blind production audit rejects target-specific environment ${name}`,
      );
    }
    if (isBlindNonSemanticRuntimeBinding(name)) continue;
    if (
      /(?:private|secret|mnemonic|password|token|key|wallet|rpc|url|endpoint)/i
        .test(name) ||
      /^https?:\/\//i.test(value) ||
      /^0x[0-9a-f]{64}$/i.test(value)
    ) {
      redactedBindings.push({
        nameSha256: blindProductionAuditHash(name),
        valueSha256: blindProductionAuditHash(value),
      });
      continue;
    }
    values[name] = value;
  }
  return Object.freeze({
    values: Object.freeze(values),
    redactedBindings: Object.freeze(redactedBindings),
  });
}

export function normalizeBlindArtifactValue(value: unknown): unknown {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) return value;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("blind artifact rejects non-finite config values");
    }
    return value;
  }
  if (Array.isArray(value)) return value.map(normalizeBlindArtifactValue);
  if (value instanceof Set) {
    return [...value].map(normalizeBlindArtifactValue);
  }
  if (value instanceof Map) {
    const entries: Array<[string, unknown]> = [...value.entries()]
      .map(([key, item]): [string, unknown] => [
        String(key),
        normalizeBlindArtifactValue(item),
      ]);
    return Object.fromEntries(
      entries.sort(([a], [b]) => a.localeCompare(b)),
    );
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined && typeof item !== "function")
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, normalizeBlindArtifactValue(item)]),
    );
  }
  throw new Error(`blind artifact rejects ${typeof value} config values`);
}

function isBlindNonSemanticRuntimeBinding(name: string): boolean {
  return name === "SEARCHER_RUNTIME_COMMIT" ||
    name === "SEARCHER_ANVIL_PORT" ||
    name === "SEARCHER_BLOCKSCAN_ANVIL_PORT" ||
    name === "SEARCHER_REVM_SIM_BIN" ||
    name === "BLIND_SOURCE_CONTROL_URL" ||
    /(?:_RPC)?_URL$/.test(name) ||
    /_ENDPOINT$/.test(name) ||
    /_PATH$/.test(name);
}
