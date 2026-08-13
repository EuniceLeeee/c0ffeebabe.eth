import { ethers } from "ethers";
import { compilePlan } from "../shared/compiler/compiler.js";
import { bytesToHex } from "../shared/compiler/encoder.js";
import { buildExecuteCalldata } from
  "../shared/executor/botvm-executor.js";
import type { ResolvedPlanNode } from "../shared/types/plan.js";
import { buildFundingBorrowFragment } from "./adapter-funding-runtime.js";
import type {
  GenericCaptureFinalSimulation,
  GenericCaptureFundingPlan,
  GenericCaptureFinalSimulationInput,
} from "./generic-family-capture.js";
import { RevmSimClient } from "./revm-sim-client.js";
import type { CanonicalValue } from "./venues/canonical-value.js";

/**
 * Real fork execution for complete capture plans. Route and Credit fragments
 * are nested under a catalog-issued Funding root, whose own plugin inserts
 * the repayment/assert-balance tail. Funding captures execute that same root
 * with no route child. Nothing is inferred from expectedEffects.
 */
export function createGenericCaptureRevmFinalSimulation(input: {
  readonly client: RevmSimClient;
  readonly rpcUrl: string;
  readonly owner: string;
  readonly executor: string;
}): GenericCaptureFinalSimulation {
  const owner = ethers.getAddress(input.owner);
  const executor = ethers.getAddress(input.executor);
  return Object.freeze({
    async simulate(
      request: GenericCaptureFinalSimulationInput,
    ): Promise<CanonicalValue> {
      const routeFragment = request.kind === "funding"
        ? null
        : request.routeFragment;
      if (routeFragment !== null && routeFragment.nodes.length !== 1) {
        throw new Error("generic final simulation requires one route root node");
      }
      const closed = closePlan(request.funding, routeFragment);
      if (closed.requirements.length !== 0) {
        throw new Error(
          "generic final simulation cannot execute out-of-callback requirements",
        );
      }
      if (closed.nodes.length !== 1) {
        throw new Error("generic final simulation requires one Funding root node");
      }
      const root = closed.nodes[0]!;
      const scriptHex = bytesToHex(compilePlan(root, executor));
      const calldata = buildExecuteCalldata(ethers.getBytes(scriptHex));
      const response = await input.client.strictSimulate({
        blockNumber: request.source.number,
        rpcUrl: input.rpcUrl,
        from: owner,
        to: executor,
        data: calldata,
        gasLimit: 0x1000000,
        observeTokens: uniqueAddresses(collectTokens(root)),
        observeAccounts: uniqueAddresses([owner, executor, ...collectAddresses(root)]),
        observeTotalSupply: uniqueAddresses(collectTokens(root)),
        observeLogs: true,
      });
      if ((response.missingStateKeys?.length ?? 0) !== 0) {
        throw new Error(
          `generic final simulation missing state: ` +
            response.missingStateKeys!.slice(0, 6).join(","),
        );
      }
      return Object.freeze({
        sourceBlock: request.source.number,
        sourceBlockHash: request.source.hash,
        semanticId: request.semanticId,
        kind: request.kind,
        success: response.success === true,
        revertReason: response.success === true
          ? null
          : response.revertReason ?? response.error ?? "unknown",
        gasUsed: String(response.gasUsed ?? "0"),
        scriptHash: ethers.sha256(scriptHex),
        calldataHash: ethers.sha256(calldata),
        observed: Object.freeze({
          tokenDeltas: Object.freeze((response.strict?.tokenDeltas ?? []).map(
            (delta) => Object.freeze({
              token: delta.token.toLowerCase(),
              account: delta.account.toLowerCase(),
              delta: delta.delta,
            }),
          )),
          totalSupplyDeltas: Object.freeze(
            (response.strict?.totalSupplyDeltas ?? []).map((delta) =>
              Object.freeze({
                token: delta.token.toLowerCase(),
                delta: delta.delta,
              })
            ),
          ),
          logsHash: ethers.sha256(ethers.toUtf8Bytes(JSON.stringify(
            response.strict?.logs ?? [],
          ))),
        }),
        safety: finalSafety(response, request, root, executor),
      });
    },
  });
}

