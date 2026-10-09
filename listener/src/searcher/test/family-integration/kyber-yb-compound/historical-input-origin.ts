// Read-only inspection of the two saved real receipts/traces. No RPC, pricing,
// graph construction, admission or execution; this is not a new replay pipeline.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { ethers } from "ethers";
import { LT_INTERFACE as LT } from "../../../venues/protocols/yieldbasis-lt-family/abi.js";
import { CTOKEN_INTERFACE as CT } from "../../../venues/protocols/compound-ctoken-family/abi.js";
import { SAMPLES, ERC20, assertReceipt, originalLeg, same, sha, json } from "./evidence.js";

const TOKEN_CALL = new ethers.Interface([
  "function transferFrom(address from,address to,uint256 amount) returns(bool)",
  "function transfer(address to,uint256 amount) returns(bool)",
]);
const lower = (s: string) => ethers.getAddress(s).toLowerCase();
type Frame = { frame: any; ancestors: any[] };
type Transfer = { from: string; to: string; value: bigint; index: bigint };

export function successfulFrames(trace: any): Frame[] {
  const result: Frame[] = [];
  const walk = (frame: any, ancestors: any[]) => {
    if (!frame || frame.error || frame.revertReason) return;
    if (frame.type === "CALL") result.push({ frame, ancestors });
    for (const child of frame.calls ?? []) walk(child, [...ancestors, frame]);
  };
  walk(trace, []); return result;
}
const one = <T>(xs: T[], reason: string): T => { assert.equal(xs.length, 1, reason); return xs[0]!; };
function transfers(receipt: any, token: string): Transfer[] {
  return receipt.logs.filter((l: any) => same(l.address, token) &&
    same(l.topics?.[0] ?? "", ERC20.getEvent("Transfer")!.topicHash)).map((l: any) => {
    const t = ERC20.parseLog(l)!.args;
    return { from: lower(t.from), to: lower(t.to), value: BigInt(t.value), index: BigInt(l.logIndex) };
  });
}
function transferCall(frame: any) {
  const p = TOKEN_CALL.parseTransaction({ data: frame.input });
  assert(p && (p.name === "transferFrom" || p.name === "transfer"));
  assert(frame.output === "0x" || TOKEN_CALL.decodeFunctionResult(p.name, frame.output)[0] === true,
    "failed ERC20 transfer is not input evidence");
  return { token: lower(frame.to), from: lower(p.name === "transferFrom" ? p.args.from : frame.from),
    to: lower(p.args.to), amount: BigInt(p.args.amount) };
}

/** For the ordinary deposit→withdraw sample, distinguish a protocol-owned
 * stablecoin payer from a second caller-funded input. This does NOT prove a
 * deposit quote, an amount/debt policy, arbitrary variants or runtime encoding. */
