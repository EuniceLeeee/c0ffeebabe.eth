import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { ethers } from "ethers";
import { RuntimeAmountProgram, runtimeProgramScript } from "../../../../../adapters/runtime-amount-program.js";
import { plugin } from "../../../production-families/set-redemption.production.js";
import { fixture, ACTOR as actor, RECEIVER as receiver, SOURCE } from "./basic-recipient-fixture.js";
import { MODULE, TOKEN } from "../codec.js";
import { sourcePin } from "../../../../test/family-integration/kyber-yb-compound/historical-dual.js";
const programs: Record<string, string> = {};
const TRANSFER = new ethers.Interface(["function transfer(address,uint256)"]);
for (const count of [4, 33]) {
  const d = fixture(count), routes = plugin.routes.project({ descriptor: d });
  for (const selected of count === 4 ? [0, 1, 2, 3] : [0, 32]) {
    const route = routes[selected];
    for (const [kind, recipient] of count === 4 ? [["self", actor], ["external", receiver]] : [["external", receiver]]) {
      const input = { descriptor: d, route, executor: actor, source: SOURCE, runtimeEvidence: [], settlement: { kind: "direct-output" as const, recipient } };
      for (const key of ["amountIn", "quotedAmountOut", "minAmountOut", "exactEvidence"])
        Object.defineProperty(input, key, { get() { throw Error("runtime read " + key); } });
      const leg = plugin.execution.buildRuntimeLeg!(input)!; assert(leg); assert.deepEqual(leg.settlementRequest, input.settlement);
      for (const amount of count === 4 ? [0n, 1n, 100n] : [100n]) programs[`${count}_${selected}_${kind}_${amount}`] = ethers.hexlify(runtimeProgramScript(ethers.getBytes(leg.program), amount));
    }
    if (count === 4) {
      const p = new RuntimeAmountProgram().call(route.tokenOut, TOKEN.encodeFunctionData("balanceOf", [actor]), { static: true }).load(1, 0)
        .call(d.module, MODULE.encodeFunctionData("redeem", [d.set, 0n, actor]), { patches: [{ offset: 36, reg: 0 }] })
        .call(route.tokenOut, TOKEN.encodeFunctionData("balanceOf", [actor]), { static: true }).load(2, 0).math("sub", 2, 2, 1)
        .call(route.tokenOut, TRANSFER.encodeFunctionData("transfer", [receiver, 0n]), { patches: [{ offset: 36, reg: 2 }] });
      programs[`${count}_${selected}_unguarded_100`] = ethers.hexlify(runtimeProgramScript(p.bytes(), 100n));
    }
  }
}
const i = process.argv.indexOf("--forge-bin"), forge = i < 0 ? "forge" : process.argv[i + 1]; assert(forge);
const repository = path.resolve(".."), directory = fs.mkdtempSync(path.join(repository, "logs/set-basic-recipient-evm-"));
fs.writeFileSync(path.join(directory, "programs.json"), JSON.stringify(programs, null, 2) + "\n");
const sha = (b: string | Buffer) => createHash("sha256").update(b).digest("hex");
const family = "listener/src/searcher/venues/protocols/set-redemption-family";
const sources = [
  ...fs.readdirSync(path.join(repository, "src"), { recursive: true }).filter(n => String(n).endsWith(".sol")).map(n => `src/${n}`),
  ...fs.readdirSync(path.join(repository, family)).filter(n => n.endsWith(".ts")).map(n => `${family}/${n}`),
  "test/SetBasicRecipient.t.sol", `${family}/test/basic-recipient-evm.ts`, `${family}/test/basic-recipient-fixture.ts`,
  "listener/src/adapters/runtime-amount-program.ts", "listener/src/searcher/venues/runtime-execution.ts",
];
const pins = () => Object.fromEntries(sources.map(name => [name, sha(fs.readFileSync(path.join(repository, name)))]));
const sourceBefore = pins(), productionBefore = sourcePin();
const result = spawnSync(forge, ["test", "--root", repository, "--match-path", "test/SetBasicRecipient.t.sol",
  "--out", path.join(directory, "out"), "--cache-path", path.join(directory, "cache"), "-vv"], { cwd: repository,
  env: { ...process.env, ...Object.fromEntries(Object.entries(programs).map(([key, value]) => [`SET_BASIC_RECIPIENT_${key}`, value])) },
  encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
const sourceAfter = pins(), productionAfter = sourcePin();
fs.writeFileSync(path.join(directory, "result.json"), JSON.stringify({
  scope: "Actual local BotVM and production-emitted program; synthetic BasicIssuance basket/module and fault tokens, not historical protocol rollback.",
  exitCode: result.status, signal: result.signal, error: result.error?.message ?? null,
  fixtureSha256: sha(fs.readFileSync(path.join(directory, "programs.json"))), sourceBefore, sourceAfter, productionBefore, productionAfter,
}, null, 2) + "\n");
fs.writeFileSync(path.join(directory, "forge.stdout.log"), result.stdout ?? ""); fs.writeFileSync(path.join(directory, "forge.stderr.log"), result.stderr ?? "");
process.stdout.write(result.stdout ?? ""); process.stderr.write(result.stderr ?? ""); console.log(`Evidence: ${directory}`);
assert.deepEqual(sourceAfter, sourceBefore); assert.deepEqual(productionAfter, productionBefore);
if (result.error) console.error(result.error.message); process.exitCode = result.status ?? 1;
