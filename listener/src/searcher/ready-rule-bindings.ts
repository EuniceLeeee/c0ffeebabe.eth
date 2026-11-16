import { createHash } from "node:crypto";
import { canonicalJson, type StartupCheckpointEnvelope } from "./universe-rebuild-checkpoint.js";

export type ReadyRuleScope = "full" | "memo" | "discovery";
export type ReadyRuleHashes = Readonly<Record<ReadyRuleScope, string>>;
export type ReadyRuleDefinitions = Readonly<Record<string, ReadyRuleHashes>>;
type Group = Readonly<{ rulesHash: string; definitionHashes: readonly string[] }>;
export interface ReadyRuleBindings {
  readonly version: 1;
  readonly origin: Readonly<{ generation: number; checkpointFingerprint: string;
    sourceSha256: string; archiveManifestSha256: string }>;
  readonly families: Readonly<Record<string, Readonly<Record<ReadyRuleScope, Group>>>>;
  readonly fingerprint: string;
}
const scopes: readonly ReadyRuleScope[] = ["full", "memo", "discovery"];
const hex = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const hash = (value: unknown) => createHash("sha256").update(canonicalJson(value)).digest("hex");

export function sealReadyRuleBindings(value: Omit<ReadyRuleBindings, "fingerprint">): ReadyRuleBindings {
  const result = JSON.parse(JSON.stringify({ ...value, fingerprint: hash(value) })) as ReadyRuleBindings;
  validateReadyRuleBindings(result);
  const freeze = (v: any): any => { if (v && typeof v === "object") { Object.values(v).forEach(freeze); Object.freeze(v); } return v; };
  return freeze(result);
}
export function validateReadyRuleBindings(value: ReadyRuleBindings): void {
  if (!value || value.version !== 1 || !value.origin || !Number.isSafeInteger(value.origin.generation) ||
      value.origin.generation < 1 || !hex(value.origin.checkpointFingerprint) ||
      !hex(value.origin.sourceSha256) || !hex(value.origin.archiveManifestSha256) ||
      !value.families || typeof value.families !== "object" || Array.isArray(value.families))
    throw new Error("invalid Ready rule bindings");
  const { fingerprint, ...body } = value;
  if (!hex(fingerprint) || fingerprint !== hash(body)) throw new Error("Ready rule binding fingerprint differs");
  for (const [id, family] of Object.entries(value.families)) {
    if (!id || Object.keys(family).sort().join() !== [...scopes].sort().join()) throw new Error("invalid Ready rule Family scopes");
    for (const scope of scopes) {
      const group = family[scope];
      if (!group || !hex(group.rulesHash) || !Array.isArray(group.definitionHashes) ||
          !group.definitionHashes.length || group.definitionHashes.some(h => !hex(h)) ||
          new Set(group.definitionHashes).size !== group.definitionHashes.length)
        throw new Error("invalid Ready rule definition binding");
    }
  }
}

/** One Ready-scoped resolver for outcome inheritance and memo restoration.
 * It neither classifies candidates nor changes source/authority requirements. */
export function createReadyRuleCompatibility(input: {
  bindings: ReadyRuleBindings; currentRules: ReadyRuleDefinitions;
  currentHashes: ReadyRuleDefinitions;
}) {
  validateReadyRuleBindings(input.bindings);
  const accepts = (familyId: string, scope: ReadyRuleScope, definitionHash: string): boolean => {
    const current = input.currentHashes[familyId];
    if (!current) return false;
    if (definitionHash === current[scope] || (scope === "memo" && definitionHash === current.full)) return true;
    const group = input.bindings.families[familyId]?.[scope];
    return group !== undefined && group.rulesHash === input.currentRules[familyId]?.[scope] &&
      group.definitionHashes.includes(definitionHash);
  };
  return Object.freeze({
    accepts,
    equivalent: (familyId: string, oldHash: string, currentHash: string) =>
      currentHash === input.currentHashes[familyId]?.full && accepts(familyId, "full", oldHash),
    nextBindings: (): ReadyRuleBindings => {
      // Disabled Families remain historical evidence, not active authority.
      // Re-enabling one still compares its actual current rules before reuse.
      const families: Record<string, Record<ReadyRuleScope, Group>> = { ...input.bindings.families };
      for (const [id, current] of Object.entries(input.currentHashes)) {
        const rules = input.currentRules[id]; if (!rules) throw new Error("Ready rule definitions are incomplete");
        const group = (scope: ReadyRuleScope): Group => {
          const old = input.bindings.families[id]?.[scope];
          return { rulesHash: rules[scope], definitionHashes: [...new Set([
            ...(old?.rulesHash === rules[scope] ? old.definitionHashes : []), current[scope],
            ...(scope === "memo" ? [current.full] : []),
           ])].sort() };
        };
        families[id] = { full: group("full"), memo: group("memo"), discovery: group("discovery") };
      }
      return sealReadyRuleBindings({ version: 1, origin: input.bindings.origin, families });
    },
  });
}
export type ReadyRuleCompatibility = ReturnType<typeof createReadyRuleCompatibility>;

const issuedMigrations = new WeakSet<object>();
export interface ReadyRuleMigration { readonly checkpointFingerprint: string; readonly bindings: ReadyRuleBindings }
/** The archive verifier supplies hashes independently reproduced from pinned
 * OLD sources. Changed current rules are deliberately not stamped onto them. */
export function issueReadyRuleMigration(input: {
  checkpoint: StartupCheckpointEnvelope; archivedHashes: ReadyRuleDefinitions;
  archivedRules: ReadyRuleDefinitions; sourceSha256: string; archiveManifestSha256: string;
}): ReadyRuleMigration {
  const ready = input.checkpoint.readyGeneration;
  if (!ready || input.checkpoint.inProgressRun || ready.ruleBindings) throw new Error("migration requires an unmigrated completed Ready");
  const families: Record<string, Record<ReadyRuleScope, Group>> = {};
  for (const [id, partition] of Object.entries(ready.familyPartitions ?? {})) {
    const hashes = input.archivedHashes[id], rules = input.archivedRules[id];
    if (!hashes || !rules || partition.familyDefinitionHash !== hashes.full ||
        partition.discoveryDefinitionHash !== hashes.discovery) throw new Error("archived Ready Family definition differs: " + id);
    families[id] = { full: { rulesHash: rules.full, definitionHashes: [hashes.full] },
      memo: { rulesHash: rules.memo, definitionHashes: [...new Set([hashes.full, hashes.memo])].sort() },
      discovery: { rulesHash: rules.discovery, definitionHashes: [hashes.discovery] } };
  }
  if (!Object.keys(families).length) throw new Error("migration requires sealed Family partitions");
  for (const memo of Object.values(input.checkpoint.verifiedMemos)) {
    if (!families[memo.familyId]?.memo.definitionHashes.includes(memo.familyDefinitionHash))
      throw new Error("archived memo definition differs: " + memo.familyId);
  }
  const bindings = sealReadyRuleBindings({ version: 1, origin: { generation: ready.generation,
    checkpointFingerprint: input.checkpoint.checkpointFingerprint,
    sourceSha256: input.sourceSha256, archiveManifestSha256: input.archiveManifestSha256 }, families });
  const migration = Object.freeze({ checkpointFingerprint: input.checkpoint.checkpointFingerprint, bindings });
  issuedMigrations.add(migration); return migration;
}
export function assertIssuedReadyRuleMigration(value: ReadyRuleMigration): void {
  if (!issuedMigrations.has(value)) throw new Error("Ready rule migration was not issued by archive verification");
}
