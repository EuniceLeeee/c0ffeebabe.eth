// Test-only original-call observer. Swap events may be zero for custom-delta hooks;
// bind the returned BalanceDelta to actual take() settlement, never whole-TX profit.
import assert from "node:assert/strict";
import { ethers } from "ethers";
import { ADDR } from "../../../../../shared/constants/addresses.js";

export const SAT1_SAMPLE = {
  tx: "0x0be85b68578d45e449cf2285b2d331b8e3ed3f68240b3166e67abb2727f30b55",
  block: 26029537,
  hash: "0xf5a4024438b6f1066af6dd18bcbe765fef47ccde9265ecd748bdebab0268cab2",
  poolId: "0xc87e90621ca16da09311f57cd7ea8262a6f803f422699103e902593f31bd140f",
} as const;
export const SAT1_INSTANCE = `${ADDR.UNISWAP_V4_POOL_MANAGER.toLowerCase()}\u001f${SAT1_SAMPLE.poolId}`;
export const V4_OBSERVATION_ABI = new ethers.Interface([
  "function unlock(bytes) returns(bytes)",
  "function swap((address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) key,(bool zeroForOne,int256 amountSpecified,uint160 sqrtPriceLimitX96) params,bytes hookData) returns(int256)",
  "function take(address currency,address to,uint256 amount)",
  "function settle() payable returns(uint256)",
  "function settleFor(address recipient) payable returns(uint256)",
  "function sync(address currency)",
  "function balanceOf(address holder) view returns(uint256)",
  "function transfer(address to,uint256 amount) returns(bool)",
  "event Swap(bytes32 indexed id,address indexed sender,int128 amount0,int128 amount1,uint160 sqrtPriceX96,uint128 liquidity,int24 tick,uint24 fee)",
  "event Transfer(address indexed from,address indexed to,uint256 value)",
]);
const ABI = V4_OBSERVATION_ABI;
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const poolId = (key: readonly unknown[]) => ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(
  ["address", "address", "uint24", "int24", "address"], key));
const graph = (raw: string) => same(raw, ethers.ZeroAddress) ? ADDR.WETH.toLowerCase() : raw.toLowerCase();
const selector = (name: string) => ABI.getFunction(name)!.selector;

export function assertSat1Receipt(receipt: any): void {
  assert(receipt && same(receipt.transactionHash, SAT1_SAMPLE.tx) && BigInt(receipt.status) === 1n);
  assert.equal(Number(BigInt(receipt.blockNumber)), SAT1_SAMPLE.block); assert(same(receipt.blockHash, SAT1_SAMPLE.hash));
  for (const log of receipt.logs) {
    assert.equal(log.removed, false); assert(same(log.transactionHash, SAT1_SAMPLE.tx) && same(log.blockHash, SAT1_SAMPLE.hash));
    assert.equal(Number(BigInt(log.blockNumber)), SAT1_SAMPLE.block);
  }
  assert(receipt.logs.some((l: any) => same(l.address, ADDR.UNISWAP_V4_POOL_MANAGER) &&
    l.topics?.[0] === ABI.getEvent("Swap")!.topicHash && same(l.topics[1], SAT1_SAMPLE.poolId)));
}

