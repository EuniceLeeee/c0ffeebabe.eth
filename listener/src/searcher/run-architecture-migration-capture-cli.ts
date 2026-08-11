import { readFile } from "node:fs/promises";
import {
  validateArchitectureMigrationCaptureCorpus,
  writeArchitectureMigrationSideCapture,
} from "./architecture-migration-capture.js";

async function main(): Promise<void> {
  const corpusPath = process.argv[2];
  const outPath = process.argv[3];
  if (corpusPath === undefined || outPath === undefined) {
    throw new Error(
      "usage: tsx src/searcher/run-architecture-migration-capture-cli.ts " +
        "<corpus.json> <out-side.json>",
    );
  }
  const corpus = validateArchitectureMigrationCaptureCorpus(
    JSON.parse(await readFile(corpusPath, "utf8")),
  );
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
