import { ethers } from "ethers";
import { RuntimeAmountProgram, runtimeProgramScript } from "../../../../adapters/runtime-amount-program.js";
import { buildSubscriptCalldata } from "../../../../shared/executor/botvm-program-entry.js";
import type { AdapterRequest, AdapterRequestResult, CanonicalSource, RequestRequirements } from "../../adapter-request-program.js";
import { runtimeExecutor } from "../../runtime-execution.js";
import { assertSource, callRequest, returnedResult, sameAddress } from "../standard-family/common.js";
import { CRYPTOPOOL_INTERFACE, LT_INTERFACE } from "./abi.js";

const TOKEN = new ethers.Interface([
  "function balanceOf(address) view returns(uint256)",
  "function approve(address,uint256) returns(bool)",
]);
const DEPOSIT = "deposit(uint256,uint256,uint256)";
export const DEPOSIT_DEBT_POLICY = "pool-balanced-v1" as const;
export const DEPOSIT_EFFECTS = ["return-data", "revert-data", "token-delta", "native-delta", "logs"] as const;
export const DEPOSIT_REQUIREMENTS: RequestRequirements = {
  transports: ["effect-delta-simulation"], caller: "executor", effects: DEPOSIT_EFFECTS,
};
export interface DepositSurface {
  readonly lt: string;
  readonly asset: string;
  readonly stablecoin: string;
  readonly cryptopool: string;
  readonly amm: string;
}
export interface DepositBalances {
  readonly stable: bigint;
  readonly asset: bigint;
}

/** One explicit policy, not a claim of optimal debt: contribute the same
 * stable/crypto ratio as the bound two-coin pool. Both values are raw units,
 * so 8/18-decimal assets need no guessed price/decimal conversion. LT pulls
 * the computed stablecoin from its AMM, never from the executor.
 *
 * The checked product deliberately matches the existing VM's uint256 math.
 * Do not allow a JS-only 512-bit intermediate that runtime cannot execute. */
export function balancedDepositDebt(assets: bigint, balances: DepositBalances): bigint {
  positive(assets); positive(balances.stable); positive(balances.asset);
  const product = assets * balances.stable;
  if (product > ethers.MaxUint256) throw new Error("Yield Basis deposit debt product overflows uint256");
  const debt = product / balances.asset;
  positive(debt); return debt;
}

function positive(n: bigint): void {
  if (typeof n !== "bigint" || n <= 0n || n > ethers.MaxUint256)
    throw new Error("Yield Basis deposit positive uint256 required");
}
function actorFor(s: DepositSurface, executor: string): string {
  const addresses = [s.lt, s.asset, s.stablecoin, s.cryptopool, s.amm].map(a => ethers.getAddress(a).toLowerCase());
  if (addresses.includes(ethers.ZeroAddress) || new Set(addresses).size !== addresses.length)
    throw new Error("Yield Basis deposit invalid bound surface");
  const actor = runtimeExecutor(executor, ...addresses);
  return actor;
}

export function depositBalanceRequests(s: DepositSurface, prefix: string): readonly AdapterRequest[] {
  return [0, 1].map(index => callRequest(`${prefix}-${index}`, s.cryptopool,
    CRYPTOPOOL_INTERFACE.encodeFunctionData("balances", [index])));
}
export function decodeDepositBalances(results: readonly AdapterRequestResult[], prefix: string,
  source: CanonicalSource): DepositBalances {
  const values = [0, 1].map(index => {
    const result = returnedResult(results, `${prefix}-${index}`); assertSource(result.source, source);
    const value = BigInt(CRYPTOPOOL_INTERFACE.decodeFunctionResult("balances", result.data)[0]);
    positive(value); return value;
  });
  return { stable: values[0]!, asset: values[1]! };
}

/** Raw policy diagnostic ONLY, not proof that the executor's guarded program
 * can execute. preview_deposit is not exact: add_liquidity can move price_scale
 * before LT calculates the mint. Production uses depositProgramSimulation.
 * Fund only this actor's asset input; neither AMM stable liquidity nor pool
 * state nor LT supply is overridden. */
