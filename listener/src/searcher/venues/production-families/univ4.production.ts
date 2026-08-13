import { defineSwapFamily } from "../adapter-family-plugin.js";
import { univ4Capture } from "../swaps/univ4-family/capture.js";
import {
  univ4SettleFamilyOwnedAction,
  univ4SettleValueFamilyOwnedAction,
  univ4SwapFamilyOwnedAction,
  univ4SyncFamilyOwnedAction,
  univ4TakeFamilyOwnedAction,
  univ4UnlockFamilyOwnedAction,
} from "../swaps/univ4-family/action.js";
import { univ4Discovery } from "../swaps/univ4-family/discovery.js";
import { univ4Exact } from "../swaps/univ4-family/exact.js";
import { univ4Execution } from "../swaps/univ4-family/execution.js";
import { univ4Identity } from "../swaps/univ4-family/identity.js";
import { univ4Instance } from "../swaps/univ4-family/instance.js";
import { univ4FamilyManifest } from "../swaps/univ4-family/manifest.js";
import { univ4Pricing } from "../swaps/univ4-family/pricing.js";
import { univ4Routes } from "../swaps/univ4-family/routes.js";
import { univ4Swap } from "../swaps/univ4-family/swap.js";

export const plugin = defineSwapFamily({
  manifest: univ4FamilyManifest,
  capture: univ4Capture,
  discovery: univ4Discovery,
  identity: univ4Identity,
  instance: univ4Instance,
  routes: univ4Routes,
  pricing: univ4Pricing,
  exact: univ4Exact,
  execution: univ4Execution,
  swap: univ4Swap,
  actionAdapters: [
    univ4UnlockFamilyOwnedAction,
    univ4SwapFamilyOwnedAction,
    univ4TakeFamilyOwnedAction,
    univ4SyncFamilyOwnedAction,
    univ4SettleFamilyOwnedAction,
    univ4SettleValueFamilyOwnedAction,
  ],
});
