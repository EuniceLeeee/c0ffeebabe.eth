import { ethers } from "ethers";
import type { Lineage } from "../../../adapters/adapter-descriptors.js";
import type { ActionAdapter, ResolvedPlanNode } from "../../../types.js";
import {
  defineFundingFamily,
  type DefinedFamilyPlugin,
  type FamilyManifest,
  type FamilyOwnedActionAdapter,
  type FundingDomainSemantics,
  type FundingFamilyPlugin,
  type FundingOfferDescriptor,
  type FundingSourceDescriptor,
} from "../adapter-family-plugin.js";
import {
  familyId,
  lineageId,
  type FamilyId,
  type LineageId,
} from "../adapter-family-identifiers.js";
import type {
  AdapterRequestResult,
} from "../adapter-request-program.js";
import { bindFamilyOwnedAction } from "../family-owned-action.js";
import type { PlanFragment } from "../route-leg-adapter.js";

const MAX_UINT256 = (1n << 256n) - 1n;
const ERC20 = new ethers.Interface([
  "function balanceOf(address account) view returns (uint256)",
]);

export interface Erc20BalanceFundingSource extends FundingSourceDescriptor {
  readonly familyId: FamilyId;
  readonly lineageId: LineageId;
  readonly liquidityHolder: string;
}

export interface Erc20BalanceFundingEvidence {
  readonly balances: readonly {
    readonly fundingId: string;
    readonly maxBorrow: bigint;
  }[];
}

export interface Erc20BalanceFundingFamilyConfig {
  readonly familyId: string;
  readonly lineageId: Lineage;
  readonly action: ActionAdapter;
  readonly target: string;
  readonly liquidityHolder: string;
  readonly repayment: "approve-pull" | "transfer";
  readonly paramShape: "none" | "tokens-and-amounts";
  readonly planningPriority: number;
  readonly liquidityPriority: number;
  readonly requiredInfraActionAdapterIds: readonly string[];
}

/**
 * Strict Funding-domain shell for providers whose source-N capacity is the
 * ERC20 balance held by a singleton lender. It declares reads and pure plan
 * fragments only; transport, retry, batching and publication remain central.
 */
export function createErc20BalanceFundingFamily(
  input: Erc20BalanceFundingFamilyConfig,
): DefinedFamilyPlugin<FundingFamilyPlugin<
  Erc20BalanceFundingSource,
  Erc20BalanceFundingEvidence
>> {
  return defineFundingFamily({
    manifest: createErc20BalanceFundingManifest(input),
    funding: createErc20BalanceFundingSemantics(input),
    actionAdapters: [createErc20BalanceFundingOwnedAction(input)],
  });
}

export function createErc20BalanceFundingManifest(
  input: Erc20BalanceFundingFamilyConfig,
): FamilyManifest<"funding"> {
  const id = familyId(input.familyId);
  const lineage = lineageId(input.lineageId);
  return Object.freeze({
    familyId: id,
    domain: "funding" as const,
    ownedActionAdapterIds: Object.freeze([input.action.id]),
    requiredInfraActionAdapterIds: Object.freeze([
      ...input.requiredInfraActionAdapterIds,
    ]),
    allowedTaxonomy: Object.freeze([{ slotKind: "flash" as const }]),
    supportedLineages: Object.freeze([lineage]),
  });
}

export function createErc20BalanceFundingOwnedAction(
  input: Pick<Erc20BalanceFundingFamilyConfig, "action" | "lineageId">,
): FamilyOwnedActionAdapter {
  return ownedFlashAction(input.action, input.lineageId);
}

