import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { ethers } from "ethers";
import { plugin } from "../../../production-families/uniswap-v1.production.js";
import { IMPLEMENTATION, POOL } from "../codec.js";

// Explicit read-only cached input; outputs must be caller-selected ignored logs.
const [cache, out] = process.argv.slice(2);
assert(cache && out, "usage: cached-evidence.ts <cache-directory> <ignored-output-directory>");
assert(resolve(out).includes("/logs/"));
const exchanges = ["0x97386862594f4cacea245e8dbfa6230ca696c37c", "0x83034714666b0eb2209aafc1b1cbb2ab9c6100db"];
const hashes: Record<string, string> = {};
function read(path: string) {
  const bytes = readFileSync(resolve(cache, path)); hashes[path] = createHash("sha256").update(bytes).digest("hex"); return bytes.toString("utf8");
}
for (const exchange of exchanges) {
  const html = read(`contracts/${exchange}.html`);
  assert(html.includes(`var litMinimalProxyImplementation = '${IMPLEMENTATION}'`));
  for (const source of ["eth_fee: uint256(wei) = (eth_sold + 999) / 1000", "self.balance - eth_sold2",
    "tokens_fee: uint256 = (tokens_sold + 999) / 1000", "self.token.transferFrom(buyer, self.issuer, tokens_fee)",
    "return self.getInputPrice(as_unitless_number(eth_sold), as_unitless_number(self.balance), token_reserve)"])
    assert(html.includes(source), `cached verified source missing ${source}`);
}
interface Frame { type?: string; from?: string; to?: string; input?: string; value?: string; output?: string; error?: string; calls?: Frame[] }
function flatten(frame: Frame): Frame[] { return frame.error ? [] : [frame, ...(frame.calls ?? []).flatMap(flatten)]; }
const samples = [], selected = new Set<string>();
for (const name of readdirSync(resolve(cache, "raw")).filter(n => n.endsWith(".json"))) {
  const raw = readFileSync(resolve(cache, "raw", name), "utf8");
  if (!exchanges.some(a => raw.includes(a))) continue;
  const x = JSON.parse(read(`raw/${name}`));
  if (!x.receipt || !x.tx || !x.trace) continue;
  const frames = flatten(x.trace);
  const calls = frames.filter(c => c.type === "CALL" && exchanges.includes(c.to ?? "") &&
    (c.input === "0x" || c.input?.startsWith(POOL.getFunction("ethToTokenSwapOutput")!.selector)));
  if (!calls.length) continue;
  const receipt = x.receipt;
  assert.equal(receipt.status, "0x1"); assert.equal(x.tx.chainId, "0x1");
  assert.equal(receipt.transactionHash, x.tx.hash); assert.equal(receipt.blockNumber, x.tx.blockNumber); assert.equal(receipt.blockHash, x.tx.blockHash);
  for (const c of calls) {
    const source = { number: Number(BigInt(receipt.blockNumber)), hash: receipt.blockHash, generation: 1 };
    const log = receipt.logs.find((l: {address: string; topics: string[]}) => l.address === c.to && l.topics[0] === POOL.getEvent("TokenPurchase")!.topicHash);
    assert(log); const event = POOL.decodeEventLog("TokenPurchase", log.data, log.topics);
    const exactOut = c.input !== "0x";
    const candidate = exactOut
      ? plugin.discovery.decodeCandidate({ observation: { kind: "call", source, target: c.to!, data: c.input! }, matchedPatternId: "univ1-ethToTokenSwapOutput" })
      : plugin.discovery.decodeCandidate({ observation: { kind: "log", source, address: c.to!, data: log.data, topics: log.topics }, matchedPatternId: "univ1-TokenPurchase" });
    assert.equal(candidate?.pool, c.to);
    if (exactOut) assert.equal(BigInt(POOL.decodeFunctionData("ethToTokenSwapOutput", c.input!)[0]), BigInt(event[2]));
    else assert.equal(BigInt(c.value!), BigInt(event[1]));
    assert.equal(event[0].toLowerCase(), c.from);
    const inner = flatten(c).find(f => f.type === "DELEGATECALL" && f.to === IMPLEMENTATION);
    assert(inner, "cached exchange must delegate to reviewed implementation");
    const transfer = flatten(c).find(f => f.type === "CALL" && f.input?.startsWith("0xa9059cbb")); assert(transfer?.input);
    const erc20 = new ethers.Interface(["function transfer(address,uint256) returns(bool)"]);
    const sent = erc20.decodeFunctionData("transfer", transfer.input);
    assert.equal(sent[0].toLowerCase(), c.from); assert.equal(BigInt(sent[1]), BigInt(event[2]));
    const fee = flatten(c).filter(f => f.type === "CALL" && f.input === "0x" && f.value && BigInt(f.value) > 0n);
    samples.push({ tx: receipt.transactionHash, N: source.number, blockHash: source.hash, exchange: c.to, token: transfer.to,
      executor: c.from, selector: c.input!.slice(0, 10), semantics: exactOut ? "landed-exact-out-not-search-exact-in" : "landed-fallback-exact-in",
      msgValue: String(BigInt(c.value!)), actualAmountIn: String(BigInt(event[1])), actualAmountOut: String(BigInt(event[2])),
      nativeTransfers: fee.map(f => ({ to: f.to, amount: String(BigInt(f.value!)) })),
      originalLegPrestateParity: "unverified", historicalEndOfBlockQuoteExecutionParity: "not-run" });
    selected.add(receipt.transactionHash);
  }
}
assert(samples.some(s => s.tx === "0x4a4255cbfc0521233d4565f2073323a88c3ac1f8600a501aa5731ee8230288fc" && s.N === 26029476));
const rows = read("receipt-rows.ndjson").trim().split("\n").filter(line => selected.has(JSON.parse(line).tx_hash));
writeFileSync(resolve(out, "sample-rows.ndjson"), rows.join("\n") + "\n");
const summary = { scope: "cached-public-receipt-trace-source-only", hashes, samples, noHistoricalRPC: true };
writeFileSync(resolve(out, "cached-evidence.json"), JSON.stringify(summary, null, 2) + "\n");
console.log(JSON.stringify(summary, null, 2));
