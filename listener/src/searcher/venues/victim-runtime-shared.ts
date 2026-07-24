import { ethers } from "ethers";
import { knownTokenStorageLayout } from "../solver/balance-slots.js";
import type { PoolImpact } from "./swap-observation.js";
import type {
  OverlayPreCall,
  VictimOverlay,
} from "./victim-runtime-capability.js";

export const VICTIM_REPLAY_WHALE =
  "0x000000000000000000000000000000000000dEaD";

const ERC20_IFACE = new ethers.Interface([
  "function approve(address spender, uint256 amount)",
  "function transfer(address recipient, uint256 amount) returns (bool)",
]);

/**
 * Shared replay envelope only: fund one neutral caller, approve the
 * family-selected spender, then execute the family-built call.
 */
export function buildApprovedSwapVictimOverlay(input: {
  readonly impact: PoolImpact;
  readonly approveTarget: string;
  readonly swapTarget: string;
  readonly swapCalldata: string;
  readonly gasLimit?: number;
}): VictimOverlay {
  const whale = ethers.getAddress(VICTIM_REPLAY_WHALE);
  const tokenIn = ethers.getAddress(input.impact.tokenIn);
  const dealAmount = input.impact.amountIn * 2n;
  const approveTarget = ethers.getAddress(input.approveTarget);

  const approveCall: OverlayPreCall = {
    from: whale,
    to: tokenIn,
    calldata: ERC20_IFACE.encodeFunctionData("approve", [
      approveTarget,
      dealAmount,
    ]),
    gasLimit: input.gasLimit,
    allowanceSlot: knownTokenStorageLayout(tokenIn)?.allowanceSlot,
  };
  const swapCall: OverlayPreCall = {
    from: whale,
    to: ethers.getAddress(input.swapTarget),
    calldata: input.swapCalldata,
    gasLimit: input.gasLimit,
  };

  return {
    whale,
    tokenDeals: [{
      token: tokenIn,
      to: whale,
      amount: dealAmount.toString(),
      balanceSlot: knownTokenStorageLayout(tokenIn)?.balanceSlot,
    }],
    preCalls: [approveCall, swapCall],
  };
}

/**
 * Shared exchange-received envelope: seed a neutral caller, transfer the exact
 * input into the pool, then invoke the family-built received-input entrypoint.
 */
export function buildTransferredInputSwapVictimOverlay(input: {
  readonly impact: PoolImpact;
  readonly inputRecipient: string;
  readonly swapTarget: string;
  readonly swapCalldata: string;
  readonly gasLimit?: number;
}): VictimOverlay {
  const whale = ethers.getAddress(VICTIM_REPLAY_WHALE);
  const tokenIn = ethers.getAddress(input.impact.tokenIn);
  const inputRecipient = ethers.getAddress(input.inputRecipient);
  const dealAmount = input.impact.amountIn * 2n;

  return {
    whale,
    tokenDeals: [{
      token: tokenIn,
      to: whale,
      amount: dealAmount.toString(),
      balanceSlot: knownTokenStorageLayout(tokenIn)?.balanceSlot,
    }],
    preCalls: [
      {
        from: whale,
        to: tokenIn,
        calldata: ERC20_IFACE.encodeFunctionData("transfer", [
          inputRecipient,
          input.impact.amountIn,
        ]),
        gasLimit: input.gasLimit,
      },
      {
        from: whale,
        to: ethers.getAddress(input.swapTarget),
        calldata: input.swapCalldata,
        gasLimit: input.gasLimit,
      },
    ],
  };
}
