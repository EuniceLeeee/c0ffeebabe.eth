import assert from "node:assert/strict";
import test from "node:test";
import { Interface } from "ethers";
import { readySelectorCensusFromTransaction } from "../ready-selector-census.js";

const a = (n: number) => "0x" + n.toString(16).padStart(40, "0");
const h = (n: number) => "0x" + n.toString(16).padStart(64, "0");
const w = (n: bigint | number) => BigInt(n).toString(16).padStart(64, "0");
const ACTOR = a(1001), ROUTER = a(1002), POOL = a(1003), TOKEN_A = a(1004), TOKEN_B = a(1005);
const erc20 = new Interface(["event Transfer(address indexed from,address indexed to,uint256 value)"]);
const erc721 = new Interface(["event Transfer(address indexed from,address indexed to,uint256 indexed id)"]);
const erc1155 = new Interface(["event TransferSingle(address indexed operator,address indexed from,address indexed to,uint256 id,uint256 value)",
  "event TransferBatch(address indexed operator,address indexed from,address indexed to,uint256[] ids,uint256[] values)"]);
const event = (token: string, index: number, iface: Interface, name: string, args: unknown[]) => ({
  log_address: token, log_index: index, ...iface.encodeEventLog(iface.getEvent(name)!, args),
});
const transfer = (token: string, index: number, from: string, to: string, amount: bigint | number) => event(token, index, erc20, "Transfer", [from, to, amount]);
const source = (extra: Record<string, unknown> = {}) => ({ tx_hash: h(1), block_number: 100, block_hash: h(2), transaction_index: 0,
  receipt_status: 1, from_address: ACTOR, to_address: POOL, input: "0x12345678" + w(17), value: "0",
  trace_rows_present: false, traces: [], logs: [], ...extra });
const census = (extra: Record<string, unknown> = {}) => readySelectorCensusFromTransaction(source(extra), { chainId: 1 });

test("an unknown selector with no catalog retains calldata and stays a raw unverified call", () => {
  const result = census();
  assert.equal(result.status, "unverified");
  assert.equal(result.calls.length, 1);
  assert.deepEqual({ selector: result.calls[0]!.selector, params: result.calls[0]!.params, wordCount: result.calls[0]!.wordCount },
    { selector: "0x12345678", params: "0x" + w(17), wordCount: 1 });
  assert.equal(result.calls[0]!.classification, "raw-call");
  assert.equal(result.calls[0]!.executionStatus, "success");
  assert.equal(result.coverage.internalCalls, "unobserved");
  assert.equal(result.coverage.allInternalCallsEnumerated, false);
  assert.deepEqual(result.coverage.issues, []);
});

test("parent router input never labels the logical pool discovered from Transfer endpoints", () => {
  const result = census({ to_address: ROUTER, logs: [transfer(TOKEN_A, 0, ACTOR, POOL, 17), transfer(TOKEN_B, 1, POOL, ACTOR, 31)] });
  assert.equal(result.calls[0]!.target, ROUTER);
  assert.deepEqual(result.calls[0]!.flowIndices, []);
  const pool = result.resources.find(r => r.address === POOL)!;
  assert.deepEqual(pool.flowIndices, [0, 1]);
  assert.equal(pool.selector, null);
  assert.equal(pool.status, "unverified");
  assert.equal(result.tokenFlows.length, 2);
});

test("direct address correlation remains unverified and makes no route or balance proof", () => {
  const result = census({ logs: [transfer(TOKEN_A, 0, ACTOR, POOL, 17), transfer(TOKEN_B, 1, POOL, ACTOR, 31)] });
  assert.equal(result.calls[0]!.classification, "flow-correlated");
  assert.equal(result.calls[0]!.flowAttribution, "address-correlation-only");
  assert.equal(result.calls[0]!.status, "unverified");
  assert.deepEqual(result.calls[0]!.flowIndices, [0, 1]);
});

