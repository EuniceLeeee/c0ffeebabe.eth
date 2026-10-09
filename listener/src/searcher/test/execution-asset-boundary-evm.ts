import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { ethers } from "ethers";
import { ADDR } from "../../shared/constants/addresses.js";
import { buildSubscriptCalldata } from "../../shared/executor/botvm-program-entry.js";
import { RuntimeAmountProgram, runtimeProgramScript } from "../../adapters/runtime-amount-program.js";
import { applyRuntimeAssetBoundary, applyQuotedAssetBoundary, executionAssetBoundaryAdapter } from "../execution-asset-boundary.js";
import { materializeAdapterRequests } from "../reth-adapter-work-runtime.js";
import { declareRequestProgram, type AdapterRequest } from "../venues/adapter-request-program.js";

const token = "0x1111111111111111111111111111111111111111";
const actor = "0x2222222222222222222222222222222222222222";
const target = "0x3333333333333333333333333333333333333333";
const rawABI = new ethers.Interface(["function exchange(bool,uint256) payable"]);
const subscript = new ethers.Interface(["function execSubscript(bytes)"]);
const fixtures: Record<string, string> = {};
const amount = 100n;

for (const nativeIn of [true, false]) {
  const route = { tokenIn: nativeIn ? ADDR.WETH : token, tokenOut: nativeIn ? token : ADDR.WETH,
    executionAssets: { input: nativeIn ? "native" as const : "erc20" as const,
      output: nativeIn ? "erc20" as const : "native" as const } };
  const p = new RuntimeAmountProgram().call(target, rawABI.encodeFunctionData("exchange", [nativeIn, 0n]), {
    patches: [{ offset: 36, reg: 0 }], ...(nativeIn ? { valueReg: 0 } : {}),
  });
  const leg = { actionAdapterId: "fixture-native", program: ethers.hexlify(p.bytes()) };
  const side = nativeIn ? "Input" : "Output";
  fixtures[`runtime${side}`] = ethers.hexlify(runtimeProgramScript(ethers.getBytes(
    applyRuntimeAssetBoundary({ route, executor: actor, leg }).program), amount));
  const fragment = applyQuotedAssetBoundary({ route, executor: actor, amountIn: amount, minimum: 200n,
    fragment: { requirements: [], nodes: [{ adapterId: leg.actionAdapterId, target, tokenIn: route.tokenIn,
      tokenOut: route.tokenOut, amount, params: {}, children: [] }] } });
  fixtures[`quoted${side}`] = ethers.hexlify(executionAssetBoundaryAdapter.encode(fragment.nodes[0], actor, runtimeProgramScript(p.bytes(), amount)));
  for (const tolerance of [0n, 1n]) {
    const live = applyQuotedAssetBoundary({ route, executor: actor, amountIn: amount, minimum: 200n,
      inputToleranceRawUnits: tolerance, fragment: { requirements: [], nodes: [{ adapterId: leg.actionAdapterId, target,
        tokenIn: route.tokenIn, tokenOut: route.tokenOut, amount, params: {}, children: [] }] } });
    fixtures[`quoted${side}Tolerance${tolerance}`] = ethers.hexlify(executionAssetBoundaryAdapter.encode(
      live.nodes[0], actor, runtimeProgramScript(p.bytes(), amount)));
  }
  const one = applyQuotedAssetBoundary({ route, executor: actor, amountIn: 1n, minimum: 200n,
    inputToleranceRawUnits: 1n, fragment: { requirements: [], nodes: [{ adapterId: leg.actionAdapterId, target,
      tokenIn: route.tokenIn, tokenOut: route.tokenOut, amount: 1n, params: {}, children: [] }] } });
  fixtures[`quotedZeroDebit${side}`] = ethers.hexlify(executionAssetBoundaryAdapter.encode(
    one.nodes[0], actor, runtimeProgramScript(p.bytes(), 1n)));
  const request: AdapterRequest = { id: "native", kind: "effect-delta-simulation",
    executionAssetBoundary: { ...route, amountIn: amount, minimum: 200n },
    call: { caller: { kind: "executor" }, executionMode: "executor-program", to: actor,
      data: buildSubscriptCalldata(runtimeProgramScript(p.bytes(), amount)) },
    overrideIntent: { caller: { kind: "executor" }, tokenBalances: [{ token: route.tokenIn, amount }] },
    observe: ["token-delta", "native-delta"],
    observeTokenBalances: [route.tokenIn, route.tokenOut].map(token => ({ token, account: { kind: "executor" } })),
  };
  const declared = declareRequestProgram({ requirements: () => ({ transports: ["effect-delta-simulation"],
    caller: "executor", effects: ["token-delta", "native-delta"] }), buildRequests: () => [request], decode: () => null }, {});
  const wire = materializeAdapterRequests(declared.requests, { executor: actor })[0];
  assert(wire.kind === "effect-delta-simulation");
  fixtures[`strict${side}`] = subscript.decodeFunctionData("execSubscript", wire.call.data)[0];
  if (nativeIn) {
    const bad = new RuntimeAmountProgram().constant(9, 1n).math("add", 10, 0, 9)
      .call(target, rawABI.encodeFunctionData("exchange", [true, 0n]), { patches: [{ offset: 36, reg: 10 }], valueReg: 10 });
    fixtures.overspendNative = ethers.hexlify(runtimeProgramScript(ethers.getBytes(applyRuntimeAssetBoundary({
      route, executor: actor, leg: { actionAdapterId: leg.actionAdapterId, program: ethers.hexlify(bad.bytes()) },
    }).program), amount));
  }
}
const forgeIndex = process.argv.indexOf("--forge-bin");
const forge = forgeIndex < 0 ? "forge" : process.argv[forgeIndex + 1];
if (!forge) throw new Error("--forge-bin needs a path");
const root = path.resolve("..");
const directory = fs.mkdtempSync(path.join(root, "logs/native-boundary-evm-"));
const fixturePath = path.join(directory, "programs.json");
fs.writeFileSync(fixturePath, JSON.stringify(fixtures, null, 2) + "\n");
console.log(`Current production-emitted EVM fixtures: ${fixturePath}`);
const result = spawnSync(forge, ["test", "--root", root, "--match-path", "test/ExecutionAssetBoundary.t.sol",
  "--out", path.join(directory, "out"), "--cache-path", path.join(directory, "cache"), "-vv"], {
  cwd: root, env: { ...process.env, ...Object.fromEntries(Object.entries(fixtures).map(([key, data]) =>
    [`NATIVE_BOUNDARY_${key}`, data])) }, encoding: "utf8", maxBuffer: 8 * 1024 * 1024,
});
const sourcePaths = ["listener/src/searcher/execution-asset-boundary.ts", "listener/src/searcher/venues/runtime-execution.ts",
  "listener/src/searcher/venues/adapter-request-program.ts", "listener/src/searcher/reth-adapter-work-runtime.ts",
  "listener/src/searcher/test/execution-asset-boundary-evm.ts", "src/BotVM.sol", "src/RuntimeAmountVM.sol",
  "test/RuntimePaymentMocks.sol", "test/ExecutionAssetBoundary.t.sol"];
fs.writeFileSync(path.join(directory, "result.json"), JSON.stringify({ scope: "Local real EVM with synthetic protocol, no historical/latency/live claim",
  exitCode: result.status, signal: result.signal, error: result.error?.message ?? null,
  fixtureSha256: createHash("sha256").update(fs.readFileSync(fixturePath)).digest("hex"),
  sources: Object.fromEntries(sourcePaths.map(p => [p, createHash("sha256").update(fs.readFileSync(path.join(root, p))).digest("hex")])) }, null, 2) + "\n");
fs.writeFileSync(path.join(directory, "forge.stdout.log"), result.stdout ?? "");
fs.writeFileSync(path.join(directory, "forge.stderr.log"), result.stderr ?? "");
process.stdout.write(result.stdout ?? ""); process.stderr.write(result.stderr ?? "");
if (result.error) console.error(result.error.message);
console.log(`Evidence: ${directory}`);
process.exitCode = result.status ?? 1;
