import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import {
  canonicalJson,
  compareBlindRun,
  type BlindOracleReveal,
  type BlindRunManifest,
  type SealedBlindProducerOutput,
} from "./adapter-family-blind-contract.js";

export function compareSealedBlindArtifacts(input: {
  readonly manifest: BlindRunManifest;
  readonly outputs: readonly SealedBlindProducerOutput[];
  readonly reveal: BlindOracleReveal;
}): ReturnType<typeof compareBlindRun> {
  assertOracleInvisibleFromProducer(input.manifest, input.reveal);
  return compareBlindRun(input.manifest, input.outputs, input.reveal);
}

export function assertOracleInvisibleFromProducer(
  manifest: BlindRunManifest,
  reveal: BlindOracleReveal,
): void {
  const producerSurface = canonicalJson({
    baseline: manifest.producers.baseline.cases,
    challenger: manifest.producers.challenger.cases,
  }).toLowerCase();
  const sensitive = new Set<string>([
    reveal.oracle.transactionId,
    ...reveal.oracle.expectedOrderedEdgeIds,
    ...reveal.oracle.expectedRequiredStateKeys,
    ...reveal.oracle.expectedPricedEdgeIds,
    reveal.oracle.expectedSimulation.profitRaw,
    reveal.oracle.expectedSimulation.gasUsed,
    reveal.oracle.expectedSimulation.calldataSha256,
    reveal.oracle.expectedEv.reason,
    ...reveal.oracle.targetRoute.flatMap((step) => [
      step.familyId,
      step.adapterId,
      step.target,
      step.tokenIn,
      step.tokenOut,
      step.executionVariantKey,
    ]),
  ].map((value) => value.toLowerCase()).filter((value) => value.length >= 12));
  for (const value of sensitive) {
    if (producerSurface.includes(value)) {
      throw new Error(`producer argv/env contains sealed oracle value ${redact(value)}`);
    }
  }
}

function parseArgs(args: readonly string[]): {
  manifestPath: string;
  outputsPath: string;
  revealPath: string;
  outPath: string;
} {
  const parsed: Record<string, string> = {};
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (!value) throw new Error(`${name} requires a value`);
    parsed[name ?? ""] = value;
  }
  const manifestPath = parsed["--manifest"];
  const outputsPath = parsed["--outputs"];
  const revealPath = parsed["--oracle-reveal"];
  const outPath = parsed["--out"];
  if (!manifestPath || !outputsPath || !revealPath || !outPath) {
    throw new Error(
      "usage: --manifest <manifest.json> --outputs <sealed-producer-outputs.json> " +
        "--oracle-reveal <private.json> --out <comparison.json>",
    );
  }
  return { manifestPath, outputsPath, revealPath, outPath };
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const report = compareSealedBlindArtifacts({
    manifest: JSON.parse(readFileSync(args.manifestPath, "utf8")) as BlindRunManifest,
    outputs: JSON.parse(
      readFileSync(args.outputsPath, "utf8"),
    ) as SealedBlindProducerOutput[],
    reveal: JSON.parse(readFileSync(args.revealPath, "utf8")) as BlindOracleReveal,
  });
  writeFileSync(args.outPath, `${canonicalJson(report)}\n`, { mode: 0o600 });
  console.log(`BLIND_COMPARISON_REPORT=${canonicalJson(report)}`);
  if (report.overall !== "pass") process.exitCode = 1;
}

function redact(value: string): string {
  return value.length <= 16 ? "<redacted>" : `${value.slice(0, 8)}…${value.slice(-6)}`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