export function observeYbInput(receipt: any, trace: any, target: string, asset: string) {
  assert(!trace.error && !trace.revertReason);
  const call = one(successfulFrames(trace).filter(({ frame: f }) => same(f.to, target) &&
    f.input?.slice(0, 10) === LT.getFunction("deposit(uint256,uint256,uint256)")!.selector),
    "one unambiguous successful ordinary deposit required").frame;
  const caller = lower(call.from), data = LT.decodeFunctionData("deposit(uint256,uint256,uint256)", call.input);
  const shares = BigInt(LT.decodeFunctionResult("deposit(uint256,uint256,uint256)", call.output)[0]);
  const assets = BigInt(data[0]), debt = BigInt(data[1]);
  assert(assets > 0n && debt > 0n && shares > 0n && shares >= BigInt(data[2]));
  assert(BigInt(call.value ?? "0x0") === 0n, "unexpected native caller input");
  const pulls = successfulFrames(call).filter(({ frame: f, ancestors }) => ancestors.length === 1 &&
    f.input?.slice(0, 10) === TOKEN_CALL.getFunction("transferFrom")!.selector).map(({ frame }) => transferCall(frame));
  assert.equal(pulls.length, 2, "unexpected direct input transfers");
  const assetPull = one(pulls.filter(p => same(p.token, asset) && p.from === caller && same(p.to, target) && p.amount === assets),
    "asset must be paid by the caller");
  const stablePull = one(pulls.filter(p => !same(p.token, asset) && same(p.to, target) && p.amount === debt),
    "one stablecoin debt transfer required");
  assert(stablePull.from !== caller, "sample requires a second caller-funded input");
  const eventLog = one(receipt.logs.filter((l: any) => same(l.address, target) &&
    same(l.topics?.[0] ?? "", LT.getEvent("Deposit")!.topicHash)), "one Deposit event required") as any;
  const e = LT.parseLog(eventLog)!.args;
  assert(same(e.sender, caller) && same(e.owner, caller)); assert.equal(e.assets, assets); assert.equal(e.shares, shares);
  for (const p of [assetPull, stablePull]) {
    one(transfers(receipt, p.token).filter(t => t.from === p.from && t.to === p.to && t.value === p.amount &&
      t.index < BigInt(eventLog.logIndex)), "input trace must match its own receipt transfer");
  }
  one(transfers(receipt, target).filter(t => t.from === ethers.ZeroAddress && t.to === caller && t.value === shares &&
    t.index < BigInt(eventLog.logIndex)), "deposit must mint the observed shares to caller");
  const withdraw = originalLeg("yb", target, { share: target, asset }, receipt, trace);
  assert.equal(withdraw.amountIn, shares); assert(same(withdraw.caller, caller));
  assert(BigInt(withdraw.logIndex) > BigInt(eventLog.logIndex), "withdraw must follow deposit");
  return { caller, target: lower(target), assetInput: assetPull, protocolStableInput: stablePull,
    mintedAndWithdrawnShares: shares, withdrawnAssets: withdraw.amountOut,
    claim: "this sample pays crypto from caller and stablecoin from a different protocol account; deposit is currently unimplemented, not disproved by a two-caller-input claim" };
}

/** A nested cToken redemption does not establish that the outer searcher ever
 * acquired cTokens. Keep the wrapper's shares separate from its held cTokens. */
export function observeCompoundInput(receipt: any, trace: any, markets: { share: string; underlying: string }[]) {
  assert(!trace.error && !trace.revertReason);
  const executor = lower(trace.to), frames = successfulFrames(trace);
  return markets.map(({ share, underlying }) => {
    const leg = originalLeg("compound", share, { share, underlying }, receipt, trace);
    assert.notEqual(leg.caller, executor, "sample is direct, not a nested wrapper redemption");
    const row = one(frames.filter(({ frame: f }) => same(f.to, share) && same(f.from, leg.caller) &&
      f.input?.slice(0, 10) === CT.getFunction("redeemUnderlying")!.selector), "one nested redeemUnderlying required");
    const ancestor = one(row.ancestors.filter(f => f.type === "CALL" && same(f.to, leg.caller) && same(f.from, executor)),
      "redeemer must be called by the searcher in the same ancestor chain");
    const wrapperTransfers = transfers(receipt, leg.caller);
    const burn = one(wrapperTransfers.filter(t => t.from === executor && t.to === ethers.ZeroAddress && t.value > 0n),
      "wrapper shares must actually burn");
    assert.equal(BigInt("0x" + ancestor.input.slice(10, 74)), burn.value, "wrapper input argument/burn mismatch");
    const receives = wrapperTransfers.filter(t => t.to === executor && t.value > 0n && t.index < burn.index);
    assert(receives.length > 0, "wrapper acquisition missing");
    const receivedShares = receives.reduce((sum, t) => sum + t.value, 0n);
    assert(receivedShares <= burn.value, "sample input attribution is ambiguous");
    const forwarded = one(successfulFrames(ancestor).filter(({ frame: f }) => same(f.to, underlying) &&
      same(f.from, leg.caller) && f.input?.slice(0, 10) === TOKEN_CALL.getFunction("transfer")!.selector)
      .map(({ frame }) => transferCall(frame)).filter(p => p.to === executor && p.amount === leg.amountOut),
      "wrapper must forward actual underlying to the searcher");
    one(transfers(receipt, underlying).filter(t => t.from === leg.caller && t.to === executor &&
      t.value === forwarded.amount && t.index > burn.index), "wrapper output receipt mismatch");
    const searcherCTokenTransfers = transfers(receipt, share).filter(t => t.value > 0n && (t.from === executor || t.to === executor));
    assert.equal(searcherCTokenTransfers.length, 0, "searcher also touched cToken inventory; this sample classification is insufficient");
    return { market: lower(share), underlying: lower(underlying), redeemer: leg.caller, executor,
      wrapperSelector: ancestor.input.slice(0, 10), wrapperSharesBurned: burn.value,
      wrapperSharesReceivedInTx: receivedShares, unaccountedWrapperShareInput: burn.value - receivedShares,
      cTokenSharesBurned: leg.amountIn, underlyingForwarded: forwarded.amount, searcherCTokenTransfers: 0,
      claim: "nested cToken leg, not a direct searcher cToken acquisition; no whole-opportunity or wrapper support verdict" };
  });
}

