import { ethers } from "ethers";
import { ADDR } from "../../shared/constants/addresses.js";
import type { StateBackend } from "../../shared/state/state-backend.js";
import type { TokenEdge, TokenQueryBackend } from "../planner/token-graph.js";
import type { PoolImpact } from "./pool-impact.js";

export interface VictimEdgeSelector {
  adapterId: string;
  target?: string;
  tokenIn?: string;
  tokenOut?: string;
}

export interface SwapVictimEffect {
  kind: "swap";
  impact: PoolImpact;
}

export interface OracleVictimEffect {
  kind: "oracle";
  descriptorId: string;
  priceScope: VictimEdgeSelector[];
  affectedEdges: VictimEdgeSelector[];
  priceChanges: OraclePriceChange[];
  maxSearchHops: number;
}

export interface OraclePriceChange extends VictimEdgeSelector {
  target: string;
  tokenIn: string;
  tokenOut: string;
  probeAmountIn: bigint;
  beforeAmountOut: bigint;
  afterAmountOut: bigint;
}

export type VictimEffect = SwapVictimEffect | OracleVictimEffect;

interface DirectCallMatcher {
  kind: "direct";
  target: string;
  selectors: string[];
}

interface ForwardedCallMatcher {
  kind: "forwarded";
  forwarder: string;
  signature: string;
  targetArg: number;
  dataArg: number;
  target: string;
  selectors: string[];
}

type VictimCallMatcher = DirectCallMatcher | ForwardedCallMatcher;

interface OracleVictimDescriptor {
  id: string;
  matcher: VictimCallMatcher;
  affectedEdges: VictimEdgeSelector[];
  priceProbe: OracleEdgePriceProbe;
  maxSearchHops: number;
}

interface OracleEdgePriceProbe {
  signature: string;
  functionName: string;
  amountIn: bigint;
  outputIndex: number;
}

/**
 * Protocol trigger facts live here as data. Detector, planner, and solver only
 * understand the generic oracle effect and never encode a protocol route or
 * amount. Adding another oracle is a descriptor entry, not a new pipeline.
 */
const ORACLE_VICTIM_DESCRIPTORS: readonly OracleVictimDescriptor[] = [
  {
    id: "metronome-eth-usd",
    matcher: {
      kind: "forwarded",
      forwarder: ADDR.METRONOME_ORACLE_FORWARDER,
      signature: "forward(address target, bytes data)",
      targetArg: 0,
      dataArg: 1,
      target: ADDR.METRONOME_ORACLE,
      selectors: ["0xb1dc65a4"],
    },
    affectedEdges: [
      { adapterId: "metronome-synth-swap", target: ADDR.METRONOME_SYNTH_POOL },
    ],
    priceProbe: {
      signature:
        "quoteSwapOut(address syntheticTokenIn, address syntheticTokenOut, uint256 amountIn) " +
        "view returns (uint256 amountOut, uint256 fee)",
      functionName: "quoteSwapOut",
      amountIn: 10n ** 18n,
      outputIndex: 0,
    },
    maxSearchHops: 8,
  },
];

export function oracleVictimWatchTargets(): string[] {
  return uniqueAddresses(
    ORACLE_VICTIM_DESCRIPTORS.map((descriptor) =>
      descriptor.matcher.kind === "direct"
        ? descriptor.matcher.target
        : descriptor.matcher.forwarder,
    ),
  );
}

export async function matchOracleVictimEffect(
  to: string | null,
  input: string,
  graph: TokenEdge[],
  before: TokenQueryBackend | null,
  beforeBlock: number,
  after: Pick<StateBackend, "call">,
): Promise<OracleVictimEffect | null> {
  const descriptor = ORACLE_VICTIM_DESCRIPTORS.find((candidate) =>
    matchesCall(candidate.matcher, to, input),
  );
  if (!descriptor || !before) return null;

  const candidateEdges = uniqueEdges(graph.filter((edge) =>
    descriptor.affectedEdges.some((selector) => edgeMatchesSelector(edge, selector)),
  ));
  const changes = await Promise.all(
    candidateEdges.map((edge) => probePriceChange(
      descriptor.priceProbe,
      edge,
      before,
      beforeBlock,
      after,
    )),
  );
  const priceChanges = changes.filter((change): change is OraclePriceChange => change !== null);
  if (priceChanges.length === 0) return null;

  return {
    kind: "oracle",
    descriptorId: descriptor.id,
    priceScope: descriptor.affectedEdges.map((selector) => ({ ...selector })),
    affectedEdges: priceChanges.map(({ adapterId, target, tokenIn, tokenOut }) => ({
      adapterId,
      target,
      tokenIn,
      tokenOut,
    })),
    priceChanges,
    maxSearchHops: descriptor.maxSearchHops,
  };
}

