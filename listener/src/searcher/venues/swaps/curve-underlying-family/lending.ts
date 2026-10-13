import { ethers } from "ethers";
import type { AdapterRequest, AdapterRequestResult, CanonicalSource, RequestRequirements } from "../../adapter-request-program.js";
import { assertSameSource, canonicalAddress, requireSuccessfulResult, sameAddress } from "./codec.js";
import type { CurveUnderlyingLendingBinding } from "./types.js";

// Bound executable semantics, never a pool-address membership list. Each pool
// must also reverse-bind its private LP token and every wrapper's underlying.
export const LENDING_POOL_CODE_HASHES = {
  "legacy-dtoken-four": "0xd8fb8e75d76c5d00a7c3957ade802de43381f994e28ab7ffd155d748167aaf9b",
  "legacy-yvault-four": "0x6a9d8cf975fffdf7d2a7a1fc50cb3aae54f92676e3810d63a01f09a64b63b707",
} as const;
export const LENDING_LP_CODE_HASH = "0xcb1d74e22245d0cf403f0be2b26f91d1eeaa0236c94bfaeca3673392aa1b1170";
export const LENDING_LOOKUP = "pool-token+lp-minter+wrapper-token" as const;
// Deployed bytecode binds these private slots (pool compiler beta17, LP beta16).
// Both pool implementations read token at slot 7; the bound LP reads minter at 6.
export const LENDING_LP_SLOT = ethers.toBeHex(7, 32);
export const LENDING_MINTER_SLOT = ethers.toBeHex(6, 32);
export const LENDING_ABI = new ethers.Interface([
  "function coins(int128) view returns(address)",
  "function underlying_coins(int128) view returns(address)",
  "function balances(int128) view returns(uint256)",
  "function token() view returns(address)",
  "function decimals() view returns(uint256)",
  "function approve(address,uint256) returns(bool)",
  "function exchange_underlying(int128,int128,uint256,uint256)",
]);
const caller = { kind: "executor" as const };
export const lendingSimulationRequirements: RequestRequirements = {
  transports: ["effect-delta-simulation"], caller: "executor",
  effects: ["return-data", "revert-data", "token-delta", "native-delta"],
};
export function lendingKind(code: string): CurveUnderlyingLendingBinding["kind"] | undefined {
  if (!ethers.isHexString(code) || code === "0x") return undefined;
  const hash = ethers.keccak256(code);
  return (Object.keys(LENDING_POOL_CODE_HASHES) as CurveUnderlyingLendingBinding["kind"][])
    .find(kind => LENDING_POOL_CODE_HASHES[kind] === hash);
}
export function lendingAddress(data: string): string {
  if (!ethers.isHexString(data, 32) || BigInt(data) >> 160n !== 0n) throw new Error("lending noncanonical address word");
  const value = canonicalAddress(ethers.dataSlice(data, 12));
  if (value === ethers.ZeroAddress) throw new Error("lending zero address");
  return value;
}
export function lendingUint(data: string): bigint {
  if (!ethers.isHexString(data, 32)) throw new Error("lending noncanonical uint256 word");
  return BigInt(data);
}
export function lendingCall(id: string, to: string, name: string, args: readonly unknown[] = []): AdapterRequest {
  return { id, kind: "eth-call", to, data: LENDING_ABI.encodeFunctionData(name, args), completion: "return-data" };
}
export function lendingPoolRequests(pool: string): readonly AdapterRequest[] {
  return [
    { id: "lending-pool-code", kind: "get-code", address: pool },
    { id: "lending-lp", kind: "get-storage", address: pool, slot: LENDING_LP_SLOT },
    ...[0, 1, 2, 3].flatMap(i => [
      lendingCall("lending-coin:" + i, pool, "coins", [i]),
      lendingCall("lending-underlying:" + i, pool, "underlying_coins", [i]),
    ]),
  ];
}
export function lendingWrapperRequests(binding: CurveUnderlyingLendingBinding): readonly AdapterRequest[] {
  return [
    { id: "lending-lp-code", kind: "get-code", address: binding.lpToken },
    { id: "lending-minter", kind: "get-storage", address: binding.lpToken, slot: LENDING_MINTER_SLOT },
    ...binding.wrappedCoins.flatMap((coin, i): AdapterRequest[] => [
      { id: "lending-wrapper-code:" + i, kind: "get-code", address: coin },
      lendingCall("lending-wrapper-token:" + i, coin, "token"),
    ]),
  ];
}
export function lendingGuardRequests(pool: string, binding: CurveUnderlyingLendingBinding): readonly AdapterRequest[] {
  assertLendingBinding(binding);
  return [...lendingPoolRequests(pool), ...lendingWrapperRequests(binding)];
}
export function assertLendingBinding(binding: CurveUnderlyingLendingBinding): void {
  if (!(binding.kind in LENDING_POOL_CODE_HASHES) || binding.poolCodeHash !== LENDING_POOL_CODE_HASHES[binding.kind] ||
      binding.lpCodeHash !== LENDING_LP_CODE_HASH || binding.wrappedCoins.length !== 4 || binding.wrapperCodeHashes.length !== 4 ||
      new Set(binding.wrappedCoins.map(c => canonicalAddress(c).toLowerCase())).size !== 4 ||
      binding.wrapperCodeHashes.some(h => !ethers.isHexString(h, 32))) throw new Error("lending unsupported binding");
  canonicalAddress(binding.lpToken);
}
export function assertLendingGuards(pool: string, coins: readonly string[], binding: CurveUnderlyingLendingBinding,
  source: CanonicalSource, results: readonly AdapterRequestResult[]): void {
  assertLendingBinding(binding);
  const reads = lendingGuardRequests(pool, binding).map(r => requireSuccessfulResult(results, r.id));
  assertSameSource(reads);
  for (const read of reads) assertLendingSource(read.source, source);
  const data = (id: string) => requireSuccessfulResult(results, id).data;
  if (coins.length !== 4 || new Set(coins.map(c => canonicalAddress(c).toLowerCase())).size !== 4 ||
      lendingKind(data("lending-pool-code")) !== binding.kind ||
      !sameAddress(lendingAddress(data("lending-lp")), binding.lpToken) ||
      ethers.keccak256(data("lending-lp-code")) !== binding.lpCodeHash ||
      !sameAddress(lendingAddress(data("lending-minter")), pool)) throw new Error("lending LP reverse binding changed");
  for (let i = 0; i < 4; i++) {
    if (sameAddress(coins[i], binding.wrappedCoins[i]) ||
        !sameAddress(lendingAddress(data("lending-coin:" + i)), binding.wrappedCoins[i]) ||
        !sameAddress(lendingAddress(data("lending-underlying:" + i)), coins[i]) ||
        !sameAddress(lendingAddress(data("lending-wrapper-token:" + i)), coins[i]) ||
        ethers.keccak256(data("lending-wrapper-code:" + i)) !== binding.wrapperCodeHashes[i])
      throw new Error("lending wrapper reverse binding changed");
  }
}
export function lendingProjection(binding?: CurveUnderlyingLendingBinding) {
  return binding ? { ...binding, wrappedCoins: [...binding.wrappedCoins], wrapperCodeHashes: [...binding.wrapperCodeHashes] } : null;
}
export function assertLendingSource(actual: CanonicalSource, expected: CanonicalSource): void {
  if (actual.number !== expected.number || actual.generation !== expected.generation ||
      actual.hash.toLowerCase() !== expected.hash.toLowerCase()) throw new Error("lending foreign source");
}
export function lendingSwapRequest(input: {
  readonly id: string; readonly pool: string; readonly tokenIn: string; readonly tokenOut: string;
  readonly i: number; readonly j: number; readonly amountIn: bigint;
}): AdapterRequest {
  if (input.amountIn <= 0n || input.amountIn > (1n << 256n) - 1n || input.i === input.j ||
      !Number.isInteger(input.i) || !Number.isInteger(input.j) ||
      input.i < 0 || input.j < 0 || input.i >= 4 || input.j >= 4 || sameAddress(input.tokenIn, input.tokenOut))
    throw new Error("lending invalid swap input");
  return {
    id: input.id, kind: "effect-delta-simulation",
    // Clear first: the production standing-grant policy may leave an allowance.
    // These calls and the swap share the existing isolated simulation state.
    preCalls: [0n, input.amountIn].map(amount => ({ caller, to: input.tokenIn,
      data: LENDING_ABI.encodeFunctionData("approve", [input.pool, amount]) })),
    call: { caller, executionMode: "impersonated-call-frame", to: input.pool,
      data: LENDING_ABI.encodeFunctionData("exchange_underlying", [input.i, input.j, input.amountIn, 1n]) },
    overrideIntent: { caller, tokenBalances: [{ token: input.tokenIn, amount: input.amountIn }] },
    observeTokenBalances: [{ token: input.tokenIn, account: caller }, { token: input.tokenOut, account: caller }],
    observe: ["return-data", "revert-data", "token-delta", "native-delta"],
  };
}
/** The pool deposits input into its wrapper and redeems output shares. Its
 * get_dy_underlying omits execution rounding and redemption effects; the output
 * transfer also sweeps existing pool cash. Read caller deltas from production
 * simulation, never a precomputed view amount or injected output balance. */
