import { readFile } from "node:fs/promises";
import {
  assertParityEvidenceBundle,
  writeParityEvidenceBundle,
} from "./architecture-migration-evidence.js";

async function main(): Promise<void> {
  const checkOnly = process.argv[2] === "--check";
  const arg = checkOnly ? process.argv[3] : process.argv[2];
  const outDir = checkOnly ? undefined : process.argv[3];
  if (arg === undefined || (outDir === undefined && !checkOnly)) {
    throw new Error(
      "usage: tsx src/searcher/run-parity-evidence-cli.ts " +
        "[--check] <input.json|bundle-dir> [out-dir]",
    );
  }
  if (checkOnly) {
    const manifest = await assertParityEvidenceBundle(arg);
    process.stdout.write(
      `evidence bundle valid ${manifest.acceptance.verdict} ` +
        `${manifest.baseline.commit.slice(0, 8)}..${manifest.challenger.commit.slice(0, 8)}\n`,
    );
    return;
  }
  const input = JSON.parse(await readFile(arg, "utf8")) as {
    readonly baselinePath: string;
    readonly challengerPath: string;
    readonly receiptPath: string;
  };
  const manifest = await writeParityEvidenceBundle({ ...input, outDir: outDir! });
  process.stdout.write(
    `evidence bundle written: ${outDir} ` +
      `eligible=${manifest.acceptance.eligible} verdict=${manifest.acceptance.verdict}\n`,
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
