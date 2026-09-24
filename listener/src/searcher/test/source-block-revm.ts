// Actual local REVM + production BotVM/compiler against synthetic loopback
// archive data. Trace replies are controlled independent oracle fixtures, NOT
// historical evidence. No request can leave this server for an upstream RPC.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { id, keccak256 } from "ethers";
import { SourceBlockSimulator, sourceBlockRevmRequest, buildSourceBlockExecutionInput } from "../simulator/source-block.js";
import { RevmSimClient } from "../revm-sim-client.js";
import { register } from "../../adapters/registry.js";
import { erc20TransferAdapter } from "../../adapters/erc20.js";
import { parseBlockScanObservedHeader } from "../blockscan-observed-header.js";
import type { ResolvedPlan } from "../solver/solver.js";

const addr = (n: number) => `0x${(4096 + n).toString(16).padStart(40, "0")}`;
const word = (n: bigint | number) => `0x${n.toString(16).padStart(64, "0")}`;
const q = (n: bigint | number) => `0x${n.toString(16)}`;
const owner = addr(1), executor = addr(2), token = addr(3), holder = addr(4);
const rawHeader = { number: q(300), hash: word(300), parentHash: word(299), stateRoot: word(99),
  timestamp: q(1_800_000_000), baseFeePerGas: q(1000), gasLimit: q(60_000_000), gasUsed: q(30_000_000),
  miner: addr(5), mixHash: word(123), difficulty: "0x0", blobGasUsed: "0x0", excessBlobGas: "0x0",
  nonce: "0x0000000000000000", sha3Uncles: "0x1dcc4de8dec75d7aab85b567b6ccd41ad312451b948a7413f0a142fd40d49347", uncles: [],
  transactionsRoot: word(4), receiptsRoot: word(5), withdrawalsRoot: word(6), parentBeaconBlockRoot: word(7),
  requestsHash: word(8), logsBloom: `0x${"00".repeat(256)}`, extraData: "0x", transactions: [], withdrawals: [] };

function tokenCode(expectedOwnerBalance?: bigint) {
  let bytes = ""; const labels = new Map<string, number>(), refs: [number, string][] = [];
  const emit = (code: string) => { bytes += code; };
  const push = (n: bigint | number) => { const s = BigInt(n).toString(16).padStart(64, "0"); emit(`7f${s}`); };
  const jump = (label: string) => { emit("61"); refs.push([bytes.length, label]); emit("000057"); };
  const label = (name: string) => { labels.set(name, bytes.length / 2); emit("5b"); };
  // balanceOf observes persistent state independently, including proxy-safe probes.
  emit("60003560e01c"); push(0x70a08231); emit("14"); jump("balance");
  // The main transfer succeeds ONLY in B's actual environment, including GASPRICE.
  for (const [op, value] of [["43", 300], ["42", 1_800_000_000], ["48", 1000], ["3a", 1000], ["46", 1]] as const) {
    emit(op); push(value); emit("1415"); jump("fail");
  }
  if (expectedOwnerBalance !== undefined) {
    push(BigInt(owner)); emit("31"); push(expectedOwnerBalance); emit("1415"); jump("fail");
  }
  push(125); emit("600055");
  push(100); emit("600052");
  for (const [from, to] of [[holder, executor], [executor, holder]]) {
    push(BigInt(to!)); push(BigInt(from!)); push(BigInt(id("Transfer(address,address,uint256)"))); emit("60206000a3");
  }
  emit("600160005260206000f3");
  label("balance"); emit("600435"); push(BigInt(executor)); emit("14"); jump("executor");
  emit("600435"); push(BigInt(holder)); emit("14"); jump("holder");
  emit("600060005260206000f3");
  label("executor"); emit("60005460005260206000f3");
  label("holder"); emit("606460005260206000f3");
  label("fail"); emit("60006000fd");
  for (const [at, name] of refs) bytes = bytes.slice(0, at) + labels.get(name)!.toString(16).padStart(4, "0") + bytes.slice(at + 4);
  return `0x${bytes}`;
}

