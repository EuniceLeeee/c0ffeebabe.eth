// Opt-in bounded historical deposit-policy probe through the real central
// issuer and REVM effect transport. This is NOT Ready/Graph/EV/performance acceptance.
import assert from "node:assert/strict";
import { readFileSync, openSync, writeFileSync, closeSync } from "node:fs";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { ethers } from "ethers";
import { executeAdapterWork } from "../../../../adapter-work-intent.js";
import { createStrictCentralAdapterRuntime } from "../../../../strict-central-adapter-runtime.js";
import { createRevmStrictSourceSimulation } from "../../../../revm-strict-source-simulation.js";
import { RevmSimClient } from "../../../../revm-sim-client.js";
import { loadBotVmRuntimeCode } from "../../../../../shared/executor/botvm-executor.js";
import { callRequest, returnedResult } from "../../standard-family/common.js";
import { LT_INTERFACE, LEVAMM_INTERFACE, CRYPTOPOOL_INTERFACE } from "../abi.js";
import { balancedDepositDebt, decodeDepositBalances, decodeDepositReceipt, depositBalanceRequests,
  depositSimulation, depositProgramSimulation, decodeDepositProgramReceipt, DEPOSIT_REQUIREMENTS, DEPOSIT_DEBT_POLICY } from "../deposit.js";

