// Assertions/observation only. No admission, pricing math, scheduler or mock EVM.
import assert from "node:assert/strict";
import { ethers } from "ethers";
import { KYSWAP_POOL_INTERFACE as KYBER } from "../../../venues/swaps/kyberswap-elastic-family/abi.js";
import { ALGEBRA_POOL_INTERFACE as ALGEBRA } from "../../../venues/swaps/algebra-integral-family/abi.js";
import { LT_INTERFACE as LT } from "../../../venues/protocols/yieldbasis-lt-family/abi.js";
import { CTOKEN_INTERFACE as CT } from "../../../venues/protocols/compound-ctoken-family/abi.js";
import { successfulRedeemCalls, classifyRedeemLog } from "../../../venues/protocols/compound-ctoken-family/test/history-evidence.js";
import { assertHistoricalPriceDirection } from "../three-family/historical-input-observations.js";
export { json, sha, word, observeBalance } from "../../../venues/protocols/set-redemption-family/test/historical-runtime-observations.js";

export const SAMPLES = {
  kyber: { family: "kyberswap-elastic", number: 25953136,
    tx: "0x023fd22564532537a14977836049e12e8df706c4872020a9302fdfbb383230d5",
    instances: ["0xf138462c76568cdfd77c6eb831e973d6963f2006"] },
  yb: { family: "protocol:yieldbasis-lt", number: 26003536,
    tx: "0x022a9ff85219675bcf0a0a2b17c76ac72b98d5e2c4177bc104edff56e706ee77",
    instances: ["0x2b9c9f3bdceb5d8e36a4704f08a78fca53343cea"] },
  compound: { family: "protocol:compound-ctoken", number: 25944463,
    tx: "0x032b820506f44423a7f62918464e8e735619ff463bb6ecce1b3d0d6299ba99df",
    instances: ["0x39aa39c021dfbae8fac545936693ac917d5e7563", "0x5d3a536e4d6dbd6114cc1ead35777bab948e3643"] },
  algebra: { family: "swap:algebra-integral", number: 26018534,
    tx: "0x02175d2ac2e806bc6e1033cae640cf45509b7ded4a2e64ebcbba9c425afff5b7",
    instances: ["0x76a278bd71f566ee6ba2fe438f6099c8d8f98f43"] },
  algebra2: { family: "swap:algebra-integral", number: 26030898,
    tx: "0x006223028f05865619d07584c43cf67cb608705d04ebc732e15bf40869d030b8",
    instances: ["0x915fd34cadd63907b51eb64dddc2eadd114a0bed"] },
} as const;
export type SampleKey = keyof typeof SAMPLES;
export const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** EIP-7702 delegation designators are valid origin-account code, not an
 * arbitrary contract sender. The harness preserves this code; it never executes
 * or authorizes a delegation and never signs a transaction. */
export function assertOriginAccountCode(code: string): void {
  assert(code === "0x" || /^0xef0100[0-9a-f]{40}$/i.test(code),
    "owner must have empty code or an exact EIP-7702 delegation designator");
}

/** A storage-access list can contain a proxy implementation slot. Overriding
 * that slot may produce empty return data, which disproves the balance-slot
 * candidate; it is not a successful observation or a transport failure. */
export function matchesBalanceSlotProbe(data: string, expected: bigint): boolean {
  return ethers.isHexString(data, 32) && BigInt(data) === expected;
}

/** Only a declared EVM revert from a local eth_call can disprove an injected
 * storage-slot hypothesis. Transport, unknown server and upstream errors fail. */
export function isLocalBalanceProbeRevert(error: unknown): boolean {
  const e = error as { localCall?: unknown; rpcCode?: unknown; returnData?: unknown } | null;
  return e instanceof Error && e.localCall === true && e.rpcCode === 3 && ethers.isHexString(e.returnData, true);
}

export const ERC20 = new ethers.Interface(["function balanceOf(address) view returns(uint256)",
  "function totalSupply() view returns(uint256)", "event Transfer(address indexed from,address indexed to,uint256 value)"]);

export function options(argv: string[]) {
  const v = new Map<string, string>();
  const names = ["--family", "--ready", "--prices", "--port", "--out"];
  for (let i = 0; i < argv.length; i += 2) {
    assert(names.includes(argv[i]!) && !v.has(argv[i]!), "unknown/duplicate argument");
    const value = argv[i + 1]; assert(value && !value.startsWith("--"), "missing argument"); v.set(argv[i]!, value);
  }
  assert.equal(v.size, names.length, "all five arguments required");
  const family = v.get("--family")!;
  assert(Object.hasOwn(SAMPLES, family), "only the registered fixed Family samples are supported");
  const portText = v.get("--port")!; assert(/^[1-9][0-9]*$/.test(portText));
  const port = Number(portText); assert(port >= 1024 && port <= 65535 && Number.isSafeInteger(port));
  return { family: family as SampleKey, port, ready: v.get("--ready")!, prices: v.get("--prices")!, out: v.get("--out")! };
}

