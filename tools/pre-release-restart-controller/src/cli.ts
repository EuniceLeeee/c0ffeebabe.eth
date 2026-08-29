#!/usr/bin/env node
import { encodeCanonicalJson } from "../../../packages/canonical-codec/src/index.ts";
import { runPreReleaseRestartControllerV1 } from "./controller-owner.ts";

const receipt = await runPreReleaseRestartControllerV1();
process.stdout.write(`${encodeCanonicalJson(receipt)}\n`);
