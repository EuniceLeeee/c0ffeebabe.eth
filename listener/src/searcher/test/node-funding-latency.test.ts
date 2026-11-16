import assert from "node:assert/strict";
import { setImmediate as nextTurn } from "node:timers/promises";
import { test } from "node:test";
import { Interface, toBeHex } from "ethers";
import { NodeInputFunding, createNodeFundingCache } from "../simulator/node-input-funding.js";
import { RevmFatalError } from "../revm-sim-client.js";

const ACCOUNT = "0x" + "11".repeat(20), TOKEN = "0x" + "22".repeat(20);
const PIN = { blockHash: "0x" + "aa".repeat(32), requireCanonical: true };
const BALANCE = new Interface(["function balanceOf(address) view returns(uint256)"]);
const TARGET_SLOT = toBeHex(1001, 32), WITNESS_SLOT = toBeHex(1002, 32);
const FULL_WORD = (1n << 256n) - 1n;

type PendingRead = {
  method: string;
  account: string;
  resolve(value?: unknown): void;
  reject(error: unknown): void;
};

function controlledSource(mask = FULL_WORD, flags = 0n) {
  const pending: PendingRead[] = [];
  const requests: { method: string; account: string; probe: boolean }[] = [];
  let holdInitial = true;
  const rpc = async (method: string, params: readonly any[]) => {
    assert.deepEqual(params[1], PIN, "every parallel read retains the exact canonical source");
    assert.equal(params[0].to, TOKEN);
    const account = String(BALANCE.decodeFunctionData("balanceOf", params[0].data)[0]).toLowerCase();
    assert(account === ACCOUNT || account === TOKEN);
    const probe = method === "eth_call" && params[2] !== undefined;
    requests.push({ method, account, probe });
    const slot = account === ACCOUNT ? TARGET_SLOT : WITNESS_SLOT;
    const word = account === ACCOUNT ? flags | 77n : 19n;
    const response = () => method === "debug_traceCall"
      ? { [TOKEN]: { storage: { [slot]: toBeHex(word, 32) } } }
      : toBeHex(BigInt(params[2]?.[TOKEN]?.stateDiff?.[slot] ?? word) & mask, 32);
    if (holdInitial && !probe) return new Promise<unknown>((resolve, reject) => {
      pending.push({ method, account, resolve: value => resolve(value === undefined ? response() : value), reject });
    });
    return response();
  };
  return { rpc, pending, requests, releaseInitial() { holdInitial = false; } };
}

for (const [layout, mask, flags, calls] of [
  ["full word", FULL_WORD, 0n, 6],
  ["packed low bits", (1n << 128n) - 1n, 0x55n << 128n, 7],
] as const) test(`funding overlaps four independent source reads and preserves ${layout} proof`, async () => {
  const source = controlledSource(mask, flags), cache = createNodeFundingCache();
  const prepared = new NodeInputFunding(source.rpc, PIN, cache).prepare([{ token: TOKEN, to: ACCOUNT, amount: "100" }]);
  assert.equal(source.pending.length, 4, "both balance reads and both prestate traces start before any completes");
  assert.deepEqual(source.pending.map(row => [row.method, row.account]), [
    ["eth_call", ACCOUNT], ["eth_call", TOKEN], ["debug_traceCall", ACCOUNT], ["debug_traceCall", TOKEN],
  ]);
  // Deliver out of order. No isolated storage override may be constructed
  // while any source evidence remains unresolved.
  for (const index of [3, 1, 2]) source.pending[index]!.resolve();
  await nextTurn();
  assert.equal(source.requests.filter(row => row.probe).length, 0);
  source.pending[0]!.resolve();
  const result = await prepared;
  assert.deepEqual(result, {
    overrides: { [TOKEN]: { stateDiff: { [TARGET_SLOT]: toBeHex(flags | 177n, 32) } } },
    expected: [{ token: TOKEN, account: ACCOUNT, balance: 177n }],
  });
  assert.equal(source.requests.filter(row => row.method === "eth_call").length, calls);
  assert.equal(source.requests.filter(row => row.method === "debug_traceCall").length, 2);
  assert.equal(cache.slots.get(`${TOKEN}:${ACCOUNT}`), TARGET_SLOT);
});

