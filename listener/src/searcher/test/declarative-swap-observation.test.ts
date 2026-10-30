import assert from "node:assert/strict";
import test from "node:test";
import { Interface, toBeHex } from "ethers";
import { compileDeclarativeSwap } from "../venues/declarative-swap-domain.js";
import { compileDeclarativeValues } from "../venues/declarative-values.js";
import { decodeReceiptObservationWithDeadline } from "../detector/pool-impact.js";

// ABI-level fixtures exercise shared declarations, not chain admission or a
// migrated UniV2/UniV3 production family. No family-specific TS is bound here.
const pool = toBeHex(1, 20), token0 = toBeHex(2, 20), token1 = toBeHex(3, 20), sender = toBeHex(4, 20);
const source = { number: 100, hash: toBeHex(100, 32), generation: 1 };
const receipt = { transactionHash: toBeHex(101, 32), blockHash: toBeHex(102, 32), blockNumber: 101 };
const v2Swap = "event Swap(address indexed sender,uint256 amount0In,uint256 amount1In,uint256 amount0Out,uint256 amount1Out,address indexed to)";
const sync = "event Sync(uint112 reserve0,uint112 reserve1)";
const v3Swap = "event Swap(address indexed sender,address indexed recipient,int256 amount0,int256 amount1,uint160 sqrtPriceX96,uint128 liquidity,int24 tick)";
const reserveAbi = new Interface(["function getReserves() view returns(uint112 reserve0,uint112 reserve1,uint32 timestamp)",
  "function factory() view returns(address)", "function token0() view returns(address)", "function token1() view returns(address)"]);
const op = (name: string, ...args: any[]) => ({ op: name, args });
const clone = (x: any) => JSON.parse(JSON.stringify(x));
const math = { uint: (value: string) => op("uint", value) };
const descriptor = { pool, token0, token1, quoteModel: { kind: "constant-product" }, tokenTransfers: [] as any[], feeBps: 30n };
const edge = { adapterId: "fixture-swap", target: pool, tokenIn: token0, tokenOut: token1, instanceKey: pool };
const direction = op("and", op("gt", "$args.amount0In", math.uint("0")), op("eq", "$args.amount1In", math.uint("0")),
  op("eq", "$args.amount0Out", math.uint("0")), op("gt", "$args.amount1Out", math.uint("0")));
const eligible = op("and", op("eq", "$descriptor.quoteModel.kind", "constant-product"),
  op("not", op("some", "$descriptor.tokenTransfers", "t", op("eq", "$t.kind", "verified-transfer-tax"))));
const relatedState = op("get", op("at", "$receipt.events", op("sub", op("length", "$receipt.events"), 1)), "payload");
const state = op("if", op("gt", op("length", "$receipt.events"), 0), relatedState, "$receiptReads.result");
function definition(): any {
  return { version: 1, canonicalIntakeTargets: [], victimSupport: "none", calls: [], events: [
    { id: "swap", signature: v2Swap, classification: "swap", pool: "$log.address", payload: "$args", valid: direction,
      relatedEvents: ["sync"], match: op("and", eligible, op("sameAddress", "$edge.tokenIn", "$descriptor.token0")),
      impact: { pool: "$edge.target", tokenIn: "$edge.tokenIn", tokenOut: "$edge.tokenOut", matchedAdapterId: "$edge.adapterId",
        amountIn: "$args.amount0In", amountOut: "$args.amount1Out", v2PostState: state } },
    { id: "sync", signature: sync, classification: "mutation", pool: "$log.address", payload: "$args", match: false, impact: {} },
  ] };
}
function compile(raw = definition()) {
  const values = compileDeclarativeValues({ abi: { pool: reserveAbi.fragments.map(fn => fn.format("full")) }, constants: {}, expressions: {}, programs: {} });
  return compileDeclarativeSwap(raw, values, { familyId: "fixture", edgeAdapterIds: [edge.adapterId] });
}
function log(signature: string, args: any[], address = pool): any {
  const abi = new Interface([signature]), event = abi.fragments[0].format("sighash");
  return { ...receipt, address, ...abi.encodeEventLog(event, args) };
}
const swapLog = () => log(v2Swap, [sender, 7n, 0n, 0n, 4n, sender]);
const syncLog = (reserve0 = 100n, reserve1 = 200n) => log(sync, [reserve0, reserve1]);
function context(logs: any[], d = descriptor): any {
  const graph = [edge];
  return { logs, graph, edgesByTarget: new Map([[pool, graph]]), resolveBinding: () => ({ familyId: "fixture", descriptor: d }),
    sourceGeneration: { id: "receipt-generation", sourceBlock: source.number, sourceBlockHash: source.hash,
      receiptId: receipt.transactionHash, receiptBlockNumber: receipt.blockNumber, receiptBlockHash: receipt.blockHash,
      receiptParentBlockHash: source.hash, receiptTransactionHash: receipt.transactionHash, logsCompleteness: "complete-receipt" },
    matchedOwnedTriggers: logs.flatMap((l, i) => l.topics[0] === new Interface([v2Swap]).getEvent("Swap")!.topicHash
      ? [{ triggerId: `trigger:${i}`, logIndex: i, emitter: l.address, topic0: l.topics[0] }] : []),
    control: { signal: new AbortController().signal, deadlineAtMs: Date.now() + 10000 } };
}
async function observe(raw: any, ctx: any): Promise<any> { return compile(raw).receiptObservation!.decodeReceiptImpacts(ctx); }

