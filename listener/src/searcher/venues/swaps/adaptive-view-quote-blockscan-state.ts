import { ethers } from "ethers";
import type { TokenEdge } from "../../planner/token-graph.js";
import {
  type BlockScanStateCapability,
  type BuildCurrentBlockReadsInput,
  type StateRead,
  type StateReadResult,
} from "../blockscan-state-capability.js";
import type { RouteVenueMidKind } from "../mid-readers.js";
import { edgeInstanceKey } from "../route-instance-identity.js";
import {
  BLOCKSCAN_MULTICALL3,
  currentBlockRead,
  decodeMulticall,
  encodeMulticall,
  midsForDirectedEdges,
  optionalMulticallData,
  quotedPoolMid,
  requireRead,
  type MulticallItem,
} from "./blockscan-state-shared.js";

export interface AdaptiveViewQuoteContext<Static> {
  readonly sourceBlock: number;
  readonly sourceBlockHash: string;
  readonly stateKey: string;
  readonly edge: TokenEdge;
  readonly static: Static;
  readonly priorResults: readonly StateReadResult[];
}

export interface AdaptiveQuoteCall {
  readonly target: string;
  readonly data: string;
}

export interface AdaptiveViewQuoteConfig<Static> {
  readonly kind: Extract<
    RouteVenueMidKind,
    "curve-underlying" | "external-swap"
  >;
  readonly edgeAdapterIds: ReadonlySet<string>;
  stateKey?(edge: TokenEdge): string;
  compileDirection(edge: TokenEdge): Static;
  initialReads(
    ctx: Omit<AdaptiveViewQuoteContext<Static>, "priorResults">,
  ): readonly StateRead[];
  quoteCandidates(ctx: AdaptiveViewQuoteContext<Static>): readonly bigint[];
  quoteCall(
    ctx: AdaptiveViewQuoteContext<Static>,
    amountIn: bigint,
  ): AdaptiveQuoteCall;
  decodeQuote(edge: TokenEdge, data: string): bigint;
  dependencies?(
    edge: TokenEdge,
    staticState: Static,
  ): readonly string[];
}

export interface AdaptiveViewQuoteGroup<Static> {
  readonly stateKey: string;
  readonly edge: TokenEdge;
  readonly static: Static;
}

export interface AdaptiveViewQuoteSchema<Static> {
  readonly groups: ReadonlyMap<string, AdaptiveViewQuoteGroup<Static>>;
}

export interface AdaptiveViewQuoteSnapshot {
  readonly stateKey: string;
  readonly amountIn: bigint;
  readonly amountOut: bigint;
}

/**
 * Direction-local current-block quotes with a family-owned input ladder.
 *
 * Families emit ordinary prerequisite reads in round 0. Round 1 executes all
 * candidate calls inside one allow-failure Multicall and publishes only a
 * genuinely successful positive quote. Reverts and zero outputs remain
 * unresolved; they are never converted into an unavailable edge.
 */
export function createAdaptiveCurrentBlockViewQuoteCapability<Static>(
  config: AdaptiveViewQuoteConfig<Static>,
): BlockScanStateCapability<
  AdaptiveViewQuoteSchema<Static>,
  AdaptiveViewQuoteSnapshot
