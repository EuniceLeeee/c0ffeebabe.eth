import {
  assertExactKeys,
  assertHash,
  hashDomain,
  type CanonicalJson,
  type Hash,
} from "../../../packages/canonical-codec/src/index.ts";
import type { ProductionFullFamilyObserverResultV1 } from "./full-family-observer.ts";

export interface ProductionTerminalPhaseFullFamilyProjectionV1 {
  readonly schemaVersion: 1;
  readonly kind: "aloha.production-terminal-phase-full-family-projection-v1";
  readonly status: "observed" | "missing";
  readonly finalDurableWindowId: Hash;
  readonly readyRecordHash: Hash;
  readonly auditRoot: Hash;
  readonly fullGraphCoarseSweepRoot: Hash;
  readonly producerTerminalBindingRoot: Hash;
  readonly laneTerminalSetRoot: Hash;
  readonly bundleContentSha256: Hash | null;
  readonly locatorContentSha256: Hash | null;
  readonly missing: ProductionFullFamilyObserverResultV1["missing"];
  readonly observationRoot: Hash;
}

export function createProductionTerminalPhaseFullFamilyProjectionV1(
  result: ProductionFullFamilyObserverResultV1,
): ProductionTerminalPhaseFullFamilyProjectionV1 {
  const status = result.kind === "aloha.production-full-family-observation-v1" ? "observed" as const : "missing" as const;
  const projection = Object.freeze({
    schemaVersion: 1 as const,
    kind: "aloha.production-terminal-phase-full-family-projection-v1" as const,
    status,
    finalDurableWindowId: result.finalDurableWindowId,
    readyRecordHash: result.readyRecordHash,
    auditRoot: result.auditRoot,
    fullGraphCoarseSweepRoot: result.fullGraphCoarseSweepRoot,
    producerTerminalBindingRoot: result.producerTerminalBindingRoot,
    laneTerminalSetRoot: result.laneTerminalSetRoot,
    bundleContentSha256: result.bundleArtifact?.contentSha256 ?? null,
    locatorContentSha256: result.locatorArtifact?.contentSha256 ?? null,
    missing: result.missing,
  });
  return Object.freeze({
    ...projection,
    observationRoot: hashDomain(
      "aloha/production-terminal-phase-full-family-projection/v1",
      projection as unknown as CanonicalJson,
    ),
  });
}

export function decodeProductionTerminalPhaseFullFamilyProjectionV1(
  value: unknown,
): ProductionTerminalPhaseFullFamilyProjectionV1 {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("terminal-phase Full-Family projection must be an object");
  }
  const input = value as Record<string, unknown>;
  assertExactKeys(input, [
    "schemaVersion", "kind", "status", "finalDurableWindowId", "readyRecordHash", "auditRoot",
    "fullGraphCoarseSweepRoot", "producerTerminalBindingRoot", "laneTerminalSetRoot",
    "bundleContentSha256", "locatorContentSha256", "missing", "observationRoot",
  ], "terminalPhaseFullFamilyProjection");
  if (input.schemaVersion !== 1
    || input.kind !== "aloha.production-terminal-phase-full-family-projection-v1"
    || (input.status !== "observed" && input.status !== "missing")
    || !Array.isArray(input.missing)) {
    throw new TypeError("terminal-phase Full-Family projection kind/status is invalid");
  }
  const missing = input.missing.map((item, index) => {
    if (item === null || typeof item !== "object" || Array.isArray(item)) {
      throw new TypeError(`terminal-phase Full-Family missing[${index}] is invalid`);
    }
    const fact = item as Record<string, unknown>;
    assertExactKeys(fact, ["code", "subjectRoot"], `terminalPhaseFullFamilyProjection.missing[${index}]`);
    if (fact.code !== "coarse-family-artifact-unavailable"
      && fact.code !== "graph-transition-audit-denominator-incomplete") {
      throw new TypeError(`terminal-phase Full-Family missing[${index}] code is invalid`);
    }
    return Object.freeze({
      code: fact.code,
      subjectRoot: assertHash(fact.subjectRoot, `terminalPhaseFullFamilyProjection.missing[${index}].subjectRoot`),
    });
  });
  const nullableHash = (item: unknown, path: string): Hash | null => item === null ? null : assertHash(item, path);
  const payload = Object.freeze({
    schemaVersion: 1 as const,
    kind: "aloha.production-terminal-phase-full-family-projection-v1" as const,
    status: input.status as "observed" | "missing",
    finalDurableWindowId: assertHash(input.finalDurableWindowId, "terminalPhaseFullFamilyProjection.finalDurableWindowId"),
    readyRecordHash: assertHash(input.readyRecordHash, "terminalPhaseFullFamilyProjection.readyRecordHash"),
    auditRoot: assertHash(input.auditRoot, "terminalPhaseFullFamilyProjection.auditRoot"),
    fullGraphCoarseSweepRoot: assertHash(input.fullGraphCoarseSweepRoot, "terminalPhaseFullFamilyProjection.fullGraphCoarseSweepRoot"),
    producerTerminalBindingRoot: assertHash(input.producerTerminalBindingRoot, "terminalPhaseFullFamilyProjection.producerTerminalBindingRoot"),
    laneTerminalSetRoot: assertHash(input.laneTerminalSetRoot, "terminalPhaseFullFamilyProjection.laneTerminalSetRoot"),
    bundleContentSha256: nullableHash(input.bundleContentSha256, "terminalPhaseFullFamilyProjection.bundleContentSha256"),
    locatorContentSha256: nullableHash(input.locatorContentSha256, "terminalPhaseFullFamilyProjection.locatorContentSha256"),
    missing: Object.freeze(missing),
  });
  if ((payload.status === "observed"
      && (payload.bundleContentSha256 === null || payload.locatorContentSha256 === null || payload.missing.length !== 0))
    || (payload.status === "missing"
      && (payload.bundleContentSha256 !== null || payload.locatorContentSha256 !== null || payload.missing.length === 0))) {
    throw new TypeError("terminal-phase Full-Family projection denominator is inconsistent");
  }
  const observationRoot = assertHash(input.observationRoot, "terminalPhaseFullFamilyProjection.observationRoot");
  if (observationRoot !== hashDomain(
    "aloha/production-terminal-phase-full-family-projection/v1",
    payload as unknown as CanonicalJson,
  )) {
    throw new TypeError("terminal-phase Full-Family projection observation root mismatch");
  }
  return Object.freeze({ ...payload, observationRoot });
}
