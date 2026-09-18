import assert from "node:assert/strict";
import test from "node:test";
import { ethers } from "ethers";
import { admitToGraph, localCatalog } from "./lifecycle.js";
import { buildFamilyExecutionFragment, executeFamilyExactQuote } from "../../../venues/adapter-family-runtime.js";
import { VAULT, ROUTER, PERMIT2, VAULT_ABI, POOL_ABI, TOKEN_ABI, ROUTER_ABI, SWAP_ABI, lower } from "../../../venues/swaps/balancer-v3-family/codec.js";

test("content-hashed catalog -> production lifecycle -> issued Graph/Exact/Execution, without legacy authority", async () => {
  const catalog = await localCatalog();
  const source = { number: 25453353, hash: `0x${"ab".repeat(32)}`, generation: 1 };
  const pool = ethers.getAddress("0x0000000000000000000000000000000000000033");
  const tokens = ["0x0000000000000000000000000000000000000011", "0x0000000000000000000000000000000000000022"];
  const executor = "0x1000000000000000000000000000000000000002";
  const balance = 1000000n * 10n ** 18n;
  const quotes: bigint[] = [];
  const provider = {
    async call(tx: { to: string; data: string }, block?: number) {
      assert.equal(block, source.number);
      if (tx.data === POOL_ABI.encodeFunctionData("getVault")) return POOL_ABI.encodeFunctionResult("getVault", [VAULT]);
      if (tx.data === TOKEN_ABI.encodeFunctionData("decimals")) return ethers.toBeHex(18, 32);
      if (lower(tx.to) === lower(VAULT)) {
        const parsed = VAULT_ABI.parseTransaction({ data: tx.data })!; assert.equal(lower(parsed.args[0]), lower(pool));
        if (parsed.name === "isPoolRegistered") return ethers.toBeHex(1, 32);
        if (parsed.name === "getHooksConfig") return VAULT_ABI.encodeFunctionResult("getHooksConfig", [[...Array(10).fill(false), ethers.ZeroAddress]]);
        return VAULT_ABI.encodeFunctionResult("getPoolTokenInfo", [tokens, tokens.map(() => [0, ethers.ZeroAddress, false]), [balance, balance], [balance, balance]]);
      }
      assert.equal(lower(tx.to), lower(ROUTER));
      if (tx.data === ROUTER_ABI.encodeFunctionData("getPermit2")) return ROUTER_ABI.encodeFunctionResult("getPermit2", [PERMIT2]);
      const args = ROUTER_ABI.decodeFunctionData("querySwapSingleTokenExactIn", tx.data);
      const amount = BigInt(args[3]); quotes.push(amount);
      return ethers.toBeHex(amount * balance * 9999n / ((balance + amount) * 10000n), 32);
    },
    async getCode(_address: string, block?: number) { assert.equal(block, source.number); return "0x60006000"; },
    async getStorage() { throw new Error("unexpected storage read"); },
  };
  const log = { kind: "log" as const, address: VAULT, source, ...SWAP_ABI.encodeEventLog(SWAP_ABI.getEvent("Swap")!,
    [pool, ...tokens, 1000000000000000000n, 999000000000000000n, 100000000000000n, 100n]) };
  const admitted = await admitToGraph({ catalog, provider, source, executor, observations: [log] });
  assert(admitted.lifecycle.publication, JSON.stringify(admitted.lifecycle.outcomes));
  const instance = admitted.lifecycle.publication.instances[0];
  assert.equal(instance.routes.length, 2); assert.equal(admitted.graph.edges.length, 2);
  assert(admitted.graph.edges.every(edge => edge.canonicalEdgeId && lower(edge.target) === lower(pool)));
  const route = instance.routeHandles[0];
  const exactInput = { family: admitted.family, route, amountIn: 123456789123456789n, executor, runtimeEvidence: [], source,
    generation: source.generation, runtime: admitted.runtime, requireChainAmountQuote: true };
  const quote = await executeFamilyExactQuote(exactInput);
  assert(quote.status === "resolved", JSON.stringify(quote.outcome)); assert(quotes.includes(exactInput.amountIn));
  assert.equal(buildFamilyExecutionFragment({ family: admitted.family, actionOwnership: catalog, route,
    exact: quote, minAmountOut: quote.amountOut * 99n / 100n, executor, runtimeEvidence: [] }).status, "resolved");
  assert.notEqual((await executeFamilyExactQuote({ ...exactInput, route: { ...route } })).status, "resolved");
  const rejected = await admitToGraph({ catalog, provider, source, executor, observations: [{ ...log, address: pool }, { ...log, data: "0x" }] });
  assert.equal(rejected.lifecycle.publication, null); assert.equal(rejected.graph.edges.length, 0);
});
