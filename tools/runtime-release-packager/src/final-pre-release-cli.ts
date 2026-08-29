#!/usr/bin/env node
import { encodeCanonicalJson } from "../../../packages/canonical-codec/src/index.ts";
import { runBoundaryGate } from "../../architecture-boundaries/src/index.ts";
import { runFinalPreReleaseV1 } from "./final-pre-release-runner.ts";

if (process.argv.length !== 2) throw new TypeError("final pre-release CLI accepts no arguments");
const receipt = runBoundaryGate({ requirePushed: true });
if (receipt.verdict !== "pass") throw new TypeError("final pre-release Boundary gate did not pass");
const result = await runFinalPreReleaseV1(receipt);
process.stdout.write(`${encodeCanonicalJson(result)}\n`);
