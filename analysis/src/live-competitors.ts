import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type CompetitorAnalysisMode = "full" | "sample";

export interface LiveCompetitorEntity {
  id: string;
  eoa: string;
  executors: string[];
  analysis_mode: CompetitorAnalysisMode;
}

export interface LiveCompetitorProfile {
  schema_version: 1;
  profile_id: string;
  entities: LiveCompetitorEntity[];
}

export const DEFAULT_LIVE_COMPETITORS_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../config/live-competitors.json",
);

const ADDRESS_RE = /^0x[a-f0-9]{40}$/;

export function loadLiveCompetitorProfile(
  path = DEFAULT_LIVE_COMPETITORS_PATH,
): LiveCompetitorProfile {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as LiveCompetitorProfile;
  if (parsed.schema_version !== 1 || !parsed.profile_id || !Array.isArray(parsed.entities)) {
    throw new Error(`invalid live competitor profile: ${path}`);
  }

  const ids = new Set<string>();
  const addresses = new Set<string>();
  for (const entity of parsed.entities) {
    entity.eoa = normalizeAddress(entity.eoa, `${entity.id}.eoa`);
    entity.executors = entity.executors.map((address) =>
      normalizeAddress(address, `${entity.id}.executors`));
    if (!entity.id || ids.has(entity.id)) throw new Error(`duplicate/blank competitor id: ${entity.id}`);
    if (entity.analysis_mode !== "full" && entity.analysis_mode !== "sample") {
      throw new Error(`invalid analysis_mode for ${entity.id}: ${entity.analysis_mode}`);
    }
    ids.add(entity.id);
    for (const address of [entity.eoa, ...entity.executors]) {
      if (addresses.has(address)) throw new Error(`duplicate competitor address: ${address}`);
      addresses.add(address);
    }
  }
  if (parsed.entities.length === 0) throw new Error("live competitor profile has no entities");
  return parsed;
}

export function competitorEoas(profile: LiveCompetitorProfile): string[] {
  return profile.entities.map((entity) => entity.eoa);
}

export function competitorScanAddresses(profile: LiveCompetitorProfile): string[] {
  return profile.entities.flatMap((entity) => [entity.eoa, ...entity.executors]);
}

export function fullAnalysisEoas(profile: LiveCompetitorProfile): Set<string> {
  return new Set(
    profile.entities
      .filter((entity) => entity.analysis_mode === "full")
      .map((entity) => entity.eoa),
  );
}

function normalizeAddress(value: string, label: string): string {
  const address = String(value).toLowerCase();
  if (!ADDRESS_RE.test(address)) throw new Error(`invalid address for ${label}: ${value}`);
  return address;
}
