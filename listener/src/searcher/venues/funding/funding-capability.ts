import type { ResolvedPlanNode } from "../../../shared/types/plan.js";
import type {
  BlockSource,
  StateKeyCoverage,
  StateOperationControl,
  StateRead,
  StateReadResult,
} from "../blockscan-state-capability.js";

declare const fundingProviderIdBrand: unique symbol;
declare const fundingLineageIdBrand: unique symbol;

/**
 * Plugin-owned provider and execution-lineage identities. New providers mint
 * validated IDs in their own module; no central literal union is extended.
 */
export type FundingProviderId = `flash-loan:${string}` & {
  readonly [fundingProviderIdBrand]: "FundingProviderId";
};
export type FundingLineageId = string & {
  readonly [fundingLineageIdBrand]: "FundingLineageId";
};

export function fundingProviderId(value: string): FundingProviderId {
  if (!/^flash-loan:[a-z0-9]+(?:[-.:][a-z0-9]+)*$/.test(value)) {
    throw new Error(
      "funding provider id must be a normalized non-empty flash-loan:* id",
    );
  }
  return value as FundingProviderId;
}

export function fundingLineageId(value: string): FundingLineageId {
  if (!/^[a-z0-9]+(?:[-.:][a-z0-9]+)*$/.test(value)) {
    throw new Error("funding lineage id must be a normalized non-empty id");
  }
  return value as FundingLineageId;
}

export interface FundingSource {
  readonly fundingId: string;
  readonly instanceKey: string;
  readonly provider: string;
  readonly stateKey: string;
  readonly asset: string;
  readonly requiredReadKeys: readonly string[];
}

export interface FundingOffer {
  readonly fundingId: string;
  readonly asset: string;
  readonly maxBorrow: bigint;
  readonly fee: bigint;
  readonly actionAdapterId: string;
  readonly planningPriority: number;
  readonly liquidityPriority: number;
}

export interface DecodedFundingState<Snapshot> {
  readonly snapshot: Snapshot;
  readonly coverageByReadKey: ReadonlyMap<
    string,
    ReadonlyMap<string, StateKeyCoverage>
  >;
}

export interface DerivedFundingOffers {
  readonly offers: ReadonlyMap<string, FundingOffer>;
  readonly coverageByFundingId: ReadonlyMap<string, StateKeyCoverage>;
}

export interface FundingBuildContext {
  readonly offer: FundingOffer;
  readonly amount: bigint;
  readonly minProfit: bigint;
  readonly children: readonly ResolvedPlanNode[];
}

/**
 * Provider-owned funding semantics. The coordinator owns transport, deadlines,
 * provenance and publication; a family owns the source schema, decoding,
 * offer derivation and borrow/repayment encoding.
 */
export interface FundingCapability<Schema, Snapshot> {
  readonly actionAdapterId: string;
  readonly lineage: FundingLineageId;
  readonly target: string;
  readonly liquidityHolder: string;
  readonly repayment: "approve-pull" | "transfer";
  readonly paramShape: "none" | "tokens-and-amounts";
  /** Lower values are preferred by path templates. */
  readonly planningPriority: number;
  /** Lower values preserve equal-balance liquidity tie breaking. */
  readonly liquidityPriority: number;

  sources(assets: readonly string[]): readonly FundingSource[];
  compileStaticSchema(
    sources: readonly FundingSource[],
    control: StateOperationControl,
  ): Schema | Promise<Schema>;
  buildCurrentBlockReadPlans(input: {
    readonly source: BlockSource;
    readonly schema: Schema;
    readonly sources: readonly FundingSource[];
  }): readonly StateRead[];
  decodeCurrentBlockState(input: {
    readonly source: BlockSource;
    readonly schema: Schema;
    readonly sources: readonly FundingSource[];
    readonly results: readonly StateReadResult[];
  }): DecodedFundingState<Snapshot>;
  deriveOffers(
    snapshot: Snapshot,
    sources: readonly FundingSource[],
  ): DerivedFundingOffers;
  buildBorrowFragment(input: FundingBuildContext): ResolvedPlanNode;
  buildRepaymentFragment(
    offer: FundingOffer,
    amount: bigint,
  ): ResolvedPlanNode;
}

