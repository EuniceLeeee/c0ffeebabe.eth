import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ethers } from "ethers";
import { runtimeProgramScript } from "../../../../../adapters/runtime-amount-program.js";
import { plugin } from "../../../production-families/uniswap-v1.production.js";
import { EXECUTOR, quote } from "./fixtures.js";

// Synthetic faults through real BotVM and production Family bytecode. Current
// deployed identity/issuer and historical parity are separately tested by the
// companion recipient-historical CLI; these mocks never provide admission.
const root = fileURLToPath(new URL("../../../../../../../", import.meta.url));
const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2) {
  const k = process.argv[i]!, v = process.argv[i + 1];
  assert(["--forge-bin", "--out"].includes(k) && !args.has(k) && v && !v.startsWith("--")); args.set(k, v);
}
assert.equal(args.size, 2);
const out = resolve(args.get("--out")!); mkdirSync(out, { recursive: false, mode: 0o700 });
const receiver = "0x1000000000000000000000000000000000000006";
const sourcePaths = [
  "src/BotVM.sol", "src/RuntimeAmountVM.sol",
  "listener/src/searcher/execution-asset-boundary.ts",
  "listener/src/searcher/venues/runtime-execution.ts",
  "listener/src/searcher/venues/swaps/univ1-family/execution.ts",
  "listener/src/searcher/venues/swaps/univ1-family/recipient.ts",
  "listener/src/searcher/venues/swaps/univ1-family/test/RecipientRuntime.t.sol",
  "listener/src/searcher/venues/swaps/univ1-family/test/recipient-runtime-evm.ts",
];
const pin = () => sourcePaths.map(path => ({ path, sha256: createHash("sha256").update(readFileSync(resolve(root, path))).digest("hex") }));
const before = pin();
function script(buy: boolean, external: boolean, amount = 1000n): string {
  const fixture = quote(10n ** 16n, buy), settlement = { kind: "direct-output" as const, recipient: external ? receiver : EXECUTOR };
  const leg = plugin.execution.buildRuntimeLeg!({ ...fixture.input, settlement }); assert(leg);
  assert.deepEqual(leg.settlementRequest, settlement); assert.equal(leg.settlement?.directOutput, true);
  assert.equal(leg.settlement?.deferredInput, undefined);
  return ethers.hexlify(runtimeProgramScript(ethers.getBytes(leg.program), amount));
}
const scripts = {
  V1_DIRECT_BUY_EXTERNAL: script(true, true), V1_DIRECT_BUY_SELF: script(true, false),
  V1_DIRECT_SELL_EXTERNAL: script(false, true), V1_DIRECT_SELL_SELF: script(false, false),
  V1_DIRECT_BUY_ZERO: script(true, true, 0n), V1_DIRECT_SELL_ZERO: script(false, true, 0n),
};
const command = ["test", "--offline", "--root", root, "--match-contract", "UniV1RecipientRuntimeTest",
  "--out", resolve(out, "foundry"), "--cache-path", resolve(out, "foundry-cache"), "-vvvv"];
const environment = Object.fromEntries(["PATH", "HOME", "TMPDIR", "TMP", "TEMP", "SYSTEMROOT"]
  .flatMap(k => process.env[k] === undefined ? [] : [[k, process.env[k]!]]));
const startedAt = new Date().toISOString();
const run = spawnSync(args.get("--forge-bin")!, command, { cwd: root, encoding: "utf8", timeout: 120_000,
  env: { ...environment, FOUNDRY_TEST: "listener/src/searcher/venues/swaps/univ1-family/test", ...scripts } });
writeFileSync(resolve(out, "stdout.log"), run.stdout ?? "", { flag: "wx", mode: 0o600 });
writeFileSync(resolve(out, "stderr.log"), run.stderr ?? "", { flag: "wx", mode: 0o600 });
const after = pin(); const unchanged = JSON.stringify(after) === JSON.stringify(before);
const passed = run.status === 0 && /25 passed; 0 failed/.test(run.stdout ?? "") && unchanged;
const report = { result: passed ? "pass" : "failed", scope: "synthetic-local-EVM-fault-controls", historicalAcceptance: false,
  noRPC: true, noSigning: true, noBroadcast: true, checks: 25, startedAt, endedAt: new Date().toISOString(),
  sourceBefore: before, sourceAfter: after, unchanged, scriptHashes: Object.fromEntries(Object.entries(scripts).map(([k,v]) => [k, ethers.keccak256(v)])),
  command, exitCode: run.status, signal: run.signal, error: run.error?.message };
writeFileSync(resolve(out, "result.json"), JSON.stringify(report, null, 2) + "\n", { flag: "wx", mode: 0o600 });
process.stdout.write(run.stdout ?? ""); process.stderr.write(run.stderr ?? "");
assert(passed, `Uniswap V1 recipient regression failed: ${run.error?.message ?? run.signal ?? run.status}`);
console.log(JSON.stringify({ result: report.result, checks: report.checks, scope: report.scope, out }));
