import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { encodeIntegrityReport, generateAuthorityArtifacts, validateReferenceLockIntegrity } from "./index.ts";

export interface ReferenceLockIntegrityCliInputV1 {
  readonly repoPath: string;
  readonly referenceRepoPath: string;
  readonly outputRepoPath: string;
  readonly generate: boolean;
}

export async function runReferenceLockIntegrityCli(input: ReferenceLockIntegrityCliInputV1): Promise<number> {
  const options = { repoPath: input.repoPath, referenceRepoPath: input.referenceRepoPath };
  let generatedArtifacts: Awaited<ReturnType<typeof generateAuthorityArtifacts>> | null = null;
  if (input.generate) {
    generatedArtifacts = await generateAuthorityArtifacts(options);
    for (const [path, bytes] of generatedArtifacts.bytes) {
      mkdirSync(dirname(resolve(input.outputRepoPath, path)), { recursive: true });
      writeFileSync(resolve(input.outputRepoPath, path), bytes, "utf8");
    }
  }
  const report = await validateReferenceLockIntegrity({
    ...options,
    artifacts: generatedArtifacts?.bytes,
    canonicalGeneration: generatedArtifacts ?? undefined,
  });
  process.stdout.write(`${encodeIntegrityReport(report)}\n`);
  return report.verdict === "pass" ? 0 : 1;
}
