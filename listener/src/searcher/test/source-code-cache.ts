import assert from "node:assert/strict";
import { createSourceCodeProviders } from "../source-code-cache.js";
import { ethers } from "ethers";
import { attestPoolIdentitiesStrict, createMinimalIdentityRuntime } from "../strict-identity-attestation.js";
import { PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG as catalog } from "../venues/production-family-composition.js";
import { UNIV3_POOL_INTERFACE, UNIV3_FACTORY_INTERFACE } from "../venues/swaps/univ3-abi.js";

const source = { number: 100, hash: "0x" + "ab".repeat(32), generation: 1 };
const a = "0x" + "ab".repeat(20), b = "0x" + "cd".repeat(20);

async function attest(cache: boolean, control: "valid" | "reverse-mismatch" | "hint-mismatch" | "empty-code") {
  const pool = "0x" + "11".repeat(20), factory = "0x" + "22".repeat(20);
  const token0 = "0x" + "33".repeat(20), token1 = "0x" + "44".repeat(20);
  let codeReads = 0;
  const calls: string[] = [];
  const raw = {
    async getCode(_address: string, blockTag?: number) {
      assert.equal(blockTag, source.number);
      codeReads++;
      return control === "empty-code" ? "0x" : "0x6000";
    },
    async getStorage() { return ethers.ZeroHash; },
    async getLogs() { return []; },
    async call(transaction: { to: string; data: string }, blockTag?: number) {
      assert.equal(blockTag, source.number);
      if (transaction.to.toLowerCase() === factory) {
        const parsed = UNIV3_FACTORY_INTERFACE.parseTransaction(transaction)!;
        assert.equal(parsed.name, "getPool");
        assert.deepEqual([...parsed.args], [token0, token1, 3000n]);
        calls.push("getPool");
        return UNIV3_FACTORY_INTERFACE.encodeFunctionResult("getPool", [
          control === "reverse-mismatch" ? ethers.ZeroAddress : pool,
        ]);
      }
      assert.equal(transaction.to.toLowerCase(), pool);
      const parsed = UNIV3_POOL_INTERFACE.parseTransaction(transaction)!;
      calls.push(parsed.name);
      const values: Record<string, string | number> = { factory, token0, token1, fee: 3000, tickSpacing: 60 };
      assert(parsed.name in values);
      return UNIV3_POOL_INTERFACE.encodeFunctionResult(parsed.name, [values[parsed.name]]);
    },
  };
  const provider = cache ? createSourceCodeProviders(raw, () => {})(source) : raw;
  // Deployment authority consumes the same raw code before the full identity lifecycle.
  const authorityCode = await provider.getCode(pool, source.number);
  const result = await attestPoolIdentitiesStrict({
    catalog, provider, runtime: createMinimalIdentityRuntime(provider), source,
    channelOrder: "reverse-binding-first",
    pools: [{ address: pool, adapter: "univ3", token0: control === "hint-mismatch" ? token1 : token0, token1 }],
  });
  return { codeReads, calls, accepted: result.accepted.length, output: JSON.stringify(
    { authorityCode, result }, (_key, value) => typeof value === "bigint" ? value.toString() : value,
  ) };
}

