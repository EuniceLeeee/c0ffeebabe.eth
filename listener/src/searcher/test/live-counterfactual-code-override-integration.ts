/** Explicit, keyless common-wiring integration driver. Never auto-runs in unit suites. */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import { ethers } from "ethers";
import { createLiveSourceSimulationFactory, prepareForkExecutor } from "../main.js";
import { AnvilStateBackend } from "../../shared/state/state-backend.js";
import { encodeReturn } from "../../encoder.js";
import { buildSubscriptCalldata } from "../../shared/executor/botvm-program-entry.js";
import { buildExecuteCalldata, dryRunBotVmCodeOverrideEnabled, loadBotVmRuntimeCode,
  DEFAULT_SEARCHER_OWNER, DEFAULT_SEARCHER_EXECUTOR } from "../../shared/executor/botvm-executor.js";
import { RevmSimClient, RevmStrictError, RevmFatalError, type DaemonResponse, type StrictSimulateRequest } from "../revm-sim-client.js";

const FROZEN_BLOCK = 26_202_387;
const FROZEN_HASH = "0xa1039f363d8d34e4941dd912bb1caeb8d602f951e1dc4ba0ebee7a592406b134";
const PREPARE_GAS_BALANCE = 100n * 10n ** 18n;
const EXISTING_SEND_GAS_FLOOR = 10_000n * 10n ** 18n;
const WRONG_OWNER = "0x1000000000000000000000000000000000000002";
type Header = { number: string; hash: string; stateRoot: string; parentHash: string };
function options(argv: string[]) {
  const args = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 2) {
    if (!["--block", "--hash", "--port", "--out"].includes(argv[i]!) || !argv[i + 1] || args.has(argv[i]!)) {
      throw new Error("invalid or duplicate input");
    }
    args.set(argv[i]!, argv[i + 1]!);
  }
  const block = Number(args.get("--block")), hash = args.get("--hash")?.toLowerCase();
  const port = Number(args.get("--port")), output = args.get("--out");
  if (block !== FROZEN_BLOCK || hash !== FROZEN_HASH || !Number.isSafeInteger(port) || port < 1024 || port > 65535 ||
      !output || !isAbsolute(output) || existsSync(output)) throw new Error("missing, mismatched or unsafe public input");
  const rpcUrl = process.env.MAINNET_RPC_URL;
  const executablePath = process.env.SEARCHER_REVM_SIM_BIN;
  if (!rpcUrl || !executablePath || !isAbsolute(executablePath) || !existsSync(executablePath) ||
    process.env.SEARCHER_DRY_RUN !== "1" || process.env.SEARCHER_DRY_RUN_KEYLESS !== "1" ||
    process.env.SEARCHER_TEST_DISABLE_DOTENV !== "1" || process.env.SEARCHER_BLOCKSCAN_SUBMIT !== "0" ||
    !dryRunBotVmCodeOverrideEnabled(process.env.SEARCHER_DRY_RUN_BOTVM_CODE_OVERRIDE, true, false)) {
    throw new Error("missing required explicit keyless dry-run configuration");
  }
  const parsed = new URL(rpcUrl);
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.hash) throw new Error("invalid RPC transport");
  return { block, hash, port, output, rpcUrl, executablePath };
}
function sameHeader(header: Header, block: number, hash: string) {
  assert.equal(Number(BigInt(header.number)), block);
  assert.equal(header.hash.toLowerCase(), hash);
  assert.match(header.stateRoot, /^0x[0-9a-f]{64}$/i);
  assert.match(header.parentHash, /^0x[0-9a-f]{64}$/i);
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  let input: ReturnType<typeof options>;
  try { input = options(argv); }
  catch {
    console.error(JSON.stringify({ schema: "live-counterfactual-integration/v1", status: "not_run", reason: "required public inputs/configuration absent, mismatched, or output already exists" }));
    return 2;
  }
  mkdirSync(dirname(input.output), { recursive: true });
  // Exclusive creation prevents a rerun from replacing either a failure or a success.
  writeFileSync(input.output, "", { flag: "wx" });
  const abort = new AbortController();
  let interrupted = false;
  const interrupt = () => { interrupted = true; abort.abort(new Error("integration driver interrupted")); };
  process.on("SIGINT", interrupt); process.on("SIGTERM", interrupt);
  const upstream = new ethers.JsonRpcProvider(input.rpcUrl, 1, { staticNetwork: true });
  const state = new AnvilStateBackend(input.rpcUrl, `http://127.0.0.1:${input.port}`, input.port);
  const report: Record<string, unknown> = { schema: "live-counterfactual-integration/v1", status: "running",
    block: input.block, hash: input.hash, port: input.port, owner: DEFAULT_SEARCHER_OWNER, executor: DEFAULT_SEARCHER_EXECUTOR,
    preparationGasBalanceWei: PREPARE_GAS_BALANCE.toString(), existingStateSendGasFloorWei: EXISTING_SEND_GAS_FLOOR.toString(),
    scope: "common wiring only; RETURN(empty) terminal program; no quote, opportunity, route, profit or Family acceptance claim",
    checks: [], cleanup: { ownedForkStopped: false, strictContextsDrained: false } };
  const checks = report.checks as Record<string, unknown>[];
  const contexts: ReturnType<ReturnType<typeof createLiveSourceSimulationFactory>>[] = [];
  let stage = "source_header", failed = false;
  const markStage = (next: string) => {
    stage = next; report.stage = stage;
    writeFileSync(input.output, JSON.stringify(report, null, 2) + "\n");
  };
  markStage(stage);
  try {
    abort.signal.throwIfAborted();
    const header = await upstream.send("eth_getBlockByNumber", [ethers.toQuantity(input.block), false]) as Header;
    sameHeader(header, input.block, input.hash);
    assert.equal(BigInt(await upstream.send("eth_chainId", [])), 1n);
    report.sourceHeader = { number: input.block, hash: header.hash, stateRoot: header.stateRoot, parentHash: header.parentHash };
    const runtime = loadBotVmRuntimeCode(DEFAULT_SEARCHER_OWNER);
    report.runtimeCodeKeccak256 = runtime.keccak256;
    // Use the existing encoder for a successful terminal RETURN with no calls/value.
    // This is not the daemon's unsuccessful EVM Halt outcome.
    const terminal = encodeReturn(new Uint8Array());
    assert.equal(ethers.hexlify(terminal), "0x03000000");
    const calldata = buildExecuteCalldata(terminal);
    markStage("owned_fork_start");
    await state.forkAt(input.block, { signal: abort.signal, deadlineAtMs: Date.now() + 120_000 });
    sameHeader(await state.provider.send("eth_getBlockByNumber", ["latest", false]), input.block, input.hash);
    const initialExecutorBalance = BigInt(await state.provider.send("eth_getBalance", [DEFAULT_SEARCHER_EXECUTOR, "latest"]));
    assert.equal(await state.provider.send("eth_getCode", [DEFAULT_SEARCHER_EXECUTOR, "latest"]), "0x");
    markStage("default_missing_code");
    await assert.rejects(prepareForkExecutor(state.provider, DEFAULT_SEARCHER_OWNER, DEFAULT_SEARCHER_EXECUTOR), /has no code/);
    checks.push({ name: stage, result: "correct_rejection" });
    markStage("explicit_override");
    await prepareForkExecutor(state.provider, DEFAULT_SEARCHER_OWNER, DEFAULT_SEARCHER_EXECUTOR, runtime);
    assert.equal((await state.provider.send("eth_getCode", [DEFAULT_SEARCHER_EXECUTOR, "latest"])).toLowerCase(), runtime.code);
    assert.equal(BigInt(await state.provider.send("eth_getBalance", [DEFAULT_SEARCHER_OWNER, "latest"])), PREPARE_GAS_BALANCE);
    assert.equal(BigInt(await state.provider.send("eth_getBalance", [DEFAULT_SEARCHER_EXECUTOR, "latest"])), initialExecutorBalance);
    const ownerAbi = new ethers.Interface(["function owner() view returns (address)"]);
    const actualOwner = ownerAbi.decodeFunctionResult("owner", await state.call({ to: DEFAULT_SEARCHER_EXECUTOR, data: ownerAbi.encodeFunctionData("owner") }))[0];
    assert.equal(ethers.getAddress(actualOwner), ethers.getAddress(DEFAULT_SEARCHER_OWNER));
    checks.push({ name: stage, result: "exact_code_owner_bound", codeKeccak256: runtime.keccak256 });
    markStage("wrong_owner");
    await assert.rejects(state.call({ to: DEFAULT_SEARCHER_EXECUTOR, from: WRONG_OWNER, data: calldata }), (error: unknown) => {
      const e = error as { code?: unknown; data?: unknown; reason?: unknown };
      assert.equal(e.code, "CALL_EXCEPTION");
      const expected = "0x08c379a0" + ethers.AbiCoder.defaultAbiCoder().encode(["string"], ["not owner"]).slice(2);
      assert.equal(e.data, expected);
      return true;
    });
    checks.push({ name: stage, result: "not_owner_rejection", mode: "read_only_eth_call", caller: WRONG_OWNER });
    markStage("owner_state_send_terminal");
    const txHash = await state.send({ from: DEFAULT_SEARCHER_OWNER, to: DEFAULT_SEARCHER_EXECUTOR, data: calldata, gas: "0x1000000" });
    const receipt = await state.provider.send("eth_getTransactionReceipt", [txHash]);
    assert.equal(BigInt(receipt.status), 1n);
    const senderBalance = BigInt(await state.provider.send("eth_getBalance", [DEFAULT_SEARCHER_OWNER, "latest"]));
    const gasCost = BigInt(receipt.gasUsed) * BigInt(receipt.effectiveGasPrice);
    assert.equal(senderBalance + gasCost, EXISTING_SEND_GAS_FLOOR);
    assert.equal(BigInt(await state.provider.send("eth_getBalance", [DEFAULT_SEARCHER_EXECUTOR, "latest"])), initialExecutorBalance);
    checks.push({ name: stage, result: "success", localForkTransactionHash: txHash, localReceiptBlock: Number(BigInt(receipt.blockNumber)),
      gasUsed: BigInt(receipt.gasUsed).toString(), existingVirtualEoaGasFloorWei: EXISTING_SEND_GAS_FLOOR.toString(), ownerBalanceAfterWei: senderBalance.toString() });
    markStage("reset_reinstall");
    await state.forkAt(input.block, { signal: abort.signal, deadlineAtMs: Date.now() + 120_000 });
    sameHeader(await state.provider.send("eth_getBlockByNumber", ["latest", false]), input.block, input.hash);
    assert.equal(await state.provider.send("eth_getCode", [DEFAULT_SEARCHER_EXECUTOR, "latest"]), "0x");
    await prepareForkExecutor(state.provider, DEFAULT_SEARCHER_OWNER, DEFAULT_SEARCHER_EXECUTOR, runtime);
    assert.equal((await state.provider.send("eth_getCode", [DEFAULT_SEARCHER_EXECUTOR, "latest"])).toLowerCase(), runtime.code);
    assert.equal(BigInt(await state.provider.send("eth_getBalance", [DEFAULT_SEARCHER_OWNER, "latest"])), PREPARE_GAS_BALANCE);
    assert.equal(BigInt(await state.provider.send("eth_getBalance", [DEFAULT_SEARCHER_EXECUTOR, "latest"])), initialExecutorBalance);
    checks.push({ name: stage, result: "same_frozen_code_reinstalled" });

    const source = Object.freeze({ number: input.block, hash: input.hash, generation: 1 });
    const invocation = { source, callerAuthority: { executor: DEFAULT_SEARCHER_EXECUTOR, transactionOrigin: DEFAULT_SEARCHER_OWNER },
      request: { id: "common-terminal", kind: "effect-delta-simulation" as const,
        call: { caller: { kind: "executor" as const }, executionMode: "executor-program" as const,
          to: DEFAULT_SEARCHER_EXECUTOR, data: buildSubscriptCalldata(terminal) },
        overrideIntent: { caller: { kind: "executor" as const } }, observe: ["return-data" as const] } };
    let creates = 0;
    const captures: { request: StrictSimulateRequest; response: DaemonResponse }[] = [];
    const factoryInput = { rpcUrl: input.rpcUrl, chainId: 1, executablePath: input.executablePath, timeoutMs: 60_000,
      runtimeAbort: abort, onFatal() {} };
    // Thin observation around the real production client; no synthetic response or alternate engine.
    const realClient: NonNullable<Parameters<typeof createLiveSourceSimulationFactory>[0]["createClient"]> = ({ onFatal }) => {
      creates++;
      const client = new RevmSimClient({ executablePath: input.executablePath, timeoutMs: 60_000, onFatal });
      return { get isTerminal() { return client.isTerminal; },
        async strictSimulate(request, control) { const response = await client.strictSimulate(request, control); captures.push({ request, response }); return response; },
        closeAndDrain: () => client.closeAndDrain() };
    };
    markStage("strict_no_code");
    const withoutCode = createLiveSourceSimulationFactory({ ...factoryInput, createClient: realClient })({ source,
      control: { signal: abort.signal, deadlineAtMs: Date.now() + 60_000 } });
    contexts.push(withoutCode);
    await assert.rejects(withoutCode.transport.simulate(invocation), error => error instanceof RevmStrictError && error.kind === "validation");
    assert.equal(creates, 0); assert.equal(captures.length, 0);
    await withoutCode.closeAndDrain();
    checks.push({ name: stage, result: "correct_rejection_before_daemon_admission" });
    markStage("strict_actual_code");
    const withCode = createLiveSourceSimulationFactory({ ...factoryInput, createClient: realClient, executorRuntimeCode: runtime })({ source,
      control: { signal: abort.signal, deadlineAtMs: Date.now() + 60_000 } });
    contexts.push(withCode);
    const result = await withCode.transport.simulate(invocation);
    assert.equal(result.data, "0x"); assert.equal(creates, 1); assert.equal(captures.length, 1);
    const { request, response } = captures[0]!;
    assert.equal(request.blockNumber, input.block); assert.equal(request.sourcePin!.blockHash, input.hash);
    assert.equal(request.from, DEFAULT_SEARCHER_EXECUTOR); assert.equal(request.to, DEFAULT_SEARCHER_EXECUTOR);
    assert.equal(request.transactionOrigin, DEFAULT_SEARCHER_OWNER);
    assert.deepEqual(request.executorRuntimeCode, runtime);
    assert.equal(request.tokenDeals?.length ?? 0, 0); assert.equal(request.preCalls?.length ?? 0, 0);
    assert.equal(request.nativeBalanceWei, undefined);
    const att = response.sourceAttestation!;
    assert.equal(att.kind, "node-attested"); assert.equal(att.chainId, 1); assert.equal(att.blockNumber, input.block);
    assert.equal(att.blockHash, input.hash); assert.equal(att.stateRoot, header.stateRoot); assert.equal(att.parentHash, header.parentHash);
    assert.deepEqual(response.strict!.counterfactualExecutorCode, { address: DEFAULT_SEARCHER_EXECUTOR, keccak256: runtime.keccak256 });
    assert.equal(response.strict!.outcome.kind, "Success"); assert.equal(response.strict!.outcome.phase, "main");
    checks.push({ name: stage, result: "node_attested_success", sourceAttestation: att,
      counterfactualExecutorCode: response.strict!.counterfactualExecutorCode,
      caller: request.from, transactionOrigin: request.transactionOrigin, executionGasUsed: response.strict!.executionGasUsed });
    report.status = "passed";
  } catch (error) {
    failed = true; report.status = interrupted ? "interrupted" : "failed";
    // Never print RPC credentials, raw request or arbitrary upstream error text.
    report.failure = { stage, name: error instanceof Error ? error.name : "unknown", strictKind: error instanceof RevmStrictError ? error.kind : undefined,
      fatalKind: error instanceof RevmFatalError ? error.fatal.kind : undefined };
  } finally {
    let contextsDrained = true;
    for (const context of contexts) {
      try { await context.closeAndDrain(); } catch { contextsDrained = false; failed = true; }
    }
    let forkStopped = false;
    try { await state.stopAndWait(); forkStopped = true; } catch { failed = true; }
    state.provider.destroy(); upstream.destroy();
    process.off("SIGINT", interrupt); process.off("SIGTERM", interrupt);
    report.cleanup = { ownedForkStopped: forkStopped, strictContextsDrained: contextsDrained,
      ownership: "only this AnvilStateBackend instance and factory-owned strict contexts are stopped; occupied port guard never kills existing processes" };
    if (failed && report.status === "passed") report.status = "failed_cleanup";
    writeFileSync(input.output, JSON.stringify(report, null, 2) + "\n");
  }
  console.log(JSON.stringify({ schema: report.schema, status: report.status, block: input.block, hash: input.hash,
    checks: checks.length, output: input.output, cleanup: report.cleanup }));
  return failed ? 1 : 0;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(code => { process.exitCode = code; }, () => {
    console.error(JSON.stringify({ schema: "live-counterfactual-integration/v1", status: "failed", reason: "driver_initialization_failure" }));
    process.exitCode = 1;
  });
}
