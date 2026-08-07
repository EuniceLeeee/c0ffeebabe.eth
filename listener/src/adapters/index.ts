/**
 * Register exactly the low-level encoders reachable from active production
 * families. Historical encoders remain directly importable by their fixtures,
 * but importing the live bootstrap cannot activate them.
 */
import { register } from "./registry.js";
import type { ActionAdapter } from "../types.js";
import {
  PRODUCTION_ADAPTER_FAMILIES,
  PRODUCTION_FAMILY_MODULES,
} from "../searcher/venues/production-registry.js";
import { balancerFlashAdapter } from "./balancer-flash.js";
import { morphoFlashAdapter } from "./morpho-flash.js";
import { fluidVaultAdapter } from "./fluid-vault.js";
import { fluidDexLiquidateAdapter, fluidDexSwapAdapter } from "./fluid-dex.js";
import { erc20ApproveAdapter, erc20TransferAdapter } from "./erc20.js";
import { makeProtocolAdapter, PROTOCOL_LEG_DESCRIPTORS } from "./protocol-legs.js";
import { psmAdapter } from "./psm.js";
import { univ3Adapter } from "./univ3.js";
import { univ2Adapter } from "./univ2.js";
import {
  univ4UnlockAdapter,
  univ4SwapAdapter,
  univ4TakeAdapter,
  univ4SyncAdapter,
  univ4SettleAdapter,
  univ4SettleValueAdapter,
} from "./univ4.js";
import { angstromV4SwapActionAdapter } from "./angstrom-v4.js";
import {
  curveExchangeUnderlyingAdapter,
} from "./curve.js";
import { assertBalanceAdapter } from "./assert-balance.js";
import {
  wethDepositValueAdapter,
  wethWithdrawAmountAdapter,
} from "./wrap.js";
import { metronomeHgUsdcExitAdapter } from "./metronome-hgusdc.js";
import { dodoV2ActionAdapter } from "./dodo-v2.js";
import { eigenpieDepositActionAdapter } from "./eigenpie-deposit.js";
import { selfBurnNativeRedeemActionAdapter } from "./self-burn-native.js";

const PRODUCTION_ACTION_CATALOG = new Map<string, ActionAdapter>(
  [
    balancerFlashAdapter,
    morphoFlashAdapter,
    fluidVaultAdapter,
    fluidDexLiquidateAdapter,
    fluidDexSwapAdapter,
    erc20ApproveAdapter,
    erc20TransferAdapter,
    ...PROTOCOL_LEG_DESCRIPTORS.map(makeProtocolAdapter),
    eigenpieDepositActionAdapter,
    selfBurnNativeRedeemActionAdapter,
    psmAdapter,
    univ3Adapter,
    univ2Adapter,
    dodoV2ActionAdapter,
    univ4UnlockAdapter,
    univ4SwapAdapter,
    univ4TakeAdapter,
    univ4SyncAdapter,
    univ4SettleAdapter,
    univ4SettleValueAdapter,
    angstromV4SwapActionAdapter,
    curveExchangeUnderlyingAdapter,
    metronomeHgUsdcExitAdapter,
    wethDepositValueAdapter,
    wethWithdrawAmountAdapter,
    assertBalanceAdapter,
  ].map((adapter) => [adapter.id, adapter]),
);

for (const module of PRODUCTION_FAMILY_MODULES) {
  for (const adapter of module.actionAdapters) {
    if (PRODUCTION_ACTION_CATALOG.has(adapter.id)) {
      throw new Error(
        `production family loader admitted duplicate ActionAdapter ${adapter.id}`,
      );
    }
    PRODUCTION_ACTION_CATALOG.set(adapter.id, adapter);
  }
}

const productionActions = PRODUCTION_ADAPTER_FAMILIES.actionIds();
const requiredActionIds = new Set([
  ...productionActions.owned,
  ...productionActions.requiredInfra,
]);
const EXCLUDE_NON_STATE_INSTANCE_FAMILIES =
  process.env.SEARCHER_EXCLUDE_NON_STATE_INSTANCE_FAMILIES === "1";
for (const id of [...requiredActionIds].sort()) {
  const action = PRODUCTION_ACTION_CATALOG.get(id);
  if (!action) throw new Error(`production family closure missing ActionAdapter ${id}`);
  register(action);
}
for (const id of PRODUCTION_ACTION_CATALOG.keys()) {
  if (!requiredActionIds.has(id) && !EXCLUDE_NON_STATE_INSTANCE_FAMILIES) {
    throw new Error(`unclaimed ActionAdapter imported by production bootstrap: ${id}`);
  }
}
