// Bounded failure diagnosis only. Uses the production native emitter and strict
// source transport, never admits an instance or substitutes for dual acceptance.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { ethers } from "ethers";
import { runtimeProgramScript } from "../../../../../adapters/runtime-amount-program.js";
import { loadBotVmRuntimeCode } from "../../../../../shared/executor/botvm-executor.js";
import { buildSubscriptCalldata } from "../../../../../shared/executor/botvm-program-entry.js";
import { createRevmStrictSourceSimulation } from "../../../../revm-strict-source-simulation.js";
import { RevmSimClient } from "../../../../revm-sim-client.js";
import type { AdapterRequest } from "../../../adapter-request-program.js";
import { ERC20, POOL, isNativeCoin, routeToken, same, executionData } from "../codec.js";
import { nativeExchangeProgram, nativeExecutionProbe } from "../native.js";
import { materializeAdapterRequests } from "../../../../reth-adapter-work-runtime.js";

async function main() {
  const names = ["--captures", "--pool", "--rpc-file", "--revm-bin", "--out"], args = new Map<string, string>();
  for (let i = 2; i < process.argv.length; i += 2) {
    assert(names.includes(process.argv[i]) && !args.has(process.argv[i]) && process.argv[i + 1]);
    args.set(process.argv[i], process.argv[i + 1]);
  }
  assert(names.every(name => args.has(name)));
  const out = resolve(args.get("--out")!), root = resolve(args.get("--captures")!);
  assert(!existsSync(out));
  const pool = ethers.getAddress(args.get("--pool")!).toLowerCase();
  const captured = readdirSync(root).filter(f => /^strict-\d+\.json$/.test(f)).map(file => {
    const bytes = readFileSync(resolve(root, file));
    return { file, sha256: createHash("sha256").update(bytes).digest("hex"), value: JSON.parse(bytes.toString()) };
  }).filter(c => c.value.request.executorRuntimeCode && c.value.request.data.toLowerCase().includes(pool.slice(2)));
  assert.equal(captured.length, 2, "exactly two captured production native directions required");
  const first = captured[0].value.request, executor = first.from, transactionOrigin = first.transactionOrigin;
  const source = { number: first.blockNumber, hash: first.sourcePin.blockHash, generation: first.blockNumber };
  const code = loadBotVmRuntimeCode(transactionOrigin);
  const rpcUrl = JSON.parse(readFileSync(args.get("--rpc-file")!, "utf8")).MAINNET_RPC_URL;
  assert(typeof rpcUrl === "string" && /^https?:\/\//.test(rpcUrl));
  const redact = (v: string) => v.split(rpcUrl).join("[REDACTED]").replace(/https?:\/\/[^\s"<>]+/g, "[REDACTED_URL]");
  const provider = new ethers.JsonRpcProvider(rpcUrl, 1, { staticNetwork: true, batchMaxCount: 1 });
  const report: any = { schema: "curve-native-diagnostic/v1", claim: "diagnostic only; no identity/Ready/dual/opportunity/performance pass",
    source, executor, transactionOrigin, pool, captures: captured.map(c => ({ file: c.file, sha256: c.sha256 })),
    runtimeCodeHash: code.keccak256, trials: [], wire: [], broadcast: false };
  const control = { signal: AbortSignal.timeout(120000), deadlineAtMs: Date.now() + 120000 };
  const simulation = createRevmStrictSourceSimulation({ identity: { source, rpcUrl, chainId: first.sourcePin.chainId }, control,
    executionGasLimit: first.executionGasLimit, executorRuntimeCode: code,
    createClient({ onFatal }) {
      const client = new RevmSimClient({ executablePath: args.get("--revm-bin"), timeoutMs: 30000, onFatal });
      const original = client.strictSimulate.bind(client);
      client.strictSimulate = async (request, workControl) => {
        const response = await original(request, workControl);
        report.wire.push({ request: { ...request, rpcUrl: "[REDACTED]" }, response });
        return response;
      };
      return client;
    }, onFatal(reason) { report.fatal = reason; } });
  try {
    const pin = { blockHash: source.hash, requireCanonical: true };
    const read = (data: string) => provider.send("eth_call", [{ to: pool, data }, pin]);
    const header = await provider.send("eth_getBlockByNumber", [ethers.toQuantity(source.number), false]);
    assert.equal(header.hash, source.hash); report.header = header;
    const coins = await Promise.all([0, 1].map(async i => POOL.decodeFunctionResult("coins", await read(POOL.encodeFunctionData("coins", [i])))[0] as string));
    assert.equal(coins.filter(isNativeCoin).length, 1); report.coins = coins;
    for (const capture of captured) {
      const previous = capture.value.request;
      assert.deepEqual(previous.sourcePin, first.sourcePin); assert.equal(previous.blockNumber, source.number);
      assert.equal(previous.from, executor); assert.equal(previous.to, executor); assert.equal(previous.transactionOrigin, transactionOrigin);
      assert.equal(previous.executorRuntimeCode.keccak256, code.keccak256); assert.equal(previous.tokenDeals.length, 1);
      const i = coins.findIndex(c => same(routeToken(c), previous.tokenDeals[0].token)); assert(i === 0 || i === 1);
      const j = 1 - i, amountIn = BigInt(previous.tokenDeals[0].amount);
      const amountOut = BigInt(POOL.decodeFunctionResult("get_dy", await read(POOL.encodeFunctionData("get_dy", [i, j, amountIn])))[0]);
      const quote = { i, j, tokenIn: routeToken(coins[i]), tokenOut: routeToken(coins[j]), amountIn, amountOut };
      const original = nativeExecutionProbe(pool, quote, "native-exchange", executor, coins);
      assert(original.kind === "effect-delta-simulation");
      const current = materializeAdapterRequests([original], { executor, transactionOrigin })[0];
      assert(current.kind === "effect-delta-simulation");
      // Saved evidence supplies source/actor/input, not proof that today's
      // changed emitter is byte-for-byte the old failed program.
      report.programBinding ??= [];
      report.programBinding.push({ i, j, previousDataHash: ethers.keccak256(previous.data),
        currentDataHash: ethers.keccak256(current.call.data), sameProgram: current.call.data.toLowerCase() === previous.data.toLowerCase() });
      const trial = async (name: string, request: Extract<AdapterRequest, { kind: "effect-delta-simulation" }>) => {
        const row: any = { name, quote }; report.trials.push(row);
        try { row.result = await simulation.transport.simulate({ request, source,
          callerAuthority: { executor, transactionOrigin }, control }); row.status = "returned"; }
        catch (error) { row.status = "failed"; row.error = String(error instanceof Error ? error.message : error); }
      };
      // This minimum is the existing production runtime value, not a changed
      // quoted acceptance tolerance. All emitter debit/inventory guards remain.
      const runtime = nativeExchangeProgram(pool, quote.tokenIn, quote.tokenOut, i, j, "native-exchange", executor, isNativeCoin(coins[i]));
      await trial("production-runtime-minimum", { ...original,
        executionAssetBoundary: { ...original.executionAssetBoundary!, minimum: 1n },
        call: { ...original.call, data: buildSubscriptCalldata(runtimeProgramScript(runtime.bytes(), amountIn)) } });
      if (!isNativeCoin(coins[i])) {
        // Isolate actual protocol debit/native receipt after the runtime guard
        // rejected it. This diagnostic bypasses the wrapper, never admission.
        const caller = { kind: "executor" as const };
        await trial("direct-pool-debit-diagnostic", { id: "direct-debit", kind: "effect-delta-simulation",
          preCalls: [{ caller, to: quote.tokenIn, data: ERC20.encodeFunctionData("approve", [pool, amountIn]) }],
          call: { caller, executionMode: "impersonated-call-frame", to: pool,
            data: executionData("native-exchange", i, j, amountIn, amountOut, executor) },
          overrideIntent: { caller, tokenBalances: [{ token: quote.tokenIn, amount: amountIn }] },
          observeTokenBalances: [{ token: quote.tokenIn, account: caller }],
          observe: ["return-data", "revert-data", "token-delta", "native-delta", "logs"] });
      }
    }
    report.diagnosticCompleted = true;
  } catch (error) { report.error = String(error instanceof Error ? error.message : error); process.exitCode = 1; }
  finally {
    await simulation.closeAndDrain(); provider.destroy();
    writeFileSync(out, JSON.stringify(report, (_, v) => typeof v === "bigint" ? v.toString() : typeof v === "string" ? redact(v) : v, 2) + "\n", { flag: "wx", mode: 0o600 });
  }
  console.log(JSON.stringify({ out, completed: report.diagnosticCompleted, trials: report.trials.map((x: any) => ({ name: x.name, status: x.status, error: x.error, quote: { amountIn: String(x.quote.amountIn), amountOut: String(x.quote.amountOut) }, result: x.result })) }, (_, v) => typeof v === "bigint" ? v.toString() : v));
}
main().catch(() => { console.error("native diagnostic input/setup failed"); process.exitCode = 1; });
