import type { EdgeKind } from "../searcher/strategy-taxonomy.js";
import type { FundingLineageId } from
  "../searcher/venues/funding/funding-capability.js";

export type Lineage =
  | "univ2" | "univ3" | "univ4" | "curve" | "balancer-flash" | "morpho-flash"
  | "angstrom-v4"
  | "psm" | "erc4626" | "goldx" | "rocksolid" | "wsteth" | "metronome" | "weth"
  | "eigenpie" | "self-burn-native"
  | "fluid-credit" | "fluid-dex" | "balancer-v3" | "dodo-v2" | "erc20-infra"
  | `custom-swap:${string}`
  | `custom-protocol:${string}`
  | FundingLineageId;

/** Descriptor action vocabulary: superset covering all edge kinds. */
export type AdapterAction =
  | "swap" | "flash" | "deposit" | "redeem" | "wrap" | "unwrap" | "convert"
  | "borrow" | "repay" | "supply" | "withdraw" | "approve" | "transfer" | "guard";

/**
 * Semantic descriptor owned by the same strict Family definition as its
 * encoder. Production registration rejects actions without this descriptor;
 * there is no central fallback table.
 */
export interface AdapterDescriptor {
  adapterId: string;
  lineage: Lineage;
  edgeKind: EdgeKind | null;
  action: AdapterAction;
  canSendValue: boolean;
  leavesStandingPositionDefault: boolean;
}
