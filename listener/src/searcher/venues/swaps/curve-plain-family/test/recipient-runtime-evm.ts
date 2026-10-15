import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { ethers } from "ethers";
import { ADDR } from "../../../../../shared/constants/addresses.js";
import { applyRuntimeAssetBoundary, mapRuntimeAssetSettlementRequest } from "../../../../execution-asset-boundary.js";
import { runtimeProgramScript } from "../../../../../adapters/runtime-amount-program.js";
import { plugin } from "../../../production-families/curve-plain.production.js";
import { CURVE_PLAIN_FAMILY_ID, CURVE_PLAIN_LINEAGE } from "../manifest.js";
import { instanceKey } from "../../../adapter-family-identifiers.js";
import type { CurvePlainDescriptor, CurvePlainMode, CurvePlainRecipientMode } from "../types.js";

const addr = (i: number) => ethers.getAddress(ethers.toBeHex(i, 20));
const actor = addr(71), pool = addr(81), coins = [addr(83), addr(84)], receiver = addr(91);
const modes: [string, CurvePlainMode, CurvePlainRecipientMode | undefined][] = [
  ["int", "exchange", "exchange-receiver"], ["uint", "exchange-uint", "exchange-uint-receiver"],
  ["received", "received", undefined], ["receivedUint", "received-uint", undefined],
];
const programs: Record<string, string> = {};
for (const [name, mode, recipientMode] of modes) for (const i of [0, 1]) {
  const d: CurvePlainDescriptor = { familyId: CURVE_PLAIN_FAMILY_ID, lineageId: CURVE_PLAIN_LINEAGE,
    instanceKey: instanceKey(pool), pool, provenance: [], runtimeRequirements: [],
    binding: { quoteAbi: mode.includes("uint") ? "uint256" : "int128", coinAbi: "uint256", balanceAbi: "uint256",
      registry: addr(82), handlers: [addr(82)], codeHash: ethers.keccak256("0x6000"), coins, decimals: [18, 18] },
    directions: [{ i, j: 1 - i, tokenIn: coins[i], tokenOut: coins[1 - i], amountIn: 100n, amountOut: 200n,
      executionMode: mode, ...(recipientMode ? { recipientMode } : {}) }] };
  const route = plugin.routes.project({ descriptor: d })[0];
  const input = { descriptor: d, route, executor: actor, runtimeEvidence: [] };
  for (const [suffix, recipient] of [["default", null], ["self", actor], ["external", receiver]] as const) {
    const leg = plugin.execution.buildRuntimeLeg!({ ...input,
      ...(recipient ? { settlement: { kind: "direct-output" as const, recipient } } : {}) }); assert(leg);
    if (recipient) {
      assert.equal(leg.settlement?.directOutput, true);
      assert.deepEqual(leg.settlementRequest, { kind: "direct-output", recipient });
    }
    for (const amount of [0n, 1n, 100n]) programs[`${name}_${i}_${suffix}_${amount}`] =
      ethers.hexlify(runtimeProgramScript(ethers.getBytes(leg.program), amount));
  }
}

