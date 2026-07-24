import { ethers } from "ethers";
import type { ResolvedPlanNode } from "../../../shared/types/plan.js";
import type { StateKeyCoverage } from "../blockscan-state-capability.js";
import type { FlashLoanAdapterFamily } from "../route-leg-adapter.js";
import {
  fundingReadId,
  registerFundingFamily,
  type FundingCapability,
  type FundingLineageId,
  type FundingOffer,
  type FundingProviderId,
  type FundingSource,
  type RegisteredFundingFamily,
} from "./funding-capability.js";

const MAX_UINT = (1n << 256n) - 1n;
const ERC20 = new ethers.Interface([
  "function balanceOf(address account) view returns (uint256)",
]);

export type FlashRepayment = "approve-pull" | "transfer";
export type FlashParamShape = "none" | "tokens-and-amounts";

export interface FlashLoanRootInput {
  readonly flashToken: string;
  readonly flashAmount: bigint;
  readonly minProfit: bigint;
  readonly children: readonly ResolvedPlanNode[];
}

interface BalanceSchema {
  readonly holder: string;
}

interface BalanceSnapshot {
  readonly amountsByFundingId: ReadonlyMap<string, bigint>;
  readonly coverageByReadKey: ReadonlyMap<
    string,
    ReadonlyMap<string, StateKeyCoverage>
  >;
}

export interface Erc20BalanceFlashFundingConfig {
  readonly familyId: FundingProviderId;
  readonly actionAdapterId: string;
  readonly lineage: FundingLineageId;
  readonly target: string;
  readonly liquidityHolder: string;
  readonly repayment: FlashRepayment;
  readonly paramShape: FlashParamShape;
  readonly planningPriority: number;
  readonly liquidityPriority: number;
}

/**
 * Shared ERC20-balance funding shell. A provider family contributes only its
 * holder and callback/repayment semantics; current-N reads, typed decoding,
 * coverage and pure offer derivation are reused.
 */
