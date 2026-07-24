import assert from "node:assert/strict";
import {
  chmodSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import { canonicalJson } from "./adapter-family-blind-contract.js";
import type {
  ConversionFreshnessPrivateEvidenceBundle,
  ConversionFreshnessPrivatePredicate,
  ConversionFreshnessReveal,
  ConversionSecret,
} from "./conversion-freshness-oracle.js";
import {
  replayPersistedConversionFreshness,
} from "./conversion-freshness-production-resume.js";
import type {
  ConversionCandidate,
  ConversionEligibilityPlan,
} from "./adapter-family-blind-contract.js";
import {
  verifySelectedConversionProductionFullLive,
  type ConversionProductionInputManifest,
} from "./conversion-freshness-production-full-live.js";

loadSearcherEnv();
const rpcUrl = process.env.CONVERSION_FRESHNESS_RPC_URL ??
  process.env.SEARCHER_LIVE_RPC_URL ??
  process.env.MAINNET_RPC_URL ??
  "";
const artifactDir = process.env.CONVERSION_FRESHNESS_ARTIFACT_DIR?.trim() ?? "";
const universePath =
  process.env.CONVERSION_FRESHNESS_FULL_UNIVERSE_PATH?.trim() ?? "";
assert(rpcUrl, "conversion production-full RPC URL is required");
assert(artifactDir, "CONVERSION_FRESHNESS_ARTIFACT_DIR is required");
assert(
  universePath,
  "CONVERSION_FRESHNESS_FULL_UNIVERSE_PATH is required",
);

const directory = resolve(artifactDir);
const predicate = readJson<ConversionFreshnessPrivatePredicate>(
  `${directory}/predicate.private.json`,
);
const persistedReveal = readJson<ConversionFreshnessReveal>(
  `${directory}/reveal.private.json`,
);
const plan = readJson<ConversionEligibilityPlan>(`${directory}/plan.json`);
const secret = readJson<ConversionSecret>(
  `${directory}/secret.private.json`,
);
const candidates = readJson<readonly ConversionCandidate[]>(
  `${directory}/candidates.private.json`,
);
const privateEvidence = readJson<ConversionFreshnessPrivateEvidenceBundle>(
  `${directory}/evidence.private.json`,
);
const productionInputs = readJson<ConversionProductionInputManifest>(
  `${directory}/production-inputs.json`,
);
const reveal = replayPersistedConversionFreshness({
  plan,
  predicate,
  candidates,
  privateEvidence,
  secret,
  persistedReveal,
});
const production = await verifySelectedConversionProductionFullLive({
  rpcUrl,
  universePath,
  universeManifestPath:
    process.env.CONVERSION_FRESHNESS_FULL_UNIVERSE_MANIFEST?.trim() ||
    `${universePath}.manifest.json`,
  predicate,
  reveal,
  productionInputs,
  stateDeadlineMs: Number(
    process.env.CONVERSION_FRESHNESS_STATE_DEADLINE_MS ?? "600000",
  ),
  ...(process.env.CONVERSION_FRESHNESS_SCAN_BUDGET_MS === undefined
    ? {}
    : {
        scanBudgetMs: Number(
          process.env.CONVERSION_FRESHNESS_SCAN_BUDGET_MS,
        ),
      }),
});
const output = `${directory}/production-full.private.json`;
writeFileSync(output, `${canonicalJson(production)}\n`, { mode: 0o600 });
chmodSync(output, 0o600);
console.log(
  `conversion-freshness-production-full COMPLETE ` +
    `selectedBlock=${reveal.selected?.sourceBlock ?? "missing"} ` +
    `production=${production.comparison.freshnessEvidence} ` +
    `reasons=${production.comparison.reasons.join(",") || "none"} ` +
    `pools=${production.graph.runtimePools} edges=${production.graph.edges} ` +
    `baseCandidates=${production.scanner.baseCandidates.length} ` +
    `sourceCandidates=${production.scanner.sourceCandidates.length} ` +
    `baseSet=${production.scanner.baseSetSha256} ` +
    `sourceSet=${production.scanner.sourceSetSha256} ` +
    `sourceWithoutTargetSet=` +
    `${production.scanner.sourceWithoutTargetUpdateSetSha256} ` +
    `targetRanks=${production.scanner.targetBaseRanks.join(",") || "none"};` +
    `${production.scanner.targetSourceWithoutUpdateRanks.join(",") || "none"}->` +
    `${production.scanner.targetSourceRanks.join(",") || "none"}`,
);
if (production.comparison.freshnessEvidence !== "selected") {
  process.exitCode = 2;
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function loadSearcherEnv(): void {
  if (process.env.SEARCHER_TEST_DISABLE_DOTENV === "1") return;
  let text = "";
  try {
    text = readFileSync(resolve("..", ".env"), "utf8");
  } catch {
    return;
  }
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const [rawKey, ...rest] = trimmed.split("=");
    const key = rawKey.replace(/^export\s+/, "");
    if (!process.env[key]) {
      process.env[key] = rest.join("=").replace(/^["']|["']$/g, "");
    }
  }
}
