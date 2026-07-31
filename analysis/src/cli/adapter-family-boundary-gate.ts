#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  evaluateAdapterFamilyBoundary,
} from "../adapter-family-boundary.js";
import type {
  FamilyOwnershipManifest,
} from "../../../listener/src/searcher/test/family-ownership-manifest.js";

const MANIFEST = "listener/src/searcher/test/family-ownership-manifest.ts";
const TSX = import.meta.resolve("tsx");

interface CliConfig {
  baseline: string;
  candidate: string;
  out: string;
}

const temp = realpathSync(
  mkdtempSync(resolve(tmpdir(), "adapter-family-boundary-")),
);
let baseWorktree: string | null = null;
let candidateWorktree: string | null = null;
let outputPath: string | null = null;
let baselineCommit: string | null = null;
let candidateCommit: string | null = null;
let changedPaths: string[] = [];
try {
  const cfg = parseArgs(process.argv.slice(2));
  outputPath = resolve(cfg.out);
  const root = gitOut(process.cwd(), ["rev-parse", "--show-toplevel"]);
  const baseline = gitOut(root, [
    "rev-parse",
    `${cfg.baseline}^{commit}`,
  ]).toLowerCase();
  baselineCommit = baseline;
  const candidate = gitOut(root, [
    "rev-parse",
    `${cfg.candidate}^{commit}`,
  ]).toLowerCase();
  candidateCommit = candidate;
  if (
    git(root, [
      "merge-base",
      "--is-ancestor",
      baseline,
      candidate,
    ]).status !== 0
  ) {
    throw new Error("baseline must be an ancestor of candidate");
  }
  changedPaths = gitOut(root, [
    "diff",
    "--name-only",
    `${baseline}..${candidate}`,
  ]).split(/\r?\n/).filter(Boolean);
  baseWorktree = createWorktree(root, temp, baseline, "baseline");
  candidateWorktree = createWorktree(
    root,
    temp,
    candidate,
    "candidate",
  );
  const result = evaluateAdapterFamilyBoundary({
    baseCommit: baseline,
    candidateCommit: candidate,
    changedPaths,
    baseManifest: loadManifest(baseWorktree),
    candidateManifest: loadManifest(candidateWorktree),
    sourceAt(commit, path) {
      const shown = git(root, ["show", `${commit}:${path}`]);
      return shown.status === 0 ? shown.stdout : null;
    },
  });
  const output = {
    schema_version: 1,
    gate: "adapter-family-boundary",
    baseline_commit: baseline,
    candidate_commit: candidate,
    changed_paths: changedPaths,
    classification: result.classification,
    impacted_family_ids: result.impactedFamilyIds,
    changed_runtime_files: result.runtimeChangedPaths,
    reasons: result.reasons,
    other_family_source_set_baseline_sha256:
      result.otherFamilySourceSetBaselineSha256,
    other_family_source_set_candidate_sha256:
      result.otherFamilySourceSetCandidateSha256,
    required_action: result.classification === "family_local"
      ? "continue adapter-family implementation"
      : "keep family-local work here; move every listed non-family change " +
        "to a separate branch before continuing",
  };
  writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`, {
    mode: 0o600,
  });
  process.stdout.write(
    `ADAPTER_FAMILY_BOUNDARY_RESULT=${JSON.stringify(output)}\n`,
  );
  if (result.classification !== "family_local") process.exitCode = 1;
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  const output = {
    schema_version: 1,
    gate: "adapter-family-boundary",
    baseline_commit: baselineCommit,
    candidate_commit: candidateCommit,
    changed_paths: changedPaths,
    classification: "framework",
    impacted_family_ids: [],
    changed_runtime_files: changedPaths.filter(
      (path) => path.startsWith("listener/src/") && !path.includes("/test/"),
    ),
    reasons: [`gate_error: ${message}`],
    required_action:
      "keep family-local work here; inspect every changed path and move " +
      "non-family or manifest-incompatible changes to a separate branch",
  };
  if (outputPath) {
    try {
      writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`, {
        mode: 0o600,
      });
    } catch {
      // The machine-readable stdout result remains available even when the
      // requested output path itself is unusable.
    }
  }
  process.stdout.write(
    `ADAPTER_FAMILY_BOUNDARY_RESULT=${JSON.stringify(output)}\n`,
  );
  process.stderr.write(
    `adapter-family-boundary-gate: ${message}\n`,
  );
  process.exitCode = 1;
} finally {
  const rootResult = git(process.cwd(), ["rev-parse", "--show-toplevel"]);
  if (rootResult.status === 0) {
    const root = rootResult.stdout.trim();
    if (baseWorktree) {
      git(root, ["worktree", "remove", "--force", baseWorktree]);
    }
    if (candidateWorktree) {
      git(root, ["worktree", "remove", "--force", candidateWorktree]);
    }
  }
  rmSync(temp, { recursive: true, force: true });
}

