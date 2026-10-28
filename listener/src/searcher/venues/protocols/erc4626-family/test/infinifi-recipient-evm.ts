import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { ethers } from "ethers";
import { runtimeProgramScript } from "../../../../../adapters/runtime-amount-program.js";
import { erc4626Instance } from "../instance.js";
import { erc4626Routes } from "../routes.js";
import { erc4626Execution } from "../execution.js";
import { ERC4626_FAMILY_ID, INFINIFI_LINEAGE_ID } from "../manifest.js";
import { INFINIFI_GATEWAY } from "../infinifi.js";
const addr = (i: number) => ethers.getAddress(ethers.toBeHex(i, 20));
const actor = addr(107), receiver = addr(91), programs: Record<string,string> = {};
const source = { number: 25944594, hash: "0x" + "11".repeat(32), generation: 3 };
const codeHash = ethers.keccak256("0x6000");
const d = erc4626Instance.compileDraft({ familyId: ERC4626_FAMILY_ID, lineageId: INFINIFI_LINEAGE_ID,
  subject: addr(101), asset: addr(102), provenance: [], verifiedDirections: { deposit: true, redeem: true },
  infinifi: { vault: addr(101), asset: addr(102), gateway: INFINIFI_GATEWAY, core: addr(103), yieldSharing: addr(104),
    proofSource: source, gatewayImplementation: addr(105), yieldSharingImplementation: addr(106), shareDecimals: 18,
    assetDecimals: 18, vaultCodeHash: codeHash, gatewayCodeHash: codeHash,
    codeHashes: { asset: codeHash, core: codeHash, yieldSharing: codeHash, gatewayImplementation: codeHash,
      yieldSharingImplementation: codeHash, multicall: codeHash } } });
for (const route of erc4626Routes.project({ descriptor: d })) {
  const i = route.direction === "deposit" ? 0 : 1;
  for (const [suffix, recipient] of [["default", null], ["self", actor], ["external", receiver]] as const) {
    const request = recipient ? { kind: "direct-output" as const, recipient } : undefined;
    const input = { descriptor: d, route, source, executor: actor, runtimeEvidence: [], ...(request ? { settlement: request } : {}) };
    for (const key of ["amountIn", "quotedAmountOut", "exactEvidence", "minAmountOut"])
      Object.defineProperty(input, key, { get() { throw new Error("runtime read " + key); } });
    const leg = erc4626Execution.buildRuntimeLeg!(input); assert(leg);
    if (request) { assert.equal(leg.settlement?.directOutput, true); assert.deepEqual(leg.settlementRequest, request); }
    for (const amount of [0n, 1n, 100n]) programs[`${i}_${suffix}_${amount}`] = ethers.hexlify(runtimeProgramScript(ethers.getBytes(leg.program), amount));
  }
}
const forgeIndex = process.argv.indexOf("--forge-bin"), forge = forgeIndex < 0 ? "forge" : process.argv[forgeIndex + 1];
assert(forge, "--forge-bin needs a path");
const repository = path.resolve(".."), directory = fs.mkdtempSync(path.join(repository, "logs/infinifi-recipient-evm-"));
const fixturePath = path.join(directory, "programs.json"); fs.writeFileSync(fixturePath, JSON.stringify(programs, null, 2) + "\n");
const result = spawnSync(forge, ["test", "--root", repository, "--match-path", "test/InfiniFiRecipient.t.sol",
  "--out", path.join(directory, "out"), "--cache-path", path.join(directory, "cache"), "-vv"], {
  cwd: repository, env: { ...process.env, ...Object.fromEntries(Object.entries(programs).map(([key, value]) =>
    [`INFINIFI_RECIPIENT_${key}`, value])) }, encoding: "utf8", maxBuffer: 8 * 1024 * 1024,
});
const sources = ["src/BotVM.sol", "src/RuntimeAmountVM.sol", "test/InfiniFiRecipient.t.sol", "test/CurvePlainRecipient.t.sol",
  "listener/src/adapters/runtime-amount-program.ts", "listener/src/searcher/venues/runtime-execution.ts",
  ...["infinifi.ts", "infinifi-execution.ts", "execution.ts", "routes.ts", "instance.ts", "binding.ts", "types.ts", "manifest.ts", "test/infinifi-recipient-evm.ts"]
    .map(name => "listener/src/searcher/venues/protocols/erc4626-family/" + name)];
const sha = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");
fs.writeFileSync(path.join(directory, "result.json"), JSON.stringify({
  scope: "Real local BotVM EVM with production InfiniFi Family programs and synthetic Gateway/tokens; not historical identity or actual Gateway execution.",
  exitCode: result.status, signal: result.signal, error: result.error?.message ?? null,
  fixtureSha256: sha(fs.readFileSync(fixturePath)),
  sources: Object.fromEntries(sources.map(name => [name, sha(fs.readFileSync(path.join(repository, name)))])),
}, null, 2) + "\n");
fs.writeFileSync(path.join(directory, "forge.stdout.log"), result.stdout ?? "");
fs.writeFileSync(path.join(directory, "forge.stderr.log"), result.stderr ?? "");
process.stdout.write(result.stdout ?? ""); process.stderr.write(result.stderr ?? "");
if (result.error) console.error(result.error.message);
console.log(`Evidence: ${directory}`); process.exitCode = result.status ?? 1;
