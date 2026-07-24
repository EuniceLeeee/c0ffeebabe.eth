import { ADDR } from "../../../shared/constants/addresses.js";
import type { FlashLoanAdapterFamily } from "../route-leg-adapter.js";
import {
  fundingLineageId,
  fundingProviderId,
} from "./funding-capability.js";
import { createErc20BalanceFlashFundingCapability } from "./flash-loan-framework.js";

const PROVIDER_ID = fundingProviderId("flash-loan:morpho");

export const morphoFlashFamily = Object.freeze({
  id: PROVIDER_ID,
  kind: "flash-loan",
  ownedActionAdapterIds: ["morpho-flash"],
  requiredInfraActionAdapterIds: ["assert-balance", "erc20-approve"],
  funding: createErc20BalanceFlashFundingCapability({
    familyId: PROVIDER_ID,
    actionAdapterId: "morpho-flash",
    lineage: fundingLineageId("morpho-flash"),
    target: ADDR.MORPHO,
    liquidityHolder: ADDR.MORPHO,
    repayment: "approve-pull",
    paramShape: "none",
    planningPriority: 0,
    liquidityPriority: 1,
  }),
} satisfies FlashLoanAdapterFamily);
