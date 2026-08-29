import { rmSync } from "node:fs";
import { resolve } from "node:path";
import {
  createGitIndexSnapshot,
  executeMaterializedIndexCli,
  installSnapshotCompilerDependencies,
} from "./index-snapshot.ts";

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}
const repoPath = resolve(argument("--repo") ?? new URL("../../..", import.meta.url).pathname);
const referenceRepoPath = resolve(argument("--reference-repo") ?? "/private/tmp/mev-s1-impl");
const useIndexSnapshot = process.argv.includes("--index-snapshot");
const materializedIndexRoot = process.argv.includes("--materialized-index-root");
const generate = process.argv.includes("--generate");
if (useIndexSnapshot && (generate || materializedIndexRoot)) {
  throw new TypeError("index snapshot launcher flags are mutually exclusive");
}

if (useIndexSnapshot) {
  const snapshotRoot = createGitIndexSnapshot(repoPath);
  try {
    installSnapshotCompilerDependencies(snapshotRoot);
    executeMaterializedIndexCli(snapshotRoot, [
      "--repo", snapshotRoot,
      "--reference-repo", referenceRepoPath,
      "--materialized-index-root",
    ]);
  } finally {
    rmSync(snapshotRoot, { recursive: true, force: true });
  }
} else {
  const { runReferenceLockIntegrityCli } = await import("./runtime-cli.ts");
  process.exitCode = await runReferenceLockIntegrityCli({ repoPath, referenceRepoPath, generate });
}