test("a failed funding cohort drains sibling reads before rejection and leaves no successful proof", async () => {
  const source = controlledSource(), cache = createNodeFundingCache(), completed = new Map();
  const failure = new Error("target balance unavailable");
  let settled = false;
  const prepared = new NodeInputFunding(source.rpc, PIN, cache, completed)
    .prepare([{ token: TOKEN, to: ACCOUNT, amount: "1" }]);
  const outcome = prepared.then(() => { settled = true; return undefined; }, error => { settled = true; return error; });
  assert.equal(source.pending.length, 4);
  source.pending[0]!.reject(failure);
  await nextTurn();
  assert.equal(settled, false, "no launched source read is abandoned when another read fails");
  for (const index of [1, 2, 3]) source.pending[index]!.resolve();
  assert.equal(await outcome, failure);
  assert.equal(cache.slots.size, 0);
  assert.equal(completed.size, 0);
  assert.equal(source.requests.filter(row => row.probe).length, 0);
});

test("out-of-order source failures retain original error precedence", async () => {
  const source = controlledSource();
  const targetFailure = new Error("target failure"), traceFailure = new Error("later trace failure");
  const prepared = new NodeInputFunding(source.rpc, PIN).prepare([{ token: TOKEN, to: ACCOUNT, amount: "1" }]);
  const outcome = prepared.catch(error => error);
  source.pending[3]!.reject(traceFailure);
  source.pending[2]!.reject(traceFailure);
  source.pending[1]!.resolve();
  await nextTurn();
  source.pending[0]!.reject(targetFailure);
  assert.equal(await outcome, targetFailure);
  assert.equal(source.requests.filter(row => row.probe).length, 0);
});

test("a concurrent fatal source fault is never hidden by an earlier ordinary failure", async () => {
  const source = controlledSource(), cache = createNodeFundingCache(), completed = new Map();
  const ordinary = new Error("target temporarily unavailable"), fatal = new RevmFatalError({ kind: "source-fault" });
  let settled = false;
  const prepared = new NodeInputFunding(source.rpc, PIN, cache, completed)
    .prepare([{ token: TOKEN, to: ACCOUNT, amount: "1" }]);
  const outcome = prepared.catch(error => { settled = true; return error; });
  source.pending[0]!.reject(ordinary);
  source.pending[1]!.resolve();
  source.pending[2]!.resolve();
  await nextTurn();
  assert.equal(settled, false);
  source.pending[3]!.reject(fatal);
  assert.equal(await outcome, fatal, "the exact fatal error must reach the source owner");
  assert.equal(cache.slots.size, 0);
  assert.equal(completed.size, 0);
  assert.equal(source.requests.filter(row => row.probe).length, 0);
});

test("invalid trace evidence still rejects before probing and a drained failure can retry", async () => {
  const source = controlledSource(), cache = createNodeFundingCache();
  const funder = new NodeInputFunding(source.rpc, PIN, cache);
  const prepared = funder.prepare([{ token: TOKEN, to: ACCOUNT, amount: "1" }]);
  const rejected = assert.rejects(prepared, /invalid node input funding prestate trace/);
  source.pending[2]!.resolve(null);
  for (const index of [0, 1, 3]) source.pending[index]!.resolve();
  await rejected;
  assert.equal(cache.slots.size, 0);
  assert.equal(source.requests.filter(row => row.probe).length, 0);
  source.releaseInitial();
  const retried = await funder.prepare([{ token: TOKEN, to: ACCOUNT, amount: "2" }]);
  assert.equal(retried.expected[0]!.balance, 79n);
  assert.equal(retried.overrides[TOKEN]!.stateDiff[TARGET_SLOT], toBeHex(79n, 32));
});