export function decodeLendingSwap(input: {
  readonly pool: string; readonly coins: readonly string[]; readonly binding: CurveUnderlyingLendingBinding;
  readonly i: number; readonly j: number; readonly amountIn: bigint; readonly source: CanonicalSource;
  readonly executor?: string;
}, read: AdapterRequestResult): bigint | null {
  if (!read.ok) throw new Error("lending unresolved simulation: " + read.failure);
  assertLendingSource(read.source, input.source);
  if (read.completion === "reverted-as-declared") return null;
  if (read.completion !== "returned" || read.data !== "0x") throw new Error("lending invalid execution return");
  const rows = read.effects?.tokenDeltas, native = read.effects?.nativeDeltas;
  if (rows?.length !== 2 || native?.length !== 1) throw new Error("lending missing caller deltas");
  const debit = rows.filter(r => sameAddress(r.token, input.coins[input.i]));
  const credit = rows.filter(r => sameAddress(r.token, input.coins[input.j]));
  if (debit.length !== 1 || credit.length !== 1 || !sameAddress(debit[0].account, credit[0].account) ||
      !sameAddress(debit[0].account, native[0].account) || native[0].delta !== 0n ||
      (input.executor !== undefined && !sameAddress(debit[0].account, input.executor)) ||
      [ethers.ZeroAddress, input.pool, input.binding.lpToken, ...input.coins, ...input.binding.wrappedCoins]
        .some(a => sameAddress(a, debit[0].account)) ||
      debit[0].delta !== -input.amountIn || credit[0].delta <= 0n)
    throw new Error("lending incomplete input debit or output receipt");
  return credit[0].delta;
}