export function depositSimulation(id: string, s: DepositSurface, assets: bigint, debt: bigint): AdapterRequest {
  positive(assets); positive(debt);
  const caller = { kind: "executor" as const };
  return {
    id, kind: "effect-delta-simulation",
    preCalls: [0n, assets].map(amount => ({ caller, to: s.asset,
      data: TOKEN.encodeFunctionData("approve", [s.lt, amount]) })),
    call: { caller, executionMode: "impersonated-call-frame", to: s.lt,
      data: LT_INTERFACE.encodeFunctionData(DEPOSIT, [assets, debt, 1n]) },
    overrideIntent: { caller, tokenBalances: [{ token: s.asset, amount: assets }] },
    observeTokenBalances: [s.asset, s.lt, s.stablecoin].map(token => ({ token, account: caller })),
    observe: DEPOSIT_EFFECTS,
  };
}

export function decodeDepositReceipt(results: readonly AdapterRequestResult[], id: string,
  s: DepositSurface, source: CanonicalSource, executor: string | undefined, assets: bigint): bigint {
  positive(assets);
  const result = returnedResult(results, id); assertSource(result.source, source);
  const shares = BigInt(LT_INTERFACE.decodeFunctionResult(DEPOSIT, result.data)[0]); positive(shares);
  return verifyDepositEffects(result, s, executor, assets, shares);
}

/** One isolated self-CALL through the centrally trusted executor. It executes
 * the identical runtime program, including exact bool-checked approvals,
 * current reserve-derived debt, input/mint/inventory guards and final cleanup.
 * No chain-side storage other than the caller's asset input is overridden. */
export function depositProgramSimulation(id: string, s: DepositSurface, executor: string, assets: bigint): AdapterRequest {
  positive(assets); const actor = actorFor(s, executor), caller = { kind: "executor" as const };
  return {
    id, kind: "effect-delta-simulation",
    call: { caller, executionMode: "executor-program", to: actor,
      data: buildSubscriptCalldata(runtimeProgramScript(depositProgram(s, actor).bytes(), assets)) },
    overrideIntent: { caller, tokenBalances: [{ token: s.asset, amount: assets }] },
    observeTokenBalances: [s.asset, s.lt, s.stablecoin].map(token => ({ token, account: caller })),
    observe: DEPOSIT_EFFECTS,
  };
}

export function decodeDepositProgramReceipt(results: readonly AdapterRequestResult[], id: string,
  s: DepositSurface, source: CanonicalSource, executor: string, assets: bigint): bigint {
  positive(assets); const actor = actorFor(s, executor);
  const result = returnedResult(results, id); assertSource(result.source, source);
  // execSubscript itself has no return word; the program already checks LT's
  // mint return against its independently observed share balance delta.
  if (result.data !== "0x") throw new Error("Yield Basis executor returned unexpected data");
  const rows = result.effects?.tokenDeltas?.filter(row => sameAddress(row.token, s.lt) && sameAddress(row.account, actor));
  if (!rows || rows.length !== 1) throw new Error("Yield Basis program mint delta missing");
  const shares = rows[0]!.delta; positive(shares);
  return verifyDepositEffects(result, s, actor, assets, shares);
}