async function main(): Promise<void> {
  let reads = 0, calls = 0;
  const raw = {
    async getCode(_address: string, _blockTag?: number) { reads++; return "0x6000"; },
    async call() { calls++; return "0x1234"; },
  };
  const forSource = createSourceCodeProviders(raw, () => {});
  const provider = forSource(source);
  assert.equal(provider, forSource({ ...source, hash: source.hash.toUpperCase() }),
    "one stable provider per source, not one per candidate");
  assert.deepEqual(await Promise.all([
    provider.getCode(a, 100), provider.getCode(a, 100),
    provider.getCode(a, 100), provider.getCode(a, 100),
  ]), Array(4).fill("0x6000"));
  await provider.getCode(a, 100);
  assert.equal(reads, 1, "concurrent and later code reads share one successful read");
  await provider.call(); await provider.call();
  assert.equal(calls, 2, "calls (including factory reverse bindings) are never cached");
  await provider.getCode(b, 100);
  await forSource({ ...source, number: 101 }).getCode(a, 101);
  await forSource({ ...source, hash: "0x" + "cd".repeat(32) }).getCode(a, 100);
  await forSource({ ...source, generation: 2 }).getCode(a, 100);
  await createSourceCodeProviders(raw, () => {})(source).getCode(a, 100);
  assert.equal(reads, 6, "address, block, hash, generation and provider namespace separate reuse");
  await assert.rejects(provider.getCode(a), /cutoff/);
  await assert.rejects(provider.getCode(a, 101), /cutoff/);
  assert.equal(reads, 6, "latest/wrong-source requests cannot hit cache or issue RPC");

  let attempts = 0;
  const retry = createSourceCodeProviders({ async getCode(_address: string, _blockTag?: number) {
    attempts++;
    if (attempts === 1) throw new Error("temporary read failure");
    return attempts === 2 ? "not-bytecode" : "0x";
  } }, () => {})(source);
  await assert.rejects(retry.getCode(a, 100), /temporary/);
  await assert.rejects(retry.getCode(a, 100), /invalid deployed/);
  assert.equal(await retry.getCode(a, 100), "0x");
  assert.equal(await retry.getCode(a, 100), "0x");
  assert.equal(attempts, 3, "failure/malformed bytes evicted; empty code remains raw evidence");

  for (const limits of [{ maxEntries: 1 }, { maxBytes: 12 }]) {
    let count = 0;
    const bounded = createSourceCodeProviders({ async getCode(_address: string, _blockTag?: number) {
      count++; return "0x6000";
    } }, () => {}, limits)(source);
    await bounded.getCode(a, 100); await bounded.getCode(b, 100);
    await bounded.getCode(a, 100);
    assert.equal(count, 3, "entry/byte limits evict old code without changing results");
  }
  let oversizedReads = 0;
  const oversized = createSourceCodeProviders({ async getCode(_address: string, _blockTag?: number) {
    oversizedReads++; return "0x60006000";
  } }, () => {}, { maxBytes: 1 })(source);
  await oversized.getCode(a, 100); await oversized.getCode(a, 100);
  assert.equal(oversizedReads, 2, "oversized result is returned but not retained");

  let fatal: Error | undefined;
  const guarded = createSourceCodeProviders(raw, () => { if (fatal) throw fatal; })(source);
  await guarded.getCode(a, 100);
  const beforeFatal = reads;
  fatal = new Error("owner aborted");
  await assert.rejects(guarded.getCode(a, 100), /owner aborted/);
  assert.equal(reads, beforeFatal, "cache hit still enforces abort/fatal latch");

  fatal = undefined;
  let release!: (value: string) => void;
  const delayed = createSourceCodeProviders({ getCode(_address: string, _blockTag?: number) {
    return new Promise<string>(resolve => { release = resolve; });
  } }, () => { if (fatal) throw fatal; })(source);
  const pending = delayed.getCode(a, 100);
  await Promise.resolve();
  fatal = new Error("owner aborted during read");
  release("0x6000");
  await assert.rejects(pending, /owner aborted during read/);
  fatal = undefined;
  const next = delayed.getCode(a, 100);
  await Promise.resolve();
  release("0x6001");
  assert.equal(await next, "0x6001", "in-flight fatal result was not retained");
  for (const control of ["valid", "reverse-mismatch", "hint-mismatch", "empty-code"] as const) {
    const baseline = await attest(false, control), cached = await attest(true, control);
    assert.equal(cached.output, baseline.output, "full attestation/publication parity: " + control);
    assert.deepEqual(cached.calls, baseline.calls, "all identity/reverse-binding calls retained: " + control);
    assert.equal(cached.accepted, control === "valid" ? 1 : 0);
    assert.equal(cached.codeReads, 1);
    if (control === "valid") {
      assert.equal(baseline.codeReads, 5, "full fixture's authority and lifecycle code reads before deduplication");
      assert.equal(cached.calls.filter(name => name === "getPool").length, 1);
    }
  }
  console.log("source-code-cache: all assertions passed");
}

main().catch(error => { console.error(error); process.exitCode = 1; });
