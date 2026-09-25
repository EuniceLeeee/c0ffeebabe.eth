import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { ethers } from "ethers";
import { plugin } from "../../../production-families/uniswap-v1.production.js";
import { concatBytes, encodeCall } from "../../../../../encoder.js";
import { MAX_UINT, MULTICALL, WETH } from "../codec.js";
import { descriptor, result } from "./fixtures.js";

const root = fileURLToPath(new URL("../../../../../../../", import.meta.url));
const artifacts = resolve(root, "logs/univ1-phase1/foundry");
const build = spawnSync("forge", ["build", "listener/src/searcher/venues/swaps/univ1-family/test/LocalExecution.sol", "--offline",
  "--out", artifacts, "--cache-path", resolve(root, "logs/univ1-phase1/foundry-cache")], { cwd: root, encoding: "utf8" });
assert.equal(build.status, 0, `${build.stdout}\n${build.stderr}`);
function artifact(file: string, name: string) {
  return JSON.parse(readFileSync(resolve(artifacts, `${file}.sol/${name}.json`), "utf8"));
}
const server = createServer(); server.listen(0, "127.0.0.1"); await once(server, "listening");
const port = (server.address() as { port: number }).port; await new Promise<void>(r => server.close(() => r()));
// Anvil has no fork URL or upstream. All transactions below use its unlocked
// disposable account via eth_sendTransaction; no wallet key is read or signed.
const child = spawn("anvil", ["--host", "127.0.0.1", "--port", String(port), "--chain-id", "31337", "--silent"], { stdio: "ignore" });
const exited = once(child, "exit");
const provider = new ethers.JsonRpcProvider(`http://127.0.0.1:${port}`, 31337, { staticNetwork: true, cacheTimeout: -1 });
try {
  let ready = false;
  for (let n = 0; n < 80; n++) {
    try { await provider.send("eth_chainId", []); ready = true; break; } catch { await new Promise(r => setTimeout(r, 100)); }
  }
  assert(ready, "local Anvil unavailable");
  assert.equal(await provider.send("eth_chainId", []), "0x7a69");
  const owner = await provider.getSigner(0), issuer = await provider.getSigner(1);
  async function deploy(file: string, name: string, args: unknown[] = []) {
    const a = artifact(file, name), c = await new ethers.ContractFactory(a.abi, a.bytecode.object, owner).deploy(...args);
    await c.waitForDeployment(); return new ethers.Contract(await c.getAddress(), a.abi, owner);
  }
  const token = await deploy("LocalExecution", "LocalToken"), bot = await deploy("BotVM", "BotVM");
  const pool = await deploy("LocalExecution", "LocalExchange", [await token.getAddress(), await issuer.getAddress()]);
  const poolAddress = (await pool.getAddress()).toLowerCase(), tokenAddress = (await token.getAddress()).toLowerCase(), executor = (await bot.getAddress()).toLowerCase();
  const wa = artifact("LocalExecution", "LocalWeth");
  await provider.send("anvil_setCode", [WETH, wa.deployedBytecode.object]);
  await provider.send("anvil_setCode", [MULTICALL, artifact("LocalExecution", "LocalBalanceReader").deployedBytecode.object]);
  const weth = new ethers.Contract(WETH, wa.abi, owner);
  await provider.send("anvil_setBalance", [WETH, ethers.toBeHex(10_000n * 10n ** 18n)]);
  await provider.send("anvil_setBalance", [poolAddress, ethers.toBeHex(100n * 10n ** 18n)]);
  const oldNative = 7n * 10n ** 18n, oldWeth = 11n * 10n ** 18n, oldToken = 500n * 10n ** 18n;
  await provider.send("anvil_setBalance", [executor, ethers.toBeHex(oldNative)]);
  await (await weth.mint(executor, oldWeth)).wait();
  await (await token.mint(executor, oldToken)).wait();
  await (await token.mint(poolAddress, 50_000n * 10n ** 18n)).wait();
  // Local descriptor fixture is NOT an admitted chain instance. Exact and
  // action calls below are the actual production Family functions.
  const d = { ...descriptor(), pool: poolAddress, instanceKey: poolAddress as ReturnType<typeof descriptor>["instanceKey"], token: tokenAddress,
    issuer: (await issuer.getAddress()).toLowerCase() };
  const routes = plugin.routes.project({ descriptor: d });
  const checkpoint = await provider.send("evm_snapshot", []);
  async function balances() { return { native: await provider.getBalance(executor), weth: BigInt(await weth.balanceOf(executor)), token: BigInt(await token.balanceOf(executor)) }; }
  function assertDelta(before: Awaited<ReturnType<typeof balances>>, after: Awaited<ReturnType<typeof balances>>, buy: boolean, amount: bigint, out: bigint) {
    assert.equal(after.native - before.native, 0n, "native residual or old balance subsidy");
    assert.equal(after.weth - before.weth, buy ? -amount : out, "WETH actual delta");
    assert.equal(after.token - before.token, buy ? out : -amount, "token actual delta");
  }
  async function prepare(buy: boolean, amountIn: bigint) {
    const block = await provider.getBlock("latest"); assert(block?.hash);
    const source = { number: block.number, hash: block.hash, generation: 1 };
    const route = routes.find(r => r.buy === buy)!;
    const input = { descriptor: d, route, source, executor, amountIn, runtimeEvidence: [] };
    const method = plugin.exact.methods(input)[1]; assert(method.kind === "request-program");
    const initialResults = await Promise.all(method.program.buildRequests(input).map(async r => {
      assert(r.kind === "eth-call");
      const data = await provider.send("eth_call", [{ to: r.to, data: r.data }, ethers.toQuantity(source.number)]);
      return result(r.id, data, source);
    }));
    const q = method.program.decode({ programInput: input, initialResults, dependentEvidence: [] });
    const fragment = plugin.execution.buildFragment({ ...input, quotedAmountOut: q.amountOut, minAmountOut: 1n, exactEvidence: q.evidence });
    return { node: fragment.nodes[0], q, amountIn };
  }
  function script(node: Awaited<ReturnType<typeof prepare>>["node"], buy: boolean) {
    const swap = plugin.actionAdapters[0].encode(node, executor, new Uint8Array());
    const approval = ethers.getBytes(token.interface.encodeFunctionData("approve", [poolAddress, MAX_UINT]));
    return ethers.hexlify(buy ? swap : concatBytes(encodeCall(tokenAddress, approval), swap));
  }
  const receipts = [];
  // Production reference amount is intentionally NOT claimed here. These are
  // local amounts plus the cached TX's input, before the serialized N gate.
  for (const buy of [true, false]) for (const amount of [1001n, 10n ** 16n, 0x16a10de9085cb7n]) {
    const { node, q } = await prepare(buy, amount);
    if (q.amountOut === 0n) continue;
    const before = await balances();
    await (await bot.execute(script(node, buy), { gasLimit: 2_000_000 })).wait();
    const after = await balances(); assertDelta(before, after, buy, amount, q.amountOut);
    receipts.push({ buy, amountIn: String(amount), quoted: String(q.amountOut), actual: String(buy ? after.token - before.token : after.weth - before.weth), nativeDelta: String(after.native - before.native) });
  }
  // Overstated output cannot be funded from the deliberately nonzero old ETH.
  for (const buy of [true, false]) {
    const { node, q } = await prepare(buy, 10n ** 16n), before = await balances();
    const wrong = { ...node, params: { ...node.params, amountOut: q.amountOut + 1n } };
    await assert.rejects(async () => { await (await bot.execute(script(wrong, buy), { gasLimit: 2_000_000 })).wait(); });
    assert.deepEqual(await balances(), before);
  }
  // A deficient token transfer can return true. Independent balance comparison
  // must catch it even with old inventory; quote/minimum alone is insufficient.
  await (await token.setShort(true)).wait();
  const { node, q, amountIn } = await prepare(true, 10n ** 16n), before = await balances();
  await (await bot.execute(script(node, true), { gasLimit: 2_000_000 })).wait();
  const awaitableBalances = await balances();
  assert.throws(() => assertDelta(before, awaitableBalances, true, amountIn, q.amountOut), /token actual delta/);
  await provider.send("evm_revert", [checkpoint]);
  console.log(JSON.stringify({ scope: "synthetic-local-EVM-only", receipts, overstatedOutputReverts: 2, deficientTokenTransferDetected: true }, null, 2));
} finally {
  provider.destroy(); child.kill("SIGTERM"); await exited;
}
