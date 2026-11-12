import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { Interface, toBeHex } from "ethers";
import { createDeclarativeSwapRuntime } from "../venues/declarative-swap.js";

// Synthetic ABI/source/Ready contracts, not fork or live execution evidence.
const rootUrl = new URL("../venues/swaps/curve-plain-family/curve-plain.json", import.meta.url);
const load = (url: URL) => JSON.parse(readFileSync(url, "utf8"));
const root = load(rootUrl);
const family: any = createDeclarativeSwapRuntime(root,
  root.variantFiles.map((file: string) => load(new URL(file, rootUrl)))).definition;
const a = (n: number) => toBeHex(n, 20);
const pool = a(100), token0 = a(201), token1 = a(202), buyer = a(203);
const native = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
const source = { number: 100, hash: toBeHex(100, 32), generation: 1 };
const receipt = { transactionHash: toBeHex(101, 32), blockHash: toBeHex(102, 32), blockNumber: 101 };
const signatures = [
  "event TokenExchange(address indexed buyer,int128 sold_id,uint256 tokens_sold,int128 bought_id,uint256 tokens_bought)",
  "event TokenExchange(address indexed buyer,uint256 sold_id,uint256 tokens_sold,uint256 bought_id,uint256 tokens_bought)",
  "event TokenExchange(address indexed buyer,uint256 sold_id,uint256 tokens_sold,uint256 bought_id,uint256 tokens_bought,uint256 fee,uint256 packed_price_scale)",
];

function fixture(eventIndex = 0, nativeInput = false, getter = "uint256") {
  const coins = [nativeInput ? native : token0, token1];
  const direction = { i: 0, j: 1, tokenIn: nativeInput ? root.standard.constants.curveWrappedNative : token0,
    tokenOut: token1, executionMode: nativeInput ? "native-exchange" : "exchange",
    executionAssets: { input: nativeInput ? "native" : "erc20", output: "erc20" } };
  const identity = { familyId: "curve-plain", lineageId: root.standard.lineageId, subject: pool,
    provenance: [{ kind: "synthetic-observation-fixture", subject: pool, evidenceHash: toBeHex(301, 32) }],
    facts: { pool, directions: [direction], binding: { registry: root.standard.constants.registry,
      handlers: [a(300)], coins, decimals: [18n, 6n], coinAbi: getter, balanceAbi: getter,
      codeHash: toBeHex(302, 32), classKind: "registry" } } };
  const descriptor = family.instance.compileDraft(identity);
  const edge = family.routes.project({ descriptor })[0];
  const abi = new Interface([signatures[eventIndex]]);
  const log = { ...receipt, address: pool, ...abi.encodeEventLog("TokenExchange",
    [buyer, 0n, 17n, 1n, 31n, ...(eventIndex === 2 ? [123n, 456n] : [])]) };
  const queryAbi = new Interface([`function coins(${getter}) view returns(address)`]);
  const reads: any[] = [];
  const context: any = { logs: [log], graph: [edge], edgesByTarget: new Map([[pool, [edge]]]),
    resolveBinding: () => ({ familyId: "curve-plain", descriptor }),
    sourceGeneration: { id: "curve-synthetic-receipt", sourceBlock: source.number, sourceBlockHash: source.hash,
      receiptId: receipt.transactionHash, receiptBlockNumber: receipt.blockNumber, receiptBlockHash: receipt.blockHash,
      receiptParentBlockHash: source.hash, receiptTransactionHash: receipt.transactionHash, logsCompleteness: "complete-receipt" },
    matchedOwnedTriggers: [{ triggerId: "curve:0", logIndex: 0, emitter: pool, topic0: log.topics[0] }],
    control: { signal: new AbortController().signal, deadlineAtMs: Date.now() + 10000 },
    tokenQuery: { async call(request: any, control: any) {
      assert.equal(control, context.control);
      assert.equal(request.blockTag, source.number);
      assert.equal(request.to.toLowerCase(), pool);
      reads.push(request);
      const index = Number(queryAbi.decodeFunctionData("coins", request.data)[0]);
      return queryAbi.encodeFunctionResult("coins", [coins[index]]);
    } },
  };
  return { context, reads, edge, descriptor, log, queryAbi };
}

test("[family=curve-plain] JSON signed/unsigned/NG receipts bind Ready coin indices and current-source getters", async () => {
  for (const event of [0, 1, 2]) for (const nativeInput of [false, true]) for (const getter of ["int128", "uint256"]) {
    const f = fixture(event, nativeInput, getter);
    const result = await family.swap.receiptObservation.decodeReceiptImpacts(f.context);
    assert.equal(result.status, "resolved");
    assert.equal(result.impacts.length, 1);
    assert.equal(f.reads.length, 2);
    const impact = result.impacts[0].impact;
    assert.equal(impact.tokenIn.toLowerCase(), f.edge.tokenIn.toLowerCase());
    assert.equal(impact.tokenOut.toLowerCase(), f.edge.tokenOut.toLowerCase());
    assert.equal(impact.amountIn, 17n); assert.equal(impact.amountOut, 31n);
    assert.equal(impact.v2PostState, undefined);
    assert.equal(family.swap.victimSupport, "detect-only");
    assert.deepEqual(result.consumedTriggerIds, ["curve:0"]);
  }
});

test("[family=curve-plain] JSON receipt refuses changed coins, foreign Ready/source and malformed observations", async () => {
  for (const change of [
    (f: any) => { f.context.tokenQuery.call = async () => f.queryAbi.encodeFunctionResult("coins", [a(999)]); },
    (f: any) => { f.context.tokenQuery.call = async () => "0x"; },
    (f: any) => { f.context.resolveBinding = () => undefined; },
    (f: any) => { f.context.resolveBinding = () => ({ familyId: "foreign", descriptor: f.descriptor }); },
    (f: any) => { f.context.sourceGeneration.sourceBlockHash = undefined; },
    (f: any) => { f.context.sourceGeneration.logsCompleteness = "fragment"; },
    (f: any) => { f.context.logs[0] = { ...f.log, transactionHash: toBeHex(999, 32) }; },
    (f: any) => { f.context.logs[0] = { ...f.log, data: f.log.data + "00" }; },
    (f: any) => { f.context.matchedOwnedTriggers.push(f.context.matchedOwnedTriggers[0]); },
  ]) {
    const f = fixture(); change(f);
    const result = await family.swap.receiptObservation.decodeReceiptImpacts(f.context);
    assert.equal(result.status, "unresolved");
  }
});

test("[family=curve-plain] JSON discovery nominates ABI evidence and rejects malformed or out-of-range directions", () => {
  for (const event of [0, 1, 2]) {
    const f = fixture(event);
    const observed = { ...f.log, kind: "log", source };
    const matchedPatternId = root.discovery.definition.events[event].id;
    const candidate = family.discovery.decodeCandidate({ observation: observed, matchedPatternId });
    assert.equal(candidate.pool.toLowerCase(), pool);
    assert.equal(candidate.hintedI, 0); assert.equal(candidate.hintedJ, 1);
    assert.equal(family.discovery.decodeCandidate({ observation: { ...observed, data: "0x" }, matchedPatternId }), null);
  }
});
