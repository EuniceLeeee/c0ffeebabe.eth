import assert from "node:assert/strict";
import { test } from "node:test";
import { searchSimAmounts } from "../simulator/sim-amount-search.js";

const options = () => ({ p: 10n, maxInput: 10000n, deadlineAtMs: Date.now() + 5000 });
test("P then 10/100/1000P and eight refine points, scored only by actual profit", async () => {
  const seen: bigint[] = [];
  const result = await searchSimAmounts({ ...options(), evaluate: async amount => {
    seen.push(amount);
    return { success: true, profit: 2000000n - (amount - 600n) ** 2n, value: { quoteProfit: -100n } };
  } });
  assert.deepEqual(seen.slice(0, 4), [10n, 100n, 1000n, 10000n]);
  assert.equal(result.status, "complete"); assert.equal(result.trials.filter(t => t.phase === "refine").length, 8);
  assert.equal(new Set(seen).size, seen.length); assert(result.best && result.best.amount > 100n && result.best.amount < 1000n);
  assert.deepEqual(result.bracket, { lo: 100n, hi: 10000n });
});
test("nonpositive P or reverted P stops; no quote-profit fallback", async () => {
  for (const first of [{ success: true as const, profit: 0n, value: 1 }, { success: false as const, reason: "revert" }]) {
    let calls = 0;
    const result = await searchSimAmounts({ ...options(), evaluate: async () => { calls++; return first; } });
    assert.equal(calls, 1); assert.equal(result.status, "p-nonpositive"); assert.equal(result.best, null);
  }
});
test("funding cap clips and deduplicates coarse amounts; no refine when disabled", async () => {
  const amounts: bigint[] = [];
  const result = await searchSimAmounts({ ...options(), maxInput: 75n, gssMaxTries: 0,
    evaluate: async amount => { amounts.push(amount); return { success: true, profit: amount, value: amount }; } });
  assert.deepEqual(amounts, [10n, 75n]); assert.equal(result.best?.amount, 75n);
});
test("independent coarse trials obey concurrency and isolate amounts", async () => {
  let active = 0, peak = 0;
  await searchSimAmounts({ ...options(), concurrency: 2, gssMaxTries: 0, evaluate: async amount => {
    peak = Math.max(peak, ++active); await new Promise(resolve => setTimeout(resolve, 5)); active--;
    return { success: true, profit: amount, value: amount };
  } });
  assert.equal(peak, 2); assert.equal(active, 0);
});
test("transport failure aborts and drains siblings instead of looking unprofitable", async () => {
  let active = 0;
  const fault = new Error("source fault");
  await assert.rejects(searchSimAmounts({ ...options(), evaluate: async (amount, control) => {
    if (amount === 10n) return { success: true, profit: 1n, value: amount };
    if (amount === 100n) throw fault;
    active++;
    await new Promise<void>(resolve => control.signal.addEventListener("abort", () => resolve(), { once: true }));
    active--; control.signal.throwIfAborted(); throw new Error("unreachable");
  } }), error => error === fault);
  assert.equal(active, 0);
});
test("deadline reports incomplete with only settled observed winners", async () => {
  const result = await searchSimAmounts({ ...options(), deadlineAtMs: Date.now() + 25,
    evaluate: async (amount, control) => {
      if (amount === 10n) return { success: true, profit: 1n, value: amount };
      await new Promise<void>(resolve => control.signal.addEventListener("abort", () => resolve(), { once: true }));
      control.signal.throwIfAborted(); throw new Error("unreachable");
    } });
  assert.equal(result.status, "deadline"); assert.equal(result.complete, false);
  assert.equal(result.best?.amount, 10n); assert.equal(result.trials.length, 1);
});
test("external cancellation is not a usable search result", async () => {
  const controller = new AbortController(); controller.abort(new Error("new head"));
  await assert.rejects(searchSimAmounts({ ...options(), signal: controller.signal,
    evaluate: async () => { throw new Error("must not run"); } }), /new head/);
});
test("cancellation during launch drains the already-issued child", async () => {
  const controller = new AbortController(); const reason = new Error("owner replaced"); let active = 0;
  await assert.rejects(searchSimAmounts({ ...options(), signal: controller.signal, evaluate: async amount => {
    if (amount === 10n) return { success: true, profit: 1n, value: amount };
    active++; controller.abort(reason);
    await new Promise(resolve => setTimeout(resolve, 10)); active--; throw reason;
  } }), error => error === reason);
  assert.equal(active, 0);
});
test("source failure after deadline is never converted to a best-so-far result", async () => {
  const fault = new Error("source attestation mismatch");
  await assert.rejects(searchSimAmounts({ ...options(), deadlineAtMs: Date.now() + 10, concurrency: 1,
    evaluate: async amount => {
      if (amount === 10n) return { success: true, profit: 1n, value: amount };
      await new Promise(resolve => setTimeout(resolve, 25)); throw fault;
    } }), error => error === fault);
});
test("late sibling fatal outranks a cooperative deadline rejection", async () => {
  const fault = new Error("protocol fault"); let active = 0;
  await assert.rejects(searchSimAmounts({ ...options(), deadlineAtMs: Date.now() + 10,
    evaluate: async (amount, control) => {
      if (amount === 10n) return { success: true, profit: 1n, value: amount };
      active++;
      if (amount === 100n) {
        await new Promise<void>(resolve => control.signal.addEventListener("abort", () => resolve(), { once: true }));
        active--; throw control.signal.reason;
      }
      await new Promise(resolve => setTimeout(resolve, 25)); active--; throw fault;
    } }), error => error === fault);
  assert.equal(active, 0);
});
test("integer tiny brackets deduplicate; state/memo never crosses searches", async () => {
  for (const profit of [1n, 5n]) {
    let calls = 0;
    const result = await searchSimAmounts({ ...options(), p: 1n, maxInput: 2n,
      evaluate: async () => { calls++; return { success: true, profit, value: null }; } });
    assert.equal(calls, 2); assert.equal(result.best?.result.success && result.best.result.profit, profit);
  }
});
test("invalid budgets and bounds fail before evaluator", async () => {
  for (const invalid of [{ p: 0n }, { maxInput: 1n }, { gssMaxTries: 1 }, { concurrency: 0 }]) {
    await assert.rejects(searchSimAmounts({ ...options(), ...invalid,
      evaluate: async () => { throw new Error("must not run"); } }), /invalid/);
  }
});