export function assertHeader(actual: any, expected: any): void {
  // Missing mandatory fields must not pass by comparing undefined to undefined.
  for (const k of ["number", "hash", "parentHash", "stateRoot", "timestamp", "baseFeePerGas", "gasLimit", "miner", "mixHash"]) {
    assert(typeof expected?.[k] === "string" && typeof actual?.[k] === "string", "missing N header " + k);
    assert.equal(actual[k].toLowerCase(), expected[k].toLowerCase(), "N header changed: " + k);
  }
  assert.equal(actual.excessBlobGas, expected.excessBlobGas);
}

export function assertPriceInput(saved: any, provenance: any, ready: any, input: {
  readySha256: string; sourceTreeSha256: string; number: number;
}): void {
  for (const p of [saved, provenance]) assert.equal(p.readySha256, input.readySha256, "prices refer to another Ready");
  assert.equal(provenance.executionMode, "source-block", "N+1 is not same-N acceptance");
  assert.equal(provenance.through, "prices"); assert.equal(provenance.broadcast, false);
  assert.equal(provenance.implementation?.sourceTreeSha256, input.sourceTreeSha256, "stale production source fingerprint");
  assert.equal(BigInt(provenance.chainId), 1n);
  assert.equal(ready.universeRange.fromBlock, input.number); assert.equal(ready.universeRange.toBlock, input.number);
  for (const source of [ready.cutoff, provenance.stateSource, provenance.topologySource,
    { number: saved.runtime?.sourceBlock, hash: saved.runtime?.sourceBlockHash },
    { number: saved.runtime?.pricing?.sourceBlock, hash: saved.runtime?.pricing?.sourceBlockHash }]) {
    assert.equal(source?.number, input.number); assert(same(source.hash, ready.cutoff.hash), "source mismatch");
  }
  assert.equal(Number(BigInt(provenance.sourceHeader.number)), input.number);
  assert(same(provenance.sourceHeader.hash, ready.cutoff.hash));
}

/** A missing/not-quoted effective row is an unmet gate, never a fabricated P. */
export function productionAmount(row: any, raw: any, edge: any, source: { number: number; hash: string }, generation: number) {
  if (!row || row.status !== "quoted") return { status: "unmet" as const, reason: row?.status ?? "missing-effective-row" };
  assertHistoricalPriceDirection(edge, row, edge.instanceKey);
  assert(raw && Number.isFinite(raw.mid) && raw.mid > 0, "quoted effective row lacks valid production raw mid");
  assert(typeof row.amountIn === "bigint" && row.amountIn > 0n && row.amountIn <= ethers.MaxUint256);
  assert(typeof row.amountOut === "bigint" && row.amountOut > 0n && row.amountOut <= ethers.MaxUint256);
  assert.equal(row.quotedAt?.number, source.number); assert(same(row.quotedAt.hash, source.hash));
  assert.equal(row.quotedAt.generation, generation, "carried/stale row is not a fresh N measurement");
  return { status: "met" as const, amountIn: row.amountIn as bigint, amountOut: row.amountOut as bigint };
}

function successfulCalls(trace: any, target: string, selector: string): any[] {
  const result: any[] = [];
  const visit = (f: any) => {
    if (!f || f.error || f.revertReason) return;
    if (f.type === "CALL" && same(f.to ?? "", target) && f.input?.slice(0, 10) === selector) result.push(f);
    for (const c of f.calls ?? []) visit(c);
  };
  visit(trace); return result;
}

