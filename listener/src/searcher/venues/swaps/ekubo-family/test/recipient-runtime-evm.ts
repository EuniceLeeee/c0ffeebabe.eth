import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { ethers } from "ethers";
import { ADDR } from "../../../../../shared/constants/addresses.js";
import { applyRuntimeAssetBoundary, mapRuntimeAssetSettlementRequest } from "../../../../execution-asset-boundary.js";
import { runtimeProgramScript } from "../../../../../adapters/runtime-amount-program.js";
import { plugin } from "../../../production-families/ekubo.production.js";
import { EKUBO_FAMILY_ID, EKUBO_LINEAGE } from "../manifest.js";
import { EKUBO_SUPPORTED_CORE_HASH, EKUBO_SUPPORTED_ROUTER_HASH, EKUBO_SUPPORTED_TWAMM_HASH } from "../extension.js";
import { ekuboPoolId } from "../../ekubo/pool-key.js";
const addr = (i: number) => ethers.getAddress(ethers.toBeHex(i, 20));
const actor = addr(71), receiver = addr(91), programs: Record<string,string> = {};
for (const name of ["vanilla", "twamm"]) for (const i of [0,1]) {
  const poolKey = { token0: ethers.ZeroAddress, token1: addr(84), config: name === "vanilla" ? ethers.toBeHex(3000n, 32)
    : "0xd47f1b1edcfeabb08f6ebd8fc337c27e636c75ba00c49ba5e353f7ce00000000" };
  const d = plugin.instance.compileDraft({ familyId: EKUBO_FAMILY_ID, lineageId: EKUBO_LINEAGE,
    subject: ekuboPoolId(poolKey), provenance: [], facts: { poolId: ekuboPoolId(poolKey), poolKey,
      coreCodeHash: EKUBO_SUPPORTED_CORE_HASH, routerCodeHash: EKUBO_SUPPORTED_ROUTER_HASH,
      ...(name === "twamm" ? { extensionCodeHash: EKUBO_SUPPORTED_TWAMM_HASH } : {}), decimals: [18, 18] } });
  const route = plugin.routes.project({ descriptor: d })[i];
  for (const [suffix, recipient] of [["default", null], ["self", actor], ["external", receiver]] as const) {
    const request = recipient ? { kind: "direct-output" as const, recipient } : undefined;
    const mapped = mapRuntimeAssetSettlementRequest({ route, executor: actor, request }); assert(mapped !== null);
    const input = { descriptor: d, route, executor: actor, runtimeEvidence: [], ...(mapped ? { settlement: mapped } : {}) };
    for (const key of ["amountIn", "quotedAmountOut", "exactEvidence", "minAmountOut"])
      Object.defineProperty(input,key,{get(){throw new Error("runtime read "+key);}});
    const raw = plugin.execution.buildRuntimeLeg!(input); assert(raw);
    if (request) { assert.equal(raw.settlement?.directOutput,true); assert.deepEqual(raw.settlementRequest,mapped); }
    const leg = applyRuntimeAssetBoundary({route,executor:actor,leg:{...raw,...(request?{settlementRequest:request}:{})}});
    for (const amount of [0n,1n,100n]) programs[`${name}_${i}_${suffix}_${amount}`] = ethers.hexlify(runtimeProgramScript(ethers.getBytes(leg.program),amount));
  }
}
const forgeIndex = process.argv.indexOf("--forge-bin"), forge = forgeIndex < 0 ? "forge" : process.argv[forgeIndex + 1];
assert(forge, "--forge-bin needs a path");
const repository = path.resolve(".."), directory = fs.mkdtempSync(path.join(repository, "logs/ekubo-native-recipient-evm-"));
const fixturePath = path.join(directory, "programs.json"); fs.writeFileSync(fixturePath, JSON.stringify(programs, null, 2) + "\n");
const result = spawnSync(forge, ["test", "--root", repository, "--match-path", "test/EkuboNativeRecipient.t.sol",
  "--out", path.join(directory, "out"), "--cache-path", path.join(directory, "cache"), "-vv"], {
  cwd: repository, env: { ...process.env, ...Object.fromEntries(Object.entries(programs).map(([key, value]) =>
    [`EKUBO_RECIPIENT_${key}`, value])) }, encoding: "utf8", maxBuffer: 8 * 1024 * 1024,
});
const sources = ["src/BotVM.sol", "src/RuntimeAmountVM.sol", "test/EkuboNativeRecipient.t.sol", "test/CurvePlainRecipient.t.sol",
  "listener/src/adapters/runtime-amount-program.ts", "listener/src/searcher/venues/runtime-execution.ts",
  "listener/src/searcher/execution-asset-boundary.ts",
  "listener/src/searcher/venues/swaps/ekubo/abi.ts", "listener/src/searcher/venues/swaps/ekubo/pool-key.ts",
  ...["codec.ts", "routes.ts", "instance.ts", "types.ts", "extension.ts", "execution.ts", "test/recipient-runtime-evm.ts"]
    .map(name => "listener/src/searcher/venues/swaps/ekubo-family/" + name)];
const sha = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");
fs.writeFileSync(path.join(directory, "result.json"), JSON.stringify({
  scope: "Real local BotVM EVM with production Family programs and synthetic Ekubo Router/tokens; not historical or performance evidence.",
  exitCode: result.status, signal: result.signal, error: result.error?.message ?? null,
  fixtureSha256: sha(fs.readFileSync(fixturePath)),
  sources: Object.fromEntries(sources.map(name => [name, sha(fs.readFileSync(path.join(repository, name)))])),
}, null, 2) + "\n");
fs.writeFileSync(path.join(directory, "forge.stdout.log"), result.stdout ?? "");
fs.writeFileSync(path.join(directory, "forge.stderr.log"), result.stderr ?? "");
process.stdout.write(result.stdout ?? ""); process.stderr.write(result.stderr ?? "");
if (result.error) console.error(result.error.message);
console.log(`Evidence: ${directory}`); process.exitCode = result.status ?? 1;
