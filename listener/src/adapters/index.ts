/** Register all adapters on import. */
import { register } from "./registry.js";
import { FLASH_PROVIDER_DESCRIPTORS } from "./flash-providers.js";
import { fluidVaultAdapter } from "./fluid-vault.js";
import { fluidDexLiquidateAdapter, fluidDexSwapAdapter } from "./fluid-dex.js";
import { erc20ApproveAdapter, erc20TransferAdapter } from "./erc20.js";
import { makeProtocolAdapter, PROTOCOL_LEG_DESCRIPTORS } from "./protocol-legs.js";
import { psmAdapter } from "./psm.js";
import { univ3Adapter } from "./univ3.js";
import { univ2Adapter, univ2RouterAdapter, univ2RouterAltAdapter } from "./univ2.js";
import {
  univ4UnlockAdapter,
  univ4SwapAdapter,
  univ4TakeAdapter,
  univ4SyncAdapter,
  univ4SettleAdapter,
  univ4SettleValueAdapter,
} from "./univ4.js";
import {
  curveExchangeAdapter,
  curveExchangeNoReceiverAdapter,
  curveExchangeUnderlyingAdapter,
  curveExchangeReceivedUintAdapter,
  curvePlainExchangeAdapter,
  curveRouterExecutePathAdapter,
} from "./curve.js";
import { assertBalanceAdapter } from "./assert-balance.js";
import {
  wethDepositValueAdapter,
  wethWithdrawAdapter,
  wethWithdrawAmountAdapter,
} from "./wrap.js";
import { metronomeHgUsdcExitAdapter } from "./metronome-hgusdc.js";
import {
  balancerV3SendToAdapter,
  balancerV3SettleAdapter,
  balancerV3SwapAdapter,
  balancerV3UnlockAdapter,
} from "./balancer-v3.js";
import { dodoV2ActionAdapter } from "./dodo-v2.js";

// Flash
for (const descriptor of [...FLASH_PROVIDER_DESCRIPTORS]
  .sort((a, b) => a.planningPriority - b.planningPriority)) {
  register(descriptor.actionAdapter);
}
// Lending
register(fluidVaultAdapter);
register(fluidDexLiquidateAdapter);
register(fluidDexSwapAdapter);
// ERC20
register(erc20ApproveAdapter);
register(erc20TransferAdapter);
for (const desc of PROTOCOL_LEG_DESCRIPTORS) {
  register(makeProtocolAdapter(desc));
}
// Swaps
register(psmAdapter);
register(univ3Adapter);
register(univ2Adapter);
register(univ2RouterAdapter);
register(univ2RouterAltAdapter);
register(dodoV2ActionAdapter);
register(univ4UnlockAdapter);
register(univ4SwapAdapter);
register(univ4TakeAdapter);
register(univ4SyncAdapter);
register(univ4SettleAdapter);
register(univ4SettleValueAdapter);
register(balancerV3UnlockAdapter);
register(balancerV3SettleAdapter);
register(balancerV3SwapAdapter);
register(balancerV3SendToAdapter);
register(curveExchangeAdapter);
register(curveExchangeReceivedUintAdapter);
register(curveExchangeNoReceiverAdapter);
register(curvePlainExchangeAdapter);
register(curveExchangeUnderlyingAdapter);
register(curveRouterExecutePathAdapter);
register(metronomeHgUsdcExitAdapter);
// Wrap
register(wethDepositValueAdapter);
register(wethWithdrawAdapter);
register(wethWithdrawAmountAdapter);
// Guards
register(assertBalanceAdapter);
