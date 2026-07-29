import { createHash } from "node:crypto";
import { ethers } from "ethers";
import { get as getActionAdapter } from "../../adapters/registry.js";
import { compilePlan } from "../../shared/compiler/compiler.js";
import {
  DEFAULT_SEARCHER_EXECUTOR,
} from "../../shared/executor/botvm-executor.js";
import type { ResolvedPlan } from "../solver/solver.js";
import type { TokenEdge } from "../planner/token-graph.js";
import { PRODUCTION_ADAPTER_FAMILIES } from "../venues/production-registry.js";
import {
  planExecutionIdentityMatchesEdge,
  resolvedPlanExecutionIdentity,
} from "../venues/route-instance-identity.js";

type RegisteredRouteFamily = ReturnType<
  ReturnType<
    typeof PRODUCTION_ADAPTER_FAMILIES.routes
  >["forEdge"]
>;

export interface ResolvedActionExecutionSurface {
  readonly actionAdapterId: string;
  readonly target: string;
  readonly selector: string;
  readonly calldataSha256: string;
}

export interface ResolvedRouteExecutionSurface {
  /** Logical graph-edge adapter identity. */
  readonly adapterId: string;
  readonly familyId: string;
  /** Family-owned route root selected from the final resolved plan. */
  readonly rootActionAdapterId: string;
  /** Physical external target/selector of that route root. */
  readonly target: string;
  readonly selector: string;
  readonly calldataSha256: string;
  /** Ordered pre-order closure, including non-call guard/opcode nodes. */
  readonly subtreeActionAdapterIds: readonly string[];
  /**
   * Every externally executing action in the selected subtree. Wrapper root
   * calldata commits its real child bytes; child calls are listed separately
   * so the declarative trace witness must also account for them.
   */
  readonly actionCalls: readonly ResolvedActionExecutionSurface[];
}

export interface ResolvedPlanExecutionEvidence {
  readonly fundingActionAdapterId: string;
  readonly routes: readonly ResolvedRouteExecutionSurface[];
  /**
   * Ordered direct children of the funding wrapper that are not a route root.
   * They are accepted only when they are ownerless and declared infra.
   * Token-changing support is additionally frozen below so the independent
   * target/final trace verifier can require semantic and byte-level coverage.
   * Family-owned multi-root fragments still fail closed until production
   * retains explicit per-leg provenance.
   */
  readonly supportActionAdapterIds: readonly string[];
  /** Every external support call that must also satisfy the route witness. */
  readonly supportExecutionCalls:
    readonly ResolvedActionExecutionSurface[];
}

/**
 * Binds each logical edge to one family-owned route root and the complete
 * executable subtree selected by the solver. No path-specific family name or
 * target appears here. Plan fragments with ambiguous sibling ownership fail
 * closed instead of being guessed back into a leg after provenance was lost.
 */
export function resolvedPlanExecutionEvidence(
  edges: readonly TokenEdge[],
  root: ResolvedPlan["root"],
): ResolvedPlanExecutionEvidence {
  return resolvedPlanExecutionEvidenceCore(edges, root, true);
}

