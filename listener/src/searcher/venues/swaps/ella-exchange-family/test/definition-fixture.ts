import { ethers } from "ethers";
import { plugin } from "../../../production-families/ella-exchange.production.js";
import definition from "../ella-exchange.json" with { type: "json" };
import type { CanonicalSource, AdapterRequestResult } from "../../../adapter-request-program.js";
import type { CompiledInstanceDescriptor, FamilyCandidate, UnifiedObservation } from "../../../adapter-family-plugin.js";
import { ellaMathModels } from "../math.js";

const {constants, abi} = definition.standard;
export const { exchangeCodeHash:EXCHANGE_CODE_HASH, factoryCodeHash:FACTORY_CODE_HASH, multicall:MULTICALL } = constants;
export const UNIT = BigInt(constants.unit), MAX_UINT = BigInt(constants.maxUint256);
export const POOL = new ethers.Interface([...abi.pool, definition.swap.events[0]!.signature]), TOKEN = new ethers.Interface(abi.token),
  ORACLE = new ethers.Interface(abi.oracle), BALANCE = new ethers.Interface(abi.balance), FEES = new ethers.Interface(abi.fees);
export const ELLA_ID = plugin.manifest.familyId;
export const BOUGHT_ID = definition.swap.events[0]!.id;
export const same = (a:string,b:string) => ethers.getAddress(a)===ethers.getAddress(b);
export function assertSource(a:CanonicalSource,b:CanonicalSource) {
  if (a.number!==b.number || a.hash.toLowerCase()!==b.hash.toLowerCase() || a.generation!==b.generation)
    throw new Error("ella mixed source evidence");
}
export type EllaDirection = "buy-token"|"sell-token";
export type EllaCandidate = FamilyCandidate & {candidateKind:"ella-exchange";pool:string};
export type EllaDescriptor = CompiledInstanceDescriptor & {pool:string;token:string;factory:string;oracle:string;aggregator:string;
  decimals:number;codeHash:string;factoryCodeHash:string};
export type EllaState = {source:CanonicalSource; price:bigint; fee:bigint; systemCut:bigint; feesAddress:string;tokenBalance:bigint;
  nativeBalance:bigint; baseFeesGenerated:bigint; feesGenerated:bigint};

export function decodeBought(observation:UnifiedObservation) {
  if (observation.kind!=="log" || !plugin.discovery!.decodeCandidate({observation,matchedPatternId:BOUGHT_ID})) return null;
  return POOL.decodeEventLog("Bought",observation.data,observation.topics);
}
export function stateRequests(d:EllaDescriptor, source:CanonicalSource) {
  const routes = plugin.routes!.project({descriptor:d as any});
  return plugin.pricing!.current.buildRequests({descriptor:{instance:d},routes,source} as any);
}
export function decodeState(d:EllaDescriptor, results:readonly AdapterRequestResult[]) {
  return plugin.pricing!.current.decodeSnapshot({descriptor:{instance:d},initialResults:results,dependentEvidence:[]} as any) as unknown as EllaState;
}
export function quoteAmount(state:EllaState,direction:EllaDirection,amountIn:bigint) {
  const {source,feesAddress,...balances}=state, model=ellaMathModels[0]!;
  const input={...balances,direction,amountIn}; model.validateInput(input);
  const row=model.evaluate(input) as Record<string,any>;model.validateOutput(row);
  return row;
}
/** Fixed-price, ordinary-transfer transition of the verified exchange runtime.
 * This kernel does NOT prove arbitrary token/oracle/fee-recipient semantics.
 * Callers must establish that dependency closure before issuing trial state. */
export function quoteAmountAndApply(state: EllaState, direction: EllaDirection, amountIn: bigint,
  pool: string, executor: string) {
  if (same(executor, pool) || same(state.feesAddress, executor) || same(state.feesAddress, pool)) {
    throw new Error("ella unsupported trial actor or self-fee recipient");
  }
  const q = quoteAmount(state, direction, amountIn);
  if (amountIn === 0n || q.unavailableReason) return { ...q, nextState: state };
  const buy = direction === "buy-token";
  // Pool retains the LP part of the output fee. The system part really leaves
  // the pool; subtracting grossOut would incorrectly discard the retained fee.
  const paid = q.amountOut + q.systemFee;
  const nativeBalance = buy ? state.nativeBalance + amountIn : state.nativeBalance - paid;
  const tokenBalance = buy ? state.tokenBalance - paid : state.tokenBalance + amountIn;
  if (nativeBalance < 0n || tokenBalance < 0n || nativeBalance > MAX_UINT || tokenBalance > MAX_UINT) {
    throw new Error("ella trial inventory overflow");
  }
  return { ...q, nextState: Object.freeze({ ...state, nativeBalance, tokenBalance,
    baseFeesGenerated: state.baseFeesGenerated + (buy ? 0n : q.fee - q.systemFee),
    feesGenerated: state.feesGenerated + (buy ? q.fee - q.systemFee : 0n) }) };
}