test("declared call observations decode named/positional ABI arguments and carried sender without fabricating value", () => {
  const raw = definition();
  raw.calls = [
    { id: "v2-call", signature: "function swap(uint256 amount0Out,uint256 amount1Out,address to,bytes data)", classification: "swap",
      payload: { pool: "$observation.target", from: "$observation.sender", amount0Out: "$args.amount0Out", callback: "$args.data" } },
    { id: "v3-call", signature: "function swap(address,bool,int256,uint160,bytes)", classification: "swap",
      payload: { pool: "$observation.target", zeroForOne: "$args.1", amountSpecified: "$args.2" } },
  ];
  const family = compile(raw);
  const inputs = [[0n, 4n, sender, "0x1234"], [sender, true, -7n, 12n, "0x"]];
  for (let i = 0; i < raw.calls.length; i++) {
    const abi = new Interface([raw.calls[i].signature]);
    const data = abi.encodeFunctionData(abi.fragments[0].format("sighash"), inputs[i]);
    const observation: any = { kind: "call", target: pool, sender, source, data, transactionHash: receipt.transactionHash };
    const effects = family.observation.decode({ observation });
    assert.equal(effects.length, 1);
    assert.equal((effects[0].canonicalPayload as any).pool, pool);
    if (i === 0) assert.deepEqual(effects[0].canonicalPayload, { pool, from: sender, amount0Out: 0n, callback: "0x1234" });
    else assert.equal((effects[0].canonicalPayload as any).amountSpecified, -7n);
    for (const bad of [data + "00", data.slice(0, -2), "0x12345678", "0x"])
      assert.deepEqual(family.observation.decode({ observation: { ...observation, data: bad } }), []);
    const requiresValue = clone(raw); requiresValue.calls[i].valid = op("eq", "$observation.value", math.uint("0"));
    assert.deepEqual(compile(requiresValue).observation.decode({ observation }), []);
  }
  assert(family.observation.patternIds.includes("v2-call"));
  assert(family.observation.patternIds.includes("v3-call"));
  assert.equal(family.receiptObservation!.decodeDirectCallImpacts, undefined, "calldata observation is not an invented receipt impact");
});

test("call declarations reject duplicate selectors, event/call ID collisions and non-function ABI", () => {
  const c = { id: "call", signature: "function swap(uint256)", classification: "swap", payload: {} };
  for (const calls of [[c, { ...c, id: "other" }], [{ ...c, id: "swap" }], [{ ...c, signature: sync }]])
    assert.throws(() => compile({ ...definition(), calls }));
});

test("same-receipt context selects final same-pool canonical Sync without consuming extra triggers", async () => {
  const raw = definition(), logs = [syncLog(10n, 20n), swapLog(), syncLog(107n, 196n), syncLog(999n, 999n)];
  logs[3].address = toBeHex(88, 20);
  const ctx = context(logs), result = await observe(raw, ctx);
  assert.equal(result.status, "resolved");
  assert.deepEqual(result.impacts[0].impact.v2PostState, { reserve0: 107n, reserve1: 196n });
  assert.deepEqual(result.consumedTriggerIds, ["trigger:1"]);
  assert.deepEqual(result.impacts[0].consumedTriggerIds, ["trigger:1"]);
});

