import { readFile } from "node:fs/promises";
import {
  assertCaptureReproducible,
  validateArchitectureMigrationCaptureCorpus,
  writeArchitectureMigrationSideCapture,
} from "./architecture-migration-capture.js";

async function main(): Promise<void> {
  const checkOnly = process.argv[2] === "--check";
  const corpusPath = checkOnly ? process.argv[3] : process.argv[2];
  const outPath = checkOnly ? undefined : process.argv[3];
  if (corpusPath === undefined || (outPath === undefined && !checkOnly)) {
    throw new Error(
      "usage: tsx src/searcher/run-architecture-migration-capture-cli.ts " +
        "[--check] <corpus.json> [out-side.json]",
    );
  }
  const corpus = validateArchitectureMigrationCaptureCorpus(
    JSON.parse(await readFile(corpusPath, "utf8")),
  );
  if (checkOnly) {
    await assertCaptureReproducible(corpus);
    process.stdout.write("capture reproducible\n");
    return;
  }
  if (outPath === undefined) throw new Error("out-side.json is required");
  const captureId = await writeArchitectureMigrationSideCapture(
    corpus,
    outPath,
  );
  process.stdout.write(`capture written captureId=${captureId}\n`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
