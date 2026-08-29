#!/usr/bin/env node
import { writeSync } from "node:fs";
import { encodeCanonicalBytes } from "../../../packages/canonical-codec/src/index.ts";
import { readPreReleaseFactLogAdvisoryV1 } from "./index.ts";

function main(argv: readonly string[]): void {
  if (argv.length !== 1) {
    throw new TypeError("usage: aloha-pre-release-fact-log <canonical-advisory-report.json>");
  }
  const records = readPreReleaseFactLogAdvisoryV1(argv[0]!);
  for (const record of records) {
    writeSync(process.stdout.fd, encodeCanonicalBytes(record));
    writeSync(process.stdout.fd, "\n");
  }
}

try {
  main(process.argv.slice(2));
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`aloha-pre-release-fact-log: ${message}\n`);
  process.exitCode = 1;
}
