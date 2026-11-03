import assert from "node:assert/strict";
import test from "node:test";
import { collectReorgActivity, isVerifiedReorgActivity, revalidateReorgActivityTarget,
  type ReorgActivityHeader } from "../blockscan-reorg-activity.js";

const hash = (number: number) => `0x${number.toString(16).padStart(64, "0")}`;
const block = (number: number, id = number, parentId = id - 1): ReorgActivityHeader => ({
  number, hash: hash(id), parentHash: hash(parentId), transactionHashes: [hash(id + 10_000)],
  passiveTouchedAddresses: [`0x${id.toString(16).padStart(40, "0")}`],
});

function fixture(depth = 1) {
  const ancestor = block(10);
  const old = Array.from({ length: depth }, (_, index) => block(11 + index, 111 + index, index === 0 ? 10 : 110 + index));
  const fresh = Array.from({ length: depth + 1 }, (_, index) => block(11 + index, 211 + index, index === 0 ? 10 : 210 + index));
  const canonical = new Map([ancestor, ...fresh].map(value => [value.number, value]));
  const byHash = new Map([ancestor, ...old].map(value => [value.hash, value]));
  const touchedCalls: string[] = [];
  const tip = old[old.length - 1]!;
  const input = {
    previousSource: { number: tip.number, hash: tip.hash }, target: fresh[fresh.length - 1]!,
    deadlineAtMs: Date.now() + 10_000,
    readCanonicalHeader: async (number: number) => canonical.get(number),
    readHeaderByHash: async (id: string) => byHash.get(id),
    readTouched: async (_number: number, anchor: ReorgActivityHeader) => {
      touchedCalls.push(anchor.hash);
      return new Set(["SHARED", `${anchor.hash === old[0]!.hash ? "old-only" : "new-or-old"}:${anchor.hash}`]);
    },
  };
  return { input, canonical, byHash, touchedCalls, ancestor, old, fresh };
}

for (const depth of [1, 2]) test(`depth ${depth} covers both branches including orphan-only activity`, async () => {
  const f = fixture(depth);
  const proof = await collectReorgActivity(f.input);
  assert.equal(proof.oldDepth, depth);
  assert.deepEqual(proof.commonAncestor, f.ancestor);
  assert.deepEqual(proof.oldBranch.map(h => h.hash), [...f.old].reverse().map(h => h.hash));
  assert.deepEqual(proof.newBranch.map(h => h.hash), f.fresh.map(h => h.hash));
  assert.deepEqual(f.touchedCalls, [...f.old].reverse().concat(f.fresh).map(h => h.hash));
  assert.ok(proof.touchedStateKeys.has(`old-only:${f.old[0]!.hash}`));
  assert.equal([...proof.touchedStateKeys].filter(key => key === "shared").length, 1);
  assert.equal(proof.touchedStateKeys.size, depth * 2 + 2);
  assert.equal(isVerifiedReorgActivity(proof), true);
});

test("proof cannot be forged, mutated, or altered through callback references", async () => {
  const f = fixture();
  const proof = await collectReorgActivity(f.input);
  assert.equal(isVerifiedReorgActivity({ ...proof }), false);
  assert.equal(isVerifiedReorgActivity(JSON.parse(JSON.stringify(proof))), false);
  await assert.rejects(revalidateReorgActivityTarget({ ...proof }), /unverified/);
  assert.throws(() => (proof.touchedStateKeys as Set<string>).clear(), TypeError);
  assert.throws(() => Set.prototype.add.call(proof.touchedStateKeys, "extra"), TypeError);
  proof.touchedStateKeys.forEach((_value, _key, set) => assert.equal(set, proof.touchedStateKeys));
  assert.ok(Object.isFrozen(proof));
  assert.ok(Object.isFrozen(proof.previousSource));
  assert.ok(Object.isFrozen(proof.target.transactionHashes));
  assert.ok(Object.isFrozen(proof.target.passiveTouchedAddresses));
  assert.ok(Object.isFrozen(proof.commonAncestor));
  assert.ok(Object.isFrozen(proof.oldBranch));
  assert.ok(Object.isFrozen(proof.newBranch));
  f.input.previousSource.hash = hash(99);
  assert.equal(proof.previousSource.hash, f.old[0]!.hash);
});

