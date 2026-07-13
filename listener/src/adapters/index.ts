/** Register all adapters on import. */
import { register } from "./registry.js";
import { morphoFlashAdapter } from "./morpho-flash.js";
import { balancerFlashAdapter } from "./balancer-flash.js";
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

// Flash
register(morphoFlashAdapter);
register(balancerFlashAdapter);
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
register(univ4UnlockAdapter);
register(univ4SwapAdapter);
register(univ4TakeAdapter);
register(univ4SyncAdapter);
register(univ4SettleAdapter);
register(univ4SettleValueAdapter);
register(curveExchangeAdapter);
register(curveExchangeReceivedUintAdapter);
register(curveExchangeNoReceiverAdapter);
register(curvePlainExchangeAdapter);
register(curveRouterExecutePathAdapter);
register(metronomeHgUsdcExitAdapter);
// Wrap
register(wethDepositValueAdapter);
register(wethWithdrawAdapter);
register(wethWithdrawAmountAdapter);
// Guards
register(assertBalanceAdapter);