test("related events reject foreign tx/block/source, malformed final Sync and incomplete receipt", async () => {
  for (const change of [{ transactionHash: toBeHex(9, 32) }, { blockHash: toBeHex(9, 32) }, { blockNumber: 99 },
    { transactionHash: undefined }, { data: syncLog().data + "00" }]) {
    const result = await observe(definition(), context([syncLog(), swapLog(), { ...syncLog(), ...change }]));
    assert.equal(result.status, "unresolved");
  }
  const ctx = context([syncLog(), swapLog()]);
  assert.equal((await observe(definition(), { ...ctx, sourceGeneration: { ...ctx.sourceGeneration, logsCompleteness: "fragment" } })).status, "unresolved");
  const wrongIds = definition(); wrongIds.events[0].relatedEvents = ["unknown"];
  assert.throws(() => compile(wrongIds), /related/);
});

test("receipt matching cannot select an edge injected only into edgesByTarget or bypass transfer-tax declarations", async () => {
  const ctx = context([syncLog(), swapLog()]);
  const forged = { ...edge, tokenOut: toBeHex(77, 20) };
  const result = await observe(definition(), { ...ctx, edgesByTarget: new Map([[pool, [forged]]]) });
  assert.equal(result.status, "resolved"); assert.equal(result.impacts.length, 0); assert.equal(result.mutations.length, 1);
  for (const d of [{ ...descriptor, quoteModel: { kind: "other" } },
    { ...descriptor, tokenTransfers: [{ kind: "verified-transfer-tax" }] }]) {
    const rejected = await observe(definition(), context([syncLog(), swapLog()], d));
    assert.equal(rejected.impacts.length, 0); assert.equal(rejected.mutations.length, 1);
  }
  assert.equal((await observe(definition(), { ...ctx, matchedOwnedTriggers: [...ctx.matchedOwnedTriggers, ...ctx.matchedOwnedTriggers] })).status, "unresolved");
});

function withReads(): any {
  const raw = definition();
  raw.receiptReads = { version: 1, when: op("eq", op("length", "$receipt.events"), 0), flow: { version: 1, steps: [
    { id: "reserves", requirements: { transports: ["eth-call"] },
      requests: [{ id: "reserves", kind: "eth-call", to: "$pool", data: op("encode", "pool", "getReserves", []), completion: "return-data" }],
      decode: [{ let: "row", value: op("at", "$reads", 0) }, { let: "reserves", value: op("decodeCanonical", "pool", "getReserves", "$row.data") },
        { return: { reserve0: op("add", "$reserves.0", "$args.amount0In"), reserve1: op("sub", "$reserves.1", "$args.amount1Out") } }] },
  ], result: "$steps.reserves" } };
  return raw;
}

test("receipt read fallback uses existing source block/control only when canonical related state is absent", async () => {
  const raw = withReads(); let calls = 0;
  const ctx = context([swapLog()]);
  ctx.tokenQuery = { async call(request: any, control: any) {
    calls++; assert.deepEqual(request, { to: pool, data: reserveAbi.encodeFunctionData("getReserves"), blockTag: source.number });
    assert.equal(control, ctx.control); return reserveAbi.encodeFunctionResult("getReserves", [100n, 200n, 1]);
  } };
  const result = await observe(raw, ctx);
  assert.equal(result.status, "resolved"); assert.equal(calls, 1);
  assert.deepEqual(result.impacts[0].impact.v2PostState, { reserve0: 107n, reserve1: 196n });
  assert.equal((result.impacts[0].impact as any).source, undefined, "query output is not canonical quote evidence");
  calls = 0;
  assert.equal((await observe(raw, { ...ctx, ...context([syncLog(), swapLog()]) })).status, "resolved");
  assert.equal(calls, 0);
  assert.equal((await observe(raw, { ...ctx, matchedOwnedTriggers: [] })).status, "no-match"); assert.equal(calls, 0);
  assert.equal((await observe(raw, { ...ctx, ...context([{ ...syncLog(), data: "0x" }, swapLog()]) })).status, "unresolved");
  assert.equal(calls, 0, "bad related state cannot become absent state and trigger reads");
  const old = definition(); delete old.events[0].relatedEvents; delete old.events[0].impact.v2PostState;
  assert.equal((await observe(old, ctx)).status, "resolved"); assert.equal(calls, 0, "old declarations add no reads");
});

