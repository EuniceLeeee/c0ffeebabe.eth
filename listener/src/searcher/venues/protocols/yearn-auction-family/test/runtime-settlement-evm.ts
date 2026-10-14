import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { ethers } from "ethers";
import { RuntimeAmountProgram, runtimeProgramScript, runtimeAmountFlowAdapter,
  type RuntimeSettlementRequest } from "../../../../../adapters/runtime-amount-program.js";
import { buildRuntimeSettlementRoot } from "../../../../simulator/runtime-settlement.js";
import { plugin } from "../../../production-families/yearn-auction.production.js";
import { takeProgram } from "../execution.js";
import { actor, addr, setup, source } from "./fixtures.js";

const { d, rs } = setup(), prefix = addr(89), taker = addr(91);
const prefixABI = new ethers.Interface(["function quote(uint256) view returns(uint256)",
  "function swap(address,uint256) returns(uint256)"]);
const build = (settlement?: RuntimeSettlementRequest) => {
  const leg = plugin.execution.buildRuntimeLeg!({ descriptor: d, route: rs[0], source, executor: actor,
    runtimeEvidence: [], ...(settlement ? { settlement } : {}) }); assert(leg); return leg;
};
const payment = new RuntimeAmountProgram().call(prefix, prefixABI.encodeFunctionData("swap", [actor, 0n]),
  { patches: [{ offset: 36, reg: 0 }] }).load(0, 0);
const ordinary = build();
const root = buildRuntimeSettlementRoot({ executor: actor, amount: 100n, minimumProfit: 1n,
  legs: [{ actionAdapterId: "fixture-prefix", tokenIn: d.sold, tokenOut: d.want, program: ethers.hexlify(payment.bytes()),
    settlement: { quoteOutput: true, directOutput: true } },
  { ...ordinary, tokenIn: d.want, tokenOut: d.sold }],
  build(index, request) {
    if (index === 1) return build(request);
    const p = request.kind === "quote-output" ? new RuntimeAmountProgram()
      .call(prefix, prefixABI.encodeFunctionData("quote", [0n]), { static: true, patches: [{ offset: 4, reg: 0 }] }).load(0, 0)
      : payment;
    return { actionAdapterId: "fixture-prefix", program: ethers.hexlify(p.bytes()), settlementRequest: request };
  } }); assert(root);
const wrap = (program: string | Uint8Array, amount = 361n) => ethers.hexlify(runtimeProgramScript(ethers.getBytes(program), amount));
const fixtures: Record<string, string> = {
  default: wrap(ordinary.program), quoted: wrap(takeProgram(d, actor, 120n).bytes()),
  direct: wrap(build({ kind: "direct-output", recipient: taker }).program),
  deferred: wrap(build({ kind: "deferred-input", paymentAmount: 100n, paymentProgram: ethers.hexlify(payment.bytes()) }).program),
  root: ethers.hexlify(runtimeAmountFlowAdapter.encode(root, actor, new Uint8Array())),
};
for (const out of [110n, 120n]) {
  fixtures[`quote${out}`] = wrap(new RuntimeAmountProgram().run(build({ kind: "quote-output" }).program, 0, 1, true)
    .constant(2, out).equal(1, 2).bytes());
}
const forgeIndex = process.argv.indexOf("--forge-bin"), forge = forgeIndex < 0 ? "forge" : process.argv[forgeIndex + 1];
if (!forge) throw new Error("--forge-bin needs a path");
const repository = path.resolve(".."), directory = fs.mkdtempSync(path.join(repository, "logs/yearn-settlement-evm-"));
const fixturePath = path.join(directory, "programs.json"); fs.writeFileSync(fixturePath, JSON.stringify(fixtures, null, 2) + "\n");
const result = spawnSync(forge, ["test", "--root", repository, "--match-path", "test/YearnAuctionSettlement.t.sol",
  "--out", path.join(directory, "out"), "--cache-path", path.join(directory, "cache"), "-vv"], {
  cwd: repository, env: { ...process.env, ...Object.fromEntries(Object.entries(fixtures).map(([key, value]) =>
    [`YEARN_SETTLEMENT_${key}`, value])) }, encoding: "utf8", maxBuffer: 8 * 1024 * 1024,
});
const sources = ["src/BotVM.sol", "src/RuntimeAmountVM.sol", "test/YearnAuctionSettlement.t.sol",
  "listener/src/adapters/runtime-amount-program.ts", "listener/src/searcher/simulator/runtime-settlement.ts",
  "listener/src/searcher/venues/protocols/yearn-auction-family/execution.ts",
  "listener/src/searcher/venues/protocols/yearn-auction-family/runtime-settlement.ts",
  "listener/src/searcher/venues/protocols/yearn-auction-family/test/runtime-settlement-evm.ts"];
const sha = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");
fs.writeFileSync(path.join(directory, "result.json"), JSON.stringify({
  scope: "Real local EVM, current production programs, synthetic auction/token/prefix. No historical or performance claim.",
  exitCode: result.status, signal: result.signal, error: result.error?.message ?? null,
  fixtureSha256: sha(fs.readFileSync(fixturePath)),
  sources: Object.fromEntries(sources.map(name => [name, sha(fs.readFileSync(path.join(repository, name)))])),
}, null, 2) + "\n");
fs.writeFileSync(path.join(directory, "forge.stdout.log"), result.stdout ?? "");
fs.writeFileSync(path.join(directory, "forge.stderr.log"), result.stderr ?? "");
process.stdout.write(result.stdout ?? ""); process.stderr.write(result.stderr ?? "");
if (result.error) console.error(result.error.message);
console.log(`Evidence: ${directory}`); process.exitCode = result.status ?? 1;
