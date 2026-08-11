import { readFile, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import {
  architectureMigrationSideJson,
  buildFixtureCaptureCorpus,
  generateArchitectureMigrationSideCapture,
} from "./architecture-migration-capture.js";
import { captureUniv2RealCase } from
  "./architecture-migration-fixture-replay.js";

function currentCommit(): string {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim();
  } catch {
    return "unknown";
  }
}

async function main(): Promise<void> {
  const descriptorPath = process.argv[2];
  const outPath = process.argv[3];
  if (descriptorPath === undefined || outPath === undefined) {
    throw new Error(
      "usage: tsx src/searcher/run-architecture-migration-capture-real-cli.ts " +
        "<pool-descriptor.json> <out-side.json>",
    );
  }
  const descriptor = JSON.parse(await readFile(descriptorPath, "utf8")) as {
    readonly pool: string;
    readonly tokenA: string;
    readonly tokenB: string;
    readonly sourceBlock: number;
    readonly sourceBlockHash: string;
    readonly reserves?: {
      readonly reserve0: string;
      readonly reserve1: string;
      readonly blockTimestampLast?: number;
    };
    readonly captureId?: string;
    readonly commit?: string;
  };
  const source = Object.freeze({
    number: descriptor.sourceBlock,
    hash: descriptor.sourceBlockHash,
    generation: descriptor.sourceBlock,
  });
  const familyCase = await captureUniv2RealCase({
    source,
    pool: descriptor.pool,
    tokenA: descriptor.tokenA,
    tokenB: descriptor.tokenB,
    reserves: descriptor.reserves,
  });
  const corpus = {
    ...buildFixtureCaptureCorpus({
      captureId: descriptor.captureId ?? "challenger",
      commit: descriptor.commit ?? currentCommit(),
      source,
      familyCases: [familyCase],
    }),
    productionClosureHash: "aa".repeat(32),
  };
  await writeFile(
    outPath,
    architectureMigrationSideJson(
      generateArchitectureMigrationSideCapture(corpus),
    ),
    "utf8",
  );
  process.stdout.write(`challenger real capture written: ${outPath}\n`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
