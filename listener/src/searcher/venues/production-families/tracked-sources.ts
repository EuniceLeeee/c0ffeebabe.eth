import { execFile } from "node:child_process";
import { lstat } from "node:fs/promises";
import {
  basename,
  dirname,
  relative,
  resolve,
  sep,
} from "node:path";
import { promisify } from "node:util";

export const PRODUCTION_ENTRY_PATTERN =
  /^[a-z0-9][a-z0-9-]*\.production\.ts$/;

const PRODUCTION_SOURCE_DIRECTORY =
  "src/searcher/venues/production-families";
const execFileAsync = promisify(execFile);

export function productionFamilySourceDirectory(
  listenerRoot: string,
): string {
  return resolve(listenerRoot, PRODUCTION_SOURCE_DIRECTORY);
}

/**
 * Development/CI audit of git-index ownership. Production activation and
 * capability identity use the checked-in generated static import root and do
 * not invoke git at runtime.
 */
export async function trackedProductionSourceFiles(
  listenerRoot: string,
): Promise<readonly string[]> {
  const resolvedListenerRoot = resolve(listenerRoot);
  const repoRoot = resolve(resolvedListenerRoot, "..");
  const sourceDirectory = productionFamilySourceDirectory(resolvedListenerRoot);
  const relativeDirectory = relative(repoRoot, sourceDirectory)
    .split(sep)
    .join("/");
  const relativePattern = `${relativeDirectory}/*.production.ts`;
  const { stdout } = await execFileAsync(
    "git",
    ["ls-files", "--cached", "-z", "--", relativePattern],
    {
      cwd: repoRoot,
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
    },
  );
  const paths = stdout
    .split("\0")
    .filter((path) => path.length > 0)
    .sort();
  const names: string[] = [];
  for (const path of paths) {
    const name = basename(path);
    if (!PRODUCTION_ENTRY_PATTERN.test(name)) {
      throw new Error(`tracked production entry has an invalid name: ${path}`);
    }
    const sourcePath = resolve(repoRoot, path);
    if (dirname(sourcePath) !== sourceDirectory) {
      throw new Error(`tracked production entry escaped its directory: ${path}`);
    }
    const stat = await lstat(sourcePath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(`tracked production entry must be a regular file: ${path}`);
    }
    names.push(name);
  }
  return Object.freeze(names);
}
