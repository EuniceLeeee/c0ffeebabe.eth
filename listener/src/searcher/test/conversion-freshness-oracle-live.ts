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
const secret = {
  seed: randomBytes(32).toString("hex"),
  salt: randomBytes(32).toString("hex"),
};
const plan = buildConversionFreshnessPlan({
  predicate,
  ...WSTETH_FRESHNESS_INTEGRATION_RANGE,
  minEligibleCardinality: 32,
  productionInputsSha256: sha256Canonical({ profile: "component-only" }),
  secret,
});
if (artifactDir) {
  const directory = resolve(artifactDir);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  writeArtifact(`${directory}/plan.json`, plan, 0o644);
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