export function oracleAffectedGraphEdges(
  graph: TokenEdge[],
  effect: OracleVictimEffect,
): TokenEdge[] {
  return graph.filter((edge) =>
    effect.affectedEdges.some((selector) => edgeMatchesSelector(edge, selector)),
  );
}

export function edgeMatchesVictimSelector(
  edge: TokenEdge,
  selector: VictimEdgeSelector,
): boolean {
  return edgeMatchesSelector(edge, selector);
}

function matchesCall(matcher: VictimCallMatcher, to: string | null, input: string): boolean {
  if (!to) return false;
  if (matcher.kind === "direct") {
    return sameAddress(to, matcher.target) && selectorMatches(input, matcher.selectors);
  }
  if (!sameAddress(to, matcher.forwarder)) return false;

  const iface = new ethers.Interface([`function ${matcher.signature}`]);
  const fragment = iface.fragments.find((candidate) => candidate.type === "function");
  if (
    !fragment ||
    input.slice(0, 10).toLowerCase() !==
      (fragment as ethers.FunctionFragment).selector.toLowerCase()
  ) {
    return false;
  }
  try {
    const decoded = iface.decodeFunctionData(fragment as ethers.FunctionFragment, input);
    const forwardedTarget = String(decoded[matcher.targetArg]);
    const forwardedData = String(decoded[matcher.dataArg]);
    return sameAddress(forwardedTarget, matcher.target) &&
      selectorMatches(forwardedData, matcher.selectors);
  } catch {
    return false;
  }
}

function selectorMatches(input: string, selectors: string[]): boolean {
  const selector = input.slice(0, 10).toLowerCase();
  return selectors.some((candidate) => candidate.toLowerCase() === selector);
}

function edgeMatchesSelector(edge: TokenEdge, selector: VictimEdgeSelector): boolean {
  return edge.adapterId === selector.adapterId &&
    (!selector.target || sameAddress(edge.target, selector.target)) &&
    (!selector.tokenIn || sameAddress(edge.tokenIn, selector.tokenIn)) &&
    (!selector.tokenOut || sameAddress(edge.tokenOut, selector.tokenOut));
}

async function probePriceChange(
  probe: OracleEdgePriceProbe,
  edge: TokenEdge,
  before: TokenQueryBackend,
  beforeBlock: number,
  after: Pick<StateBackend, "call">,
): Promise<OraclePriceChange | null> {
  const iface = new ethers.Interface([`function ${probe.signature}`]);
  const data = iface.encodeFunctionData(probe.functionName, [
    edge.tokenIn,
    edge.tokenOut,
    probe.amountIn,
  ]);
  try {
    const [beforeRaw, afterRaw] = await Promise.all([
      before.call({ to: edge.target, data, blockTag: beforeBlock }),
      after.call({ to: edge.target, data }),
    ]);
    const beforeDecoded = iface.decodeFunctionResult(probe.functionName, beforeRaw);
    const afterDecoded = iface.decodeFunctionResult(probe.functionName, afterRaw);
    const beforeAmountOut = BigInt(beforeDecoded[probe.outputIndex]);
    const afterAmountOut = BigInt(afterDecoded[probe.outputIndex]);
    if (beforeAmountOut === afterAmountOut) return null;
    return {
      adapterId: edge.adapterId,
      target: edge.target,
      tokenIn: edge.tokenIn,
      tokenOut: edge.tokenOut,
      probeAmountIn: probe.amountIn,
      beforeAmountOut,
      afterAmountOut,
    };
  } catch {
    return null;
  }
}

function uniqueEdges(edges: TokenEdge[]): TokenEdge[] {
  const seen = new Set<string>();
  return edges.filter((edge) => {
    const key = [
      edge.adapterId,
      edge.target,
      edge.tokenIn,
      edge.tokenOut,
      edge.poolId ?? "",
    ].map((part) => part.toLowerCase()).join(":");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function sameAddress(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

function uniqueAddresses(addresses: string[]): string[] {
  return [...new Map(addresses.map((address) => [address.toLowerCase(), address])).values()];
}
