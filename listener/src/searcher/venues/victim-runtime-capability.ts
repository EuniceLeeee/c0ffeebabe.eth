import type { StateBackend } from "../../shared/state/state-backend.js";
import type { TokenEdge } from "../planner/token-graph.js";
import type {
  PoolStateCache,
  PostImpactSeed,
} from "../solver/pool-state-cache.js";
import type { PoolImpact } from "./swap-observation.js";

export interface LocalVictimApplyResult {
  readonly postImpact: PostImpactSeed;
  readonly amountOut: bigint;
}

export interface LocalVictimApplyContext {
  readonly cache: PoolStateCache;
  readonly impact: PoolImpact;
  readonly blockNumber: number;
  readonly state?: StateBackend;
  readonly control: VictimRuntimeCallControl;
}

export interface VictimLocalApplyCapability {
  /** True only when the callback consumes PoolStateCache pre-state. */
  readonly cacheBacked: boolean;
  /** Whether a cache miss may be repaired by the shared mutable-pool updater. */
  readonly needsMutablePoolRefresh: boolean;
  apply(
    ctx: LocalVictimApplyContext,
  ): Promise<LocalVictimApplyResult | null> | LocalVictimApplyResult | null;
}

export interface OverlayTokenDeal {
  token: string;
  to: string;
  amount: string;
  balanceSlot?: number;
}

export interface OverlayPreCall {
  from: string;
  to: string;
  calldata: string;
  gasLimit?: number;
  allowanceSlot?: number;
}

export interface VictimOverlay {
  /** Whale account that needs ETH funding for gas (engine funds it). */
  whale: string;
  tokenDeals: OverlayTokenDeal[];
  preCalls: OverlayPreCall[];
}

export interface VictimOverlayBuildContext {
  readonly impact: PoolImpact;
  readonly graph: readonly TokenEdge[];
  readonly control: VictimRuntimeCallControl;
  /**
   * Generic pinned-state read. Family callbacks own ABI selection and result
   * decoding; the replay coordinator never learns a venue-specific view.
   */
  read(req: { readonly to: string; readonly data: string }): Promise<string>;
}

export interface VictimRuntimeCapability {
  readonly localApply: VictimLocalApplyCapability | null;
  readonly exactPostImpact:
    ((
      impact: PoolImpact,
      blockNumber: number,
      control: VictimRuntimeCallControl,
    ) => Promise<PostImpactSeed | null> | PostImpactSeed | null) | null;
  readonly buildOverlay:
    ((ctx: VictimOverlayBuildContext) => Promise<VictimOverlay>) | null;
}

export type VictimRuntimeStage =
  | "local-apply"
  | "exact-post-impact"
  | "overlay";

export interface VictimRuntimeCallControl {
  readonly deadlineAtMs: number;
  readonly signal: AbortSignal;
}

export type VictimRuntimeStageResult<T> =
  | {
      readonly ok: true;
      readonly familyId: string;
      readonly stage: VictimRuntimeStage;
      readonly elapsedMs: number;
      readonly value: T;
    }
  | {
      readonly ok: false;
      readonly familyId: string;
      readonly stage: VictimRuntimeStage;
      readonly elapsedMs: number;
      readonly timedOut: boolean;
      readonly reason: string;
    };