export function createErc20BalanceFundingSemantics(
  input: Erc20BalanceFundingFamilyConfig,
): FundingDomainSemantics<
    Erc20BalanceFundingSource,
    Erc20BalanceFundingEvidence
  > {
  const id = familyId(input.familyId);
  const lineage = lineageId(input.lineageId);
  const target = ethers.getAddress(input.target);
  const liquidityHolder = ethers.getAddress(input.liquidityHolder);
  const funding: FundingDomainSemantics<
    Erc20BalanceFundingSource,
    Erc20BalanceFundingEvidence
  > = {
      liquidity: {
        sources: (assets) => Object.freeze(
          [...new Set(assets.map((asset) => ethers.getAddress(asset)))]
            .sort((left, right) =>
              left.toLowerCase().localeCompare(right.toLowerCase())
            )
            .map((asset): Erc20BalanceFundingSource => {
              const fundingId = fundingKey(id, asset);
              return Object.freeze({
                familyId: id,
                lineageId: lineage,
                fundingId,
                instanceKey: target.toLowerCase(),
                provider: target,
                stateKey: fundingId,
                asset,
                liquidityHolder,
                requiredReadKeys: Object.freeze(["balance"]),
              });
            }),
        ),
        program: {
          requirements: () => ({ transports: ["eth-call"] }),
          buildRequests: ({ sources }) => Object.freeze(sources.map((source) => {
            assertSource(source, id, lineage, target, liquidityHolder);
            return Object.freeze({
              id: balanceRequestId(source),
              kind: "eth-call" as const,
              to: source.asset,
              data: ERC20.encodeFunctionData("balanceOf", [liquidityHolder]),
              completion: "return-data" as const,
            });
          })),
          decode: ({ programInput, results }) => Object.freeze({
            balances: Object.freeze(programInput.sources.map((source) => {
              const result = successfulResult(results, balanceRequestId(source));
              const [balance] = ERC20.decodeFunctionResult(
                "balanceOf",
                result.data,
              );
              return Object.freeze({
                fundingId: source.fundingId,
                maxBorrow: BigInt(balance),
              });
            })),
          }),
        },
        deriveOffers: ({ evidence, sources }) => {
          const sourceByFundingId = new Map(
            sources.map((source) => [source.fundingId, source]),
          );
          return Object.freeze(evidence.balances.map((balance) => {
            const source = sourceByFundingId.get(balance.fundingId);
            if (source === undefined) {
              throw new Error(
                `funding evidence references unknown source ${balance.fundingId}`,
              );
            }
            return Object.freeze({
              fundingId: source.fundingId,
              asset: source.asset,
              maxBorrow: balance.maxBorrow,
              fee: 0n,
              actionAdapterId: input.action.id,
              planningPriority: input.planningPriority,
              liquidityPriority: input.liquidityPriority,
            });
          }));
        },
      },
      repayment: {
        target,
        liquidityHolder,
        mode: input.repayment,
        paramShape: input.paramShape,
        buildRepaymentFragment: ({ offer, amount }) => {
          assertOffer(offer, id, input.action.id);
          assertAmount(amount);
          if (amount > offer.maxBorrow) {
            throw new Error(
              `funding repayment ${amount} exceeds offer ${offer.maxBorrow}`,
            );
          }
          return repaymentFragment(input.repayment, target, offer, amount);
        },
        buildBorrowFragment: (borrow) => {
          assertOffer(borrow.offer, id, input.action.id);
          assertAmount(borrow.amount);
          assertAmount(borrow.minProfit);
          if (borrow.amount > borrow.offer.maxBorrow) {
            throw new Error(
              `funding borrow ${borrow.amount} exceeds offer ${borrow.offer.maxBorrow}`,
            );
          }
          const repayment = repaymentFragment(
            input.repayment,
            target,
            borrow.offer,
            borrow.amount,
          );
          const nestedNodes = borrow.children.flatMap((child) => child.nodes);
          const requirements = Object.freeze([
            ...borrow.children.flatMap((child) => child.requirements),
            ...repayment.requirements,
          ]);
          const params: ResolvedPlanNode["params"] =
            input.paramShape === "tokens-and-amounts"
              ? {
                  tokens: [borrow.offer.asset],
                  amounts: [borrow.amount],
                }
              : {};
          if (Array.isArray(params.tokens)) Object.freeze(params.tokens);
          if (Array.isArray(params.amounts)) Object.freeze(params.amounts);
          Object.freeze(params);
          const assertBalanceChildren: ResolvedPlanNode[] = [];
          const assertBalance: ResolvedPlanNode = {
            adapterId: "assert-balance",
            target: borrow.offer.asset,
            tokenIn: borrow.offer.asset,
            tokenOut: borrow.offer.asset,
            amount: borrow.amount + borrow.minProfit,
            params: {},
            children: assertBalanceChildren,
          };
          Object.freeze(assertBalance.params);
          Object.freeze(assertBalanceChildren);
          Object.freeze(assertBalance);
          const children: ResolvedPlanNode[] = [
            ...nestedNodes,
            assertBalance,
            ...repayment.nodes,
          ];
          Object.freeze(children);
          const root: ResolvedPlanNode = {
            adapterId: input.action.id,
            target,
            tokenIn: borrow.offer.asset,
            tokenOut: borrow.offer.asset,
            amount: borrow.amount,
            params,
            children,
          };
          Object.freeze(root);
          const nodes: ResolvedPlanNode[] = [root];
          Object.freeze(nodes);
          return Object.freeze({
            requirements,
            nodes,
          });
        },
      },
  };
  return Object.freeze(funding);
}

