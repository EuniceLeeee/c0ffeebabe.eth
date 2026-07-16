import { ADDR } from "../shared/constants/addresses.js";
import type { ActionAdapter } from "../types.js";
import { balancerFlashAdapter } from "./balancer-flash.js";
import { morphoFlashAdapter } from "./morpho-flash.js";

export type FlashRepayment = "approve-pull" | "transfer";
export type FlashParamShape = "none" | "tokens-and-amounts";

/** Static protocol metadata; this does not add a Route/Flash adapter registry. */
export interface FlashProviderDescriptor {
  readonly adapterId: "balancer-flash" | "morpho-flash";
  readonly lineage: "balancer-flash" | "morpho-flash";
  readonly actionAdapter: ActionAdapter;
  readonly target: string;
  readonly liquidityHolder: string;
  readonly repayment: FlashRepayment;
  readonly paramShape: FlashParamShape;
  /** Lower values are preferred by path templates. */
  readonly planningPriority: number;
  /** Lower values preserve the liquidity cache's equal-balance tie break. */
  readonly liquidityPriority: number;
}

export const FLASH_PROVIDER_DESCRIPTORS: readonly FlashProviderDescriptor[] = Object.freeze([
  Object.freeze({
    adapterId: "balancer-flash",
    lineage: "balancer-flash",
    actionAdapter: balancerFlashAdapter,
    target: ADDR.BALANCER_VAULT,
    liquidityHolder: ADDR.BALANCER_VAULT,
    repayment: "transfer",
    paramShape: "tokens-and-amounts",
    planningPriority: 1,
    liquidityPriority: 0,
  }),
  Object.freeze({
    adapterId: "morpho-flash",
    lineage: "morpho-flash",
    actionAdapter: morphoFlashAdapter,
    target: ADDR.MORPHO,
    liquidityHolder: ADDR.MORPHO,
    repayment: "approve-pull",
    paramShape: "none",
    planningPriority: 0,
    liquidityPriority: 1,
  }),
]);

export const FLASH_PLANNING_ADAPTER_IDS: readonly string[] = Object.freeze(
  [...FLASH_PROVIDER_DESCRIPTORS]
    .sort((a, b) => a.planningPriority - b.planningPriority)
    .map((descriptor) => descriptor.adapterId),
);

export const DEFAULT_FLASH_ADAPTER_ID = FLASH_PROVIDER_DESCRIPTORS.reduce((best, candidate) =>
  candidate.planningPriority < best.planningPriority ? candidate : best
).adapterId;

export function findFlashProviderDescriptor(
  adapterId: string,
): FlashProviderDescriptor | null {
  return FLASH_PROVIDER_DESCRIPTORS.find((descriptor) => descriptor.adapterId === adapterId) ?? null;
}
