import type { EdgeKind } from "../searcher/strategy-taxonomy.js";

export type Lineage =
  | "univ2" | "univ3" | "univ4" | "curve" | "balancer-flash" | "morpho-flash"
  | "psm" | "erc4626" | "goldx" | "wsteth" | "metronome" | "weth" | "fluid-credit" | "fluid-dex" | "erc20-infra";

/** Descriptor action vocabulary: superset covering all edge kinds. Do not reuse ProtocolAction. */
export type AdapterAction =
  | "swap" | "flash" | "deposit" | "redeem" | "wrap" | "unwrap" | "convert"
  | "borrow" | "repay" | "supply" | "withdraw" | "approve" | "transfer" | "guard";

export interface AdapterDescriptor {
  adapterId: string;
  lineage: Lineage;
  edgeKind: EdgeKind | null;
  action: AdapterAction;
  canSendValue: boolean;
  leavesStandingPositionDefault: boolean;
}

// Credit adapters default `leavesStandingPositionDefault:true` to match the runtime fail-closed law
// (deriveEdgeTaxonomy: credit -> leavesStandingPosition:true). A credit leg that actually closes in-tx
// (e.g. a liquidation) is still flagged true here — the CONSERVATIVE/safe direction for the S2 guard
// (over-flag, never under-flag). Do NOT read this as the live S2 bit: the runtime edge derivation is the
// source of truth; this is the descriptor-level default that must never disagree in the unsafe direction.
export const ADAPTER_DESCRIPTORS: Record<string, AdapterDescriptor> = {
  "assert-balance": {
    adapterId: "assert-balance",
    lineage: "erc20-infra",
    edgeKind: null,
    action: "guard",
    canSendValue: false,
    leavesStandingPositionDefault: false,
  },
  "erc20-approve": {
    adapterId: "erc20-approve",
    lineage: "erc20-infra",
    edgeKind: null,
    action: "approve",
    canSendValue: false,
    leavesStandingPositionDefault: false,
  },
  "erc20-transfer": {
    adapterId: "erc20-transfer",
    lineage: "erc20-infra",
    edgeKind: null,
    action: "transfer",
    canSendValue: false,
    leavesStandingPositionDefault: false,
  },
  "balancer-flash": {
    adapterId: "balancer-flash",
    lineage: "balancer-flash",
    edgeKind: "flash",
    action: "flash",
    canSendValue: false,
    leavesStandingPositionDefault: false,
  },
  "morpho-flash": {
    adapterId: "morpho-flash",
    lineage: "morpho-flash",
    edgeKind: "flash",
    action: "flash",
    canSendValue: false,
    leavesStandingPositionDefault: false,
  },
  "curve-exchange": {
    adapterId: "curve-exchange",
    lineage: "curve",
    edgeKind: "swap",
    action: "swap",
    canSendValue: false,
    leavesStandingPositionDefault: false,
  },
  "curve-exchange-nr": {
    adapterId: "curve-exchange-nr",
    lineage: "curve",
    edgeKind: "swap",
    action: "swap",
    canSendValue: false,
    leavesStandingPositionDefault: false,
  },
  "curve-exchange-plain": {
    adapterId: "curve-exchange-plain",
    lineage: "curve",
    edgeKind: "swap",
    action: "swap",
    canSendValue: false,
    leavesStandingPositionDefault: false,
  },
  "curve-exchange-underlying": {
    adapterId: "curve-exchange-underlying",
    lineage: "curve",
    edgeKind: "swap",
    action: "swap",
    canSendValue: false,
    leavesStandingPositionDefault: false,
  },
  "curve-exchange-received-uint": {
    adapterId: "curve-exchange-received-uint",
    lineage: "curve",
    edgeKind: "swap",
    action: "swap",
    canSendValue: false,
    leavesStandingPositionDefault: false,
  },
  "curve-router-execute-path": {
    adapterId: "curve-router-execute-path",
    lineage: "curve",
    edgeKind: "swap",
    action: "swap",
    canSendValue: false,
    leavesStandingPositionDefault: false,
  },
  "metronome-hgusdc-exit": {
    adapterId: "metronome-hgusdc-exit",
    lineage: "metronome",
    edgeKind: "protocol",
    action: "redeem",
    canSendValue: false,
    leavesStandingPositionDefault: false,
  },
  "univ2-swap": {
    adapterId: "univ2-swap",
    lineage: "univ2",
    edgeKind: "swap",
    action: "swap",
    canSendValue: false,
    leavesStandingPositionDefault: false,
  },
  "univ2-router-swap-exact-in": {
    adapterId: "univ2-router-swap-exact-in",
    lineage: "univ2",
    edgeKind: "swap",
    action: "swap",
    canSendValue: false,
    leavesStandingPositionDefault: false,
  },
  "univ2-router-swap-exact-in-alt": {
    adapterId: "univ2-router-swap-exact-in-alt",
    lineage: "univ2",
    edgeKind: "swap",
    action: "swap",
    canSendValue: false,
    leavesStandingPositionDefault: false,
  },
  "univ3-swap": {
    adapterId: "univ3-swap",
    lineage: "univ3",
    edgeKind: "swap",
    action: "swap",
    canSendValue: false,
    leavesStandingPositionDefault: false,
  },
  "univ4-unlock": {
    adapterId: "univ4-unlock",
    lineage: "univ4",
    edgeKind: "swap",
    action: "swap",
    canSendValue: false,
    leavesStandingPositionDefault: false,
  },
  "univ4-swap": {
    adapterId: "univ4-swap",
    lineage: "univ4",
    edgeKind: "swap",
    action: "swap",
    canSendValue: false,
    leavesStandingPositionDefault: false,
  },
  "univ4-take": {
    adapterId: "univ4-take",
    lineage: "univ4",
    edgeKind: "swap",
    action: "swap",
    canSendValue: false,
    leavesStandingPositionDefault: false,
  },
  "univ4-sync": {
    adapterId: "univ4-sync",
    lineage: "univ4",
    edgeKind: "swap",
    action: "swap",
    canSendValue: false,
    leavesStandingPositionDefault: false,
  },
  "univ4-settle": {
    adapterId: "univ4-settle",
    lineage: "univ4",
    edgeKind: "swap",
    action: "swap",
    canSendValue: false,
    leavesStandingPositionDefault: false,
  },
  "univ4-settle-value": {
    adapterId: "univ4-settle-value",
    lineage: "univ4",
    edgeKind: "swap",
    action: "swap",
    canSendValue: true,
    leavesStandingPositionDefault: false,
  },
  "fluid-dex-swap": {
    adapterId: "fluid-dex-swap",
    lineage: "fluid-dex",
    edgeKind: "swap",
    action: "swap",
    canSendValue: false,
    leavesStandingPositionDefault: false,
  },
  "fluid-dex-liquidate": {
    adapterId: "fluid-dex-liquidate",
    lineage: "fluid-credit",
    edgeKind: "credit",
    action: "repay",
    canSendValue: false,
    leavesStandingPositionDefault: true,
  },
  "fluid-vault": {
    adapterId: "fluid-vault",
    lineage: "fluid-credit",
    edgeKind: "credit",
    action: "borrow",
    canSendValue: false,
    leavesStandingPositionDefault: true,
  },
  psm: {
    adapterId: "psm",
    lineage: "psm",
    edgeKind: "protocol",
    action: "convert",
    canSendValue: false,
    leavesStandingPositionDefault: false,
  },
  "goldx-mint": {
    adapterId: "goldx-mint",
    lineage: "goldx",
    edgeKind: "protocol",
    action: "convert",
    canSendValue: false,
    leavesStandingPositionDefault: false,
  },
  "erc4626-deposit": {
    adapterId: "erc4626-deposit",
    lineage: "erc4626",
    edgeKind: "protocol",
    action: "deposit",
    canSendValue: false,
    leavesStandingPositionDefault: false,
  },
  "erc4626-redeem": {
    adapterId: "erc4626-redeem",
    lineage: "erc4626",
    edgeKind: "protocol",
    action: "redeem",
    canSendValue: false,
    leavesStandingPositionDefault: false,
  },
  "erc4626-redeem-silo": {
    adapterId: "erc4626-redeem-silo",
    lineage: "erc4626",
    edgeKind: "protocol",
    action: "redeem",
    canSendValue: false,
    leavesStandingPositionDefault: false,
  },
  "wsteth-wrap": {
    adapterId: "wsteth-wrap",
    lineage: "wsteth",
    edgeKind: "protocol",
    action: "wrap",
    canSendValue: false,
    leavesStandingPositionDefault: false,
  },
  "wsteth-unwrap": {
    adapterId: "wsteth-unwrap",
    lineage: "wsteth",
    edgeKind: "protocol",
    action: "unwrap",
    canSendValue: false,
    leavesStandingPositionDefault: false,
  },
  "metronome-synth-swap": {
    adapterId: "metronome-synth-swap",
    lineage: "metronome",
    edgeKind: "protocol",
    action: "convert",
    canSendValue: false,
    leavesStandingPositionDefault: false,
  },
  "weth-deposit-value": {
    adapterId: "weth-deposit-value",
    lineage: "weth",
    edgeKind: "protocol",
    action: "wrap",
    canSendValue: true,
    leavesStandingPositionDefault: false,
  },
  "weth-withdraw": {
    adapterId: "weth-withdraw",
    lineage: "weth",
    edgeKind: "protocol",
    action: "unwrap",
    canSendValue: false,
    leavesStandingPositionDefault: false,
  },
  "weth-withdraw-amount": {
    adapterId: "weth-withdraw-amount",
    lineage: "weth",
    edgeKind: "protocol",
    action: "unwrap",
    canSendValue: false,
    leavesStandingPositionDefault: false,
  },
};

export function descriptorFor(adapterId: string): AdapterDescriptor | null {
  const descriptor = (ADAPTER_DESCRIPTORS as Partial<Record<string, AdapterDescriptor>>)[adapterId];
  return descriptor ?? null;
}
