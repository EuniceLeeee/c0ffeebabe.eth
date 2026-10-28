import { constants } from "node:fs";
import { copyFile, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UniverseRebuildCheckpointStore } from "./universe-rebuild-checkpoint.js";

async function signature(path: string): Promise<string | null> {
  try {
    const s = await stat(path, { bigint: true });
    return [s.dev, s.ino, s.size, s.mtimeNs, s.ctimeNs].join(":");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function copyIfPresent(from: string, to: string): Promise<void> {
  try {
    await copyFile(from, to, constants.COPYFILE_FICLONE);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

/** Point-in-time diagnostic snapshot, never a Ready/admission authority.
 * Store.load takes the writer lock and can hold it longer than a producer's
 * lock timeout while validating a large checkpoint. Validate a private copy
 * instead. Base compaction is an atomic rename; journal appends may leave a
 * partial final record, which the existing reader already ignores and checks.
 */
export async function loadCheckpointStatusSnapshot(path: string) {
  let lastError: unknown = new Error("Checkpoint changed during status snapshot");
  for (let attempt = 0; attempt < 3; attempt++) {
    const directory = await mkdtemp(join(tmpdir(), "mev-checkpoint-status-"));
    try {
      const before = await signature(path);
      const snapshot = join(directory, "checkpoint.json");
      await copyIfPresent(path, snapshot);
      await copyIfPresent(path + ".attestation-journal", snapshot + ".attestation-journal");
      if (before !== await signature(path)) continue;
      return await new UniverseRebuildCheckpointStore({ path: snapshot }).load();
    } catch (error) {
      // A compacted base can briefly coexist with its old journal. Retry the
      // whole copy; persistent corruption still fails through the same parser.
      lastError = error;
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
  throw lastError;
}
