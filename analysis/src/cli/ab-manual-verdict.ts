#!/usr/bin/env node
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { AbVerdict, ManualVerdictArtifact } from "../ab-canary.js";

const args = process.argv.slice(2);
const value = (name: string): string | undefined => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
const experimentId = value("--experiment");
const author = value("--author");
const verdict = value("--verdict") as AbVerdict | undefined;
const evidence = value("--evidence");
const aLog = value("--a-log");
const bLog = value("--b-log");
const out = value("--out");
if (!experimentId || !author || !verdict || !evidence || !aLog || !bLog || !out
    || !(["win", "lose", "inconclusive"] as string[]).includes(verdict)) {
  throw new Error("usage: ab-manual-verdict --experiment <id> --author <name> --verdict win|lose|inconclusive --evidence <text> --a-log <path> --b-log <path> --out <json>");
}
if (fs.existsSync(out)) throw new Error("manual verdict artifact already exists; refuse to rewrite chronology");
const aSource = fs.readFileSync(aLog);
const bSource = fs.readFileSync(bLog);
const artifact: ManualVerdictArtifact = {
  schema_version: 2,
  experiment_id: experimentId,
  author,
  verdict,
  evidence,
  written_at: new Date().toISOString(),
  a_log_sha256: createHash("sha256").update(aSource).digest("hex"),
  b_log_sha256: createHash("sha256").update(bSource).digest("hex"),
  a_log_bytes: aSource.length,
  b_log_bytes: bSource.length,
  seal_nonce: randomBytes(24).toString("hex"),
};
fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
fs.writeFileSync(out, `${JSON.stringify(artifact, null, 2)}\n`, { flag: "wx", mode: 0o600 });
console.log(JSON.stringify(artifact));
