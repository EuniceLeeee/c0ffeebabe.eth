#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import {
  freezeTrustedSixStepInputs,
  runTrustedSixStepValidation,
} from "../six-step-validation-controller.js";
import {
  cleanupFinalValidatedBranch,
  type SixStepFinalEvidence,
} from "../six-step-validation-lifecycle.js";

const args = process.argv.slice(2);
const parsed = parseArgs(args);
const requestPath = parsed.values.request
  ? resolve(parsed.values.request) : null;
const outputPath = parsed.values.out ? resolve(parsed.values.out) : null;
const phase = parsed.values.phase;
const freeze = parsed.flags.has("freeze-inputs");
const cleanup = parsed.flags.has("finalize-cleanup");

try {
  if (parsed.error) throw new Error(parsed.error);
  if (!requestPath || !outputPath) throw new Error(
    "usage: --freeze-inputs --request <json> --out <snapshot> | " +
    "--phase checkpoint|final --request <json> --out <receipt>",
  );
  if (freeze && phase) throw new Error("--freeze-inputs does not accept --phase");
  if (!freeze && phase !== "checkpoint" && phase !== "final") {
    throw new Error("--phase must be checkpoint or final");
  }
  if (cleanup && phase !== "final") {
    throw new Error("--finalize-cleanup is allowed only in final phase");
  }
  const request = JSON.parse(readFileSync(requestPath, "utf8")) as unknown;
  if (freeze) {
    await freezeTrustedSixStepInputs({ request, snapshotPath: outputPath });
    emit(0, {
      phase: "freeze_inputs", status: "inputs_frozen",
      request_path: requestPath, evidence_path: outputPath,
    });
  }
  if (!request || typeof request !== "object" || Array.isArray(request) ||
      (request as Record<string, unknown>).mode !== phase) {
    throw new Error(`request mode must equal requested phase ${phase}`);
  }
  const result = await runTrustedSixStepValidation({
    request, evidencePath: outputPath,
  });
  const root = repoRoot();
  const removed = cleanup
    ? cleanupFinalValidatedBranch(
        result.evidence as SixStepFinalEvidence, root,
      ) : undefined;
  emit(0, {
    phase, status: result.evidence.status, request_path: requestPath,
    evidence_path: result.evidencePath,
    raw_producer_path: result.rawProducerPath,
    ...(removed ? { cleanup: removed } : {}),
  });
} catch (error) {
  emit(1, {
    phase: freeze ? "freeze_inputs" : phase ?? null,
    status: null, request_path: requestPath, evidence_path: outputPath,
    errors: [error instanceof Error ? error.message : String(error)],
  });
}

function parseArgs(values: string[]): {
  values: Record<string, string>;
  flags: Set<string>;
  error?: string;
} {
  const result = { values: {} as Record<string, string>, flags: new Set<string>() };
  for (let index = 0; index < values.length; index++) {
    const key = values[index].replace(/^--/, "");
    if (["finalize-cleanup", "freeze-inputs"].includes(key)) {
      if (result.flags.has(key)) return { ...result, error: `--${key} repeated` };
      result.flags.add(key);
    } else if (["request", "out", "phase"].includes(key)) {
      const next = values[++index];
      if (!next || next.startsWith("--")) {
        return { ...result, error: `--${key} requires a value` };
      }
      result.values[key] = next;
    } else return { ...result, error: `unknown option --${key}` };
  }
  return result;
}

function repoRoot(): string {
  const result = spawnSync("git", ["rev-parse", "--show-toplevel"], {
    encoding: "utf8",
  });
  if (result.status !== 0) throw new Error("not inside a git repository");
  return result.stdout.trim();
}

function emit(code: number, fields: Record<string, unknown>): never {
  process.stdout.write(`${JSON.stringify({
    schema_version: 1, gate: "six-step-validation-lifecycle",
    verdict: code === 0 ? "pass" : "fail", raw_producer_path: null,
    errors: [], ...fields,
  })}\n`);
  process.exit(code);
}
