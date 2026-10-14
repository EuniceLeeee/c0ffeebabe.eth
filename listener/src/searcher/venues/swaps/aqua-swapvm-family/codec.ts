import { ethers } from "ethers";
import type { AdapterRequest, AdapterRequestResult, CanonicalSource } from "../../adapter-request-program.js";
import { callRequest, codeRequest, returnedResult, assertSameSource, assertSource } from "../../protocols/standard-family/common.js";
import type { Binding, Order, State } from "./types.js";
export const ORDER = "tuple(address maker,uint256 traits,bytes data)";
export const ABI = new ethers.Interface([
  `function hash(${ORDER}) view returns(bytes32)`, "function AQUA() view returns(address)",
  `function quote(${ORDER},address tokenIn,address tokenOut,uint256 amount,bytes takerTraitsAndData) returns(uint256 amountIn,uint256 amountOut,bytes32 orderHash)`,
  `function swap(${ORDER},address tokenIn,address tokenOut,uint256 amount,bytes takerTraitsAndData) returns(uint256 amountIn,uint256 amountOut,bytes32 orderHash)`,
  "function ship(address app,bytes strategy,address[] tokens,uint256[] amounts) returns(bytes32)",
  "event Shipped(address maker,address app,bytes32 strategyHash,bytes strategy)",
  "event Swapped(bytes32 orderHash,address maker,address taker,address tokenIn,address tokenOut,uint256 amountIn,uint256 amountOut)",
  "function rawBalances(address maker,address app,bytes32 strategyHash,address token) view returns(uint248 balance,uint8 tokensCount)",
  "function balanceOf(address) view returns(uint256)", "function allowance(address,address) view returns(uint256)",
  "function decimals() view returns(uint8)", "function approve(address,uint256) returns(bool)",
]);
// Infrastructure identity source, not a strategy/maker/pool admission list.
export const AQUA = "0x1111113ccf1426a8e30e2bff5e005d929bf6a90a";
// Exact deployed v1.0 runtime, independently matched to verified Sourcify source.
// Current upstream uses a different ABI/opcode bank and is not this profile.
export const CODE_HASH = "0x1ffc57300722e5a2c523b5131e17c01950f447718449e1c9fd2ab382b3e340f9";
export const AQUA_TRAITS = 1n << 254n;
const coder = ethers.AbiCoder.defaultAbiCoder();
export function address(v: string): string {
  const a = ethers.getAddress(v).toLowerCase(); if (a === ethers.ZeroAddress) throw new Error("aqua zero address"); return a;
}
export function amount(v: bigint, zero = false): bigint {
  if (typeof v !== "bigint" || v < (zero ? 0n : 1n) || v > ethers.MaxUint256) throw new Error("aqua uint256 amount"); return v;
}
export function order(v: Order): Order {
  const traits = amount(BigInt(v.traits), true).toString();
  if (!ethers.isHexString(v.data, true) || ethers.dataLength(v.data) > 4096) throw new Error("aqua malformed order data");
  return { maker: address(v.maker), traits, data: v.data.toLowerCase() };
}
export const encodeOrder = (o: Order) => coder.encode([ORDER], [order(o)]);
export const orderHash = (o: Order) => ethers.keccak256(encodeOrder(o));
export function decodeOrder(data: string): Order {
  const [o] = coder.decode([ORDER], data), result = order({ maker: o.maker, traits: o.traits.toString(), data: o.data });
  if (encodeOrder(result).toLowerCase() !== data.toLowerCase()) throw new Error("aqua noncanonical strategy"); return result;
}
/** Narrow proven v1 strategy grammar. No hooks, signatures, external fee code,
 * origin credentials, time dependence, token overrides or arbitrary jumps. */