test("receipt queries are deduplicated per receipt, bounded, and cannot override source or caller", async () => {
  const raw = withReads(), ctx = context([swapLog(), swapLog()]); let calls = 0;
  ctx.tokenQuery = { async call() { calls++; return reserveAbi.encodeFunctionResult("getReserves", [100n, 200n, 1]); } };
  assert.equal((await observe(raw, ctx)).status, "resolved"); assert.equal(calls, 1);
  for (const field of ["blockTag", "caller", "value"]) {
    const bad = clone(raw); bad.receiptReads.flow.steps[0].requests[0][field] = 1;
    calls = 0; assert.equal((await observe(bad, ctx)).status, "unresolved"); assert.equal(calls, 0);
  }
  for (const generation of [{ sourceBlockHash: null }, { sourceBlock: null }]) {
    calls = 0;
    assert.equal((await observe(raw, { ...ctx, sourceGeneration: { ...ctx.sourceGeneration, ...generation } })).status, "unresolved");
    assert.equal(calls, 0);
  }
  const many = clone(raw); many.receiptReads.flow.steps[0].requests = Array.from({ length: 65 }, (_, i) =>
    ({ ...many.receiptReads.flow.steps[0].requests[0], id: String(i) }));
  calls = 0; assert.equal((await observe(many, ctx)).status, "unresolved"); assert.equal(calls, 0);
});

test("JSON owns parallel receipt ABI reads, token/factory checks and dependent rounds", async () => {
  const raw = withReads(), first = raw.receiptReads.flow.steps[0];
  for (const name of ["factory", "token0", "token1"]) first.requests.push({ id: name, kind: "eth-call", to: "$pool",
    data: op("encode", "pool", name, []), completion: "return-data" });
  const checks = ["factory", "token0", "token1"].flatMap((name, i) => [
    { let: `${name}Row`, value: op("at", "$reads", i + 1) },
    { let: `${name}Words`, value: op("decodeCanonical", "pool", name, `$${name}Row.data`) },
    { assert: op("sameAddress", `$${name}Words.0`, name === "factory" ? sender : `$descriptor.${name}`), error: `${name} binding mismatch` },
  ]);
  first.decode = [...checks, ...first.decode];
  // A second round is data-driven as well; no fixed protocol sequence lives
  // in the common read executor. A duplicate physical call still reuses bytes.
  raw.receiptReads.flow.steps.push({ id: "confirm", requirements: { transports: ["eth-call"] },
    requests: [{ id: "confirm", kind: "eth-call", to: "$pool", data: op("encode", "pool", "factory", []), completion: "return-data" }],
    result: "$steps.reserves" });
  raw.receiptReads.flow.result = "$steps.confirm";
  const ctx = context([swapLog()]);
  let called: string[] = [], bad = false;
  ctx.tokenQuery = { async call(request: any, control: any) {
    const name = reserveAbi.parseTransaction({ data: request.data })!.name;
    called.push(name); assert.equal(control, ctx.control); assert.equal(request.blockTag, source.number);
    if (name === "getReserves") return reserveAbi.encodeFunctionResult(name, [100n, 200n, 1]);
    return reserveAbi.encodeFunctionResult(name, [name === "factory" ? sender : name === "token0" ? (bad ? token1 : token0) : token1]);
  } };
  const result = await observe(raw, ctx); assert.equal(result.status, "resolved");
  assert.deepEqual(called, ["getReserves", "factory", "token0", "token1"]);
  assert.deepEqual(result.impacts[0].impact.v2PostState, { reserve0: 107n, reserve1: 196n });
  bad = true; called = [];
  assert.equal((await observe(raw, ctx)).status, "unresolved");
  assert.equal(called.length, 4, "invalid token binding cannot progress to another request round");
});

