import { ethers } from "ethers";
import { ADDR } from "../../../../shared/constants/addresses.js";
import type {
  SwapDomainSemantics,
  UnifiedObservation,
} from "../../adapter-family-plugin.js";
import {
  ANGSTROM_ADAPTER_SWAP_ABI,
  ANGSTROM_MAINNET_ADAPTER,
  ANGSTROM_MAINNET_HOOK,
} from "../angstrom-attestation.js";
import {
  UNIV4_INITIALIZE_TOPIC,
  UNIV4_POOL_MANAGER_INTERFACE,
  UNIV4_SWAP_TOPIC,
} from "../univ4-abi.js";
import { v4PoolId } from "../univ4-common.js";
import {
  ANGSTROM_INITIALIZE_PATTERN_ID,
  ANGSTROM_SWAP_CALL_PATTERN_ID,
  ANGSTROM_SWAP_LOG_PATTERN_ID,
  canonicalAddress,
  canonicalPoolId,
  canonicalPoolKey,
  poolKeyProjection,
  sameAddress,
} from "./codec.js";
import type {
  AngstromV4Descriptor,
  AngstromV4Route,
} from "./types.js";
import { angstromV4VictimReplay } from "./victim.js";

const ANGSTROM_ADAPTER_INTERFACE = new ethers.Interface(
  ANGSTROM_ADAPTER_SWAP_ABI,
);

export const angstromV4Swap = {
  landedEvents: {
    patternIds: [ANGSTROM_SWAP_LOG_PATTERN_ID],
    classify({ observation }) {
      if (
        observation.kind !== "log" ||
        !sameAddress(observation.address, ADDR.UNISWAP_V4_POOL_MANAGER)
      ) {
        return null;
      }
      return observation.topics[0]?.toLowerCase() === UNIV4_SWAP_TOPIC
        ? "swap"
        : null;
    },
  },
  observation: {
    patternIds: [ANGSTROM_SWAP_CALL_PATTERN_ID, ANGSTROM_SWAP_LOG_PATTERN_ID],
    decode: ({ observation }) => decodeEffects(observation),
  },
  victimSupport: "replay",
  replay: angstromV4VictimReplay,
  poolMaterialization: {
    patternIds: [ANGSTROM_INITIALIZE_PATTERN_ID],
    candidateBinding({ observation }) {
      if (
        observation.kind !== "log" ||
        !sameAddress(observation.address, ADDR.UNISWAP_V4_POOL_MANAGER) ||
        observation.topics[0]?.toLowerCase() !== UNIV4_INITIALIZE_TOPIC
      ) {
        return null;
      }
      try {
        const decoded = UNIV4_POOL_MANAGER_INTERFACE.decodeEventLog(
          "Initialize",
          observation.data,
          observation.topics,
        );
        const poolKey = canonicalPoolKey({
          currency0: String(decoded.currency0),
          currency1: String(decoded.currency1),
          fee: Number(decoded.fee),
          tickSpacing: Number(decoded.tickSpacing),
          hooks: String(decoded.hooks),
        });
        if (!sameAddress(poolKey.hooks, ANGSTROM_MAINNET_HOOK)) return null;
        const poolId = canonicalPoolId(String(decoded.id));
        if (v4PoolId(poolKey) !== poolId) return null;
        return {
          manager: canonicalAddress(observation.address),
          adapter: canonicalAddress(ANGSTROM_MAINNET_ADAPTER),
          poolId,
          poolKey: poolKeyProjection(poolKey),
        };
      } catch {
        return null;
      }
    },
  },
} satisfies SwapDomainSemantics<AngstromV4Descriptor, AngstromV4Route>;

function decodeEffects(
  observation: UnifiedObservation,
): ReturnType<SwapDomainSemantics["observation"]["decode"]> {
  try {
    if (observation.kind === "call") {
      if (!sameAddress(observation.target, ANGSTROM_MAINNET_ADAPTER)) return [];
      const decoded = ANGSTROM_ADAPTER_INTERFACE.decodeFunctionData(
        "swap",
        observation.data,
      );
      const key = decoded.key;
      const poolKey = canonicalPoolKey({
        currency0: String(key.currency0),
        currency1: String(key.currency1),
        fee: Number(key.fee),
        tickSpacing: Number(key.tickSpacing),
        hooks: String(key.hooks),
      });
      if (!sameAddress(poolKey.hooks, ANGSTROM_MAINNET_HOOK)) return [];
      return [Object.freeze({
        kind: "swap" as const,
        canonicalPayload: {
          adapter: canonicalAddress(observation.target),
          manager: canonicalAddress(ADDR.UNISWAP_V4_POOL_MANAGER),
          poolId: v4PoolId(poolKey),
          poolKey: poolKeyProjection(poolKey),
          zeroForOne: Boolean(decoded.zeroForOne),
          amountIn: BigInt(decoded.amountIn),
          minAmountOut: BigInt(decoded.minAmountOut),
          attestations: [...decoded.bundle].map((item) => ({
            blockNumber: BigInt(item.blockNumber),
            unlockData: String(item.unlockData),
          })),
          recipient: canonicalAddress(String(decoded.recipient)),
          deadline: BigInt(decoded.deadline),
        },
      })];
    }
    if (
      observation.kind !== "log" ||
      !sameAddress(observation.address, ADDR.UNISWAP_V4_POOL_MANAGER) ||
      observation.topics[0]?.toLowerCase() !== UNIV4_SWAP_TOPIC
    ) {
      return [];
    }
    const decoded = UNIV4_POOL_MANAGER_INTERFACE.decodeEventLog(
      "Swap",
      observation.data,
      observation.topics,
    );
    const amount0 = BigInt(decoded.amount0);
    const amount1 = BigInt(decoded.amount1);
    const zeroForOne = amount0 < 0n && amount1 > 0n;
    const oneForZero = amount1 < 0n && amount0 > 0n;
    if (!zeroForOne && !oneForZero) return [];
    return [Object.freeze({
      kind: "swap" as const,
      canonicalPayload: {
        manager: canonicalAddress(observation.address),
        poolId: canonicalPoolId(String(decoded.id)),
        sender: canonicalAddress(String(decoded.sender)),
        zeroForOne,
        amount0,
        amount1,
        amountIn: zeroForOne ? -amount0 : -amount1,
        // Deliberately omit amountOut: afterSwap hook accounting can change
        // the caller balance after PoolManager emits its BalanceDelta.
        exactPostState: {
          poolId: canonicalPoolId(String(decoded.id)),
          sqrtPriceX96: BigInt(decoded.sqrtPriceX96),
          liquidity: BigInt(decoded.liquidity),
          tick: Number(decoded.tick),
          lpFee: Number(decoded.fee),
        },
      },
    })];
  } catch {
    return [];
  }
}
