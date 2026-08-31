import { rmSync } from "node:fs";
import { resolve } from "node:path";
import {
  createGitIndexSnapshot,
  createWorkingTreeSnapshot,
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
const materializedWorkingTreeRoot = process.argv.includes("--materialized-working-tree-root");
const outputRepoArgument = argument("--output-repo");
const generate = process.argv.includes("--generate");
if (useIndexSnapshot && (generate || materializedIndexRoot || materializedWorkingTreeRoot || outputRepoArgument !== undefined)) {
  throw new TypeError("index snapshot launcher flags are mutually exclusive");
}
if (materializedIndexRoot && (generate || materializedWorkingTreeRoot || outputRepoArgument !== undefined)) {
  throw new TypeError("materialized index flags are mutually exclusive");
}
if (materializedWorkingTreeRoot !== (generate && outputRepoArgument !== undefined)) {
  throw new TypeError("materialized working-tree generation requires exact output repository binding");
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
} else if (generate && !materializedWorkingTreeRoot) {
  const snapshotRoot = createWorkingTreeSnapshot(repoPath);
  try {
    installSnapshotCompilerDependencies(snapshotRoot);
    executeMaterializedIndexCli(snapshotRoot, [
      "--repo", snapshotRoot,
      "--reference-repo", referenceRepoPath,
      "--materialized-working-tree-root",
      "--output-repo", repoPath,
      "--generate",
    ]);
  } finally {
    rmSync(snapshotRoot, { recursive: true, force: true });
  }
} else {
  const { runReferenceLockIntegrityCli } = await import("./runtime-cli.ts");
  process.exitCode = await runReferenceLockIntegrityCli({
    repoPath,
    referenceRepoPath,
    outputRepoPath: resolve(outputRepoArgument ?? repoPath),
    generate,
  });
}
