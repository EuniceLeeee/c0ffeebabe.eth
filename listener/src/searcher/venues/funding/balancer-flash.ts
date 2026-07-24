import { ADDR } from "../../../shared/constants/addresses.js";
import type { FlashLoanAdapterFamily } from "../route-leg-adapter.js";
import {
  fundingLineageId,
  fundingProviderId,
} from "./funding-capability.js";
import { createErc20BalanceFlashFundingCapability } from "./flash-loan-framework.js";

const PROVIDER_ID = fundingProviderId("flash-loan:balancer-v2");

export const balancerFlashFamily = Object.freeze({
  id: PROVIDER_ID,
  kind: "flash-loan",
  ownedActionAdapterIds: ["balancer-flash"],
  requiredInfraActionAdapterIds: ["assert-balance", "erc20-transfer"],
  funding: createErc20BalanceFlashFundingCapability({
    familyId: PROVIDER_ID,
    actionAdapterId: "balancer-flash",
    lineage: fundingLineageId("balancer-flash"),
    target: ADDR.BALANCER_VAULT,
    liquidityHolder: ADDR.BALANCER_VAULT,
    repayment: "transfer",
    paramShape: "tokens-and-amounts",
    planningPriority: 1,
    liquidityPriority: 0,
  }),
} satisfies FlashLoanAdapterFamily);