function verifyDepositEffects(result: Extract<AdapterRequestResult, { ok: true }>,
  s: DepositSurface, executor: string | undefined, assets: bigint, shares: bigint): bigint {
  const deltas = result.effects?.tokenDeltas;
  if (!deltas || deltas.length !== 3) throw new Error("Yield Basis deposit incomplete token effects");
  const inputRows = deltas.filter(row => sameAddress(row.token, s.asset));
  if (inputRows.length !== 1) throw new Error("Yield Basis deposit ambiguous input actor");
  const actor = actorFor(s, executor ?? inputRows[0]!.account);
  for (const [token, amount] of [[s.asset, -assets], [s.lt, shares], [s.stablecoin, 0n]] as const) {
    const rows = deltas.filter(row => sameAddress(row.token, token) && sameAddress(row.account, actor));
    if (rows.length !== 1 || rows[0]!.delta !== amount) throw new Error("Yield Basis deposit actual input/output mismatch");
  }
  const native = result.effects?.nativeDeltas;
  if (!native || native.length !== 1 || !sameAddress(native[0]!.account, actor) || native[0]!.delta !== 0n)
    throw new Error("Yield Basis deposit native conservation mismatch");
  const deposits = (result.effects?.logs ?? []).filter(log => sameAddress(log.address, s.lt) &&
    log.topics[0]?.toLowerCase() === LT_INTERFACE.getEvent("Deposit")!.topicHash.toLowerCase());
  if (deposits.length !== 1) throw new Error("Yield Basis deposit missing/duplicate mint event");
  const log = deposits[0]!;
  const event = LT_INTERFACE.decodeEventLog("Deposit", log.data, [...log.topics]);
  if (!sameAddress(event.sender, actor) || !sameAddress(event.owner, actor) || event.assets !== assets || event.shares !== shares)
    throw new Error("Yield Basis deposit event/effect mismatch");
  // LT can rebase the staker's shares inside deposit. Its total supply delta is
  // not generally equal to the user's mint, so never use that false equality.
  return shares;
}

/** Shared Family-owned emitter for runtime input and specified-amount quote
 * execution. Runtime always derives debt from the CURRENT bound pool balances;
 * quoted mode may bind its already-validated debt. No amount/quote/provider is
 * read while constructing runtime bytes. No new central VM instruction needed.
 * This module alone does not project/admit a deposit route. */
export function depositProgram(s: DepositSurface, executor: string,
  options: { readonly minimumShares?: bigint; readonly quotedDebt?: bigint } = {}): RuntimeAmountProgram {
  const actor = actorFor(s, executor), minimum = options.minimumShares ?? 1n; positive(minimum);
  if (options.quotedDebt !== undefined) positive(options.quotedDebt);
  const balance = TOKEN.encodeFunctionData("balanceOf", [actor]);
  const p = new RuntimeAmountProgram().constant(12, 1n).math("sub", 11, 0, 12).nativeBalance(9);
  if (options.quotedDebt === undefined) {
    p.call(s.cryptopool, CRYPTOPOOL_INTERFACE.encodeFunctionData("balances", [0n]), { static: true }).load(1, 0)
      .call(s.cryptopool, CRYPTOPOOL_INTERFACE.encodeFunctionData("balances", [1n]), { static: true }).load(2, 0)
      .math("mul", 3, 0, 1).math("div", 3, 3, 2).math("sub", 11, 3, 12);
  } else p.constant(3, options.quotedDebt);
  p.call(s.asset, balance, { static: true }).load(14, 0)
    .call(s.lt, balance, { static: true }).load(13, 0)
    .call(s.stablecoin, balance, { static: true }).load(15, 0);
  // Exact approval and cleanup, no permanent max allowance. Bool-returning
  // approval is the supported asset contract here, never ignored false/empty.
  p.call(s.asset, TOKEN.encodeFunctionData("approve", [s.lt, 0n])).load(1, 0).equal(1, 12)
    .call(s.asset, TOKEN.encodeFunctionData("approve", [s.lt, 0n]), { patches: [{ offset: 36, reg: 0 }] })
    .load(1, 0).equal(1, 12)
    .call(s.lt, LT_INTERFACE.encodeFunctionData(DEPOSIT, [0n, 0n, minimum]),
      { patches: [{ offset: 4, reg: 0 }, { offset: 36, reg: 3 }] }).load(10, 0)
    .call(s.asset, TOKEN.encodeFunctionData("approve", [s.lt, 0n])).load(1, 0).equal(1, 12)
    .call(s.asset, balance, { static: true }).load(1, 0).math("sub", 1, 14, 1).equal(1, 0)
    .call(s.stablecoin, balance, { static: true }).load(1, 0).equal(1, 15)
    .call(s.lt, balance, { static: true }).load(1, 0).math("sub", 1, 1, 13).equal(1, 10)
    .constant(2, minimum).math("sub", 2, 1, 2)
    .nativeBalance(1).equal(1, 9);
  return p;
}
