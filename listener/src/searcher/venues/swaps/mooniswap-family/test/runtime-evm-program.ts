// Opt-in local EVM fixture. Synthetic identity; emitted production bytecode only.
import assert from "node:assert/strict";
import { ethers } from "ethers";
import { instanceKey } from "../../../adapter-family-identifiers.js";
import { MOONISWAP_ID, MOONISWAP_LINEAGE } from "../codec.js";
import { mooniswapRoutes } from "../routes.js";
import { buildMooniswapRuntimeLeg } from "../runtime-execution.js";
import type { MooniswapDescriptor } from "../types.js";

const [pool, token0, token1, executor, recipient, direction, mode] = process.argv.slice(2);
assert(pool && token0 && token1 && executor && recipient && ["0", "1"].includes(direction!));
assert(mode === "direct-output" || mode === "quote-output");
const descriptor: MooniswapDescriptor = { familyId: MOONISWAP_ID, lineageId: MOONISWAP_LINEAGE,
  instanceKey: instanceKey(pool.toLowerCase()), pool, token0, token1,
  codeHash: ethers.ZeroHash, provenance: [], runtimeRequirements: [] };
const route = mooniswapRoutes.project({ descriptor })[Number(direction)]!;
const leg = buildMooniswapRuntimeLeg({ descriptor, route, executor, runtimeEvidence: [],
  source: { number: 1, generation: 1, hash: ethers.ZeroHash }, settlement: { kind: mode, recipient } });
assert(leg); process.stdout.write(leg.program);
