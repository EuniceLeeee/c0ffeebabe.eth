import { assertBalanceAdapter } from "../../adapters/assert-balance.js";
import {
  erc20ApproveAdapter,
  erc20TransferAdapter,
} from "../../adapters/erc20.js";
import {
  wethDepositValueAdapter,
  wethWithdrawAmountAdapter,
} from "../../adapters/wrap.js";
import type { ActionAdapter } from "../../types.js";

/**
 * Protocol-neutral BotVM primitives. Family-owned actions enter production
 * only through their scanned strict plugin; this is the complete infrastructure
 * root that a Family manifest may reference without owning.
 */
export const PRODUCTION_INFRA_ACTION_ADAPTERS = Object.freeze([
  assertBalanceAdapter,
  erc20ApproveAdapter,
  erc20TransferAdapter,
  wethDepositValueAdapter,
  wethWithdrawAmountAdapter,
] satisfies readonly ActionAdapter[]);

export const PRODUCTION_INFRA_ACTION_ADAPTER_IDS = Object.freeze(
  PRODUCTION_INFRA_ACTION_ADAPTERS.map((adapter) => adapter.id).sort(),
);
