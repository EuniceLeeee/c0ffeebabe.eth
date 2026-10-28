import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { ethers } from "ethers";
import { applyRuntimeAssetBoundary, mapRuntimeAssetSettlementRequest } from "../../../../execution-asset-boundary.js";
import { runtimeProgramScript } from "../../../../../adapters/runtime-amount-program.js";
import { instanceKey } from "../../../adapter-family-identifiers.js";
import { plugin } from "../../../production-families/precision-pool.production.js";
import { descriptor } from "./fixtures.js";
import { binding } from "../instance.js";
import { hashCanonical } from "../../../canonical-value.js";
const addr = (n: number) => ethers.getAddress(ethers.toBeHex(n, 20)).toLowerCase();
const actor = addr(71), receiver = addr(91), pool = addr(81);
// Synthetic test descriptor, never admitted or published into Ready. Identity
// proofs have their own production lifecycle test using the recorded runtime.
const d = { ...descriptor(), pool, instanceKey: instanceKey(pool), token0: ethers.ZeroAddress, token1: addr(84) };
const programs: Record<string, string> = {};
for (const [i, route] of plugin.routes.project({ descriptor: d }).entries()) {
  for (const [kind, recipient] of [["default", null], ["self", actor], ["external", receiver]] as const) {
    const request = recipient ? { kind: "direct-output" as const, recipient } : undefined;
    const mapped = mapRuntimeAssetSettlementRequest({ route, executor: actor, request }); assert(mapped !== null);
    const input = { descriptor: d, route, executor: actor, runtimeEvidence: [], ...(mapped ? { settlement: mapped } : {}) };
    for (const key of ["amountIn", "quotedAmountOut", "exactEvidence", "minAmountOut"])
      Object.defineProperty(input, key, { get() { throw Error("runtime construction accessed " + key); } });
    const raw = plugin.execution.buildRuntimeLeg(input); assert(raw);
    assert.deepEqual(raw.settlementRequest, mapped);
    const leg = applyRuntimeAssetBoundary({ route, executor: actor, leg: { ...raw, ...(request ? { settlementRequest: request } : {}) } });
    for (const amount of [0n, 1n, 100n]) programs[`${i}_${kind}_${amount}`] = ethers.hexlify(runtimeProgramScript(ethers.getBytes(leg.program), amount));
  }
  for (const amount of [1n, 100n]) {
    const amountOut = amount * 2n;
    const fragment = plugin.execution.buildFragment({ descriptor: d, route, executor: actor, runtimeEvidence: [],
      amountIn: amount, quotedAmountOut: amountOut, minAmountOut: amountOut,
      exactEvidence: { kind: "precision-pool-chain-quote", source: { number: 1, hash: ethers.id("synthetic-evm"), generation: 1 },
        executor: actor, routeKey: route.routeKey, binding: hashCanonical(binding(d)), amountIn: amount, amountOut } });
    const node = fragment.nodes[0], script = plugin.actionAdapters[0].encode(node, actor, new Uint8Array());
    const leg = applyRuntimeAssetBoundary({ route, executor: actor,
      leg: { actionAdapterId: node.adapterId, program: ethers.hexlify(script.slice(36)) } });
    programs[`${i}_quoted_${amount}`] = ethers.hexlify(runtimeProgramScript(ethers.getBytes(leg.program), amount));
  }
}
const forgeIndex = process.argv.indexOf("--forge-bin"), forge = forgeIndex < 0 ? "forge" : process.argv[forgeIndex + 1];
assert(forge, "--forge-bin needs a path");
const repository = path.resolve(".."), directory = fs.mkdtempSync(path.join(repository, "logs/precision-recipient-evm-"));
const fixturePath = path.join(directory, "programs.json"); fs.writeFileSync(fixturePath, JSON.stringify(programs, null, 2) + "\n");
const result = spawnSync(forge, ["test", "--root", repository, "--match-path", "test/PrecisionPoolRecipient.t.sol",
  "--out", path.join(directory, "out"), "--cache-path", path.join(directory, "cache"), "-vv"], {
  cwd: repository, env: { ...process.env, ...Object.fromEntries(Object.entries(programs).map(([key, value]) => [`PRECISION_RECIPIENT_${key}`, value])) },
  encoding: "utf8", maxBuffer: 8 * 1024 * 1024,
});
const sources = ["src/BotVM.sol", "src/RuntimeAmountVM.sol", "test/PrecisionPoolRecipient.t.sol", "test/CurvePlainRecipient.t.sol",
  "listener/src/adapters/runtime-amount-program.ts", "listener/src/searcher/venues/runtime-execution.ts",
  "listener/src/searcher/execution-asset-boundary.ts", "listener/src/searcher/venues/production-families/precision-pool.production.ts",
  ...["codec.ts", "routes.ts", "instance.ts", "types.ts", "runtime.ts", "runtime-execution.ts", "execution.ts", "action.ts", "manifest.ts",
    "test/fixtures.ts", "test/runtime-fixture.json", "test/recipient-runtime-evm.ts"]
    .map(name => "listener/src/searcher/venues/swaps/precision-pool-family/" + name)];
const sha = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");
fs.writeFileSync(path.join(directory, "result.json"), JSON.stringify({
  scope: "Real local BotVM with production PrecisionPool emitter/common boundary and synthetic pool/token state; not historical, natural-discovery or performance evidence.",
  exitCode: result.status, signal: result.signal, error: result.error?.message ?? null,
  fixtureSha256: sha(fs.readFileSync(fixturePath)),
  sources: Object.fromEntries(sources.map(name => [name, sha(fs.readFileSync(path.join(repository, name)))])),
}, null, 2) + "\n");
fs.writeFileSync(path.join(directory, "forge.stdout.log"), result.stdout ?? "");
fs.writeFileSync(path.join(directory, "forge.stderr.log"), result.stderr ?? "");
process.stdout.write(result.stdout ?? ""); process.stderr.write(result.stderr ?? "");
if (result.error) console.error(result.error.message);
console.log(`Evidence: ${directory}`); process.exitCode = result.status ?? 1;