export function originalV4Leg(instance: string, descriptor: {
  poolId: string; poolKey: { currency0: string; currency1: string; fee: number; tickSpacing: number; hooks: string };
  managerBinding: { manager: string };
}, receipt: any, trace: any, zeroForOne: boolean) {
  assert(!trace.error && !trace.revertReason && BigInt(receipt.status) === 1n);
  const manager = descriptor.managerBinding.manager.toLowerCase(), key = descriptor.poolKey;
  const id = descriptor.poolId;
  assert.equal(instance.toLowerCase(), `${manager}\u001f${id.toLowerCase()}`, "V4 instance is manager plus poolId, not poolId alone");
  assert(same(manager, ADDR.UNISWAP_V4_POOL_MANAGER));
  assert(same(poolId([key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks]), id));
  const frames: { frame: any; unlock: any; order: number; end: number }[] = [];
  const walk = (frame: any, unlock: any = null) => {
    if (!frame || frame.error || frame.revertReason) return;
    if (frame.type === "CALL" && same(frame.to ?? "", manager) && frame.input?.startsWith(selector("unlock"))) unlock = frame;
    const row = { frame, unlock, order: frames.length, end: 0 }; frames.push(row);
    for (const child of frame.calls ?? []) walk(child, unlock);
    row.end = frames.length;
  };
  walk(trace);
  const isCall = (f: any, to: string, name: string) => f.type === "CALL" && same(f.to ?? "", to) && f.input?.startsWith(selector(name));
  const swaps = frames.filter(({ frame: f }) => {
    if (!isCall(f, manager, "swap")) return false;
    const a = ABI.decodeFunctionData("swap", f.input);
    return same(poolId(a.key), id) && a.params.zeroForOne === zeroForOne;
  });
  assert.equal(swaps.length, 1, "exactly one successful original swap for this pool and direction");
  const { frame: swap, unlock, end } = swaps[0]!;
  assert(unlock && same(unlock.from, swap.from), "swap must bind its caller's unlock");
  const args = ABI.decodeFunctionData("swap", swap.input), specified = BigInt(args.params.amountSpecified);
  assert(specified < 0n); assert.equal(BigInt(swap.value ?? "0x0"), 0n);
  const packed = BigInt.asUintN(256, BigInt(ABI.decodeFunctionResult("swap", swap.output)[0]));
  const deltas = [BigInt.asIntN(128, packed >> 128n), BigInt.asIntN(128, packed)];
  const inputIndex = zeroForOne ? 0 : 1, outputIndex = 1 - inputIndex;
  const amountIn = -deltas[inputIndex]!, amountOut = deltas[outputIndex]!;
  assert(amountIn > 0n && amountOut > 0n); assert.equal(amountIn, -specified, "original full-input spend required");
  const raw = [key.currency0, key.currency1], rawIn = raw[inputIndex]!, rawOut = raw[outputIndex]!;
  const scope = frames.filter(x => x.unlock === unlock);
  assert.equal(scope.filter(x => isCall(x.frame, manager, "swap") && same(x.frame.from, swap.from)).length, 1,
    "aggregated same-caller swaps need a separate settlement observer");
  const takes = scope.filter(x => isCall(x.frame, manager, "take") && same(x.frame.from, swap.from));
  const matches = takes.filter(x => { const a = ABI.decodeFunctionData("take", x.frame.input);
    return x.order >= end && same(a.currency, rawOut) && a.amount === amountOut; });
  assert.equal(matches.length, 1, "returned credit must bind one later caller take");
  const take = matches[0]!.frame, recipient = String(ABI.decodeFunctionData("take", take.input).to);
  const payments = (take.calls ?? []).filter((f: any) => !f.error && !f.revertReason);
  if (same(rawOut, ethers.ZeroAddress)) {
    assert.equal(payments.filter((f: any) => f.type === "CALL" && same(f.from ?? "", manager) && same(f.to ?? "", recipient) &&
      f.input === "0x" && BigInt(f.value ?? "0x0") === amountOut).length, 1, "native take must actually pay the recipient");
  } else {
    const transfers = payments.filter((f: any) => isCall(f, rawOut, "transfer") && same(f.from, manager)).filter((f: any) => {
      const a = ABI.decodeFunctionData("transfer", f.input); return same(a.to, recipient) && a.amount === amountOut;
    });
    assert.equal(transfers.length, 1); assert.equal(ABI.decodeFunctionResult("transfer", transfers[0].output)[0], true);
    const logs = receipt.logs.filter((l: any) => same(l.address, rawOut) && l.topics?.[0] === ABI.getEvent("Transfer")!.topicHash)
      .map((l: any) => ABI.parseLog(l)!.args);
    assert.equal(logs.filter((l: any) => same(l.from, manager) && same(l.to, recipient) && l.value === amountOut).length, 1);
  }
  const settles = scope.filter(x => isCall(x.frame, manager, "settle") && same(x.frame.from, swap.from) &&
    BigInt(ABI.decodeFunctionResult("settle", x.frame.output)[0]) === amountIn);
  assert.equal(settles.length, 1, "original debit must settle for the swap caller");
  if (same(rawIn, ethers.ZeroAddress)) assert.equal(BigInt(settles[0]!.frame.value), amountIn);
  else {
    assert.equal(BigInt(settles[0]!.frame.value ?? "0x0"), 0n);
    const sync = scope.filter(x => x.order < settles[0]!.order && isCall(x.frame, manager, "sync")).at(-1);
    assert(sync && same(sync.frame.from, swap.from) && same(ABI.decodeFunctionData("sync", sync.frame.input).currency, rawIn),
      "active synchronization must bind the input currency and caller");
    assert.equal(scope.filter(x => x.order >= sync.end && x.order < settles[0]!.order &&
      (isCall(x.frame, manager, "settle") || isCall(x.frame, manager, "settleFor"))).length, 0,
      "a synchronization already consumed by another settlement is not current input evidence");
    const observedManagerBalance = (parent: any) => {
      const reads = (parent.calls ?? []).filter((f: any) => !f.error && !f.revertReason && f.type === "STATICCALL" &&
        same(f.from ?? "", manager) && same(f.to ?? "", rawIn) && f.input?.startsWith(selector("balanceOf")) &&
        same(ABI.decodeFunctionData("balanceOf", f.input).holder, manager));
      assert.equal(reads.length, 1, "settlement requires actual manager balance observations");
      return BigInt(ABI.decodeFunctionResult("balanceOf", reads[0].output)[0]);
    };
    assert.equal(observedManagerBalance(settles[0]!.frame) - observedManagerBalance(sync.frame), amountIn);
    assert.equal(scope.filter(x => x.order >= sync.end && x.end <= settles[0]!.order && isCall(x.frame, rawIn, "transfer") && same(x.frame.from, swap.from))
      .filter(x => { const a = ABI.decodeFunctionData("transfer", x.frame.input);
        return same(a.to, manager) && a.amount === amountIn && ABI.decodeFunctionResult("transfer", x.frame.output)[0] === true; }).length, 1);
    const transfers = receipt.logs.filter((l: any) => same(l.address, rawIn) && l.topics?.[0] === ABI.getEvent("Transfer")!.topicHash)
      .map((l: any) => ABI.parseLog(l)!.args);
    assert.equal(transfers.filter((l: any) => same(l.from, swap.from) && same(l.to, manager) && l.value === amountIn).length, 1,
      "input transfer must be present in the successful receipt");
  }
  const swapsInReceipt = receipt.logs.filter((l: any) => same(l.address, manager) && l.topics?.[0] === ABI.getEvent("Swap")!.topicHash && same(l.topics[1], id))
    .map((l: any) => ABI.parseLog(l)!.args).filter((a: any) => same(a.sender, swap.from));
  assert.equal(swapsInReceipt.length, 1);
  if (same(key.hooks, ethers.ZeroAddress)) {
    assert.equal(swapsInReceipt[0].amount0, deltas[0]); assert.equal(swapsInReceipt[0].amount1, deltas[1]);
  }
  return { tokenIn: graph(rawIn), tokenOut: graph(rawOut), amountIn, amountOut, caller: swap.from.toLowerCase(), recipient: recipient.toLowerCase(),
    originalInterface: "PoolManager.swap+settle+take", comparison: "actual original take payment; N-end execution is NOT original pre-call replay",
    originalOutputAsset: same(rawOut, ethers.ZeroAddress) ? "native-ETH" : rawOut.toLowerCase() };
}
