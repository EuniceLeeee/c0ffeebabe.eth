#!/usr/bin/env node
import {
  readFileSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import {
  evaluateSixStepJudgment,
} from "../six-step-judgment.js";

const parsed = parseArgs(process.argv.slice(2));
let output: ReturnType<typeof evaluateSixStepJudgment>;
try {
  if (parsed.error) throw new Error(parsed.error);
  if (!parsed.input) {
    throw new Error("usage: --input <semantic-receipt.json> [--out <json>]");
  }
  output = evaluateSixStepJudgment(
    JSON.parse(readFileSync(resolve(parsed.input), "utf8")) as unknown,
  );
} catch (error) {
  output = evaluateSixStepJudgment(null);
  output = {
    ...output,
    errors: [
      error instanceof Error ? error.message : String(error),
    ],
  };
}

const serialized = `${JSON.stringify(output, null, 2)}\n`;
if (parsed.out) {
  writeFileSync(resolve(parsed.out), serialized, { mode: 0o600 });
}
process.stdout.write(serialized);
process.exit(output.verdict === "pass" ? 0 : 1);

function parseArgs(values: readonly string[]): {
  input?: string;
  out?: string;
  error?: string;
} {
  const parsed: { input?: string; out?: string; error?: string } = {};
  for (let index = 0; index < values.length; index += 2) {
    const name = values[index];
    const value = values[index + 1];
    if (
      (name !== "--input" && name !== "--out") ||
      !value ||
      value.startsWith("--")
    ) {
      return {
        ...parsed,
        error: "usage: --input <semantic-receipt.json> [--out <json>]",
      };
    }
    const key = name === "--input" ? "input" : "out";
    if (parsed[key]) {
      return { ...parsed, error: `${name} may appear only once` };
    }
    parsed[key] = value;
  }
  return parsed;
}
