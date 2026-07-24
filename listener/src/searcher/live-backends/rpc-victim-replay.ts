import { ethers } from "ethers";
import { AnvilStateBackend } from "../../shared/state/state-backend.js";
import type { PoolImpact } from "../detector/pool-impact.js";
import type { TokenEdge } from "../planner/token-graph.js";
import { buildVictimOverlay } from "./victim-overlay.js";

const FORK_ETH_BALANCE = "0x56bc75e2d63100000"; // 100 ETH

/** Replay the same registry-selected victim overlay on an Anvil fork. */
export async function replayVictimSwapOnAnvil(
  state: AnvilStateBackend,
  impact: PoolImpact,
  graph: TokenEdge[],
  timeoutMs?: number,
): Promise<void> {
  const overlay = await buildVictimOverlay(impact, {
    graph,
    read: (req) => state.call(req),
  }, timeoutMs);

  const replaySnapshot = await state.snapshot();
  try {
    await state.provider.send("anvil_setBalance", [overlay.whale, FORK_ETH_BALANCE]);
    for (const deal of overlay.tokenDeals) {
      await dealToken(state, deal.token, deal.to, BigInt(deal.amount));
    }
    await state.provider.send("anvil_impersonateAccount", [overlay.whale]);
    try {
      for (const call of overlay.preCalls) {
        await state.send({
          from: call.from,
          to: call.to,
          data: call.calldata,
          gas: call.gasLimit === undefined ? undefined : ethers.toBeHex(call.gasLimit),
        });
      }
    } finally {
      await state.provider.send("anvil_stopImpersonatingAccount", [overlay.whale]);
    }
  } catch (error) {
    try {
      await state.revert(replaySnapshot);
    } catch (rollbackError) {
      throw new Error(
        `victim replay failed and rollback failed: ${
          rollbackError instanceof Error
            ? rollbackError.message
            : String(rollbackError)
        }`,
        { cause: error },
      );
    }
    throw error;
  }
}

/** Deal ERC-20 tokens by probing the same common balance slots as the legacy path. */
async function dealToken(
  state: AnvilStateBackend,
  token: string,
  to: string,
  amount: bigint,
): Promise<void> {
  const tokenAddr = ethers.getAddress(token);
  const toAddr = ethers.getAddress(to);
  const balanceSlotsToTry = [0, 1, 2, 3, 4, 5, 9, 51];

  for (const slotIndex of balanceSlotsToTry) {
    const snap = await state.snapshot();
    const slot = ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(["address", "uint256"], [toAddr, slotIndex]),
    );
    const value = ethers.zeroPadValue(ethers.toBeHex(amount), 32);
    await state.provider.send("anvil_setStorageAt", [tokenAddr, slot, value]);
    try {
      if (await state.getTokenBalance(tokenAddr, toAddr) >= amount) return;
    } catch {
      // Continue probing after restoring the snapshot below.
    }
    await state.revert(snap);
  }

  console.log(
    `[searcher/live] warning: dealToken could not find balance slot for ${tokenAddr}`,
  );
}
