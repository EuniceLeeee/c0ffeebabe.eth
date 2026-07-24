import { ethers } from "ethers";
import { PROTOCOL_LEG_DESCRIPTORS } from "../../../adapters/protocol-legs.js";
import { ADDR } from "../../../shared/constants/addresses.js";
import {
  isStateCallAbortedError,
  type StateBackend,
} from "../../../shared/state/state-backend.js";

type CallBackend = Pick<StateBackend, "call">;

const goldxIface = new ethers.Interface(["function unit() view returns (uint256)"]);
const GOLDX_WAD = 10n ** 18n;
const psmIface = new ethers.Interface([
  "function tin() view returns (uint256)",
  "function tout() view returns (uint256)",
]);
const WAD = 10n ** 18n;
const PSM_TO18 = 10n ** 12n;
const siloRedeemIface = new ethers.Interface([
  "function previewRedeem(uint256 shares) view returns (uint256 assets)",
  "function previewWithdraw(uint256 assets) view returns (uint256 shares)",
]);

export const metronomeSynthPoolIface = new ethers.Interface([
  "function quoteSwapOut(address syntheticTokenIn, address syntheticTokenOut, uint256 amountIn) view returns (uint256 amountOut, uint256 fee)",
]);

export async function quoteGoldxMint(
  state: CallBackend,
  target: string,
  tokenIn: string,
  tokenOut: string,
  amountIn: bigint,
): Promise<bigint> {
  if (
    tokenIn.toLowerCase() !== ADDR.PAXG.toLowerCase() ||
    tokenOut.toLowerCase() !== ADDR.GOLDX.toLowerCase()
  ) {
    throw new Error(`GOLDx mint only supports PAXG->GOLDx, got ${tokenIn} -> ${tokenOut}`);
  }
  const result = await state.call({ to: target, data: goldxIface.encodeFunctionData("unit") });
  const unit = BigInt(goldxIface.decodeFunctionResult("unit", result)[0]);
  if (unit <= 0n) throw new Error(`GOLDx unit() returned ${unit}`);
  return amountIn * unit / GOLDX_WAD;
}

export async function quotePSM(
  state: CallBackend,
  target: string,
  tokenIn: string,
  tokenOut: string,
  amountIn: bigint,
): Promise<bigint> {
  const usdc = ADDR.USDC.toLowerCase();
  const dai = ADDR.DAI.toLowerCase();
  const sellsGem = tokenIn.toLowerCase() === usdc && tokenOut.toLowerCase() === dai;
  const buysGem = tokenIn.toLowerCase() === dai && tokenOut.toLowerCase() === usdc;
  if (!sellsGem && !buysGem) {
    throw new Error(`PSM only supports USDC<->DAI, got ${tokenIn} -> ${tokenOut}`);
  }
  if (sellsGem) {
    const tin = await readPSMFee(state, target, "tin");
    const gemAmt18 = amountIn * PSM_TO18;
    return gemAmt18 - gemAmt18 * tin / WAD;
  }
  const tout = await readPSMFee(state, target, "tout");
  return (amountIn * WAD / (WAD + tout)) / PSM_TO18;
}

/** Block-scan graph only admits the USDC→DAI leg; preserve its one-call prewarm shape. */
export async function quotePSMSellGemPrewarm(
  state: StateBackend,
  target: string,
  tokenIn: string,
  tokenOut: string,
  amountIn: bigint,
): Promise<bigint> {
  if (
    tokenIn.toLowerCase() !== ADDR.USDC.toLowerCase() ||
    tokenOut.toLowerCase() !== ADDR.DAI.toLowerCase()
  ) {
    throw new Error(`PSM prewarm only supports USDC->DAI, got ${tokenIn} -> ${tokenOut}`);
  }
  const tin = await readPSMFee(state, target, "tin");
  const gemAmt18 = amountIn * PSM_TO18;
  return gemAmt18 - gemAmt18 * tin / WAD;
}

export async function quoteProtocolLeg(
  state: StateBackend,
  target: string,
  adapterId: string,
  amountIn: bigint,
): Promise<bigint> {
  const desc = PROTOCOL_LEG_DESCRIPTORS.find((entry) => entry.id === adapterId);
  if (!desc) throw new Error(`protocol leg quote descriptor not found for adapter ${adapterId}`);
  if (desc.quoteSig === undefined) throw new Error(`protocol leg ${adapterId} has no quoteSig`);
  const iface = new ethers.Interface([protocolLegQuoteAbi(desc.quoteSig)]);
  const fnName = protocolLegQuoteFunctionName(adapterId, desc.quoteSig);
  const result = await state.call({
    to: target,
    data: iface.encodeFunctionData(fnName, [amountIn]),
  });
  return BigInt(iface.decodeFunctionResult(fnName, result)[0]);
}

export async function quoteSiloRedeem(
  state: StateBackend,
  vault: string,
  outToken: string,
  shares: bigint,
): Promise<bigint> {
  const assetsRaw = await state.call({
    to: vault,
    data: siloRedeemIface.encodeFunctionData("previewRedeem", [shares]),
  });
  const assets = BigInt(siloRedeemIface.decodeFunctionResult("previewRedeem", assetsRaw)[0]);
  const outRaw = await state.call({
    to: outToken,
    data: siloRedeemIface.encodeFunctionData("previewWithdraw", [assets]),
  });
  return BigInt(siloRedeemIface.decodeFunctionResult("previewWithdraw", outRaw)[0]);
}

export async function quoteMetronomeSynthSwap(
  state: CallBackend,
  pool: string,
  synthIn: string,
  synthOut: string,
  amountIn: bigint,
): Promise<bigint> {
  const result = await state.call({
    to: pool,
    data: metronomeSynthPoolIface.encodeFunctionData("quoteSwapOut", [
      synthIn,
      synthOut,
      amountIn,
    ]),
  });
  return BigInt(metronomeSynthPoolIface.decodeFunctionResult("quoteSwapOut", result)[0]);
}

async function readPSMFee(
  state: CallBackend,
  target: string,
  fee: "tin" | "tout",
): Promise<bigint> {
  try {
    const result = await state.call({ to: target, data: psmIface.encodeFunctionData(fee) });
    return BigInt(psmIface.decodeFunctionResult(fee, result)[0]);
  } catch (error) {
    if (isStateCallAbortedError(error)) throw error;
    throw new Error(
      `PSM fee unresolved: ${fee} read failed for ${target}; current-block pricing is unresolved`,
      { cause: error },
    );
  }
}

function protocolLegQuoteFunctionName(adapterId: string, signature: string): string {
  const paren = signature.indexOf("(");
  if (paren <= 0) {
    throw new Error(`invalid protocol leg quote signature for ${adapterId}: ${signature}`);
  }
  return signature.slice(0, paren);
}

function protocolLegQuoteAbi(signature: string): string {
  return /\breturns\s*\(/.test(signature)
    ? `function ${signature}`
    : `function ${signature} view returns (uint256)`;
}
