import { ethers } from "ethers";
import definition from "../../uniswap-v1-family/uniswap-v1.json" with { type: "json" };
import { plugin } from "../../../production-families/uniswap-v1.production.js";
import { compileDeclarativeValues } from "../../../declarative-values.js";
import { univ1MathModels, UNIV1_ISSUER_MODEL, UNIV1_STANDARD_MODEL } from "../math.js";

const { constants, abi } = definition.standard;
export const ID = plugin.manifest.familyId;
export const IMPLEMENTATION = constants.implementation;
export const MAX_UINT = BigInt(constants.maxUint256);
export const MAX_VALUE = BigInt(constants.maxValue);
export const MULTICALL = constants.multicall;
export const MODEL = UNIV1_ISSUER_MODEL;
export const STANDARD_MODEL = UNIV1_STANDARD_MODEL;
export const WETH = constants.weth;
export const POOL = new ethers.Interface([...abi.pool, ...abi.transfer]);
export const lower = (s: string) => ethers.getAddress(s).toLowerCase();
export const same = (a: string,b: string) => lower(a) === lower(b);

const expressions = definition.identity.definition.expressions;
const values = compileDeclarativeValues({ abi, constants, expressions });
export const cloneImplementation = (code: string) => values.evaluate(expressions.cloneAddress, {code, constants});
export const poolAddress = (raw: string) => values.evaluate(expressions.addressOrZero, {raw, constants});

type Reserves = { source: {number: number; hash: string; generation:number}; tokenReserve: bigint; nativeReserve: bigint };
const quoteModel = univ1MathModels[0]!;
export function quoteTransition(state:Reserves, buy:boolean, amountIn:bigint, model = MODEL as string) {
  const input = { nativeReserve:state.nativeReserve, tokenReserve:state.tokenReserve, buy, amountIn, model };
  quoteModel.validateInput(input);
  const row = quoteModel.evaluate(input) as Record<string,bigint>;
  quoteModel.validateOutput(row);
  return { amountOut:row.amountOut!, state:Object.freeze({source:state.source, tokenReserve:row.tokenReserve!, nativeReserve:row.nativeReserve!}) };
}
export const quoteAmount = (s:Reserves, buy:boolean, amountIn:bigint, model = MODEL as string) =>
  quoteTransition(s, buy, amountIn, model).amountOut;
