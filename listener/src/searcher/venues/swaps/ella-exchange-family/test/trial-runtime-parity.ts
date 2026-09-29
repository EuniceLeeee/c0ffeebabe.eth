import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { ethers } from "ethers";
import { EXCHANGE_CODE_HASH, MAX_UINT, UNIT, POOL } from "../codec.js";
import { quoteAmountAndApply } from "../state.js";
import type { EllaState } from "../types.js";
import sample from "./public-sample.json";

test("Ella transitions match hash-verified deployed runtime under controlled dependencies", async () => {
  const root = fileURLToPath(new URL("../../../../../../../", import.meta.url));
  const output = resolve(root, "logs/ella-local-trial/foundry");
  const build = spawnSync("forge", ["build", "listener/src/searcher/venues/swaps/ella-exchange-family/test/LocalDependencies.sol",
    "--offline", "--out", output, "--cache-path", resolve(root, "logs/ella-local-trial/foundry-cache")], { cwd: root, encoding: "utf8" });
  assert.equal(build.status, 0, `${build.stdout}\n${build.stderr}`);
  const artifact = (name: string) => JSON.parse(readFileSync(resolve(output, `LocalDependencies.sol/${name}.json`), "utf8"));
  const server = createServer(); server.listen(0, "127.0.0.1"); await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  await new Promise<void>(done => server.close(() => done()));
  // No upstream/fork/key: independent bytecode execution on a disposable EVM.
  const process = spawn("anvil", ["--host", "127.0.0.1", "--port", String(port), "--chain-id", "31337", "--silent"], { stdio: "ignore" });
  const exited = once(process, "exit");
  const provider = new ethers.JsonRpcProvider(`http://127.0.0.1:${port}`, 31337, { staticNetwork: true, cacheTimeout: -1 });
  try {
    let ready = false;
    for (let n = 0; n < 80; n++) {
      try { await provider.send("eth_chainId", []); ready = true; break; }
      catch { await new Promise(done => setTimeout(done, 100)); }
    }
    assert(ready); assert.equal(await provider.send("eth_chainId", []), "0x7a69");
    // Keep synthetic contracts outside the EVM precompile address range.
    const owner = await provider.getSigner(0), pool = "0x1000000000000000000000000000000000000100";
    const token = "0x1000000000000000000000000000000000000200", factory = "0x1000000000000000000000000000000000000300";
    const oracle = "0x1000000000000000000000000000000000000400", executor = "0x1000000000000000000000000000000000000500";
    const fees = "0x1000000000000000000000000000000000000600";
    assert.equal(ethers.keccak256(sample.poolCode), EXCHANGE_CODE_HASH);
    await provider.send("anvil_setCode", [pool, sample.poolCode]);
    for (const [address, name] of [[token, "EllaTokenFixture"], [factory, "EllaFeeFixture"], [oracle, "EllaOracleFixture"], [executor, "EllaTrialDriver"]]) {
      await provider.send("anvil_setCode", [address, artifact(name).deployedBytecode.object]);
    }
    const tokenContract = new ethers.Contract(token, artifact("EllaTokenFixture").abi, owner);
    const feeContract = new ethers.Contract(factory, artifact("EllaFeeFixture").abi, owner);
    const oracleContract = new ethers.Contract(oracle, artifact("EllaOracleFixture").abi, owner);
    const driver = new ethers.Contract(executor, artifact("EllaTrialDriver").abi, owner);
    const slot = (n: number, value: bigint | string) => provider.send("anvil_setStorageAt", [pool, ethers.toBeHex(n, 32), ethers.toBeHex(BigInt(value), 32)]);
    await slot(0, "0x000000000000000000000000000000000000dead"); await slot(1, token);
    await slot(2, BigInt(factory) | (1n << 160n)); await slot(10, factory); await slot(15, oracle);
    const source = { number: 1, hash: ethers.id("ella-bytecode-controlled-dependencies"), generation: 1 };
    const initial: EllaState = { source, price: 2n * UNIT, fee: UNIT * 3n / 1000n, systemCut: UNIT / 5n,
      feesAddress: fees, tokenBalance: 1000n * UNIT, nativeBalance: 1000n * UNIT, baseFeesGenerated: 0n, feesGenerated: 0n };
    const actorToken = 1000n * UNIT, actorNative = 1000n * UNIT;
    async function configure(s: EllaState) {
      await (await tokenContract.seed(pool, s.tokenBalance)).wait();
      await (await tokenContract.seed(executor, actorToken)).wait();
      await (await tokenContract.seed(fees, 0n)).wait();
      await provider.send("anvil_setBalance", [pool, ethers.toQuantity(s.nativeBalance)]);
      await provider.send("anvil_setBalance", [executor, ethers.toQuantity(actorNative)]);
      await provider.send("anvil_setBalance", [fees, "0x0"]);
      await slot(11, s.baseFeesGenerated); await slot(12, s.feesGenerated);
      await (await feeContract.configure(s.fee, s.systemCut, s.feesAddress)).wait();
      await (await oracleContract.configure(s.price)).wait();
      assert.equal(BigInt(await provider.call({ to: pool, data: POOL.encodeFunctionData("tokenPrice") })), s.price);
    }
    let legs = 0;
    async function run(s: EllaState, buys: boolean[], amounts: bigint[]) {
      await configure(s);
      const saved = structuredClone(s);
      let expected = s, actorT = actorToken, actorN = actorNative, feeT = 0n, feeN = 0n;
      const checkpoints = buys.map((buy, index) => {
        const q = quoteAmountAndApply(expected, buy ? "buy-token" : "sell-token", amounts[index], pool, executor);
        assert.equal(q.unavailableReason, undefined); expected = q.nextState;
        actorT += buy ? q.amountOut : -amounts[index]; actorN += buy ? -amounts[index] : q.amountOut;
        if (buy) feeT += q.systemFee; else feeN += q.systemFee;
        return [BigInt(index), expected.tokenBalance, expected.nativeBalance, actorT, actorN, feeT, feeN];
      });
      const receipt = await (await driver.run(pool, token, s.feesAddress, buys, amounts, { gasLimit: 5_000_000 })).wait();
      const actual = receipt.logs.filter((log: { address: string }) => log.address.toLowerCase() === executor)
        .map((log: { topics: string[]; data: string }) => [...driver.interface.parseLog(log)!.args]);
      assert.deepEqual(actual, checkpoints);
      assert.equal(BigInt(await provider.getStorage(pool, 11)), expected.baseFeesGenerated);
      assert.equal(BigInt(await provider.getStorage(pool, 12)), expected.feesGenerated);
      assert.deepEqual(s, saved, "source state never mutated"); legs += buys.length;
    }
    await run(initial, [true], [UNIT]); await run(initial, [false], [UNIT]);
    await run(initial, [true, true, true], [UNIT, UNIT / 3n, 10n]);
    await run(initial, [false, false, false], [UNIT, UNIT / 3n, 10n]);
    await run(initial, [true, false, true, false], [UNIT, UNIT / 5n, UNIT / 2n, UNIT / 7n]);
    const rounding = { ...initial, price: UNIT, fee: UNIT / 3n, systemCut: UNIT / 2n };
    await run(rounding, [true, false, true], [10n, 11n, 17n]);
    // This distinguishes add(fee - cut) from overflowing add(fee).sub(cut).
    await run({ ...rounding, feesGenerated: MAX_UINT - 2n }, [true], [10n]);
    const failures: [EllaState, boolean, bigint, string][] = [
      [{ ...rounding, tokenBalance: 8n }, true, 10n, "gross-output-exceeds-inventory"],
      [{ ...rounding, nativeBalance: 8n }, false, 10n, "gross-output-exceeds-inventory"],
      [{ ...rounding, feesGenerated: MAX_UINT - 1n }, true, 10n, "fee-counter-overflow"],
      [{ ...rounding, baseFeesGenerated: MAX_UINT - 1n }, false, 10n, "fee-counter-overflow"],
    ];
    for (const [state, buy, amount, reason] of failures) {
      await configure(state);
      const quote = quoteAmountAndApply(state, buy ? "buy-token" : "sell-token", amount, pool, executor);
      assert.equal(quote.unavailableReason, reason); assert.strictEqual(quote.nextState, state);
      await assert.rejects(driver.run.staticCall(pool, token, fees, [buy], [amount]));
    }
    const historical = { ...initial, price: BigInt(sample.states[0].calls.tokenPrice),
      tokenBalance: BigInt(sample.states[0].calls.balanceOf), nativeBalance: BigInt(sample.states[0].nativeBalance) };
    await run(historical, [true], [BigInt(sample.amountIn)]);
    assert.equal(quoteAmountAndApply(historical, "buy-token", BigInt(sample.amountIn), pool, executor).amountOut, BigInt(sample.netAmountOut));
    console.log(JSON.stringify({ scope: "cached-exchange-runtime-controlled-dependencies", runtimeHash: EXCHANGE_CODE_HASH,
      legs, rejectedCapacityAndCounterCases: failures.length, sameTransactionSequences: true,
      externalRpc: false, provesUnknownDependencyModels: false }));
  } finally {
    provider.destroy(); process.kill("SIGTERM"); await exited;
  }
});
