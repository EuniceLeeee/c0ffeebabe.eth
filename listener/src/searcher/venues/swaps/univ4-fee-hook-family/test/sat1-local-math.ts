import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { ethers } from "ethers";
import { sat1BurnFor, sat1Exp, sat1Exp2, sat1Ln, sat1Log2, sat1MarginalPrice, sat1MintFor,
  sat1QuoteAndApply, sat1TotalMinted, SAT1_K, SAT1_WAD as W, type Sat1LocalState } from "../sat1-math.js";

test("Sat1 port matches independent cached-source Solidity integer math and sequential state", async () => {
  const root = fileURLToPath(new URL("../../../../../../../", import.meta.url));
  const artifacts = resolve(root, "logs/sat1-local-math/foundry");
  const solidity = "listener/src/searcher/venues/swaps/univ4-fee-hook-family/test/Sat1MathOracle.sol";
  const build = spawnSync("forge", ["build", solidity, "--offline", "--out", artifacts,
    "--cache-path", resolve(root, "logs/sat1-local-math/foundry-cache")], { cwd: root, encoding: "utf8" });
  assert.equal(build.status, 0, `${build.stdout}\n${build.stderr}`);
  const artifact = JSON.parse(readFileSync(resolve(artifacts, "Sat1MathOracle.sol/Sat1MathOracle.json"), "utf8"));
  const server = createServer(); server.listen(0, "127.0.0.1"); await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  await new Promise<void>(done => server.close(() => done()));
  // Standalone local EVM: no fork, upstream, signing key or sent transaction.
  const child = spawn("anvil", ["--host", "127.0.0.1", "--port", String(port), "--chain-id", "31337", "--silent"], { stdio: "ignore" });
  const exited = once(child, "exit");
  const provider = new ethers.JsonRpcProvider(`http://127.0.0.1:${port}`, 31337, { staticNetwork: true, cacheTimeout: -1 });
  try {
    let ready = false;
    for (let n = 0; n < 80; n++) {
      try { await provider.send("eth_chainId", []); ready = true; break; }
      catch { await new Promise(done => setTimeout(done, 100)); }
    }
    assert(ready, "local Anvil unavailable");
    assert.equal(await provider.send("eth_chainId", []), "0x7a69");
    const address = "0x1111111111111111111111111111111111111111";
    await provider.send("anvil_setCode", [address, artifact.deployedBytecode.object]);
    const oracle = new ethers.Contract(address, artifact.abi, provider);
    let vectors = 0;
    for (const x of [0n, 1n, 999n, W - 1n, W, W + 1n, 3141592653589793238n, 50n * W, 133n * W]) {
      const result = await oracle.exponential(x);
      assert.deepEqual([...result], [sat1Exp(x), sat1Exp2(x)], `exp at ${x}`); vectors++;
    }
    for (const x of [W, W + 1n, W + W / 3n, 2n * W - 1n, 2n * W, 2718281828459045235n, 10n ** 37n, (1n << 256n) - 1n]) {
      const result = await oracle.logarithm(x);
      assert.deepEqual([...result], [sat1Ln(x), sat1Log2(x)], `log at ${x}`); vectors++;
    }
    // Include the cached source's exact ethCum, tiny values, exhaustion and
    // asymmetric actual/fair supply. Every expected output comes from Solidity.
    for (const eth of [0n, 1n, 10n ** 9n, W, 24278393268966303699n, 1361n * W, 15000n * W]) {
      for (const ethIn of [1n, 1001n, 10n ** 15n, 5n * W]) {
        const supply = sat1TotalMinted(eth), tokens = supply === SAT1_K ? 0n : supply / 13n;
        const result = await oracle.curve(eth, ethIn, supply, tokens);
        assert.deepEqual([...result], [sat1TotalMinted(eth), sat1MarginalPrice(eth), sat1MintFor(eth, ethIn), sat1BurnFor(supply, tokens)]);
        vectors++;
      }
    }
    assert.equal(sat1TotalMinted(24278393268966303699n), 1656190412597317296000000n, "cached real source fair supply");
    assert.equal(sat1MarginalPrice(24278393268966303699n), 15278138135087n, "cached real source marginal price");
    const buyer = "0x1111111111111111111111111111111111111111", seller = "0x2222222222222222222222222222222222222222";
    const block = 26029537n;
    const initial: Sat1LocalState = Object.freeze({ ethCum: 24278393268966303699n,
      actualSupply: 1700000n * W, nativeBalance: 30n * W, managerNativeBalance: 1000n * W,
      managerTokenBalance: 1700000n * W, genesisBlock: 25044547n, initialized: true,
      deprecated: false, lastBuyBlocks: Object.freeze({ [buyer]: 0n, [seller]: 0n }) });
    const solidityState = (s: Sat1LocalState, actor: string) => [s.ethCum, s.actualSupply, s.nativeBalance,
      s.managerNativeBalance, s.managerTokenBalance, s.genesisBlock, s.initialized, s.deprecated, s.lastBuyBlocks[actor]];
    async function compare(s: Sat1LocalState, amount: bigint, buy: boolean, actor: string, at = block) {
      const actual = await oracle.quote(solidityState(s, actor), amount, buy, at);
      const local = sat1QuoteAndApply(s, amount, buy, actor, at);
      assert.equal(local.amountOut, actual[0]);
      assert.deepEqual(solidityState(local.nextState, actor), [...actual[1]]);
      vectors++; return local;
    }
    for (const amount of [1n, 1001n, 10n ** 15n, 5n * W]) await compare(initial, amount, true, buyer);
    let current = (await compare(initial, 10n ** 16n, true, buyer)).nextState;
    current = (await compare(current, 1000n * W, false, seller)).nextState;
    current = (await compare(current, 5n * W, true, buyer)).nextState;
    current = (await compare(current, 1900n * W, false, seller)).nextState;
    await compare(current, 100n * W, false, buyer, block + 1n);
    assert.equal(initial.lastBuyBlocks[buyer], 0n, "original state remains immutable");
    assert.equal(initial.ethCum, 24278393268966303699n);
    const nearThreshold = { ...initial, ethCum: 1360n * W, nativeBalance: 1360n * W };
    const exhausted = await compare(nearThreshold, 5n * W, true, buyer);
    assert(exhausted.nextState.deprecated);
    const sellAmount = 1000n * W;
    const sellOut = sat1QuoteAndApply(initial, sellAmount, false, seller, block).amountOut;
    await compare({ ...initial, nativeBalance: sellOut }, sellAmount, false, seller);
    const rejectCases: [Sat1LocalState, bigint, boolean, string, bigint][] = [
      [initial, 5n * W + 1n, true, buyer, block],
      [{ ...initial, deprecated: true }, W, true, buyer, block],
      [initial, W, true, buyer, initial.genesisBlock + 99n],
      [{ ...initial, initialized: false }, W, true, buyer, block],
      [{ ...initial, nativeBalance: sellOut - 1n }, sellAmount, false, seller, block],
      [{ ...initial, actualSupply: 0n }, W, false, seller, block],
      [{ ...initial, managerNativeBalance: W - 1n }, W, true, buyer, block],
      [{ ...initial, managerTokenBalance: W - 1n }, W, false, seller, block],
      [{ ...initial, lastBuyBlocks: { ...initial.lastBuyBlocks, [seller]: block } }, W, false, seller, block],
      [{ ...initial, lastBuyBlocks: { ...initial.lastBuyBlocks, [seller]: block + 1n } }, W, false, seller, block],
    ];
    for (const [s, amount, buy, actor, at] of rejectCases) {
      await assert.rejects(oracle.quote(solidityState(s, actor), amount, buy, at));
      assert.throws(() => sat1QuoteAndApply(s, amount, buy, actor, at)); vectors++;
    }
    console.log(JSON.stringify({ scope: "standalone-local-EVM-integer-parity", vectors,
      sourceSha256: createHash("sha256").update(readFileSync(resolve(root, solidity))).digest("hex"),
      compiler: (typeof artifact.metadata === "string" ? JSON.parse(artifact.metadata) : artifact.metadata)?.compiler?.version,
      mainnetRpc: false, historicalFullRouteAcceptance: false }));
  } finally {
    provider.destroy(); child.kill("SIGTERM"); await exited;
  }
});
