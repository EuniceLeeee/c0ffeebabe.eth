import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { ContractFactory, JsonRpcProvider, MaxUint256, isError, type Contract, type Signer } from "ethers";
import { runtimeProgramScript } from "../../adapters/runtime-amount-program.js";
import { buildObservedCallRuntimeProgram } from "../venues/observed-call-runtime.js";
import { synthesizeObservedCallTemplates } from "../venues/observed-call-template.js";
import { extractObservedCallSamples } from "../observed-call-evidence.js";
import type { ReadyTransactionEvidence } from "../ready-transaction-input.js";

/** Opt-in because anvil and solc are development tools, not listener runtime
 * dependencies. OBSERVED_CALL_ANVIL_BIN chooses the local binary and
 * OBSERVED_CALL_SOLC_MODULE may be an absolute path to solc/index.js.
 * The test always creates its own loopback chain; no RPC URL is accepted. */
test("actual local EVM executes unknown-call template and preserves output guards", {
  skip: process.env.OBSERVED_CALL_EVM_TEST !== "1", timeout: 180_000,
}, async t => {
  const require = createRequire(import.meta.url);
  const solc = require(process.env.OBSERVED_CALL_SOLC_MODULE ?? "solc");
  const root = new URL("../../../../", import.meta.url);
  const files = ["src/BotVM.sol", "src/Constants.sol", "src/RuntimeAmountVM.sol", "src/RuntimeAmountKernel.sol",
    "src/RuntimeCallSequence.sol", "src/interfaces/IERC20.sol",
    "listener/src/searcher/test/fixtures/ObservedCallSmoke.sol"];
  const output = JSON.parse(solc.compile(JSON.stringify({ language: "Solidity",
    sources: Object.fromEntries(files.map(file => [file, { content: readFileSync(new URL(file, root), "utf8") }])),
    settings: { optimizer: { enabled: true, runs: 200 }, viaIR: true, evmVersion: "cancun",
      outputSelection: { "*": { "*": ["abi", "evm.bytecode.object", "evm.deployedBytecode.object"] } } },
  })));
  const errors = (output.errors ?? []).filter((error: any) => error.severity === "error");
  assert.deepEqual(errors, [], errors.map((error: any) => error.formattedMessage).join("\n"));
  const socket = createServer();
  await new Promise<void>((resolve, reject) => { socket.once("error", reject); socket.listen(0, "127.0.0.1", resolve); });
  const address = socket.address(); assert(address && typeof address !== "string");
  const port = address.port;
  await new Promise<void>(resolve => socket.close(() => resolve()));
  const child = spawn(process.env.OBSERVED_CALL_ANVIL_BIN ?? "anvil",
    // The pre-existing BotVM compiled with this repository's settings exceeds
    // EIP-170. Relax only the local fixture deployment limit to exercise its
    // actual interpreter; this test is not production deployment acceptance.
    ["--host", "127.0.0.1", "--port", String(port), "--chain-id", "31337", "--hardfork", "cancun", "--disable-code-size-limit", "--silent"],
    { stdio: ["ignore", "ignore", "pipe"] });
  let startupError: Error | undefined, stderr = "";
  child.once("error", error => { startupError = error; });
  child.stderr.on("data", data => { stderr = (stderr + String(data)).slice(-2000); });
  const rpc = `http://127.0.0.1:${port}`;
  const provider = new JsonRpcProvider(rpc, 31337, { staticNetwork: true, cacheTimeout: -1 });
  try {
    let ready = false;
    for (let attempt = 0; attempt < 60; attempt++) {
      if (startupError) throw startupError;
      if (child.exitCode !== null) throw new Error(`local anvil stopped: ${stderr}`);
      try {
        const response = await fetch(rpc, { method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }), signal: AbortSignal.timeout(500) });
        const body: any = await response.json();
        if (body.result === "0x7a69") { ready = true; break; }
      } catch { /* Retry only startup on the newly spawned local process. */ }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert(ready, `local anvil did not start: ${stderr}`);
    const owner = await provider.getSigner(0), oldActor = await provider.getSigner(1);
    const oldActorAddress = await oldActor.getAddress();
    const fixture = "listener/src/searcher/test/fixtures/ObservedCallSmoke.sol";
    async function deploy(file: string, name: string, args: readonly unknown[] = [], signer: Signer = owner): Promise<Contract> {
      const artifact = output.contracts[file][name];
      const contract = await new ContractFactory(artifact.abi, `0x${artifact.evm.bytecode.object}`, signer).deploy(...args);
      await contract.waitForDeployment();
      return contract as unknown as Contract;
    }
    const input = await deploy(fixture, "ObservedCallSmokeToken"), out = await deploy(fixture, "ObservedCallSmokeToken");
    const extra = await deploy(fixture, "ObservedCallSmokeToken"), executor = await deploy("src/BotVM.sol", "BotVM");
    const tokenIn = await input.getAddress(), tokenOut = await out.getAddress(), actor = await executor.getAddress();
    const pool = await deploy(fixture, "ObservedCallSmokePool", [tokenIn, tokenOut]), target = await pool.getAddress();
    const send = async (contract: Contract, method: string, args: readonly unknown[]) => {
      const tx = await contract.getFunction(method)(...args); const receipt = await tx.wait(); assert(receipt?.status === 1); return { tx, receipt };
    };
    async function minedEvidence(transactionHash: string): Promise<ReadyTransactionEvidence> {
      const receipt = await provider.send("eth_getTransactionReceipt", [transactionHash]);
      const rawTrace = await provider.send("debug_traceTransaction", [transactionHash, { tracer: "callTracer" }]);
      assert.equal(BigInt(receipt.status), 1n);
      return { receipt: { transactionHash: receipt.transactionHash,
        blockNumber: Number(BigInt(receipt.blockNumber)), blockHash: receipt.blockHash,
        transactionIndex: Number(BigInt(receipt.transactionIndex)), status: 1, logs: receipt.logs },
        method: "debug_traceTransaction", rawTrace };
    }
    await send(input, "mint", [oldActorAddress, 10_000n]);
    await send(input, "mint", [actor, 100_000n]);
    await send(out, "mint", [target, 1_000_000n]);
    await send(extra, "mint", [actor, 91n]);
    await send(input.connect(oldActor) as Contract, "approve", [target, 1000n]);
    const beforeHistorical = await out.getFunction("balanceOf")(oldActorAddress) as bigint;
    const original = await send(pool.connect(oldActor) as Contract, "unfamiliarConversion", [1000n, oldActorAddress, 1n]);
    const historicalOutput = (await out.getFunction("balanceOf")(oldActorAddress) as bigint) - beforeHistorical;
    const originalBlock = await provider.getBlock(original.receipt.blockNumber); assert(originalBlock?.hash);
    // Obtain the candidate from an actual mined transaction. Supplying a
    // hand-authored sample here would exercise only the template/compiler,
    // and could hide an extractor that rejects the very call we claim to learn.
    const evidence = await minedEvidence(original.tx.hash);
    const extracted = extractObservedCallSamples({ evidence, chainId: 31337, target });
    assert.equal(extracted.samples.length, 1, JSON.stringify(extracted.unresolved));
    assert.equal(extracted.witnesses.length, 1);
    const sample = extracted.samples[0]!;
    assert.equal(sample.calldata, original.tx.data.toLowerCase());
    assert.equal(sample.source.transactionHash, original.tx.hash.toLowerCase());
    assert.equal(sample.amountIn, "1000");
    assert.equal(sample.amountOut, historicalOutput.toString());
    assert.equal(sample.tokenIn, tokenIn.toLowerCase());
    assert.equal(sample.tokenOut, tokenOut.toLowerCase());
    assert.deepEqual(sample.payment, { kind: "approval", spender: target.toLowerCase() });
    const learned = synthesizeObservedCallTemplates(sample);
    if (learned.status !== "candidates") assert.fail(JSON.stringify(learned));
    assert.equal(learned.templates.length, 1);
    const template = learned.templates[0]!;
    const results: { amountIn: string; amountOut: string; gasUsed: string }[] = [];
    for (const amountIn of [1000n, 1250n, 2000n]) {
      const block = await provider.getBlock("latest"); assert(block?.hash);
      const program = buildObservedCallRuntimeProgram({ template, executor: actor, actionAdapterId: "fixture:unknown-call",
        source: { number: block.number, hash: block.hash, generation: 0 }, protectedTokens: [await extra.getAddress()] });
      const beforeIn = await input.getFunction("balanceOf")(actor) as bigint;
      const beforeOut = await out.getFunction("balanceOf")(actor) as bigint;
      const run = await send(executor, "execute", [runtimeProgramScript(program.bytes(), amountIn)]);
      const amountOut = (await out.getFunction("balanceOf")(actor) as bigint) - beforeOut;
      assert.equal(beforeIn - (await input.getFunction("balanceOf")(actor) as bigint), amountIn);
      assert.equal(amountOut, amountIn * 3n + 7n);
      assert.equal(await input.getFunction("allowance")(actor, target), 0n);
      assert.equal(await extra.getFunction("balanceOf")(actor), 91n);
      results.push({ amountIn: amountIn.toString(), amountOut: amountOut.toString(), gasUsed: run.receipt.gasUsed.toString() });
    }

    const mintVault = await deploy(fixture, "ObservedCallSmokeMintVault", [tokenIn]);
    const mintTarget = await mintVault.getAddress();
    await send(input.connect(oldActor) as Contract, "approve", [mintTarget, 800n]);
    const originalMint = await send(mintVault.connect(oldActor) as Contract, "unfamiliarMint", [800n, oldActorAddress]);
    const extractedMint = extractObservedCallSamples({ evidence: await minedEvidence(originalMint.tx.hash), chainId: 31337, target: mintTarget });
    assert.equal(extractedMint.samples.length, 1, JSON.stringify(extractedMint.unresolved));
    assert.equal(extractedMint.samples[0]!.amountOut, "1601");
    assert.equal(extractedMint.samples[0]!.tokenOut, mintTarget.toLowerCase());
    const mintTemplates = synthesizeObservedCallTemplates(extractedMint.samples[0]!);
    if (mintTemplates.status !== "candidates") assert.fail(JSON.stringify(mintTemplates));
    assert.equal(mintTemplates.templates.length, 1);
    const mintBlock = await provider.getBlock("latest"); assert(mintBlock?.hash);
    const mintProgram = buildObservedCallRuntimeProgram({ template: mintTemplates.templates[0]!, executor: actor,
      actionAdapterId: "fixture:unknown-mint", source: { number: mintBlock.number, hash: mintBlock.hash, generation: 0 },
      protectedTokens: [tokenOut, await extra.getAddress()], outputWordOffset: 0 });
    const mintBeforeIn = await input.getFunction("balanceOf")(actor) as bigint;
    const mintBeforeOut = await mintVault.getFunction("balanceOf")(actor) as bigint;
    const mintRun = await send(executor, "execute", [runtimeProgramScript(mintProgram.bytes(), 1000n)]);
    const mintReceived = (await mintVault.getFunction("balanceOf")(actor) as bigint) - mintBeforeOut;
    assert.equal(mintBeforeIn - (await input.getFunction("balanceOf")(actor) as bigint), 1000n);
    assert.equal(mintReceived, 2001n);
    assert.equal(await input.getFunction("allowance")(actor, mintTarget), 0n);
    const latest = await provider.getBlock("latest"); assert(latest?.hash);
    const controlInput = { template, executor: actor, actionAdapterId: "fixture:unknown-call",
      source: { number: latest.number, hash: latest.hash, generation: 0 }, protectedTokens: [await extra.getAddress()] };
    for (const control of [{ kind: "zero-runtime-input", amount: 0n, minimumAmountOut: 1n },
      { kind: "forced-output-minimum", amount: 1000n, minimumAmountOut: MaxUint256 }]) {
      const program = buildObservedCallRuntimeProgram({ ...controlInput, minimumAmountOut: control.minimumAmountOut });
      const call = { from: await owner.getAddress(), to: actor,
        data: executor.interface.encodeFunctionData("execute", [runtimeProgramScript(program.bytes(), control.amount)]) };
      await assert.rejects(provider.call(call), error => isError(error, "CALL_EXCEPTION"));
      const trace = await provider.send("debug_traceCall", [call, "latest", { tracer: "callTracer" }]);
      assert(trace.error, `${control.kind} must be an observed EVM revert`);
      if (control.kind === "zero-runtime-input") assert.equal(trace.calls?.length ?? 0, 0, "zero-input guard must precede external calls");
      else assert((trace.calls ?? []).some((frame: any) => frame.to?.toLowerCase() === target.toLowerCase() && !frame.error),
        "forced output floor must follow the real protocol call");
    }
    // The same successful pool call returns the deliberately false value 1.
    // When the existing owner requires return-word equality, its constraint
    // must survive replacement of the selector and reject the fresh credit.
    const strictProgram = buildObservedCallRuntimeProgram({ ...controlInput, outputWordOffset: 0 });
    const strictCall = { from: await owner.getAddress(), to: actor,
      data: executor.interface.encodeFunctionData("execute", [runtimeProgramScript(strictProgram.bytes(), 1000n)]) };
    await assert.rejects(provider.call(strictCall), error => isError(error, "CALL_EXCEPTION"));
    const strictTrace = await provider.send("debug_traceCall", [strictCall, "latest", { tracer: "callTracer" }]);
    assert(strictTrace.error, "owner return-word equality must be an observed EVM revert");
    const poolFrame = (strictTrace.calls ?? []).find((frame: any) => frame.to?.toLowerCase() === target.toLowerCase());
    assert(poolFrame && !poolFrame.error, "return-word rejection must follow the successful protocol call");
    assert.equal(BigInt(poolFrame.output), 1n, "fixture must return its deliberately false output word");
    const balanceReads = (strictTrace.calls ?? []).filter((frame: any) =>
      frame.to?.toLowerCase() === tokenOut.toLowerCase() && frame.input?.startsWith("0x70a08231"));
    assert.equal(balanceReads.length, 2, "runtime must read output inventory before and after the call");
    const strictFreshOutput = BigInt(balanceReads[1].output) - BigInt(balanceReads[0].output);
    assert.equal(strictFreshOutput, 3007n, "owner equality must reject despite positive fresh output");
    t.diagnostic(JSON.stringify({ evidence: "local-anvil-evm", chainId: 31337, compiler: solc.version(),
      candidateSource: "actual-receipt-and-debug-trace", extractedSamples: extracted.samples.length,
      transferWitnesses: extracted.witnesses.length,
      fixtureCodeSizeLimitDisabled: true, botVMRuntimeBytes: output.contracts["src/BotVM.sol"].BotVM.evm.deployedBytecode.object.length / 2,
      selector: template.selector, historicalAmountOut: historicalOutput.toString(), executions: results,
      directMint: { extractedSamples: extractedMint.samples.length, historicalAmountIn: "800", historicalAmountOut: "1601",
        runtimeAmountIn: "1000", runtimeAmountOut: mintReceived.toString(), gasUsed: mintRun.receipt.gasUsed.toString() },
      controls: ["zero-runtime-input:observed-revert", "forced-output-minimum:observed-revert", "owner-return-word-equality:observed-revert"],
      ownerReturnWordEquality: { outputWordOffset: 0, returnedWord: "1", freshAmountOut: strictFreshOutput.toString() },
      fixture: fileURLToPath(new URL("./fixtures/ObservedCallSmoke.sol", import.meta.url)) }));
  } finally {
    provider.destroy(); child.kill("SIGTERM");
    await Promise.race([new Promise<void>(resolve => child.once("exit", () => resolve())),
      new Promise<void>(resolve => setTimeout(resolve, 1000))]);
    if (child.exitCode === null) child.kill("SIGKILL");
  }
});
