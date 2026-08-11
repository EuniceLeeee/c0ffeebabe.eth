import { readFile } from "node:fs/promises";
import {
  createArchitectureMigrationProductionCaptureIssuer,
  runArchitectureMigrationParityFiles,
  type ArchitectureMigrationBatchInput,
  type ArchitectureMigrationEvidenceClass,
} from "./architecture-migration-parity-runner.js";
import type { ArchitectureMigrationMode } from
  "./architecture-migration-parity.js";

interface BatchRequestFile {
  readonly baselinePath: string;
  readonly challengerPath: string;
  readonly evidenceClass: ArchitectureMigrationEvidenceClass;
  readonly mode: ArchitectureMigrationMode;
  readonly stateAnchors: ArchitectureMigrationBatchInput["stateAnchors"];
  readonly performanceDiagnostics: ArchitectureMigrationBatchInput["performanceDiagnostics"];
  readonly declaredDeltas?: ArchitectureMigrationBatchInput["declaredDeltas"];
}

async function main(): Promise<void> {
  const requestPath = process.argv[2];
  if (requestPath === undefined) {
    throw new Error(
      "usage: tsx src/searcher/run-architecture-migration-parity-cli.ts <batch-request.json>",
    );
  }
  const request = JSON.parse(await readFile(requestPath, "utf8")) as
    BatchRequestFile;
  const productionCaptureIssuer =
    request.evidenceClass === "sealed-production"
      ? createArchitectureMigrationProductionCaptureIssuer()
      : undefined;
  const receipt = await runArchitectureMigrationParityFiles({
    ...request,
    productionCaptureIssuer,
  });
  process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