const N = 26003536, HASH = "0xf913fc4aaaeca0fd9fcd871c1a2b0159e1ecc3679724fff679a061ca7bedeaad";
const TX = "0x022a9ff85219675bcf0a0a2b17c76ac72b98d5e2c4177bc104edff56e706ee77";
const lt = "0x2b9c9f3bdceb5d8e36a4704f08a78fca53343cea";
const executor = "0x1000000000000000000000000000000000000002", owner = "0x1000000000000000000000000000000000000001";
const json = (v: unknown) => JSON.stringify(v, (_, x) => typeof x === "bigint" ? x.toString() : x, 2);
const sha = (x: Uint8Array) => createHash("sha256").update(x).digest("hex");
export async function recordedDepositTrial(report: { samples: any[] }, trial: { amountIn: bigint; debt: bigint },
  execute: () => Promise<unknown>, decode: (results: any) => bigint) {
  const row: any = { ...trial, status: "started" }; report.samples.push(row);
  try { row.results = await execute(); row.amountOut = decode(row.results); row.status = "pass"; }
  catch (e) { row.status = "failed"; row.error = String(e instanceof Error ? e.message : e); throw e; }
  return row;
}
async function main() {
  const args = new Map<string, string>();
  for (let i = 2; i < process.argv.length; i += 2) {
    assert(["--rpc-file", "--rpc-env", "--revm-bin", "--out", "--mode"].includes(process.argv[i]!) && !args.has(process.argv[i]!) && process.argv[i + 1]);
    args.set(process.argv[i]!, process.argv[i + 1]!);
  }
  assert(args.has("--revm-bin") && args.has("--out") && args.has("--rpc-file") !== args.has("--rpc-env"));
  const mode = args.get("--mode") ?? "raw-policy";
  assert(mode === "raw-policy" || mode === "executor-program");
  if (args.has("--rpc-env")) assert.equal(args.get("--rpc-env"), "MAINNET_RPC_URL");
  const fd = openSync(args.get("--out")!, "wx", 0o600);
  const report: any = { result: "failed", tx: TX, block: N, policy: DEPOSIT_DEBT_POLICY,
    mode, claim: "bounded same-N deposit diagnostic; executor-program includes approval/cleanup/guards; no Ready/full-route/latency verdict", samples: [],
    safety: { signing: false, broadcast: false, funded: "executor asset input only; pool/AMM/supply untouched" } };
  const controller = new AbortController(), deadlineAtMs = Date.now() + 180_000;
  const timer = setTimeout(() => controller.abort(new Error("probe deadline")), 180_000);
  let rpcUrl = "", simulation: ReturnType<typeof createRevmStrictSourceSimulation> | undefined;
  let calls = 0;
  try {
    const sourcePaths = [new URL("../deposit.ts", import.meta.url), new URL("../abi.ts", import.meta.url), new URL(import.meta.url),
      ...["revm-strict-simulation-transport.ts", "strict-central-adapter-runtime.ts", "revm-sim-client.ts"].map(p => new URL("../../../../" + p, import.meta.url)),
      new URL("../../../../../shared/executor/botvm-program-entry.ts", import.meta.url),
      new URL("../../../../../adapters/runtime-amount-program.ts", import.meta.url)];
    const fingerprint = () => sourcePaths.map(path => ({ path: path.pathname, sha256: sha(readFileSync(path)) }));
    report.sourceFiles = fingerprint(); report.revmSha256 = sha(readFileSync(args.get("--revm-bin")!));
    rpcUrl = args.has("--rpc-file") ? JSON.parse(readFileSync(args.get("--rpc-file")!, "utf8")).MAINNET_RPC_URL : process.env.MAINNET_RPC_URL!;
    assert(typeof rpcUrl === "string" && /^https?:\/\//.test(rpcUrl));
    const rpc = async (method: string, params: unknown[]) => {
      assert(["eth_chainId", "eth_getBlockByNumber", "eth_getTransactionReceipt", "eth_call", "eth_getCode", "eth_getStorageAt"].includes(method));
      const id = ++calls; assert(id <= 50); controller.signal.throwIfAborted();
      const r = await fetch(rpcUrl, { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(20_000)]) });
      assert(r.ok, `HTTP ${r.status}`); const data: any = await r.json();
      assert.equal(data.id, id); assert.equal(data.jsonrpc, "2.0");
      assert(!data.error, "historical read failed: " + method); return data.result;
    };
    assert.equal(BigInt(await rpc("eth_chainId", [])), 1n);
    const receipt = await rpc("eth_getTransactionReceipt", [TX]);
    assert.equal(receipt.blockHash, HASH); assert.equal(Number(BigInt(receipt.blockNumber)), N);
    assert.equal(BigInt(receipt.status), 1n); assert.equal(receipt.transactionHash, TX);
    const header = await rpc("eth_getBlockByNumber", [ethers.toQuantity(N), false]); assert.equal(header.hash, HASH);
    report.header = header;
    const source = { number: N, hash: HASH, generation: 1 }, pin = { blockHash: HASH, requireCanonical: true };
    const executorRuntimeCode = mode === "executor-program" ? loadBotVmRuntimeCode(owner) : undefined;
    if (executorRuntimeCode) report.trustedExecutor = { executor, transactionOrigin: owner, keccak256: executorRuntimeCode.keccak256 };
    simulation = createRevmStrictSourceSimulation({ identity: { source, rpcUrl, chainId: 1, stateRoot: header.stateRoot },
      ...(executorRuntimeCode === undefined ? {} : { executorRuntimeCode }),
      control: { signal: controller.signal, deadlineAtMs }, executionGasLimit: 0x1000000,
      createClient: ({ onFatal }) => new RevmSimClient({ executablePath: args.get("--revm-bin")!, timeoutMs: 90_000, onFatal }),
      onFatal: () => controller.abort(new Error("source/transport fatal")) });
    const runtime = createStrictCentralAdapterRuntime({ simulator: simulation.transport, executor, transactionOrigin: owner,
      generationFence: { assertCurrent(g, s) { assert.equal(g, source.generation); assert.deepEqual(s, source); controller.signal.throwIfAborted(); } },
      provider: { call: async ({ blockTag, ...r }: any) => { assert.equal(blockTag, N); return rpc("eth_call", [r, pin]); },
        getCode: async (a: string) => rpc("eth_getCode", [a, pin]),
        getStorage: async (a: string, slot: string) => rpc("eth_getStorageAt", [a, slot, pin]) } as never });
    const work = async (requests: any[], requirements: any) => {
      const outcome = await executeAdapterWork({ runtime, control: { signal: controller.signal, deadlineAtMs },
        intent: { stage: "exact-refine", familyId: "protocol:yieldbasis-lt" as never,
        source, generation: 1, programInput: undefined,
        program: { requirements: () => requirements, buildRequests: () => requests, decode: ({ results }) => results } } });
      if (outcome.status !== "resolved") {
        report.failedIssuerOutcome = JSON.parse(json(outcome));
        throw new Error("production issuer unresolved: " + outcome.status);
      }
      return outcome.executed.evidence;
    };
    const names = ["ASSET_TOKEN", "STABLECOIN", "CRYPTOPOOL", "amm"];
    const surfaceResults = await work(names.map(name => callRequest(name, lt, LT_INTERFACE.encodeFunctionData(name))), { transports: ["eth-call"] });
    const values = names.map(name => ethers.getAddress(String(LT_INTERFACE.decodeFunctionResult(name, returnedResult(surfaceResults, name).data)[0])));
    const s = { lt, asset: values[0]!, stablecoin: values[1]!, cryptopool: values[2]!, amm: values[3]! };
    const bindingRequests = [
      callRequest("back", s.amm, LEVAMM_INTERFACE.encodeFunctionData("LT_CONTRACT")),
      callRequest("collateral", s.amm, LEVAMM_INTERFACE.encodeFunctionData("COLLATERAL")),
      callRequest("stable", s.amm, LEVAMM_INTERFACE.encodeFunctionData("STABLECOIN")),
      ...[0, 1].map(i => callRequest("coin" + i, s.cryptopool, CRYPTOPOOL_INTERFACE.encodeFunctionData("coins", [i]))),
      ...depositBalanceRequests(s, "balance"),
    ];
    const result = await work(bindingRequests, { transports: ["eth-call"] });
    for (const [id, expected] of [["back", lt], ["collateral", s.cryptopool], ["stable", s.stablecoin], ["coin0", s.stablecoin], ["coin1", s.asset]])
      assert.equal(ethers.getAddress("0x" + returnedResult(result, id!).data.slice(-40)), ethers.getAddress(expected!));
    const balances = decodeDepositBalances(result, "balance", source);
    report.surface = s; report.balances = balances;
    for (const amount of [2_000_000_000_000_000n, 41_885_594_439_574_942n]) {
      const debt = balancedDepositDebt(amount, balances), id = "deposit";
      const row = await recordedDepositTrial(report, { amountIn: amount, debt },
        () => work([mode === "executor-program" ? depositProgramSimulation(id, s, executor, amount) : depositSimulation(id, s, amount, debt)], DEPOSIT_REQUIREMENTS),
        results => mode === "executor-program" ? decodeDepositProgramReceipt(results, id, s, source, executor, amount)
          : decodeDepositReceipt(results, id, s, source, executor, amount));
      console.log(json({ amountIn: amount, debt, amountOut: row.amountOut }));
    }
    assert.deepEqual(fingerprint(), report.sourceFiles); report.result = "pass";
  } catch (e) { report.error = String(e instanceof Error ? e.message : e).split(rpcUrl || "\0").join("[REDACTED]").replace(/https?:\/\/[^\s"<>]+/g, "[REDACTED_URL]"); process.exitCode = 1; }
  finally {
    try { await simulation?.closeAndDrain(); } catch { report.drainFailure = true; report.result = "failed"; process.exitCode = 1; }
    clearTimeout(timer); report.directReads = calls;
    writeFileSync(fd, json(report).split(rpcUrl || "\0").join("[REDACTED]").replace(/https?:\/\/[^\s"<>]+/g, "[REDACTED_URL]") + "\n"); closeSync(fd);
    console.log(json({ result: report.result, error: report.error, samples: report.samples.length }));
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch(() => { console.error("invalid deposit probe input"); process.exitCode = 1; });