function closePlan(
  funding: GenericCaptureFundingPlan,
  route: import("./venues/route-leg-adapter.js").PlanFragment | null,
) {
  const requirementNodes: readonly ResolvedPlanNode[] = route === null
    ? []
    : route.requirements.map((requirement): ResolvedPlanNode => {
        if (requirement.kind === "approve") {
          return {
              adapterId: "erc20-approve",
              target: requirement.token,
              tokenIn: requirement.token,
              tokenOut: requirement.token,
              amount: requirement.amount,
              params: {
                spender: requirement.spender,
                amount: requirement.amount,
              },
              children: [],
          };
        }
        return {
          adapterId: "erc20-transfer",
          target: requirement.token,
          tokenIn: requirement.token,
          tokenOut: requirement.token,
          amount: requirement.amount,
          params: { to: requirement.pool, amount: requirement.amount },
          children: [],
        };
      });
  const routeChild = route === null
    ? Object.freeze([])
    : Object.freeze([Object.freeze({
        requirements: Object.freeze([]),
        nodes: Object.freeze([
          ...requirementNodes,
          ...route.nodes,
        ]),
      })]);
  return buildFundingBorrowFragment({
    family: funding.family,
    offer: funding.offer,
    source: funding.offer.source,
    generation: funding.offer.generation,
    amount: funding.amount,
    minProfit: funding.minProfit,
    children: routeChild,
  });
}

function finalSafety(
  response: Awaited<ReturnType<RevmSimClient["strictSimulate"]>>,
  request: GenericCaptureFinalSimulationInput,
  root: ResolvedPlanNode,
  executor: string,
): CanonicalValue {
  const funding = request.funding;
  const asset = funding.offer.asset.toLowerCase();
  const canonicalExecutor = executor.toLowerCase();
  const deltas = response.strict?.tokenDeltas ?? [];
  const executorDelta = deltas
    .filter((delta) =>
      delta.token.toLowerCase() === asset &&
      delta.account.toLowerCase() === canonicalExecutor
    )
    .reduce((total, delta) => total + BigInt(delta.delta), 0n);
  const supplyByToken = new Map(
    (response.strict?.totalSupplyDeltas ?? []).map((delta) => [
      delta.token.toLowerCase(),
      BigInt(delta.delta),
    ]),
  );
  const balanceByToken = new Map<string, bigint>();
  for (const delta of deltas) {
    const token = delta.token.toLowerCase();
    balanceByToken.set(
      token,
      (balanceByToken.get(token) ?? 0n) + BigInt(delta.delta),
    );
  }
  const conservation = [...new Set(collectTokens(root).map((token) =>
    token.toLowerCase()
  ))].sort().map((token) => {
    const balanceDelta = balanceByToken.get(token) ?? 0n;
    const supplyDelta = supplyByToken.get(token) ?? 0n;
    return Object.freeze({
      token,
      observedBalanceDelta: balanceDelta.toString(),
      observedSupplyDelta: supplyDelta.toString(),
      residual: (balanceDelta - supplyDelta).toString(),
    });
  });
  const success = response.success === true;
  const repaymentSatisfied = success && executorDelta >= funding.minProfit;
  const conservationSatisfied = success && conservation.every((item) =>
    item.residual === "0"
  );
  return Object.freeze({
    fundingFamilyId: funding.offer.familyId,
    fundingId: funding.offer.fundingId,
    borrowedAsset: asset,
    borrowedAmount: funding.amount.toString(),
    requiredMinProfit: funding.minProfit.toString(),
    repaymentGuardExecuted: success,
    repaymentSatisfied,
    tokenConservationObserved: response.strict !== undefined,
    tokenConservationSatisfied: conservationSatisfied,
    conservation,
    standingPositionResult: success
      ? request.kind === "credit"
        ? "plugin-position-plan-executed"
        : "closed-plan-executed"
      : "simulation-reverted",
    executorAssetDelta: executorDelta.toString(),
    grossProfit: executorDelta.toString(),
    netProfitBeforeGas: executorDelta.toString(),
  });
}

function collectTokens(root: {
  readonly tokenIn: string;
  readonly tokenOut: string;
  readonly children: readonly unknown[];
}): string[] {
  const tokens = [root.tokenIn, root.tokenOut];
  for (const child of root.children) {
    if (
      child !== null && typeof child === "object" &&
      "tokenIn" in child && "tokenOut" in child && "children" in child
    ) {
      tokens.push(...collectTokens(child as Parameters<typeof collectTokens>[0]));
    }
  }
  return tokens;
}

function collectAddresses(root: {
  readonly target: string;
  readonly params?: Readonly<Record<string, unknown>>;
  readonly children: readonly unknown[];
}): string[] {
  const addresses = [root.target];
  for (const value of Object.values(root.params ?? {})) {
    if (typeof value === "string" && ethers.isAddress(value)) {
      addresses.push(value);
    }
  }
  for (const child of root.children) {
    if (
      child !== null && typeof child === "object" &&
      "target" in child && "children" in child
    ) {
      addresses.push(...collectAddresses(
        child as Parameters<typeof collectAddresses>[0],
      ));
    }
  }
  return addresses;
}

function uniqueAddresses(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => ethers.getAddress(value).toLowerCase()))]
    .sort();
}
