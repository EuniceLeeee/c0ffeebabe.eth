import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { ethers } from "ethers";
import { runtimeProgramScript } from "../../../../../adapters/runtime-amount-program.js";
import { plugin } from "../../../production-families/yieldbasis-lt.production.js";
import { instanceKey } from "../../../adapter-family-identifiers.js";
import { descriptor, answerFor, SOURCE } from "./fixtures.js";
import { sourcePin } from "../../../../test/family-integration/kyber-yb-compound/historical-dual.js";
const addr = (n: number) => ethers.getAddress(ethers.toBeHex(n, 20)), actor = addr(107), receiver = addr(91);
const d = { ...descriptor(answerFor({ deposit: true })), lt: addr(101), share: addr(101), asset: addr(102), stablecoin: addr(103),
  cryptopool: addr(104), amm: addr(105), staker: addr(108), instanceKey: instanceKey(addr(101).toLowerCase()) };
const programs: Record<string, string> = {};
for (const route of plugin.routes.project({ descriptor: d })) for (const [kind, recipient] of [["self", actor], ["external", receiver]] as const) {
  const input = { descriptor: d, route, executor: actor, source: SOURCE, runtimeEvidence: [], settlement: { kind: "direct-output" as const, recipient } };
  for (const key of ["amountIn", "quotedAmountOut", "minAmountOut", "exactEvidence"])
    Object.defineProperty(input, key, { get() { throw Error("runtime read " + key); } });
  const leg = plugin.execution.buildRuntimeLeg!(input)!; assert(leg); assert.deepEqual(leg.settlementRequest, input.settlement);
  for (const amount of [0n, 1n, 100n]) programs[`${route.direction}_${kind}_${amount}`] = ethers.hexlify(runtimeProgramScript(ethers.getBytes(leg.program), amount));
}
const i = process.argv.indexOf("--forge-bin"), forge = i < 0 ? "forge" : process.argv[i + 1]; assert(forge);
const repository = path.resolve(".."), directory = fs.mkdtempSync(path.join(repository, "logs/yieldbasis-recipient-evm-"));
fs.writeFileSync(path.join(directory, "programs.json"), JSON.stringify(programs, null, 2) + "\n");
const sha = (b: string | Buffer) => createHash("sha256").update(b).digest("hex");
const family = "listener/src/searcher/venues/protocols/yieldbasis-lt-family";
const sources = [
  ...fs.readdirSync(path.join(repository, "src"), { recursive: true }).filter(n => String(n).endsWith(".sol")).map(n => `src/${n}`),
  ...fs.readdirSync(path.join(repository, family)).filter(n => n.endsWith(".ts")).map(n => `${family}/${n}`),
  "test/YieldBasisRecipient.t.sol", `${family}/test/recipient-evm.ts`, `${family}/test/fixtures.ts`,
  "listener/src/adapters/runtime-amount-program.ts", "listener/src/searcher/venues/runtime-execution.ts",
];
const pins = () => Object.fromEntries(sources.map(name => [name, sha(fs.readFileSync(path.join(repository, name)))]));
const sourceBefore = pins(), productionBefore = sourcePin();
const result = spawnSync(forge, ["test", "--root", repository, "--match-path", "test/YieldBasisRecipient.t.sol",
  "--out", path.join(directory, "out"), "--cache-path", path.join(directory, "cache"), "-vv"], { cwd: repository,
  env: { ...process.env, ...Object.fromEntries(Object.entries(programs).map(([key, value]) => [`YB_RECIPIENT_${key}`, value])) },
  encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
const sourceAfter = pins(), productionAfter = sourcePin();
fs.writeFileSync(path.join(directory, "result.json"), JSON.stringify({
  scope: "Actual local BotVM and production-emitted program; synthetic LT, pool and tokens, not historical protocol rollback.",
  exitCode: result.status, signal: result.signal, error: result.error?.message ?? null,
  fixtureSha256: sha(fs.readFileSync(path.join(directory, "programs.json"))), sourceBefore, sourceAfter, productionBefore, productionAfter,
}, null, 2) + "\n");
fs.writeFileSync(path.join(directory, "forge.stdout.log"), result.stdout ?? ""); fs.writeFileSync(path.join(directory, "forge.stderr.log"), result.stderr ?? "");
process.stdout.write(result.stdout ?? ""); process.stderr.write(result.stderr ?? ""); console.log(`Evidence: ${directory}`);
assert.deepEqual(sourceAfter, sourceBefore); assert.deepEqual(productionAfter, productionBefore);
if (result.error) console.error(result.error.message); process.exitCode = result.status ?? 1;