function resolvedPlanExecutionEvidenceCore(
  edges: readonly TokenEdge[],
  root: ResolvedPlan["root"],
  requireFundingOwner: boolean,
): ResolvedPlanExecutionEvidence {
  const fundingFamily =
    PRODUCTION_ADAPTER_FAMILIES.findFundingByAction(root.adapterId);
  if (
    requireFundingOwner &&
    (
      !fundingFamily ||
      PRODUCTION_ADAPTER_FAMILIES.ownerForAction(root.adapterId) !==
        fundingFamily.id
    )
  ) {
    throw new Error(
      `resolved plan funding root ${root.adapterId} lacks one owner`,
    );
  }
  const topLevel = root.children;
  const selectedIndexes = new Set<number>();
  const routes: ResolvedRouteExecutionSurface[] = [];
  let cursor = 0;

  for (let edgeIndex = 0; edgeIndex < edges.length; edgeIndex++) {
    const edge = edges[edgeIndex];
    const family = PRODUCTION_ADAPTER_FAMILIES.routes().forEdge(
      edge.adapterId,
    );
    let selectedIndex = -1;
    for (let index = cursor; index < topLevel.length; index++) {
      const node = topLevel[index];
      if (
        PRODUCTION_ADAPTER_FAMILIES.ownerForAction(node.adapterId) !==
          family.id ||
        !resolvedNodeMatchesEdge(family, node, edge)
      ) {
        continue;
      }
      selectedIndex = index;
      break;
    }
    if (selectedIndex < 0) {
      throw new Error(
        `resolved plan route execution identity is out of order; ` +
          `no family-owned route root for leg ` +
          `${edgeIndex + 1}:${edge.adapterId}`,
      );
    }
    const node = topLevel[selectedIndex];
    selectedIndexes.add(selectedIndex);
    cursor = selectedIndex + 1;
    const subtree = planSubtree(node);
    for (const action of subtree) {
      const owner = PRODUCTION_ADAPTER_FAMILIES.ownerForAction(
        action.adapterId,
      );
      const allowedInfra =
        owner === null &&
        family.requiredInfraActionAdapterIds.includes(action.adapterId);
      if (owner !== family.id && !allowedInfra) {
        throw new Error(
          `${family.id} resolved subtree uses foreign action ` +
            action.adapterId,
        );
      }
      assertExecutableTreeShape(action);
    }
    const actionCalls = subtree.flatMap(actionExecutionSurfaces);
    const rootCalls = actionExecutionSurfaces(node);
    const rootCall = rootCalls[0];
    if (!rootCall) {
      throw new Error(
        `resolved route root ${node.adapterId} emits no external call`,
      );
    }
    routes.push(Object.freeze({
      adapterId: edge.adapterId,
      familyId: family.id,
      rootActionAdapterId: node.adapterId,
      target: rootCall.target,
      selector: rootCall.selector,
      calldataSha256: rootCall.calldataSha256,
      subtreeActionAdapterIds: Object.freeze(
        subtree.map((action) => action.adapterId),
      ),
      actionCalls: Object.freeze(actionCalls),
    }));
  }

  const requiredSupport = new Set([
    ...(fundingFamily?.requiredInfraActionAdapterIds ?? []),
    ...edges.flatMap((edge) =>
      PRODUCTION_ADAPTER_FAMILIES.routes()
        .forEdge(edge.adapterId)
        .requiredInfraActionAdapterIds),
  ]);
  const supportActionAdapterIds: string[] = [];
  const supportExecutionCalls: ResolvedActionExecutionSurface[] = [];
  for (let index = 0; index < topLevel.length; index++) {
    if (selectedIndexes.has(index)) continue;
    const node = topLevel[index];
    if (
      PRODUCTION_ADAPTER_FAMILIES.ownerForAction(node.adapterId) !== null ||
      !requiredSupport.has(node.adapterId) ||
      node.children.length !== 0
    ) {
      throw new Error(
        `resolved plan has ambiguous non-route action ${node.adapterId}`,
      );
    }
    getActionAdapter(node.adapterId);
    supportActionAdapterIds.push(node.adapterId);
    supportExecutionCalls.push(...actionExecutionSurfaces(node));
  }

  return Object.freeze({
    fundingActionAdapterId: root.adapterId,
    routes: Object.freeze(routes),
    supportActionAdapterIds: Object.freeze(supportActionAdapterIds),
    supportExecutionCalls: Object.freeze(supportExecutionCalls),
  });
}

export function resolvedRouteExecutionSurfaces(
  edges: readonly TokenEdge[],
  root: ResolvedPlan["root"],
): readonly ResolvedRouteExecutionSurface[] {
  return resolvedPlanExecutionEvidenceCore(edges, root, false).routes;
}

