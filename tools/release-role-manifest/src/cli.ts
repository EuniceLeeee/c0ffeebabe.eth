import { checkGeneratedReleaseRoleManifest, generateReleaseRoleManifest, writeGeneratedReleaseRoleManifest } from "./index.ts";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

function findRepositoryRoot(start: string): string {
  let current = resolve(start);
  while (true) {
    const packagePath = resolve(current, "package.json");
    if (existsSync(packagePath)) {
      try {
        const value = JSON.parse(readFileSync(packagePath, "utf8")) as Record<string, unknown>;
        if (Array.isArray(value.workspaces)) return current;
      } catch {
        // Continue to the parent; the boundary will report a malformed root.
      }
    }
    const parent = dirname(current);
    if (parent === current) throw new Error("repository root with workspaces package.json not found");
    current = parent;
  }
}

const repositoryRoot = findRepositoryRoot(process.cwd());
const options = {
  repositoryRoot,
} as const;

const args = process.argv.slice(2);
if (args.some((arg) => arg !== "--check")) {
  throw new Error("usage: generate-release-role-manifest [--check]");
}
if (args.includes("--check")) {
  const errors = await checkGeneratedReleaseRoleManifest(options);
  if (errors.length > 0) {
    process.stderr.write(`${errors.join("\n")}\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write("release-role-manifest: exact\n");
  }
} else {
const result = await generateReleaseRoleManifest(options);
writeGeneratedReleaseRoleManifest(result, options);
process.stdout.write(`${result.manifest.rootDigest}\n`);
}