function repaymentFragment(
  mode: "approve-pull" | "transfer",
  target: string,
  offer: FundingOfferDescriptor,
  amount: bigint,
): PlanFragment {
  assertAmount(amount);
  const children: ResolvedPlanNode[] = [];
  Object.freeze(children);
  const node: ResolvedPlanNode = mode === "transfer"
    ? {
        adapterId: "erc20-transfer",
        target: offer.asset,
        tokenIn: offer.asset,
        tokenOut: offer.asset,
        amount,
        params: { to: target, amount },
        children,
      }
    : {
        adapterId: "erc20-approve",
        target: offer.asset,
        tokenIn: offer.asset,
        tokenOut: offer.asset,
        amount: MAX_UINT256,
        params: { spender: target, amount: MAX_UINT256 },
        children,
      };
  Object.freeze(node.params);
  Object.freeze(node);
  const nodes: ResolvedPlanNode[] = [node];
  Object.freeze(nodes);
  return Object.freeze({
    requirements: Object.freeze([]),
    nodes,
  });
}

function ownedFlashAction(
  action: ActionAdapter,
  lineage: Lineage,
): FamilyOwnedActionAdapter {
  return bindFamilyOwnedAction({
    action,
    descriptor: {
      adapterId: action.id,
      lineage,
      edgeKind: "flash",
      action: "flash",
      canSendValue: false,
      leavesStandingPositionDefault: false,
    },
  });
}

function assertSource(
  source: Erc20BalanceFundingSource,
  id: FamilyId,
  lineage: LineageId,
  target: string,
  liquidityHolder: string,
): void {
  if (
    source.familyId !== id ||
    source.lineageId !== lineage ||
    ethers.getAddress(source.provider) !== target ||
    ethers.getAddress(source.liquidityHolder) !== liquidityHolder ||
    source.fundingId !== fundingKey(id, source.asset)
  ) {
    throw new Error(`funding source ${source.fundingId} escaped its Family binding`);
  }
}

function assertOffer(
  offer: FundingOfferDescriptor,
  id: FamilyId,
  actionAdapterId: string,
): void {
  assertAmount(offer.maxBorrow);
  if (
    offer.actionAdapterId !== actionAdapterId ||
    offer.fundingId !== fundingKey(id, offer.asset) ||
    offer.fee !== 0n
  ) {
    throw new Error(
      `funding offer ${offer.fundingId} escaped ${id}/${actionAdapterId}`,
    );
  }
}

function assertAmount(amount: bigint): void {
  if (typeof amount !== "bigint" || amount < 0n || amount > MAX_UINT256) {
    throw new Error("funding amount must fit uint256");
  }
}

function successfulResult(
  results: readonly AdapterRequestResult[],
  id: string,
): Extract<AdapterRequestResult, { readonly ok: true }> {
  const result = results.find((candidate) => candidate.id === id);
  if (result === undefined || !result.ok) {
    throw new Error(`funding balance request ${id} did not resolve`);
  }
  return result;
}

function balanceRequestId(source: Erc20BalanceFundingSource): string {
  return `funding-balance:${source.fundingId}`;
}

function fundingKey(id: FamilyId, asset: string): string {
  return `${id}\u001f${ethers.getAddress(asset).toLowerCase()}`;
}