/** Extract only one unambiguous real successful call + event per instance. */
export function originalLeg(key: SampleKey, instance: string, descriptor: any, receipt: any, trace: any) {
  assert(!trace.error && !trace.revertReason, "original transaction reverted");
  const isSwap = key === "kyber" || key === "algebra" || key === "algebra2";
  const abi = key === "kyber" ? KYBER : isSwap ? ALGEBRA : key === "yb" ? LT : CT;
  const event = isSwap ? "Swap" : key === "yb" ? "Withdraw" : "Redeem";
  const logs = receipt.logs.filter((l: any) => same(l.address, instance) && same(l.topics?.[0] ?? "", abi.getEvent(event)!.topicHash));
  assert.equal(logs.length, 1, "ambiguous original event count");
  const a = abi.parseLog(logs[0])!.args;
  let tokenIn: string, tokenOut: string, amountIn: bigint, amountOut: bigint, caller: string, recipient: string;
  let originalInterface: string, comparison: string;
  if (isSwap) {
    const calls = successfulCalls(trace, instance, abi.getFunction("swap")!.selector); assert.equal(calls.length, 1);
    const c = calls[0], data = abi.decodeFunctionData("swap", c.input), out = abi.decodeFunctionResult("swap", c.output);
    assert.equal(out[0], a.amount0); assert.equal(out[1], a.amount1);
    const zeroIn = a.amount0 > 0n && a.amount1 < 0n;
    assert(zeroIn || (a.amount1 > 0n && a.amount0 < 0n), "not a settled one-input swap");
    tokenIn = zeroIn ? descriptor.token0 : descriptor.token1; tokenOut = zeroIn ? descriptor.token1 : descriptor.token0;
    amountIn = BigInt(zeroIn ? a.amount0 : a.amount1); amountOut = -BigInt(zeroIn ? a.amount1 : a.amount0);
    const required = key === "kyber" ? data.swapQty : data.amountRequired;
    const direction = key === "kyber" ? data.isToken0 : data.zeroToOne;
    assert(required > 0n && required === amountIn && direction === zeroIn, "sample is not full exact-input swap");
    caller = c.from; recipient = data.recipient;
    assert(same(a.sender, caller) && same(a.recipient, recipient)); originalInterface = "swap/exact-input";
    comparison = "same interface at N-end; original pre-call state NOT restored";
  } else if (key === "yb") {
    const selector = LT.getFunction("withdraw(uint256,uint256)")!.selector;
    const calls = successfulCalls(trace, instance, selector); assert.equal(calls.length, 1, "ordinary two-argument withdraw required");
    const c = calls[0], data = LT.decodeFunctionData("withdraw(uint256,uint256)", c.input);
    tokenIn = descriptor.share; tokenOut = descriptor.asset; amountIn = a.shares; amountOut = a.assets;
    caller = c.from; recipient = a.receiver;
    assert.equal(data[0], amountIn); assert.equal(LT.decodeFunctionResult("withdraw(uint256,uint256)", c.output)[0], amountOut);
    assert(same(a.sender, caller) && same(a.owner, caller) && same(recipient, caller));
    originalInterface = "withdraw(uint256,uint256)"; comparison = "same interface at N-end; original pre-call state NOT restored";
  } else {
    const calls = successfulRedeemCalls(trace, new Set([instance.toLowerCase()]));
    const kind = classifyRedeemLog({ emitter: instance, redeemer: a.redeemer, redeemTokens: a.redeemTokens, redeemAmount: a.redeemAmount }, calls, logs.length);
    assert.notEqual(kind, "unverified-or-ambiguous");
    tokenIn = descriptor.share; tokenOut = descriptor.underlying; amountIn = a.redeemTokens; amountOut = a.redeemAmount;
    caller = a.redeemer; recipient = a.redeemer; originalInterface = calls[0]!.method;
    comparison = kind === "underlying-output"
      ? "redeemUnderlying observed; burned shares mapped to redeem at N-end, NOT original interface/pre-call parity"
      : "redeem at N-end; original pre-call state NOT restored";
  }
  assert(ethers.isAddress(tokenIn) && ethers.isAddress(tokenOut) && !same(tokenIn, tokenOut));
  assert(amountIn > 0n && amountOut > 0n);
  // Independent receipt transfer to the observed recipient, not whole-TX net profit.
  const received = receipt.logs.filter((l: any) => same(l.address, tokenOut) && l.topics?.[0] === ERC20.getEvent("Transfer")!.topicHash)
    .map((l: any) => ERC20.parseLog(l)!.args).filter((t: any) => same(t.to, recipient) && t.value === amountOut);
  assert.equal(received.length, 1, "original output receipt is missing/ambiguous");
  return { tokenIn: tokenIn.toLowerCase(), tokenOut: tokenOut.toLowerCase(), amountIn, amountOut,
    caller: caller.toLowerCase(), recipient: recipient.toLowerCase(), originalInterface, comparison, logIndex: logs[0].logIndex };
}

export function assertReceipt(receipt: any, tx: string, header: any): void {
  assert(same(receipt?.transactionHash ?? "", tx) && same(receipt.blockHash, header.hash));
  assert.equal(BigInt(receipt.blockNumber), BigInt(header.number)); assert.equal(BigInt(receipt.status), 1n);
  for (const l of receipt.logs) {
    assert(!l.removed && same(l.transactionHash, tx) && same(l.blockHash, header.hash));
    assert.equal(BigInt(l.blockNumber), BigInt(header.number));
  }
}

export function assertDeltas(input: { before: bigint; after: bigint; delta: bigint }, output: { before: bigint; after: bigint; delta: bigint }, amountIn: bigint, quoteOut: bigint) {
  assert.equal(input.delta, -amountIn, "real input debit mismatch");
  assert.equal(input.after, input.before - amountIn, "old input inventory consumed");
  assert.equal(output.delta, quoteOut, "actual credited output differs from quote (inventory cannot top up)");
  assert.equal(output.after, output.before + quoteOut, "old output inventory consumed");
}

/** The same guard wraps the real production Exact/quoted calls in the runner. */
export function constructionGuard() {
  let building = false;
  const counts = { exact: 0, quoted: 0, forbiddenDuringBuild: 0 };
  const check = () => { if (building) { counts.forbiddenDuringBuild++; throw new Error("Exact/quoted/RPC forbidden during runtime build"); } };
  return { counts, check,
    exact<T>(f: () => T): T { check(); counts.exact++; return f(); },
    quoted<T>(f: () => T): T { check(); counts.quoted++; return f(); },
    build<T>(f: () => T): T { assert(!building); building = true; try { return f(); } finally { building = false; } },
    runtime<T extends object>(runtime: T): T { return new Proxy(runtime, { get(target, key, receiver) {
      if (!["callerAuthority", "generationFence"].includes(String(key))) check(); return Reflect.get(target, key, receiver);
    } }); },
  };
}