export interface PreparedFundingFamily {
  readonly familyId: FundingProviderId;
  readonly source: BlockSource;
  readonly sources: readonly FundingSource[];
  readonly reads: readonly StateRead[];
  readonly actionAdapterId: string;
  readonly planningPriority: number;
  readonly liquidityPriority: number;
  decodeAndDerive(results: readonly StateReadResult[]): {
    readonly decodedCoverage: ReadonlyMap<
      string,
      ReadonlyMap<string, StateKeyCoverage>
    >;
    readonly derived: DerivedFundingOffers;
  };
}

/**
 * Existential wrapper: concrete Schema/Snapshot types stay captured inside
 * this closure. The shared runtime never stores or casts family state through
 * `unknown`.
 */
export interface RegisteredFundingFamily {
  readonly familyId: FundingProviderId;
  readonly actionAdapterId: string;
  readonly lineage: FundingLineageId;
  readonly target: string;
  readonly liquidityHolder: string;
  readonly repayment: "approve-pull" | "transfer";
  readonly paramShape: "none" | "tokens-and-amounts";
  readonly planningPriority: number;
  readonly liquidityPriority: number;
  buildBorrowFragment(input: FundingBuildContext): ResolvedPlanNode;
  buildRepaymentFragment(
    offer: FundingOffer,
    amount: bigint,
  ): ResolvedPlanNode;
  describeSources(assets: readonly string[]): readonly FundingSource[];
  prepare(input: {
    readonly assets: readonly string[];
    readonly source: BlockSource;
    readonly control: StateOperationControl;
  }): Promise<PreparedFundingFamily>;
}

export function registerFundingFamily<Schema, Snapshot>(
  familyId: FundingProviderId,
  capability: FundingCapability<Schema, Snapshot>,
): RegisteredFundingFamily {
  const validatedFamilyId = fundingProviderId(familyId);
  const validatedLineage = fundingLineageId(capability.lineage);
  return Object.freeze({
    familyId: validatedFamilyId,
    actionAdapterId: capability.actionAdapterId,
    lineage: validatedLineage,
    target: capability.target,
    liquidityHolder: capability.liquidityHolder,
    repayment: capability.repayment,
    paramShape: capability.paramShape,
    planningPriority: capability.planningPriority,
    liquidityPriority: capability.liquidityPriority,
    buildBorrowFragment: (input: FundingBuildContext) =>
      capability.buildBorrowFragment(input),
    buildRepaymentFragment: (offer: FundingOffer, amount: bigint) =>
      capability.buildRepaymentFragment(offer, amount),
    describeSources: (assets: readonly string[]) =>
      Object.freeze([...capability.sources(assets)]),
    async prepare(input: {
      readonly assets: readonly string[];
      readonly source: BlockSource;
      readonly control: StateOperationControl;
    }): Promise<PreparedFundingFamily> {
      const sources = Object.freeze([...capability.sources(input.assets)]);
      const schema = await capability.compileStaticSchema(sources, input.control);
      const reads = Object.freeze([
        ...capability.buildCurrentBlockReadPlans({
          source: input.source,
          schema,
          sources,
        }),
      ]);
      return Object.freeze({
        familyId: validatedFamilyId,
        source: input.source,
        sources,
        reads,
        actionAdapterId: capability.actionAdapterId,
        planningPriority: capability.planningPriority,
        liquidityPriority: capability.liquidityPriority,
        decodeAndDerive(results: readonly StateReadResult[]) {
          const decoded = capability.decodeCurrentBlockState({
            source: input.source,
            schema,
            sources,
            results,
          });
          if (isThenable(decoded)) {
            throw new Error(
              `funding family ${familyId} decodeCurrentBlockState must be synchronous`,
            );
          }
          const derived = capability.deriveOffers(decoded.snapshot, sources);
          if (isThenable(derived)) {
            throw new Error(
              `funding family ${familyId} deriveOffers must be synchronous and pure`,
            );
          }
          return Object.freeze({
            decodedCoverage: decoded.coverageByReadKey,
            derived,
          });
        },
      });
    },
  });
}

export function fundingReadId(stateKey: string, readKey: string): string {
  return `${stateKey}\u001e${readKey}`;
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    "then" in value &&
    typeof (value as { then?: unknown }).then === "function"
  );
}
