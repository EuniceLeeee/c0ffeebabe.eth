// Local Forge fixture encoder; calls the actual Family emitter. It supplies no
// admission/price evidence and never connects to a chain or changes production.
import assert from "node:assert/strict";
import { ethers } from "ethers";
import { plugin } from "../../../production-families/psv.production.js";
import { fixture, setup, source, implementationCode } from "./fixtures.js";
const [target, implementation, gem, stable, executor, recipient, direction, gemDecimals, stableDecimals, mode] = process.argv.slice(2);
assert(["direct-output", "quote-output", "default"].includes(mode!));
const f = { ...fixture(), target: target.toLowerCase(), implementation: implementation.toLowerCase(), gem: gem.toLowerCase(), stable: stable.toLowerCase(), code: implementationCode(implementation.toLowerCase()), gemDecimals: Number(gemDecimals), stableDecimals: Number(stableDecimals) };
// Compile the descriptor from the independently checked source template's
// fixture identity. Local EVM installation and controls are owned by the test.
const { d, rs } = setup(f);
const leg = plugin.execution.buildRuntimeLeg!({ descriptor: d, route: rs[Number(direction)], source, executor, runtimeEvidence: [],
  ...(mode === "default" ? {} : { settlement: { kind: mode as "direct-output" | "quote-output", recipient } }) });
assert(leg); process.stdout.write(ethers.hexlify(ethers.getBytes(leg.program)));
