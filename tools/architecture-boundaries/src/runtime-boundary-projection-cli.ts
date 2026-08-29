#!/usr/bin/env node
import { encodeCanonicalJson } from "../../../packages/canonical-codec/src/index.ts";
import { issueRuntimeBoundaryProjectionV1, runBoundaryGate } from "./index.ts";

const args = process.argv.slice(2);
if (args.length !== 0) {
  process.stderr.write("runtime closure is selected by the fixed Boundary owner; no arguments are accepted\n");
  process.exit(64);
}

const receipt = runBoundaryGate({ requirePushed: true });
const projection = issueRuntimeBoundaryProjectionV1(receipt);
process.stdout.write(`${encodeCanonicalJson(projection)}\n`);