> {
  const stateKey = config.stateKey ?? directedViewQuoteStateKey;
  const capability: BlockScanStateCapability<
    AdaptiveViewQuoteSchema<Static>,
    AdaptiveViewQuoteSnapshot
  > = {
    stateKey,

    compileStaticSchema({ edges }) {
      const groups = new Map<string, AdaptiveViewQuoteGroup<Static>>();
      for (const edge of edges) {
        if (!config.edgeAdapterIds.has(edge.adapterId)) {
          throw new Error(`adaptive view-quote family does not own ${edge.adapterId}`);
        }
        const key = stateKey(edge);
        if (!key || groups.has(key)) {
          throw new Error(`duplicate or empty adaptive view-quote state key ${key}`);
        }
        groups.set(key, Object.freeze({
          stateKey: key,
          edge,
          static: config.compileDirection(edge),
        }));
      }
      return Object.freeze({ groups });
    },

    buildCurrentBlockReads(input) {
      const group = requireGroup(input, stateKey);
      const reads = config.initialReads({
        sourceBlock: input.sourceBlock,
        sourceBlockHash: input.sourceBlockHash,
        stateKey: group.stateKey,
        edge: group.edge,
        static: group.static,
      });
      if (reads.length === 0) {
        throw new Error(
          `adaptive view-quote ${group.stateKey} emitted no prerequisite reads`,
        );
      }
      const ids = new Set<string>();
      for (const read of reads) {
        if (!read.id || ids.has(read.id)) {
          throw new Error(`duplicate or empty adaptive prerequisite read ${read.id}`);
        }
        ids.add(read.id);
      }
      return Object.freeze([...reads]);
    },

    buildDependentBlockReads(input) {
      if (input.completedRound > 0) return Object.freeze([]);
      const group = requireGroup(input, stateKey);
      const ctx = Object.freeze({
        sourceBlock: input.sourceBlock,
        sourceBlockHash: input.sourceBlockHash,
        stateKey: group.stateKey,
        edge: group.edge,
        static: group.static,
        priorResults: input.priorResults,
      });
      const candidates = normalizeCandidates(config.quoteCandidates(ctx));
      const items = quoteItems(config, ctx, candidates);
      return Object.freeze([
        currentBlockRead({
          id: adaptiveQuoteReadId(group.stateKey),
          sourceBlock: input.sourceBlock,
          sourceBlockHash: input.sourceBlockHash,
          to: BLOCKSCAN_MULTICALL3,
          data: encodeMulticall(items),
          transport: "rpc-batch",
        }),
      ]);
    },

    decodeState(schema, results) {
      const group = findResultGroup(schema, results);
      const first = results[0];
      if (!first) throw new Error("adaptive view-quote state has no reads");
      const ctx = Object.freeze({
        sourceBlock: first.sourceBlock,
        sourceBlockHash: first.sourceBlockHash,
        stateKey: group.stateKey,
        edge: group.edge,
        static: group.static,
        priorResults: results,
      });
      const candidates = normalizeCandidates(config.quoteCandidates(ctx));
      const items = quoteItems(config, ctx, candidates);
      const decoded = decodeMulticall(
        requireRead(results, adaptiveQuoteReadId(group.stateKey)),
        items,
      );
      for (let index = 0; index < candidates.length; index++) {
        const data = optionalMulticallData(decoded, quoteItemLabel(index));
        if (!data) continue;
        const amountOut = config.decodeQuote(group.edge, data);
        if (amountOut <= 0n) continue;
        return Object.freeze({
          stateKey: group.stateKey,
          amountIn: candidates[index],
          amountOut,
        });
      }
      throw new Error(
        `adaptive current-N quote returned no positive result for ${group.stateKey}`,
      );
    },

    deriveMids(snapshot, edges) {
      if (edges.length !== 1 || stateKey(edges[0]) !== snapshot.stateKey) {
        throw new Error(
          `adaptive view-quote snapshot ${snapshot.stateKey} used for a different direction`,
        );
      }
      return midsForDirectedEdges(edges, (edge) =>
        quotedPoolMid({
          kind: config.kind,
          edge,
          amountIn: snapshot.amountIn,
          amountOut: snapshot.amountOut,
          depthIn: snapshot.amountIn * 10_000n,
          depthOut: snapshot.amountOut * 10_000n,
        })
      );
    },

    dependencies(edges) {
      if (edges.length !== 1) {
        throw new Error("adaptive view-quote dependency group must contain one edge");
      }
      const edge = edges[0];
      const staticState = config.compileDirection(edge);
      return Object.freeze([
        ...new Set([
          ethers.getAddress(edge.target).toLowerCase(),
          ethers.getAddress(edge.tokenIn).toLowerCase(),
          ethers.getAddress(edge.tokenOut).toLowerCase(),
          ...(config.dependencies?.(edge, staticState) ?? []).map((address) =>
            ethers.getAddress(address).toLowerCase()
          ),
        ]),
      ]);
    },
  };
  return Object.freeze(capability);
}

export function directedViewQuoteStateKey(edge: TokenEdge): string {
  return [
    edgeInstanceKey(edge),
    edge.curveI ?? "",
    edge.curveJ ?? "",
    ethers.getAddress(edge.tokenIn).toLowerCase(),
    ethers.getAddress(edge.tokenOut).toLowerCase(),
  ].join("\u001f");
}

function requireGroup<Static>(
  input: BuildCurrentBlockReadsInput<AdaptiveViewQuoteSchema<Static>>,
  stateKey: (edge: TokenEdge) => string,
): AdaptiveViewQuoteGroup<Static> {
  if (input.edges.length !== 1) {
    throw new Error("adaptive view-quote state group must contain one edge");
  }
  const key = stateKey(input.edges[0]);
  const group = input.schema.groups.get(key);
  if (!group) throw new Error(`adaptive view-quote schema missing ${key}`);
  return group;
}

function findResultGroup<Static>(
  schema: AdaptiveViewQuoteSchema<Static>,
  results: readonly StateReadResult[],
): AdaptiveViewQuoteGroup<Static> {
  const matches = [...schema.groups.values()].filter((group) =>
    results.some((result) => result.id === adaptiveQuoteReadId(group.stateKey))
  );
  if (matches.length !== 1) {
    throw new Error(`adaptive view-quote results matched ${matches.length} state groups`);
  }
  return matches[0];
}

function quoteItems<Static>(
  config: AdaptiveViewQuoteConfig<Static>,
  ctx: AdaptiveViewQuoteContext<Static>,
  candidates: readonly bigint[],
): readonly MulticallItem[] {
  return Object.freeze(candidates.map((amountIn, index) => {
    const call = config.quoteCall(ctx, amountIn);
    return Object.freeze({
      label: quoteItemLabel(index),
      target: call.target,
      callData: call.data,
      allowFailure: true,
    });
  }));
}

function normalizeCandidates(input: readonly bigint[]): readonly bigint[] {
  const candidates: bigint[] = [];
  const seen = new Set<string>();
  for (const amount of input) {
    if (amount <= 0n || amount > ethers.MaxUint256) continue;
    const key = amount.toString();
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push(amount);
  }
  if (candidates.length === 0 || candidates.length > 32) {
    throw new Error(
      `adaptive view-quote requires 1..32 positive candidates, got ${candidates.length}`,
    );
  }
  return Object.freeze(candidates);
}

function adaptiveQuoteReadId(stateKey: string): string {
  return `adaptive-quote:${stateKey}`;
}

function quoteItemLabel(index: number): string {
  return `candidate:${index}`;
}