register(erc20TransferAdapter);
for (const codeMode of ["onchain", "counterfactual-revert", "counterfactual-absent"] as const)
test(`full compiled BotVM source-block ${codeMode}: B/GASPRICE, isolated code and effects`, async () => {
  const artifact = JSON.parse(readFileSync(resolve("../out/BotVM.sol/BotVM.json"), "utf8"));
  let code: string = artifact.deployedBytecode.object;
  const refs = Object.values(artifact.deployedBytecode.immutableReferences) as { start: number; length: number }[][];
  assert.equal(refs.length, 1);
  for (const ref of refs[0]!) { assert.equal(ref.length, 32); const at = 2 + ref.start * 2;
    code = code.slice(0, at) + word(BigInt(owner)).slice(2) + code.slice(at + 64); }
  const executorRuntimeCode = codeMode === "onchain" ? undefined : { code, keccak256: keccak256(code) };
  const plan: ResolvedPlan = { root: { adapterId: "erc20-transfer", target: token, tokenIn: token, tokenOut: token,
    amount: 100n, params: { to: holder }, children: [] }, flashAmount: 100n, profitToken: token, netProfit: 999999n, templateName: "synthetic full-executor control" };
  let differentEffects = false, badGasPrice = false, traceUnavailable = false;
  let realOwnerBalance = 1_234_567_890_123_456_789n;
  const methods: string[] = [];
  const server = createServer((req, res) => {
    let data = ""; req.setEncoding("utf8"); req.on("data", c => data += c);
    req.on("end", () => {
      const body = JSON.parse(data);
      const handle = (r: any) => {
        methods.push(r.method);
        const ok = (result: unknown) => ({ jsonrpc: "2.0", id: r.id, result });
        const err = () => ({ jsonrpc: "2.0", id: r.id, error: { code: -32601, message: "local fixture unsupported" } });
        if (r.method === "eth_chainId") return ok("0x1");
        if (r.method === "eth_getBlockByHash") { assert.equal(r.params[0], rawHeader.hash); return ok(rawHeader); }
        if (r.method === "eth_getBlockByNumber") { assert.equal(r.params[0], rawHeader.number); return ok(rawHeader); }
        const pin = r.params[r.method === "eth_getStorageAt" ? 2 : 1];
        assert.deepEqual(pin, { blockHash: rawHeader.hash, requireCanonical: true });
        if (r.method === "eth_getBalance" && r.params[0] === owner) return ok(q(realOwnerBalance));
        if (r.method === "eth_getBalance" || r.method === "eth_getTransactionCount") return ok(r.params[0] === executor && codeMode !== "counterfactual-absent"
          ? r.method === "eth_getBalance" ? q(900) : q(7) : "0x0");
        if (r.method === "eth_getCode") return ok(r.params[0] === executor
          ? codeMode === "onchain" ? code : codeMode === "counterfactual-revert" ? "0x60006000fd" : "0x"
          : r.params[0] === token ? tokenCode(executorRuntimeCode ? realOwnerBalance : undefined) : "0x");
        if (r.method === "eth_getStorageAt") return ok(r.params[0] === token && BigInt(r.params[1]) === 0n ? word(100) : word(0));
        if (r.method === "debug_traceCall") {
          const [tx, , config] = r.params;
          if (config.tracer === "prestateTracer" && !config.tracerConfig?.diffMode) return err(); // optional REVM warm hint
          assert(!config.blockOverrides); assert.equal(tx.gasPrice, "0x3e8");
          assert.equal(tx.from, owner); assert.equal(tx.to, executor);
          assert.deepEqual(config.stateOverrides[executor], executorRuntimeCode ? { code } : undefined);
          assert.deepEqual(Object.keys(config.stateOverrides), executorRuntimeCode ? [executor] : [owner]);
          if (executorRuntimeCode && realOwnerBalance < BigInt(tx.gas) * BigInt(tx.gasPrice))
            return { jsonrpc: "2.0", id: r.id, error: { code: -32000, message: "insufficient funds for gas" } };
          if (traceUnavailable) return err();
          if (config.tracer === "prestateTracer") return ok({ pre: { [token]: { storage: { [word(0)]: word(100) } } },
            post: { [token]: { storage: { [word(0)]: word(differentEffects ? 124 : 125) } } } });
          return ok({ type: "CALL", from: tx.from, to: tx.to, input: tx.data, output: "0x", gasUsed: "0x5208" });
        }
        if (r.method === "eth_call") {
          const [tx, , overlay] = r.params;
          assert.equal(tx.gasPrice, rawHeader.baseFeePerGas, "balanceOf GASPRICE must match strict_probe");
          assert.equal(tx.to, token); assert.equal(tx.data.slice(0, 10), "0x70a08231");
          assert.deepEqual(overlay?.[executor], executorRuntimeCode ? { code } : undefined,
            "both before and post balance probes must see the identical counterfactual code");
          assert.equal(overlay?.[owner], undefined, "independent balance probes cannot top up the owner");
          const account = `0x${tx.data.slice(-40)}`;
          return ok(account === executor ? overlay?.[token]?.stateDiff?.[word(0)] ?? word(100) : account === holder ? word(100) : word(0));
        }
        return err();
      };
      try { res.end(JSON.stringify(Array.isArray(body) ? body.map(handle) : handle(body))); }
      catch (e) { res.statusCode = 500; res.end(JSON.stringify({ fixtureFailure: String(e) })); }
    });
  });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  const listening = server.address(); assert(listening && typeof listening === "object");
  const simulator = new SourceBlockSimulator({ rpcUrl: `http://127.0.0.1:${listening.port}`, executor, owner,
    chainId: 1, stateRoot: rawHeader.stateRoot, executablePath: resolve("revm-sim/target/debug/revm-sim"),
    executorRuntimeCode,
    fundingForPlan: () => ({ asset: token, liquidityHolder: holder, target: holder, amount: "100" }) });
  const context = () => ({ source: { number: 300, hash: rawHeader.hash, generation: 7 },
    header: parseBlockScanObservedHeader(rawHeader, 300, 1n), signal: new AbortController().signal, deadlineAtMs: Date.now() + 30_000 });
  try {
    const input = simulator.captureInput(plan, context());
    const differentCode = buildSourceBlockExecutionInput({ ...input, header: context().header,
      executorRuntimeCode: { code: "0x00", keccak256: keccak256("0x00") } });
    const callsBeforeMismatch = methods.length;
    await assert.rejects(simulator.simulateExecutionInput(differentCode, context()), /code configuration mismatch/);
    assert.equal(methods.length, callsBeforeMismatch, "even a coherently rebuilt different code/hash must reject before I/O");
    if (executorRuntimeCode) {
      assert(Object.isFrozen(input.executorRuntimeCode));
      const original = { ...executorRuntimeCode };
      executorRuntimeCode.code = "0x00"; executorRuntimeCode.keccak256 = keccak256("0x00");
      assert.deepEqual(simulator.captureInput(plan, context()).executorRuntimeCode, original, "options copy must detach code binding");
      Object.assign(executorRuntimeCode, original);
      const client = new RevmSimClient({ executablePath: resolve("revm-sim/target/debug/revm-sim") });
      try {
        const req = sourceBlockRevmRequest(input, `http://127.0.0.1:${listening.port}`);
        assert(!Object.hasOwn(req, "nativeBalanceWei"));
        req.observeNativeBalances!.push(owner);
        const { executorRuntimeCode: _, ...plain } = req;
        const baseline = await client.strictSimulate(plain);
        assert.equal(baseline.success, codeMode === "counterfactual-absent");
        if (baseline.success) assert(baseline.strict!.tokenDeltas.every(d => d.delta === "0"));
        const changed = await client.strictSimulate(req);
        assert(changed.success); assert.equal(changed.strict!.tokenDeltas[0]!.delta, "25");
        assert.deepEqual(changed.strict!.nativeDeltas[1], { account: owner,
          before: realOwnerBalance.toString(), after: realOwnerBalance.toString(), delta: "0" });
        assert.deepEqual(changed.strict!.counterfactualExecutorCode, { address: executor, keccak256: original.keccak256 });
        const clean = await client.strictSimulate(plain);
        assert.equal(clean.success, baseline.success); assert.deepEqual(clean.strict, baseline.strict, "override must not leak into reused pinned cache");
      } finally { await client.closeAndDrain(); }
    }
    for (let i = 0; i < 2; i++) {
      const result = await simulator.simulateExecutionInput(input, context());
      assert(result.success); assert.equal(result.grossProfit, 25n); assert.equal(result.gasUsed, 21000n);
      assert(result.sourceBlockEvidence.repaymentVerified); assert.equal(result.calldata, input.calldata);
      assert.deepEqual(result.sourceBlockEvidence.counterfactualExecutorCode, executorRuntimeCode
        ? { address: executor, keccak256: executorRuntimeCode.keccak256 } : undefined);
      assert.equal(result.sourceBlockEvidence.effects.nativeDeltas[0]!.before, codeMode === "counterfactual-absent" ? "0" : "900");
      assert.equal(result.sourceBlockEvidence.effects.nativeDeltas[0]!.delta, "0");
    }
    differentEffects = true;
    await assert.rejects(simulator.simulateExecutionInput(input, context()), /effects disagree/);
    differentEffects = false; traceUnavailable = true;
    await assert.rejects(simulator.simulateExecutionInput(input, context()), /trace unavailable/);
    traceUnavailable = false;
    if (executorRuntimeCode) {
      realOwnerBalance = 0n;
      await assert.rejects(simulator.simulateExecutionInput(input, context()), /trace unavailable/,
        "insufficient real gas funding must reject without injecting owner balance or retrying funded");
      realOwnerBalance = 1_234_567_890_123_456_789n;
    }
    const changed = { ...context(), header: { ...context().header, baseFeePerGas: 1125n } };
    await assert.rejects(simulator.simulate(plan, changed), /header changed/);
    const abort = new AbortController(); abort.abort();
    const n = methods.length;
    await assert.rejects(simulator.simulateExecutionInput(input, { ...context(), signal: abort.signal }), /cancelled/);
    assert.equal(methods.length, n);
    assert(!methods.some(m => /send|sign|mine|eth_simulate/i.test(m)));
  } finally { await new Promise<void>(done => server.close(() => done())); }
});