test("canonical target changes during activity collection or after quotes reject", async () => {
  const f = fixture();
  const normalRead = f.input.readTouched;
  await assert.rejects(collectReorgActivity({ ...f.input, readTouched: async (n, h) => {
    f.canonical.set(f.input.target.number, block(f.input.target.number, 999));
    return normalRead(n, h);
  } }), /target changed/);
  const stable = fixture();
  const proof = await collectReorgActivity(stable.input);
  await revalidateReorgActivityTarget(proof);
  stable.canonical.set(stable.input.target.number, block(stable.input.target.number, 999));
  await assert.rejects(revalidateReorgActivityTarget(proof), /target changed/);
});

test("missing old branch or malformed identity/parent chain never returns proof", async () => {
  for (const mode of ["missing-tip", "missing-parent", "wrong-tip", "wrong-old-parent", "wrong-new-parent", "wrong-height"]) {
    const f = fixture(2);
    if (mode === "missing-tip") f.byHash.delete(f.input.previousSource.hash);
    if (mode === "missing-parent") f.byHash.delete(f.old[0]!.hash);
    if (mode === "wrong-tip") f.byHash.set(f.input.previousSource.hash, block(12, 999));
    if (mode === "wrong-old-parent") f.byHash.set(f.old[0]!.hash, block(11, 999));
    if (mode === "wrong-new-parent") f.canonical.set(11, block(11, 211, 999));
    if (mode === "wrong-height") f.canonical.set(11, block(12, 211, 10));
    await assert.rejects(collectReorgActivity(f.input), undefined, mode);
    assert.deepEqual(f.touchedCalls, []);
  }
});

test("bounds reject deep/long/same-height/backward recovery without partial activity", async () => {
  const f = fixture(2);
  await assert.rejects(collectReorgActivity({ ...f.input, maxDepth: 1 }), /recovery depth/);
  await assert.rejects(collectReorgActivity({ ...f.input, maxCatchupBlocks: 2 }), /recovery bound/);
  for (const number of [12, 11]) {
    await assert.rejects(collectReorgActivity({ ...f.input, target: block(number, 999) }), /must advance/);
  }
  for (const maxDepth of [0, -1, NaN, 1.1]) {
    await assert.rejects(collectReorgActivity({ ...f.input, maxDepth }), /bounds/);
  }
  assert.deepEqual(f.touchedCalls, []);
});

test("missing passive/transaction coverage on either branch fails closed", async () => {
  for (const side of ["old", "new", "ancestor"] as const) {
    for (const field of ["passiveTouchedAddresses", "transactionHashes"] as const) {
      const f = fixture();
      const current = side === "old" ? f.old[0]! : side === "new" ? f.fresh[0]! : f.ancestor;
      const malformed = { ...current, [field]: undefined } as unknown as ReorgActivityHeader;
      if (side === "old") f.byHash.set(current.hash, malformed);
      else f.canonical.set(current.number, malformed);
      await assert.rejects(collectReorgActivity(f.input), /coverage/);
      assert.deepEqual(f.touchedCalls, []);
    }
  }
});

test("retired source becoming canonical again recovers through verified forward activity", async () => {
  const f = fixture();
  f.canonical.set(f.old[0]!.number, f.old[0]!);
  const next = block(12, 212, 111);
  f.canonical.set(12, next);
  const proof = await collectReorgActivity({ ...f.input, target: next });
  assert.equal(proof.oldDepth, 0);
  assert.deepEqual(proof.commonAncestor, f.old[0]);
  assert.deepEqual(f.touchedCalls, [next.hash]);
  assert.equal(isVerifiedReorgActivity(proof), true);
  await revalidateReorgActivityTarget(proof);
});

test("reader errors, cancellation and deadline fail closed after partial collection", async () => {
  for (const mode of ["reader", "abort", "deadline"] as const) {
    const f = fixture();
    const controller = new AbortController();
    let count = 0;
    await assert.rejects(collectReorgActivity({ ...f.input, signal: controller.signal,
      deadlineAtMs: mode === "deadline" ? Date.now() + 20 : f.input.deadlineAtMs,
      readTouched: async () => {
        count++;
        if (count === 2) {
          if (mode === "reader") throw new Error("trace coverage missing");
          if (mode === "abort") controller.abort(new Error("cancel recovery"));
          if (mode === "deadline") return new Promise<ReadonlySet<string>>(() => {});
        }
        return new Set(["partial"]);
      },
    }));
    assert.equal(count, 2);
  }
  const f = fixture();
  await assert.rejects(collectReorgActivity({ ...f.input, deadlineAtMs: 0 }), /deadline/);
  assert.deepEqual(f.touchedCalls, []);
});
