import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { encodeIntegrityReport, generateAuthorityArtifacts, validateReferenceLockIntegrity } from "./index.ts";
import { createWorkingTreeSnapshot, installSnapshotCompilerDependencies } from "./index-snapshot.ts";

export interface ReferenceLockIntegrityCliInputV1 {
  readonly repoPath: string;
  readonly referenceRepoPath: string;
  readonly generate: boolean;
}

export async function runReferenceLockIntegrityCli(input: ReferenceLockIntegrityCliInputV1): Promise<number> {
  const snapshotRoot = input.generate ? createWorkingTreeSnapshot(input.repoPath) : null;
  const authorityRepoPath = snapshotRoot ?? input.repoPath;
  if (snapshotRoot !== null) installSnapshotCompilerDependencies(snapshotRoot);
  const options = { repoPath: authorityRepoPath, referenceRepoPath: input.referenceRepoPath };
  try {
    let generatedArtifacts: Awaited<ReturnType<typeof generateAuthorityArtifacts>> | null = null;
    if (input.generate) {
      generatedArtifacts = await generateAuthorityArtifacts(options);
      for (const [path, bytes] of generatedArtifacts.bytes) {
        mkdirSync(dirname(resolve(input.repoPath, path)), { recursive: true });
        writeFileSync(resolve(input.repoPath, path), bytes, "utf8");
      }
    }
    const report = await validateReferenceLockIntegrity({
      ...options,
      artifacts: generatedArtifacts?.bytes,
      canonicalGeneration: generatedArtifacts ?? undefined,
    });
    process.stdout.write(`${encodeIntegrityReport(report)}\n`);
    return report.verdict === "pass" ? 0 : 1;
  } finally {
    if (snapshotRoot !== null) rmSync(snapshotRoot, { recursive: true, force: true });
  }
}