test("every output and NFT token ID survives without being converted to an ERC20 pair", () => {
  const logs = [transfer(TOKEN_A, 0, ACTOR, POOL, 17), transfer(TOKEN_B, 1, POOL, ACTOR, (1n << 256n) - 1n),
    event(a(1006), 2, erc721, "Transfer", [POOL, ACTOR, 9]),
    event(a(1007), 3, erc1155, "TransferSingle", [ACTOR, POOL, ACTOR, 11, 5]),
    event(a(1008), 4, erc1155, "TransferBatch", [ACTOR, POOL, ACTOR, [12, 13], [6, 7]])];
  const result = census({ logs });
  assert.equal(result.tokenFlows.length, 6);
  assert.equal(result.tokenFlows[1]!.amount, ((1n << 256n) - 1n).toString());
  assert.deepEqual(result.tokenFlows.slice(2).map(f => [f.standard, f.tokenId, f.amount]),
    [["erc721", "9", "1"], ["erc1155", "11", "5"], ["erc1155", "12", "6"], ["erc1155", "13", "7"]]);
  assert.deepEqual(result.logs, logs);
  assert.equal(result.calls[0]!.status, "unverified");
});

test("a Withdraw or arbitrary log is preserved without inventing its function selector", () => {
  const withdraw = new Interface(["event Withdraw(address indexed caller,address indexed receiver,uint256 assets,uint256 shares)"]);
  const log = event(POOL, 0, withdraw, "Withdraw", [ACTOR, ACTOR, 17, 31]);
  const result = census({ to_address: ROUTER, logs: [log] });
  assert.equal(result.calls[0]!.selector, "0x12345678");
  assert.equal(result.tokenFlows.length, 0);
  assert.deepEqual(result.logs, [log]);
  assert.equal(result.resources.find(r => r.address === POOL)!.selector, null);
});

test("bytes32 parameters are opaque unless an explicit selector layout declares poolId", () => {
  const tx = source({ input: "0x12345678" + w(999) + w(17) });
  assert.equal(readySelectorCensusFromTransaction(tx, { chainId: 1 }).calls[0]!.poolId, undefined);
  const result = readySelectorCensusFromTransaction(tx, { chainId: 1,
    poolIdLayouts: [{ selector: "0x12345678", wordCount: 2, poolIdWord: 0, namespace: "shared-manager" }] });
  assert.equal(result.calls[0]!.poolId, h(999));
  assert.equal(result.calls[0]!.poolNamespace, "shared-manager");
  assert.equal(result.calls[0]!.params, "0x" + w(999) + w(17));
  assert.equal(result.calls[0]!.status, "unverified");
});

test("ambiguous poolId layouts cannot silently choose one namespace", () => {
  const layout = { selector: "0x12345678", wordCount: 1, poolIdWord: 0, namespace: "a" };
  assert.throws(() => readySelectorCensusFromTransaction(source(), { poolIdLayouts: [layout, { ...layout, namespace: "b" }] }), /ambiguous/);
  assert.throws(() => readySelectorCensusFromTransaction(source(), { poolIdLayouts: [{ ...layout, poolIdWord: 1 }] }), /invalid/);
});

test("old supplied trace input preserves unknown internal selectors and reports its limited scope", () => {
  const result = census({ input: undefined, from_address: undefined, to_address: undefined, traces: [
    { trace_address: "", call_type: "call", status: 1, from_address: ACTOR, to_address: ROUTER, input: "0x11111111" },
    { trace_address: "0", call_type: "call", status: 1, from_address: ROUTER, to_address: POOL, input: "0x22222222" + w(17) },
  ], trace_rows_present: true });
  assert.equal(result.coverage.topLevelInput, "trace-root");
  assert.equal(result.coverage.internalCalls, "observed-traces");
  assert.equal(result.coverage.allInternalCallsEnumerated, false);
  assert.deepEqual(result.calls.map(c => [c.selector, c.target]), [["0x11111111", ROUTER], ["0x22222222", POOL]]);
});

