import { MaxUint256 } from "ethers";
import type { RuntimeMathModel } from "./declarative-runtime-math.js";

const MAX_UINT256 = MaxUint256.toString();

/**
 * In-transaction PSV recipient quote terms shared by the default receiver and a
 * settlement receiver. The fee is only paid to the receiver when the receiver is
 * also the treasury; the gross reserve check always includes the treasury fee.
 * The output is the receiver's actual token delta, so the shared execution
 * compiler can compare it with the measured receipt instead of trusting an
 * off-chain quote. No transport, ABI, state or settlement work is performed.
 */
export const psvQuoteTermsRuntimeMathModel: RuntimeMathModel = Object.freeze({
  id: "psv:quote-terms",
  version: 1,
  inputs: ["amountIn", "net", "fee", "treasury", "recipient", "maxPerTransaction",
    "remaining", "reserve0", "reserve1", "isSell", "scale"],
  outputs: ["gross", "received", "maximum", "wad", "reserve"],
  operations: ([
    { name: "gross", op: "add", left: { input: "net" }, right: { input: "fee" } },
    { name: "sameTreasury", op: "eq", left: { input: "treasury" }, right: { input: "recipient" } },
    { name: "feeToReceiver", op: "mul", left: { input: "fee" }, right: { local: "sameTreasury" } },
    { name: "received", op: "add", left: { input: "net" }, right: { local: "feeToReceiver" } },
    { name: "capIsZero", op: "eq", left: { input: "maxPerTransaction" }, right: { constant: "0" } },
    { name: "unbounded", op: "mul", left: { local: "capIsZero" }, right: { constant: MAX_UINT256 } },
    { name: "maximum", op: "add", left: { input: "maxPerTransaction" }, right: { local: "unbounded" } },
    { name: "wad", op: "mul", left: { input: "amountIn" }, right: { input: "scale" } },
    { name: "isBuy", op: "sub", left: { constant: "1" }, right: { input: "isSell" } },
    { name: "reserveSell", op: "mul", left: { input: "reserve0" }, right: { input: "isSell" } },
    { name: "reserveBuy", op: "mul", left: { input: "reserve1" }, right: { local: "isBuy" } },
    { name: "reserve", op: "add", left: { local: "reserveSell" }, right: { local: "reserveBuy" } },
  ] as const),
});