test("receipt backend failures, cancellation and production deadline stay unresolved without fallback", async () => {
  const raw = withReads(), ctx = context([swapLog()]);
  for (const tokenQuery of [{ async call() { throw new Error("RPC unavailable"); } }, { async call() { return "0x00"; } }])
    assert.equal((await observe(raw, { ...ctx, tokenQuery })).status, "unresolved");
  const controller = new AbortController(); controller.abort(); let calls = 0;
  assert.equal((await observe(raw, { ...ctx, tokenQuery: { async call() { calls++; return "0x"; } },
    control: { ...ctx.control, signal: controller.signal } })).status, "unresolved"); assert.equal(calls, 0);
  let sawAbort = false;
  const timed = await decodeReceiptObservationWithDeadline(compile(raw).receiptObservation!, { ...ctx,
    tokenQuery: { call(_req: any, control: any) { return new Promise<string>((_resolve, reject) => {
      control.signal.addEventListener("abort", () => { sawAbort = true; reject(new Error("aborted")); }, { once: true });
    }); } } }, 10);
  assert.equal(timed.status, "unresolved"); assert.equal(sawAbort, true);
});

test("signed V3 event post-state remains JSON projection and rejects wrong sign directions", async () => {
  const raw = definition(); raw.events = [{ id: "v3-swap", signature: v3Swap, classification: "swap", pool: "$log.address",
    payload: "$args", valid: op("and", op("gt", "$args.amount0", math.uint("0")), op("lt", "$args.amount1", math.uint("0"))),
    match: op("sameAddress", "$edge.tokenIn", "$descriptor.token0"),
    impact: { pool: "$edge.target", tokenIn: "$edge.tokenIn", tokenOut: "$edge.tokenOut", matchedAdapterId: "$edge.adapterId",
      amountIn: "$args.amount0", amountOut: op("sub", math.uint("0"), "$args.amount1"),
      v3PostState: { sqrtPriceX96: "$args.sqrtPriceX96", liquidity: "$args.liquidity", tick: op("number", "$args.tick") } } }];
  const observed = log(v3Swap, [sender, sender, 7n, -4n, 123n, 456n, -3]);
  const ctx = context([observed]); ctx.matchedOwnedTriggers = [{ triggerId: "v3:0", logIndex: 0, emitter: pool, topic0: observed.topics[0] }];
  const result = await observe(raw, ctx);
  assert.equal(result.status, "resolved"); assert.deepEqual(result.impacts[0].impact.v3PostState, { sqrtPriceX96: 123n, liquidity: 456n, tick: -3 });
  const bad = log(v3Swap, [sender, sender, 7n, 4n, 123n, 456n, -3]);
  assert.equal((await observe(raw, { ...ctx, logs: [bad] })).status, "unresolved");
});

test("existing replay expressions bind admitted routes and keep eligibility/post-state checks in JSON", () => {
  const raw = definition(); raw.victimSupport = "replay";
  raw.replay = { bind: op("if", op("and", eligible, op("sameAddress", "$impact.pool", "$descriptor.pool"),
    op("sameAddress", "$impact.tokenIn", "$descriptor.token0"), op("sameAddress", "$impact.tokenOut", "$descriptor.token1")), "forward", null),
    applyLocal: null, buildOverlay: null,
    exactPostState: op("if", op("and", eligible, op("eq", "$impact.exactPostState.feeBps", "$descriptor.feeBps")), "$impact.exactPostState", null) };
  const replay = compile(raw).replay!;
  const route: any = { routeKey: "forward", ...edge }, impact = { pool, tokenIn: token0, tokenOut: token1, amountIn: 7n,
    exactPostState: { reserve0: 107n, reserve1: 196n, feeBps: 30n } };
  const input: any = { descriptor, routes: [route], route, impact, source };
  assert.equal(replay.bind(input), route); assert.deepEqual(replay.exactPostState!(input), impact.exactPostState);
  assert.equal(replay.bind({ ...input, impact: { ...impact, tokenIn: token1, tokenOut: token0 } }), null);
  assert.equal(replay.bind({ ...input, descriptor: { ...descriptor, tokenTransfers: [{ kind: "verified-transfer-tax" }] } }), null);
  assert.equal(replay.exactPostState!({ ...input, impact: { ...impact, exactPostState: { ...impact.exactPostState, feeBps: 29n } } }), null);
  assert.throws(() => replay.bind({ ...input, routes: [] }), /admitted route/);
  assert.throws(() => replay.bind({ ...input, routes: [route, route] }), /admitted route/);
});