// Native variants use the same request mapping and boundary as the production issuer.
for (const [name, mode, recipientMode] of [
  ["nativeInt", "native-exchange", "native-exchange-receiver"],
  ["nativeUint", "native-exchange-uint", "native-exchange-uint-receiver"],
  ["nativeLegacy", "native-exchange", undefined],
] as const) for (const i of [0, 1]) {
  const nativeCoins = ["0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee", coins[1]];
  const graph = [ADDR.WETH, coins[1]];
  const d: CurvePlainDescriptor = { familyId: CURVE_PLAIN_FAMILY_ID, lineageId: CURVE_PLAIN_LINEAGE,
    instanceKey: instanceKey(pool), pool, provenance: [], runtimeRequirements: [],
    binding: { quoteAbi: mode.includes("uint") ? "uint256" : "int128", coinAbi: "uint256", balanceAbi: "uint256",
      registry: addr(82), handlers: [addr(82)], codeHash: ethers.keccak256("0x6000"), coins: nativeCoins, decimals: [18, 18] },
    directions: [{ i, j: 1 - i, tokenIn: graph[i], tokenOut: graph[1 - i], amountIn: 100n, amountOut: 200n,
      executionMode: mode, ...(i === 0 && recipientMode ? { recipientMode } : {}) }] };
  const route = plugin.routes.project({ descriptor: d })[0];
  const input = { descriptor: d, route, executor: actor, runtimeEvidence: [] };
  for (const [suffix, recipient] of [["default", null], ["self", actor], ["external", receiver]] as const) {
    const request = recipient ? { kind: "direct-output" as const, recipient } : undefined;
    const mapped = mapRuntimeAssetSettlementRequest({ route, executor: actor, request });
    assert(mapped !== null);
    const buildInput = { ...input, ...(mapped ? { settlement: mapped } : {}) };
    for (const field of ["amountIn", "quotedAmountOut", "exactEvidence", "minAmountOut"])
      Object.defineProperty(buildInput, field, { get() { throw new Error("native runtime read " + field); } });
    const raw = plugin.execution.buildRuntimeLeg!(buildInput);
    if (name === "nativeLegacy" && i === 0 && request) { assert.equal(raw, null); continue; }
    assert(raw);
    if (request) assert.deepEqual(raw.settlementRequest, mapped);
    const leg = applyRuntimeAssetBoundary({ route, executor: actor,
      leg: { ...raw, ...(request ? { settlementRequest: request } : {}) } });
    for (const amount of [0n, 1n, 100n]) programs[`${name}_${i}_${suffix}_${amount}`] =
      ethers.hexlify(runtimeProgramScript(ethers.getBytes(leg.program), amount));
  }
}
const forgeIndex = process.argv.indexOf("--forge-bin"), forge = forgeIndex < 0 ? "forge" : process.argv[forgeIndex + 1];
assert(forge, "--forge-bin needs a path");
const repository = path.resolve(".."), directory = fs.mkdtempSync(path.join(repository, "logs/curve-recipient-evm-"));
const fixturePath = path.join(directory, "programs.json"); fs.writeFileSync(fixturePath, JSON.stringify(programs, null, 2) + "\n");
const result = spawnSync(forge, ["test", "--root", repository, "--match-path", "test/CurvePlainRecipient.t.sol",
  "--out", path.join(directory, "out"), "--cache-path", path.join(directory, "cache"), "-vv"], {
  cwd: repository, env: { ...process.env, ...Object.fromEntries(Object.entries(programs).map(([key, value]) =>
    [`CURVE_RECIPIENT_${key}`, value])) }, encoding: "utf8", maxBuffer: 8 * 1024 * 1024,
});
const sources = ["src/BotVM.sol", "src/RuntimeAmountVM.sol", "test/CurvePlainRecipient.t.sol",
  "listener/src/adapters/runtime-amount-program.ts", "listener/src/searcher/venues/runtime-execution.ts",
  "listener/src/searcher/execution-asset-boundary.ts",
  ...["codec.ts", "routes.ts", "instance.ts", "types.ts", "recipient.ts", "native.ts", "execution.ts", "test/recipient-runtime-evm.ts"]
    .map(name => "listener/src/searcher/venues/swaps/curve-plain-family/" + name)];
const sha = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");
fs.writeFileSync(path.join(directory, "result.json"), JSON.stringify({
  scope: "Real local BotVM EVM with production Family programs and synthetic Curve/tokens; not historical or performance evidence.",
  exitCode: result.status, signal: result.signal, error: result.error?.message ?? null,
  fixtureSha256: sha(fs.readFileSync(fixturePath)),
  sources: Object.fromEntries(sources.map(name => [name, sha(fs.readFileSync(path.join(repository, name)))])),
}, null, 2) + "\n");
fs.writeFileSync(path.join(directory, "forge.stdout.log"), result.stdout ?? "");
fs.writeFileSync(path.join(directory, "forge.stderr.log"), result.stderr ?? "");
process.stdout.write(result.stdout ?? ""); process.stderr.write(result.stderr ?? "");
if (result.error) console.error(result.error.message);
console.log(`Evidence: ${directory}`); process.exitCode = result.status ?? 1;
