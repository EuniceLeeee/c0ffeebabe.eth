import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  canonicalJson,
  sha256Canonical,
} from "./adapter-family-blind-contract.js";
import {
  buildConversionFreshnessPlan,
  revealConversionFreshness,
  scanConversionFreshness,
} from "./conversion-freshness-oracle.js";
import {
  WSTETH_FRESHNESS_INTEGRATION_RANGE,
  WSTETH_FRESHNESS_KNOWN_CANDIDATES,
  wstethFreshnessPrivatePredicate,
} from "./fixtures/conversion-freshness-wsteth.js";
import {
  verifySelectedConversionProductionLive,
} from "./conversion-freshness-production-live.js";
import {
  freezeConversionProductionInputs,
  verifySelectedConversionProductionFullLive,
} from "./conversion-freshness-production-full-live.js";

const rpcUrl = process.env.CONVERSION_FRESHNESS_RPC_URL ??
  process.env.SEARCHER_LIVE_RPC_URL ??
  process.env.MAINNET_RPC_URL ??
  "";
assert(
  rpcUrl,
  "CONVERSION_FRESHNESS_RPC_URL/SEARCHER_LIVE_RPC_URL/MAINNET_RPC_URL is required",
);

const predicate = wstethFreshnessPrivatePredicate();
const artifactDir = process.env.CONVERSION_FRESHNESS_ARTIFACT_DIR?.trim();
const productionInputs = artifactDir
  ? freezeConversionProductionInputs({
      env: process.env,
      artifactDirectory: resolve(artifactDir),
    })
  : null;
const secret = {
  seed: randomBytes(32).toString("hex"),
  salt: randomBytes(32).toString("hex"),
};
const plan = buildConversionFreshnessPlan({
  predicate,
  ...WSTETH_FRESHNESS_INTEGRATION_RANGE,
  minEligibleCardinality: 32,
  productionInputsSha256: productionInputs
    ? sha256Canonical(productionInputs)
    : sha256Canonical({ profile: "component-only" }),
  secret,
});
if (artifactDir) {
  const directory = resolve(artifactDir);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  writeArtifact(`${directory}/plan.json`, plan, 0o644);
  writeArtifact(`${directory}/production-inputs.json`, productionInputs, 0o644);
  writeArtifact(`${directory}/predicate.private.json`, predicate, 0o600);
  writeArtifact(`${directory}/secret.private.json`, secret, 0o600);
  console.log(
    `conversion-freshness commitment range=${plan.range.rangeHash} ` +
      `predicate=${plan.predicateSha256} seed=${plan.seedCommitment}`,
  );
}
const scanned = await scanConversionFreshness({
  plan,
  predicate,
  rpcUrl,
  rpcTimeoutMs: 30_000,
  rpcMinIntervalMs: 0,
  logChunkSize: 10_000,
});
if (artifactDir) {
  const directory = resolve(artifactDir);
  writeArtifact(
    `${directory}/candidates.private.json`,
    scanned.candidates,
    0o600,
  );
  writeArtifact(
    `${directory}/evidence.private.json`,
    scanned.privateEvidence,
    0o600,
  );
}
const candidateBlocks = new Set(
  scanned.candidates.map((candidate) => candidate.sourceBlock),
);
for (const expected of WSTETH_FRESHNESS_KNOWN_CANDIDATES) {
  assert(
    candidateBlocks.has(expected),
    "trusted live integration omitted a confirmed conversion update",
  );
}
assert(
  scanned.privateEvidence.eligible.every((entry) =>
    entry.evidence.topologyUnchanged &&
    entry.evidence.rateChangedAtSource &&
    entry.evidence.rates.length === 2 &&
    entry.evidence.rates.every((rate) => rate.changed)
  ),
  "trusted live conversion evidence is incomplete",
);
assert(
  scanned.candidates.length >= plan.minEligibleCardinality,
  "trusted live conversion range does not satisfy frozen cardinality",
);
const revealed = revealConversionFreshness({
  plan,
  predicate,
  candidates: scanned.candidates,
  privateEvidence: scanned.privateEvidence,
  secret,
});
assert.equal(
  revealed.freshnessEvidence,
  "selected",
  "trusted live conversion range did not reveal a real selected sample",
);
assert(revealed.selected && revealed.selectedEvidence);
if (artifactDir) {
  writeArtifact(
    `${resolve(artifactDir)}/reveal.private.json`,
    revealed,
    0o600,
  );
}
if (process.env.CONVERSION_FRESHNESS_SKIP_COMPONENT === "1") {
  console.log(
    `conversion-freshness-oracle-live PASS candidates=${scanned.candidates.length} ` +
      `selectedBlock=${revealed.selected.sourceBlock} production=not-run`,
  );
  process.exit(0);
}
const fullUniversePath =
  process.env.CONVERSION_FRESHNESS_FULL_UNIVERSE_PATH?.trim();
if (fullUniversePath) {
  assert(
    productionInputs,
    "production-full conversion requires CONVERSION_FRESHNESS_ARTIFACT_DIR",
  );
  const production = await verifySelectedConversionProductionFullLive({
    rpcUrl,
    predicate,
    reveal: revealed,
    productionInputs,
    universePath: fullUniversePath,
    universeManifestPath:
      process.env.CONVERSION_FRESHNESS_FULL_UNIVERSE_MANIFEST?.trim() ||
      `${fullUniversePath}.manifest.json`,
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
  if (artifactDir) {
    writeArtifact(
      `${resolve(artifactDir)}/production-full.private.json`,
      production,
      0o600,
    );
  }
  console.log(
    `conversion-freshness-oracle-live COMPLETE candidates=${scanned.candidates.length} ` +
      `selectedBlock=${revealed.selected.sourceBlock} ` +
      `production=${production.comparison.freshnessEvidence} ` +
      `graph=${production.graph.edges} ` +
      `baseCandidates=${production.scanner.baseCandidates.length} ` +
      `sourceCandidates=${production.scanner.sourceCandidates.length} ` +
      `targetRanks=${production.scanner.targetBaseRanks.join(",") || "none"};` +
      `${production.scanner.targetSourceWithoutUpdateRanks.join(",") || "none"}->` +
      `${production.scanner.targetSourceRanks.join(",") || "none"}`,
  );
  process.exit(
    production.comparison.freshnessEvidence === "selected" ? 0 : 2,
  );
}
const production = await verifySelectedConversionProductionLive({
  rpcUrl,
  predicate,
  reveal: revealed,
});
console.log(
  `conversion-freshness-oracle-live COMPONENT_ONLY candidates=${scanned.candidates.length} ` +
  `production=${production.freshnessEvidence}`,
);
process.exitCode = 2;

function writeArtifact(
  path: string,
  value: unknown,
  mode: number,
): void {
  writeFileSync(path, `${canonicalJson(value)}\n`, { mode });
  chmodSync(path, mode);
}
