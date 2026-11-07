import assert from "node:assert/strict";
import test from "node:test";
import * as activity from "../blockscan-touched-state.js";
import { collectReorgActivity, revalidateReorgActivityTarget } from "../blockscan-reorg-activity.js";

const hash = (n: number) => "0x" + n.toString(16).padStart(64, "0");
const address = (n: number) => "0x" + n.toString(16).padStart(40, "0");
const manager = address(900);
const block = (number: number, id = number, parentId = id - 1) => ({
  number, hash: hash(id), parentHash: hash(parentId),
  transactionHashes: [hash(id + 10_000)], passiveTouchedAddresses: [address(id)],
});
type Header = ReturnType<typeof block>;
type Resolver = activity.BlockTouchedStateKeyResolver;
// On the pre-fix source this is exactly the old reorg callback. It fails the
// orphan regression on the missing trace, rather than failing an import.
const retained = (provider: activity.BlockTouchedProvider, h: Header, resolver?: Resolver,
  control?: { signal?: AbortSignal; deadlineAtMs?: number }, poolManager = manager) =>
  "readRetainedBlockTouchedStateKeys" in activity
    ? activity.readRetainedBlockTouchedStateKeys(provider, h.number, poolManager, h, resolver, control)
    : activity.readBlockTouchedStateKeys(provider, h.number, poolManager, h, undefined, resolver);

function fixture(headers: Header[]) {
  const byHash = new Map(headers.map(h => [h.hash, h]));
  const unavailable = new Set<string>();
  const malformed = new Set<string>();
  const reads: string[] = [];
  const provider: activity.BlockTouchedProvider = {
    async getLogs(filter) {
      assert.ok("blockHash" in filter);
      reads.push("logs:" + filter.blockHash);
      return [];
    },
    async send(method, params) {
      assert.equal(method, "debug_traceBlockByHash");
      const id = String(params[0]); reads.push("trace:" + id);
      if (unavailable.has(id)) throw new Error("block not found");
      const h = byHash.get(id); assert.ok(h);
      return malformed.has(id) ? [] : [{ txHash: h.transactionHashes[0], result: {
        type: "CALL", from: address(700), to: address(Number(BigInt(id)) + 1000),
        gas: "0x100", gasUsed: "0x10", input: "0x", output: "0x",
      } }];
    },
  };
  const normal = (h: Header, resolver?: Resolver) => activity.readBlockTouchedStateKeys(
    provider, h.number, manager, h, {
      previousSource: { number: h.number - 1, hash: h.parentHash },
      readHeader: async () => { throw new Error("unexpected intermediate header"); },
    }, resolver);
  return { provider, unavailable, malformed, reads, normal };
}

test("verified orphan activity survives canonical range invalidation and unavailable trace RPC", async () => {
  const ancestor = block(10), old = block(11, 111, 10), replacement = block(11, 211, 10), target = block(12, 212, 211);
  const f = fixture([old, replacement, target]);
  const oldKeys = await f.normal(old);
  (oldKeys as Set<string>).clear();
  f.unavailable.add(old.hash);
  // Real production invalidates the ordinary range memo before entering reorg recovery.
  await assert.rejects(activity.readBlockTouchedStateKeys(f.provider, target.number, manager, target, {
    previousSource: { number: old.number, hash: old.hash },
    readHeader: async () => { throw new Error("unexpected header"); },
  }), /canonical hash chain/);
  const canonical = new Map([ancestor, replacement, target].map(h => [h.number, h]));
  const proof = await collectReorgActivity({
    previousSource: old, target, deadlineAtMs: Date.now() + 10_000,
    readCanonicalHeader: async n => canonical.get(n),
    readHeaderByHash: async id => [ancestor, old].find(h => h.hash === id),
    readTouched: (_n, h, control) => retained(f.provider, h as Header, undefined, control),
  });
  assert.equal(proof.oldDepth, 1);
  for (const id of [111, 211, 212]) {
    assert.ok(proof.touchedStateKeys.has(address(id)), "passive branch-only activity retained");
    assert.ok(proof.touchedStateKeys.has(address(id + 1000)), "call branch-only activity retained");
  }
  assert.equal(f.reads.filter(x => x === "trace:" + old.hash).length, 1);
  await revalidateReorgActivityTarget(proof);
  canonical.set(target.number, block(12, 999, 211));
  await assert.rejects(revalidateReorgActivityTarget(proof), /target changed/);
});

test("retained facts cannot cross provider, manager or resolver identities", async () => {
  for (const which of ["provider", "manager", "resolver"]) {
    const h = block(11), f = fixture([h]);
    const a: Resolver = () => ["old-derived"], b: Resolver = () => ["new-derived"];
    await f.normal(h, a);
    f.unavailable.add(h.hash);
    const other = fixture([h]); other.unavailable.add(h.hash);
    await assert.rejects(retained(which === "provider" ? other.provider : f.provider, h,
      which === "resolver" ? b : a, undefined, which === "manager" ? address(901) : manager), /block not found/);
  }
});

test("same hash with different height, parent, transaction or passive coverage rejects", async () => {
  for (const field of ["height", "parent", "transaction", "passive"]) {
    const h = block(11), f = fixture([h]); await f.normal(h); f.reads.length = 0;
    const changed = { ...h };
    if (field === "height") changed.number++;
    if (field === "parent") changed.parentHash = hash(999);
    if (field === "transaction") changed.transactionHashes = [hash(999)];
    if (field === "passive") changed.passiveTouchedAddresses = [];
    await assert.rejects(retained(f.provider, changed), /anchor mismatch/);
    assert.deepEqual(f.reads, []);
  }
});

test("failed or incomplete traces never become retained activity", async () => {
  for (const failure of ["missing", "malformed"]) {
    const h = block(11), f = fixture([h]);
    if (failure === "missing") f.unavailable.add(h.hash); else f.malformed.add(h.hash);
    await assert.rejects(f.normal(h));
    f.unavailable.add(h.hash); f.malformed.clear();
    await assert.rejects(retained(f.provider, h), /block not found/);
    assert.equal(f.reads.filter(x => x === "trace:" + h.hash).length, 2);
  }
});

test("returned sets cannot mutate retained data and cache hits obey cancellation/deadline", async () => {
  const h = block(11), f = fixture([h]); await f.normal(h); f.unavailable.add(h.hash);
  const first = await retained(f.provider, h);
  (first as Set<string>).clear();
  assert.equal((await retained(f.provider, h)).size, 3);
  const controller = new AbortController(); controller.abort(new Error("cancel recovery"));
  await assert.rejects(retained(f.provider, h, undefined, { signal: controller.signal }), /cancel recovery/);
  await assert.rejects(retained(f.provider, h, undefined, { deadlineAtMs: 0 }), /deadline/);
});

test("retention is bounded; an evicted or never-observed orphan remains unavailable", async () => {
  const headers = Array.from({ length: activity.MAX_ACTIVITY_TRANSITIONS + 1 }, (_, i) => block(i + 1));
  const f = fixture(headers);
  for (const h of headers) await f.normal(h);
  for (const h of headers) f.unavailable.add(h.hash);
  await assert.rejects(retained(f.provider, headers[0]!), /block not found/);
  assert.equal((await retained(f.provider, headers[1]!)).size, 3);
  assert.equal((await retained(f.provider, headers.at(-1)!)).size, 3);
});
