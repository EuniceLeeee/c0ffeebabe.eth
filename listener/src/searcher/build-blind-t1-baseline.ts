/**
 * F9: blind T1 baseline vocabulary generator (dev/CI tool, never part of the
 * production import closure).
 *
 * T0/T1 were deliberately frozen before the family-line implementation. Their
 * blind comparator has one immutable semantic vocabulary. This generator is
 * the single source of that frozen vocabulary: it writes
 * generated/blind-t1-baseline.generated.json, which production code reads as
 * sealed data. Changing this vocabulary silently invalidates the trusted
 * baseline, so a future acceptance generation must freeze a new T0 instead of
 * editing this bridge (see blind-production-compatibility.ts).
 *
 * Central-path rule (§0.1): the literal per-family tables live only in this
 * dev/CI tool + the sealed artifact it emits, never in the production import
 * closure.
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const GENERATOR_SOURCE = join(
  ROOT,
  "listener",
  "src",
  "searcher",
  "build-blind-t1-baseline.ts",
);
const ARTIFACT_PATH = join(
  ROOT,
  "listener",
  "src",
  "searcher",
  "generated",
  "blind-t1-baseline.generated.json",
);

const registeredRouteFamilyIds = Object.freeze([
  "univ2-standard",
  "univ3-standard",
  "curve-plain",
  "curve-underlying",
  "balancer-v3",
  "univ4",
  "custom-swap:dodo-v2",
  "protocol:erc4626",
  "protocol:goldx",
  "protocol:metronome-synth",
  "protocol:metronome-hgusdc",
  "protocol:psm",
  "protocol:eigenpie",
  "protocol:rocksolid",
  "protocol:wsteth",
]);

const currentRouteFamilyIds = Object.freeze([
  ...registeredRouteFamilyIds,
  "protocol:erc4626-silo-redeem",
  "fluid-dex",
  "credit:fluid",
]);

const warmKindByFamily = Object.freeze({
  "univ2-standard": "mutable-pool",
  "univ3-standard": "mutable-pool",
  "curve-plain": "curve-pool",
  "curve-underlying": "external-mid",
  "balancer-v3": "external-mid",
  "univ4": "mutable-pool",
  "custom-swap:dodo-v2": "external-mid",
  "fluid-dex": "legacy-mid",
  "protocol:erc4626": "protocol-mid",
  "protocol:erc4626-silo-redeem": "protocol-mid",
  "protocol:goldx": "protocol-mid",
  "protocol:metronome-synth": "protocol-mid",
  "protocol:metronome-hgusdc": "protocol-mid",
  "protocol:psm": "protocol-mid",
  "protocol:eigenpie": "protocol-mid",
  "protocol:rocksolid": "protocol-mid",
  "protocol:wsteth": "protocol-mid",
  "credit:fluid": null,
});

/** T1 baseline merge groups: familyId -> extra families merged into its descriptor. */
const mergeGroups = Object.freeze({
  "protocol:erc4626": Object.freeze(["protocol:erc4626-silo-redeem"]),
});

const fluidLegacyDescriptor = Object.freeze({
  edgeAdapterId: "fluid-dex-swap",
  poolAdapters: Object.freeze(["fluid-dex"]),
  slotKind: "swap",
  reason: "legacy Fluid DEX route; RouteAdapter migration is fixture-blocked",
});

function generatorSourceHash(): string {
  return createHash("sha256")
    .update(readFileSync(GENERATOR_SOURCE, "utf8"))
    .digest("hex");
}

function artifact(): unknown {
  return {
    schemaVersion: "blind-t1-baseline-v1",
    frozenAcceptanceVocabulary: true,
    registeredRouteFamilyIds,
    currentRouteFamilyIds,
    warmKindByFamily,
    mergeGroups,
    fluidLegacyDescriptor,
    generatedFrom: "listener/src/searcher/build-blind-t1-baseline.ts",
    generatorSourceHash: generatorSourceHash(),
  };
}

function main(): void {
  const mode = process.argv[2] ?? "--check";
  const next = artifact();
  if (mode === "--write") {
    writeFileSync(ARTIFACT_PATH, JSON.stringify(next, null, 2) + "\n");
    console.log("blind T1 baseline artifact written");
    return;
  }
  const current = JSON.parse(readFileSync(ARTIFACT_PATH, "utf8"));
  if (JSON.stringify(current) !== JSON.stringify(next)) {
    console.error(
      "blind T1 baseline artifact is stale; run build-blind-t1-baseline.ts --write",
    );
    process.exitCode = 1;
    return;
  }
  console.log("blind T1 baseline artifact check OK");
}

main();