export function createErc20BalanceFlashFundingCapability(
  configInput: Erc20BalanceFlashFundingConfig,
): RegisteredFundingFamily {
  const config = Object.freeze({
    ...configInput,
    target: ethers.getAddress(configInput.target),
    liquidityHolder: ethers.getAddress(configInput.liquidityHolder),
  });
  const capability: FundingCapability<BalanceSchema, BalanceSnapshot> = {
    actionAdapterId: config.actionAdapterId,
    lineage: config.lineage,
    target: config.target,
    liquidityHolder: config.liquidityHolder,
    repayment: config.repayment,
    paramShape: config.paramShape,
    planningPriority: config.planningPriority,
    liquidityPriority: config.liquidityPriority,
    sources(assets) {
      return Object.freeze(
        [...new Set(assets.map((asset) => ethers.getAddress(asset)))]
          .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()))
          .map((asset): FundingSource => {
            const fundingId = fundingKey(config.familyId, asset);
            return Object.freeze({
              fundingId,
              instanceKey: config.target.toLowerCase(),
              provider: config.target,
              stateKey: fundingId,
              asset,
              requiredReadKeys: Object.freeze(["balance"]),
            });
          }),
      );
    },
    compileStaticSchema() {
      return Object.freeze({ holder: config.liquidityHolder });
    },
    buildCurrentBlockReadPlans({ source, schema, sources }) {
      return Object.freeze(sources.map((fundingSource) => Object.freeze({
        id: fundingReadId(fundingSource.stateKey, "balance"),
        sourceBlock: source.number,
        sourceBlockHash: source.hash,
        to: fundingSource.asset,
        data: ERC20.encodeFunctionData("balanceOf", [schema.holder]),
        transport: "multicall-safe" as const,
      })));
    },
    decodeCurrentBlockState({ sources, results }) {
      const byId = new Map(results.map((result) => [result.id, result]));
      const amountsByFundingId = new Map<string, bigint>();
      const coverageByReadKey = new Map<
        string,
        ReadonlyMap<string, StateKeyCoverage>
      >();
      for (const source of sources) {
        const result = byId.get(fundingReadId(source.stateKey, "balance"));
        let coverage: StateKeyCoverage;
        if (!result?.ok) {
          coverage = Object.freeze({
            status: "unresolved" as const,
            reason: result?.error ?? "missing current-N balance read",
          });
        } else {
          try {
            const [amount] = ERC20.decodeFunctionResult("balanceOf", result.data);
            amountsByFundingId.set(source.fundingId, BigInt(amount));
            coverage = Object.freeze({ status: "resolved" as const });
          } catch (error) {
            coverage = Object.freeze({
              status: "unresolved" as const,
              reason: `invalid balanceOf result: ${
                error instanceof Error ? error.message : String(error)
              }`,
            });
          }
        }
        coverageByReadKey.set(
          source.stateKey,
          new Map([["balance", coverage]]),
        );
      }
      return Object.freeze({
        snapshot: Object.freeze({
          amountsByFundingId: new Map(amountsByFundingId),
          coverageByReadKey: new Map(coverageByReadKey),
        }),
        coverageByReadKey: new Map(coverageByReadKey),
      });
    },
    deriveOffers(snapshot, sources) {
      const offers = new Map<string, FundingOffer>();
      const coverageByFundingId = new Map<string, StateKeyCoverage>();
      for (const source of sources) {
        const readCoverage = snapshot.coverageByReadKey
          .get(source.stateKey)
          ?.get("balance");
        if (readCoverage?.status !== "resolved") {
          coverageByFundingId.set(
            source.fundingId,
            readCoverage ?? Object.freeze({
              status: "unresolved" as const,
              reason: "missing balance coverage",
            }),
          );
          continue;
        }
        const maxBorrow = snapshot.amountsByFundingId.get(source.fundingId);
        if (maxBorrow === undefined) {
          coverageByFundingId.set(source.fundingId, Object.freeze({
            status: "unresolved" as const,
            reason: "resolved balance read did not produce an offer",
          }));
          continue;
        }
        offers.set(source.fundingId, Object.freeze({
          fundingId: source.fundingId,
          asset: source.asset,
          maxBorrow,
          fee: 0n,
          actionAdapterId: config.actionAdapterId,
          planningPriority: config.planningPriority,
          liquidityPriority: config.liquidityPriority,
        }));
        coverageByFundingId.set(
          source.fundingId,
          Object.freeze({ status: "resolved" as const }),
        );
      }
      return Object.freeze({
        offers: new Map(offers),
        coverageByFundingId: new Map(coverageByFundingId),
      });
    },
    buildRepaymentFragment(_offer, amount): ResolvedPlanNode {
      if (config.repayment === "transfer") {
        return {
          adapterId: "erc20-transfer",
          target: _offer.asset,
          tokenIn: _offer.asset,
          tokenOut: _offer.asset,
          amount,
          params: { to: config.target, amount },
          children: [],
        };
      }
      return {
        adapterId: "erc20-approve",
        target: _offer.asset,
        tokenIn: _offer.asset,
        tokenOut: _offer.asset,
        amount: MAX_UINT,
        params: { spender: config.target, amount: MAX_UINT },
        children: [],
      };
    },
    buildBorrowFragment(input) {
      const children = [...input.children];
      children.push({
        adapterId: "assert-balance",
        target: input.offer.asset,
        tokenIn: input.offer.asset,
        tokenOut: input.offer.asset,
        amount: input.amount + input.minProfit,
        params: {},
        children: [],
      });
      children.push(capability.buildRepaymentFragment(input.offer, input.amount));
      const params: Record<string, string[] | bigint[]> =
        config.paramShape === "tokens-and-amounts"
          ? { tokens: [input.offer.asset], amounts: [input.amount] }
          : {};
      return {
        adapterId: config.actionAdapterId,
        target: config.target,
        tokenIn: input.offer.asset,
        tokenOut: input.offer.asset,
        amount: input.amount,
        params,
        children,
      };
    },
  };
  return registerFundingFamily(config.familyId, capability);
}

/**
 * Compatibility entrypoint for the existing planner. Encoding is still
 * provider-owned through the registered capability; this wrapper only adapts
 * the planner's historical argument shape.
 */
export function buildFlashLoanRoot(
  family: FlashLoanAdapterFamily,
  input: FlashLoanRootInput,
): ResolvedPlanNode {
  const asset = ethers.getAddress(input.flashToken);
  const offer: FundingOffer = Object.freeze({
    fundingId: fundingKey(family.id, asset),
    asset,
    maxBorrow: input.flashAmount,
    fee: 0n,
    actionAdapterId: family.funding.actionAdapterId,
    planningPriority: family.funding.planningPriority,
    liquidityPriority: family.funding.liquidityPriority,
  });
  return family.funding.buildBorrowFragment({
    offer,
    amount: input.flashAmount,
    minProfit: input.minProfit,
    children: input.children,
  });
}

export function assertFlashFamilyConservation(
  family: FlashLoanAdapterFamily,
  input: {
    lenderBalanceBefore: bigint;
    lenderBalanceAfter: bigint;
  },
): void {
  if (input.lenderBalanceAfter < input.lenderBalanceBefore) {
    throw new Error(
      `flash family ${family.id} under-repaid lender: ` +
        `${input.lenderBalanceAfter} < ${input.lenderBalanceBefore}`,
    );
  }
}

function fundingKey(familyId: string, token: string): string {
  return `${familyId}\u001f${ethers.getAddress(token).toLowerCase()}`;
}