function parseArgs(args: readonly string[]): CliConfig {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (
      !["--baseline", "--candidate", "--out"].includes(name ?? "") ||
      !value ||
      value.startsWith("--") ||
      values.has(name)
    ) {
      throw new Error(
        "usage: --baseline <ref> --candidate <ref> --out <json>",
      );
    }
    values.set(name, value);
  }
  if (
    values.size !== 3 ||
    !values.has("--baseline") ||
    !values.has("--candidate") ||
    !values.has("--out")
  ) {
    throw new Error(
      "usage: --baseline <ref> --candidate <ref> --out <json>",
    );
  }
  return {
    baseline: values.get("--baseline")!,
    candidate: values.get("--candidate")!,
    out: values.get("--out")!,
  };
}

function createWorktree(
  root: string,
  parent: string,
  commit: string,
  name: string,
): string {
  const target = resolve(parent, name);
  const result = git(root, [
    "worktree",
    "add",
    "--detach",
    target,
    commit,
  ]);
  if (result.status !== 0) {
    throw new Error(result.stderr || "git worktree add failed");
  }
  for (const path of ["analysis/node_modules", "listener/node_modules"]) {
    const source = resolve(root, path);
    if (!existsSync(source)) {
      throw new Error(`missing local toolchain: ${path}`);
    }
    symlinkSync(source, resolve(target, path), "dir");
  }
  return target;
}

function loadManifest(cwd: string): FamilyOwnershipManifest {
  const manifestTemp = realpathSync(
    mkdtempSync(resolve(tmpdir(), "adapter-family-manifest-")),
  );
  const outputPath = resolve(manifestTemp, "manifest.json");
  const env: NodeJS.ProcessEnv = {
    SEARCHER_TEST_DISABLE_DOTENV: "1",
  };
  for (const key of [
    "PATH",
    "TMPDIR",
    "TMP",
    "TEMP",
    "LANG",
    "LC_ALL",
    "TZ",
  ]) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  try {
    const result = spawnSync(process.execPath, [
      "--import",
      TSX,
      resolve(cwd, MANIFEST),
      "--out",
      outputPath,
    ], { cwd, env, encoding: "utf8" });
    if (result.status !== 0) {
      throw new Error(result.stderr || "family manifest failed");
    }
    return JSON.parse(
      readFileSync(outputPath, "utf8"),
    ) as FamilyOwnershipManifest;
  } finally {
    rmSync(manifestTemp, { recursive: true, force: true });
  }
}

function gitOut(cwd: string, args: readonly string[]): string {
  const result = git(cwd, args);
  if (result.status !== 0) {
    throw new Error(result.stderr || `git ${args[0]} failed`);
  }
  return result.stdout.trim();
}

function git(
  cwd: string,
  args: readonly string[],
): { status: number; stdout: string; stderr: string } {
  const result = spawnSync("git", [...args], { cwd, encoding: "utf8" });
  if (result.error) throw result.error;
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}