function resolvedNodeMatchesEdge(
  family: RegisteredRouteFamily,
  node: ResolvedPlan["root"],
  edge: TokenEdge,
): boolean {
  try {
    return (
      node.tokenIn.toLowerCase() === edge.tokenIn.toLowerCase() &&
      planExecutionIdentityMatchesEdge(
        resolvedPlanExecutionIdentity(family, node),
        edge,
      )
    );
  } catch {
    return false;
  }
}

function planSubtree(
  root: ResolvedPlan["root"],
): readonly ResolvedPlan["root"][] {
  const result: ResolvedPlan["root"][] = [];
  const visit = (node: ResolvedPlan["root"]): void => {
    result.push(node);
    node.children.forEach(visit);
  };
  visit(root);
  return result;
}

function assertExecutableTreeShape(node: ResolvedPlan["root"]): void {
  const adapter = getActionAdapter(node.adapterId);
  if (!adapter.isWrapper && node.children.length > 0) {
    throw new Error(
      `non-wrapper ${node.adapterId} has ignored resolved-plan children`,
    );
  }
}

function actionExecutionSurfaces(
  node: ResolvedPlan["root"],
): readonly ResolvedActionExecutionSurface[] {
  const calls = encodedExternalCalls(
    compilePlan(node, DEFAULT_SEARCHER_EXECUTOR),
  );
  if (
    calls.length > 0 &&
    calls[0].target !== node.target.toLowerCase()
  ) {
    throw new Error(
      `resolved action target ${calls[0].target} differs from ${node.target}`,
    );
  }
  return Object.freeze(calls.map((call) => Object.freeze({
    actionAdapterId: node.adapterId,
    target: call.target,
    selector: call.selector,
    calldataSha256: createHash("sha256")
      .update(call.calldata)
      .digest("hex"),
  })));
}

function encodedExternalCalls(
  encoded: Uint8Array,
): readonly {
  readonly target: string;
  readonly selector: string;
  readonly calldata: string;
}[] {
  let cursor = 0;
  const calls: Array<{
    readonly target: string;
    readonly selector: string;
    readonly calldata: string;
  }> = [];
  const requireBytes = (count: number): void => {
    if (cursor + count > encoded.length) {
      throw new Error("encoded action is truncated");
    }
  };
  const uint24At = (offset: number): number =>
    encoded[offset] * 0x1_0000 +
      encoded[offset + 1] * 0x100 +
      encoded[offset + 2];
  while (cursor < encoded.length) {
    const opcode = encoded[cursor];
    if (opcode === 0x00 || opcode === 0x01) {
      const headerLength = opcode === 0x00 ? 24 : 36;
      requireBytes(headerLength);
      const lengthOffset = cursor + (opcode === 0x00 ? 21 : 33);
      const payloadOffset = cursor + headerLength;
      const payloadLength = uint24At(lengthOffset);
      if (payloadLength < 4 || payloadOffset + payloadLength > encoded.length) {
        throw new Error("encoded external call lacks complete calldata");
      }
      const calldata = ethers.hexlify(
        encoded.slice(payloadOffset, payloadOffset + payloadLength),
      ).toLowerCase();
      calls.push({
        target: ethers.hexlify(
          encoded.slice(cursor + 1, cursor + 21),
        ).toLowerCase(),
        selector: calldata.slice(0, 10),
        calldata,
      });
      cursor = payloadOffset + payloadLength;
      continue;
    }
    if (opcode === 0x02 || opcode === 0x06) {
      requireBytes(4);
      cursor += 4;
      continue;
    }
    if (opcode === 0x03) {
      requireBytes(4);
      const payloadLength = uint24At(cursor + 1);
      requireBytes(4 + payloadLength);
      cursor += 4 + payloadLength;
      continue;
    }
    if (opcode === 0x04 || opcode === 0x05 || opcode === 0x07) {
      cursor += 1;
      continue;
    }
    if (opcode === 0x08) {
      requireBytes(53);
      cursor += 53;
      continue;
    }
    throw new Error(
      `encoded action has unknown BotVM opcode 0x${opcode.toString(16)}`,
    );
  }
  return Object.freeze(calls);
}