export function inspectSavedInput(key: "yb" | "compound", saved: any) {
  const s = SAMPLES[key], { receipt, transaction, trace } = saved.original;
  assert.equal(saved.family, s.family); assert.equal(saved.source.number, s.number);
  assertReceipt(receipt, s.tx, saved.environment);
  assert.equal(sha(json(receipt)), saved.original.receiptSha256); assert.equal(sha(json(trace)), saved.original.traceSha256);
  assert(same(transaction.hash, s.tx) && same(transaction.blockHash, receipt.blockHash));
  assert(same(trace.from, transaction.from) && same(trace.to, transaction.to) && trace.input === transaction.input);
  if (key === "yb") return observeYbInput(receipt, trace, s.instances[0], saved.samples[0].tokenOut);
  return observeCompoundInput(receipt, trace, SAMPLES.compound.instances.map(share => {
    const sample: any = one(saved.samples.filter((x: any) => same(x.instance, share)), "missing saved market");
    return { share, underlying: sample.tokenOut as string };
  }));
}

function main(argv: string[]) {
  const args = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 2) {
    assert(["--yb", "--compound", "--out"].includes(argv[i]!) && !args.has(argv[i]!) && argv[i + 1] && !argv[i + 1]!.startsWith("--"));
    args.set(argv[i]!, argv[i + 1]!);
  }
  assert.equal(args.size, 3);
  const expected = { yb: "424e1aeed40d8c3db032647bdd3de3e472ea9da2c9e09c259854e3417d0c023a",
    compound: "c263bda18a1208273e1fbbf30819bab42e875da3290e8744cf0bc62365424e30" };
  const findings = Object.fromEntries((["yb", "compound"] as const).map(key => {
    const bytes = readFileSync(args.get("--" + key)!); assert.equal(sha(bytes), expected[key], "not the frozen historical evidence artifact");
    return [key, { evidenceSha256: sha(bytes), observation: inspectSavedInput(key, JSON.parse(bytes.toString())) }];
  }));
  const result = { schema: "four-family-input-origin-v1", evidenceMode: "saved-real-receipt-and-trace",
    rpcCalls: 0, newEvmExecutions: 0, ...findings,
    limitations: "sample input attribution only; no new admission, production amount, deposit implementation, whole-route profitability or latency verdict" };
  writeFileSync(args.get("--out")!, json(result) + "\n", { flag: "wx", mode: 0o600 });
  console.log(json(result));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv.slice(2));
