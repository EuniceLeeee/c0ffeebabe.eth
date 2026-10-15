import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { ethers } from "ethers";
import { runtimeProgramScript } from "../../../../../adapters/runtime-amount-program.js";
import { erc4626SiloRedeemInstance } from "../instance.js";
import { erc4626SiloRedeemRoutes } from "../routes.js";
import { erc4626SiloRedeemExecution } from "../execution.js";
import { siloEvmDependencySource } from "./recipient-evm-source.js";
import { sourcePin } from "../../../../test/family-integration/kyber-yb-compound/historical-dual.js";

const addr = (i: number) => ethers.getAddress(ethers.toBeHex(i, 20));
const actor = addr(107), receiver = addr(91), programs: Record<string, string> = {};
const source = { number: 26130609, hash: "0x" + "11".repeat(32), generation: 3 };
const d = erc4626SiloRedeemInstance.compileDraft({ vault: addr(101), payoutToken: addr(102), underlyingAsset: addr(103), provenance: [] } as any);
const route = erc4626SiloRedeemRoutes.project({ descriptor: d })[0]!;
for (const [suffix, recipient] of [["default", null], ["self", actor], ["external", receiver]] as const) {
  const request = recipient ? { kind: "direct-output" as const, recipient } : undefined;
  const input = { descriptor: d, route, source, executor: actor, runtimeEvidence: [], ...(request ? { settlement: request } : {}) };
  for (const key of ["amountIn", "quotedAmountOut", "exactEvidence", "minAmountOut"])
    Object.defineProperty(input, key, { get() { throw new Error("runtime read " + key); } });
  const leg = erc4626SiloRedeemExecution.buildRuntimeLeg(input); assert(leg);
  assert.equal(leg.settlement?.directOutput, true);
  if (request) assert.deepEqual(leg.settlementRequest, request);
  for (const amount of [0n, 1n, 100n]) programs[`${suffix}_${amount}`] = ethers.hexlify(runtimeProgramScript(ethers.getBytes(leg.program), amount));
}
const forgeIndex = process.argv.indexOf("--forge-bin"), forge = forgeIndex < 0 ? "forge" : process.argv[forgeIndex + 1];
assert(forge, "--forge-bin needs a path");
const repository = path.resolve(".."), directory = fs.mkdtempSync(path.join(repository, "logs/silo-recipient-evm-"));
const fixturePath = path.join(directory, "programs.json"); fs.writeFileSync(fixturePath, JSON.stringify(programs, null, 2) + "\n");
const sha = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");
const sources = [
  ...fs.readdirSync(path.join(repository, "src"), { recursive: true }).filter(n => String(n).endsWith(".sol")).map(n => `src/${n}`),
  "test/SiloRecipient.t.sol", "test/CurvePlainRecipient.t.sol",
  "listener/src/adapters/runtime-amount-program.ts", "listener/src/searcher/venues/runtime-execution.ts",
  ...["execution.ts", "routes.ts", "instance.ts", "shared.ts", "types.ts", "manifest.ts", "test/recipient-evm.ts", "test/recipient-evm-source.ts"]
    .map(name => "listener/src/searcher/venues/protocols/erc4626-silo-redeem-family/" + name)];
const readSources = () => Object.fromEntries(sources.map(name => [name, fs.readFileSync(path.join(repository, name), "utf8")]));
const pins = (input: Record<string, string>, scoped = false) => Object.fromEntries(Object.entries(input)
  .map(([name, text]) => [name, sha(scoped ? siloEvmDependencySource(name, text) : text)]));
const rawBefore = readSources(), sourceBefore = pins(rawBefore), dependencySourceBefore = pins(rawBefore, true);
const productionSourceBefore = sourcePin();
const result = spawnSync(forge, ["test", "--root", repository, "--match-path", "test/SiloRecipient.t.sol",
  "--out", path.join(directory, "out"), "--cache-path", path.join(directory, "cache"), "-vv"], {
  cwd: repository, env: { ...process.env, ...Object.fromEntries(Object.entries(programs).map(([key, value]) =>
    [`SILO_RECIPIENT_${key}`, value])) }, encoding: "utf8", maxBuffer: 8 * 1024 * 1024,
});
const rawAfter = readSources(), sourceAfter = pins(rawAfter), dependencySourceAfter = pins(rawAfter, true);
const productionSourceAfter = sourcePin();
fs.writeFileSync(path.join(directory, "result.json"), JSON.stringify({
  scope: "Real local BotVM EVM using production Family programs and synthetic Tranche/tokens; not historical identity or actual Tranche execution.",
  exitCode: result.status, signal: result.signal, error: result.error?.message ?? null,
  fixtureSha256: sha(fs.readFileSync(fixturePath)), sourceBefore, sourceAfter, dependencySourceBefore, dependencySourceAfter,
  dependencyScope: "CurvePlainRecipient header and standalone CurveRecipientToken only; other files complete",
  sharedFixtureSourceBefore: rawBefore["test/CurvePlainRecipient.t.sol"],
  sharedFixtureSourceAfter: rawAfter["test/CurvePlainRecipient.t.sol"],
  productionSourceBefore, productionSourceAfter,
}, null, 2) + "\n");
fs.writeFileSync(path.join(directory, "forge.stdout.log"), result.stdout ?? "");
fs.writeFileSync(path.join(directory, "forge.stderr.log"), result.stderr ?? "");
process.stdout.write(result.stdout ?? ""); process.stderr.write(result.stderr ?? "");
console.log(`Evidence: ${directory}`);
assert.deepEqual(dependencySourceAfter, dependencySourceBefore); assert.deepEqual(productionSourceAfter, productionSourceBefore);
if (result.error) console.error(result.error.message);
process.exitCode = result.status ?? 1;