test("missing ancestors, duplicated paths and explicit truncation are retained as coverage issues", () => {
  const result = census({ traces: [
    { trace_address: "0", call_type: "call", status: 1, to_address: POOL, input: "0x22222222", truncated: true },
    { trace_address: "0", call_type: "call", status: 1, to_address: POOL, input: "0x33333333" },
  ], trace_rows_present: true });
  assert.equal(result.calls.length, 3);
  for (const issue of ["trace-root-missing-or-duplicate", "duplicate-trace-path", "trace-explicitly-incomplete", "trace-ancestor-missing-or-duplicate"])
    assert(result.coverage.issues.includes(issue));
  assert.equal(result.calls[1]!.executionStatus, "unknown");
});

test("failed child, static and auxiliary calls stay visible without declaring execution failures for raw calls", () => {
  const result = census({ traces: [
    { trace_address: "", call_type: "call", status: 1, to_address: POOL, input: "0x12345678" + w(17) },
    { trace_address: "0", call_type: "staticcall", status: 1, to_address: TOKEN_A, input: "0x70a08231" + w(1001) },
    { trace_address: "1", call_type: "call", status: 0, to_address: TOKEN_B, input: "0x99999999" },
    { trace_address: "1,0", call_type: "call", status: 1, to_address: TOKEN_A, input: "0x88888888" },
  ] });
  assert.equal(result.calls[2]!.callType, "staticcall");
  assert.equal(result.calls[2]!.classification, "raw-call");
  assert.equal(result.calls[2]!.status, "unverified");
  assert.equal(result.calls[3]!.executionStatus, "reverted");
  assert.equal(result.calls[4]!.executionStatus, "reverted");
});

test("unavailable source identities remain null, never fabricated canonical block/hash values", () => {
  const result = readySelectorCensusFromTransaction({ logs: [], traces: [], input: "0x" });
  assert.equal(result.chainId, null);
  assert.equal(result.transactionHash, null);
  assert.equal(result.blockNumber, null);
  assert.equal(result.blockHash, null);
  assert.equal(result.receiptStatus, null);
  assert(result.coverage.issues.includes("block-hash-unavailable"));
  assert.equal(result.calls[0]!.selector, null);
  assert.equal(result.calls[0]!.executionStatus, "unknown");
});

test("malformed transfer data stays in the raw ledger and never emits partial batch flows", () => {
  const log = event(TOKEN_A, 0, erc1155, "TransferBatch", [ACTOR, POOL, ACTOR, [12, 13], [6, 7]]);
  const malformed = { ...log, data: log.data.slice(0, -64) };
  const result = census({ logs: [malformed] });
  assert.deepEqual(result.logs, [malformed]);
  assert.deepEqual(result.tokenFlows, []);
  assert(result.coverage.issues.includes("malformed-transfer-event"));
});

test("opaque byte parameters and unknown events are retained even without a word-aligned ABI", () => {
  const result = census({ input: "0x12345678aabb", logs: [{ log_address: POOL, log_index: 0, topics: [h(19)], data: "0xaabb" }] });
  assert.equal(result.calls[0]!.wordCount, null);
  assert.equal(result.calls[0]!.params, "0xaabb");
  assert.equal(result.logs.length, 1);
  assert.equal(result.tokenFlows.length, 0);
});

test("input data is not frozen or mutated by immutable census publication", () => {
  const logs = [transfer(TOKEN_A, 0, ACTOR, POOL, 17)], tx = source({ logs });
  const result = readySelectorCensusFromTransaction(tx, { chainId: 1 });
  assert(Object.isFrozen(result));
  assert(Object.isFrozen(result.logs[0]));
  assert(!Object.isFrozen(logs[0]));
  logs[0]!.data = "0x";
  assert.notDeepEqual(result.logs, logs);
});

test("creation initcode is retained without inventing a function selector and native value remains exact", () => {
  const result = census({ to_address: null, input: "0x6080604052", value: "0xffffffffffffffffffffffffffffffff" });
  assert.equal(result.calls[0]!.callType, "create");
  assert.equal(result.calls[0]!.selector, null);
  assert.equal(result.calls[0]!.calldata, "0x6080604052");
  assert.equal(result.calls[0]!.value, ((1n << 128n) - 1n).toString());
  const malformed = census({ to_address: "not-an-address" });
  assert.equal(malformed.calls[0]!.callType, null);
  assert(malformed.coverage.issues.includes("transaction-target-malformed"));
});