export function profile(o: Order): { feeBps: number } | null {
  if (BigInt(o.traits) !== AQUA_TRAITS) return null;
  const b = ethers.getBytes(o.data); let pc = 0;
  function instruction(op: number, length?: number): Uint8Array | null {
    if (pc + 2 > b.length || b[pc] !== op) return null;
    const n = b[pc + 1]; if (length !== undefined && n !== length || pc + 2 + n > b.length) return null;
    const args = b.slice(pc + 2, pc + 2 + n); pc += 2 + n; return args;
  }
  const concentration = instruction(18, 64); if (!concentration) return null;
  const lower = BigInt(ethers.hexlify(concentration.slice(0, 32))), upper = BigInt(ethers.hexlify(concentration.slice(32)));
  if (lower === 0n || upper <= lower) return null;
  const fee = instruction(21, 4); if (!fee) return null;
  const feeRaw = BigInt(ethers.hexlify(fee)); if (feeRaw >= 1_000_000_000n) return null;
  if (!instruction(17, 0) || !instruction(20) || pc !== b.length) return null;
  return { feeBps: Number(feeRaw) / 100000 };
}
export function binding(router: string, o: Order, tokens: readonly string[]): Binding {
  const r = address(router), normalized = order(o), t = tokens.map(address).sort();
  if (t.length !== 2 || new Set([r, AQUA, normalized.maker, ...t]).size !== 5) throw new Error("aqua distinct strategy pair required");
  return { router: r, aqua: AQUA, order: normalized, strategyHash: orderHash(normalized), tokens: [t[0], t[1]], codeHash: CODE_HASH };
}
export const key = (b: Binding) => `${b.router}:${b.order.maker}:${b.strategyHash}:${b.tokens.join(":")}`;
export function takerData(minimum: bigint, options: { recipient?: string; callbackScript?: Uint8Array } = {}): string {
  amount(minimum, true);
  // Default bytes remain 0x61: exact input, input first, router transferFrom + Aqua.push.
  // 0x45 releases output first, then calls the taker before the same router push.
  let header = options.callbackScript === undefined ? 0x61n : 0x45n;
  // The packed TakerTraits callback slice has no preceding length. Wrap the VM
  // script as ABI bytes so both incoming/outgoing VM offsets have a length word.
  const callback = options.callbackScript === undefined ? "0x" : coder.encode(["bytes"], [options.callbackScript]);
  const slices = [ethers.toBeHex(minimum, 32), options.recipient === undefined ? "0x" : address(options.recipient),
    "0x", "0x", "0x", "0x", "0x", callback, "0x", "0x"];
  let end = 0;
  for (let i = 0; i < slices.length; i++) {
    end += ethers.dataLength(slices[i]!);
    if (end > 65535) throw new Error("aqua taker slice length");
    header |= BigInt(end) << BigInt(16 + 16 * i);
  }
  return ethers.concat([ethers.toBeHex(header, 22), ...slices]);
}
export const call = (id: string, to: string, fn: string, args: readonly unknown[] = []) => callRequest(id, to, ABI.encodeFunctionData(fn, args));
export function read(rs: readonly AdapterRequestResult[], id: string, fn: string) {
  const data = returnedResult(rs, id).data, values = ABI.decodeFunctionResult(fn, data);
  if (ABI.encodeFunctionResult(fn, values).toLowerCase() !== data.toLowerCase()) throw new Error("aqua noncanonical return"); return values;
}
export function sourceOf(rs: readonly AdapterRequestResult[], expected?: CanonicalSource): CanonicalSource {
  const s = assertSameSource(rs.map(r => returnedResult(rs, r.id)));
  if (new Set(rs.map(r => r.id)).size !== rs.length) throw new Error("aqua duplicate result");
  if (expected) assertSource(s, expected); return s;
}
export function stateRequests(b: Binding): readonly AdapterRequest[] {
  return [codeRequest("router-code", b.router), codeRequest("aqua-code", AQUA), call("aqua", b.router, "AQUA"),
    call("hash", b.router, "hash", [b.order]), ...b.tokens.flatMap((t, i) => [
      codeRequest(`token-code:${i}`, t), call(`decimals:${i}`, t, "decimals"),
      call(`raw:${i}`, AQUA, "rawBalances", [b.order.maker, b.router, b.strategyHash, t]),
      call(`balance:${i}`, t, "balanceOf", [b.order.maker]), call(`allowance:${i}`, t, "allowance", [b.order.maker, AQUA]),
    ])];
}
export function decodeState(b: Binding, rs: readonly AdapterRequestResult[], expected?: CanonicalSource): State {
  const source = sourceOf(rs, expected);
  if (!profile(b.order) || ethers.keccak256(returnedResult(rs, "router-code").data) !== CODE_HASH ||
      address(read(rs, "aqua", "AQUA")[0]) !== AQUA || returnedResult(rs, "aqua-code").data === "0x" ||
      read(rs, "hash", "hash")[0].toLowerCase() !== b.strategyHash) throw new Error("aqua runtime/order/registry mismatch");
  const raw = b.tokens.map((_, i) => read(rs, `raw:${i}`, "rawBalances"));
  const active = raw.every(x => x[1] === 2n);
  const decimals = b.tokens.map((_, i) => {
    const d = BigInt(read(rs, `decimals:${i}`, "decimals")[0]);
    if (d > 77n || returnedResult(rs, `token-code:${i}`).data === "0x") throw new Error("aqua unsupported token metadata"); return d;
  });
  const balances = raw.map(x => BigInt(x[0]));
  const capacities = balances.map((balance, i) => [balance, BigInt(read(rs, `balance:${i}`, "balanceOf")[0]),
    BigInt(read(rs, `allowance:${i}`, "allowance")[0])].reduce((a, c) => a < c ? a : c));
  return { source, active, balances, capacities, decimals };
}
export function quoteRequest(b: Binding, i: number, value: bigint, id = "quote"): AdapterRequest {
  amount(value); if (i !== 0 && i !== 1) throw new Error("aqua direction");
  return callRequest(id, b.router, ABI.encodeFunctionData("quote", [b.order, b.tokens[i], b.tokens[1-i], value, takerData(1n)]), { kind: "executor" });
}
export function quoteOutput(b: Binding, rs: readonly AdapterRequestResult[], input: bigint, capacity: bigint, id = "quote"): bigint {
  const v = read(rs, id, "quote"), out = amount(v[1]);
  if (v[0] !== input || v[2].toLowerCase() !== b.strategyHash || out > capacity) throw new Error("aqua quote amount/hash/capacity mismatch");
  return out;
}
