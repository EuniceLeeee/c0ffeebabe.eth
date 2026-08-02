import { ethers } from "ethers";
import type { TokenEdge } from "../../planner/token-graph.js";
import type {
  BlockScanStateCapability,
  BuildCurrentBlockReadsInput,
  StateRead,
  StateReadResult,
} from "../blockscan-state-capability.js";
import { blockScanEdgeKey } from "../blockscan-state-capability.js";
import type { RouteVenueMid } from "../mid-readers.js";
import { edgeInstanceKey } from "../route-instance-identity.js";

const erc20MetadataIface = new ethers.Interface([
  "function decimals() view returns (uint8)",
]);

export interface ProtocolQuoteRead {
  readonly suffix: string;
  readonly to: string;
  readonly data: string;
  /**
   * Opt in only when the view result is independent of msg.sender. The local
   * backend may then collapse many current-block reads into one aggregate3
   * call; the default preserves direct eth_call semantics.
   */
  readonly transport?: StateRead["transport"];
}

export interface ProtocolQuoteSnapshot {
  readonly results: ReadonlyMap<string, string>;
  readonly amountInByToken: ReadonlyMap<string, bigint>;
}

export interface ProtocolQuoteStateConfig {
  readonly familyId: string;
  readonly edgeAdapterIds: readonly string[];
  /** See BlockScanStateCapability.addressTouchCarryPolicy. */
  readonly addressTouchCarryPolicy?: "dependency-touch";
  /**
   * The default groups all directions at one contract. Multi-pair singleton
   * protocols can add their pair identity so unrelated instances fail
   * independently.
   */
  readonly stateKey?: (edge: TokenEdge) => string;
  readonly buildQuoteReads: (
    edge: TokenEdge,
    amountIn: bigint,
  ) => readonly ProtocolQuoteRead[];
  /**
   * Optional bounded follow-up reads whose calldata depends on prior
   * current-block results. completedRound=1 follows the initial quote round.
   */
  readonly buildDependentQuoteReads?: (
    edge: TokenEdge,
    amountIn: bigint,
    completedRound: number,
    result: (suffix: string) => string,
  ) => readonly ProtocolQuoteRead[];
  readonly deriveAmountOut: (
    edge: TokenEdge,
    amountIn: bigint,
    result: (suffix: string) => string,
  ) => bigint;
  /**
   * Family opt-in for view methods whose token metadata does not provide a
   * sufficiently large quote probe. Each follow-up is still a current-block
   * coordinator-owned read; the family declares the finite expansion bound.
   */
  readonly adaptiveProbe?: {
    readonly stepMultiplier: bigint;
    /** Initial quote plus at most four coordinator dependent rounds. */
    readonly maxDependentRounds: number;
  };
  readonly extraDependencies?: (edges: readonly TokenEdge[]) => readonly string[];
}

export interface ProtocolQuoteSchema {
  readonly familyId: string;
  readonly edgeAdapterIds: readonly string[];
  readonly amountInByToken: ReadonlyMap<string, bigint>;
}

/**
 * Current-block quote capability shared by protocol-conversion families.
 *
 * Token decimals are graph-fingerprint-scoped static schema. Every generation
 * batches one family-owned current-N view plan per edge using exactly one
 * token as the probe amount. The coordinator owns source pinning,
 * cancellation and publication; this framework performs no I/O and keeps
 * deriveMids synchronous.
 */
export function createProtocolQuoteStateCapability(
  config: ProtocolQuoteStateConfig,
): BlockScanStateCapability<ProtocolQuoteSchema, ProtocolQuoteSnapshot> {
  const allowed = new Set(config.edgeAdapterIds);
  if (!config.familyId || allowed.size === 0) {
    throw new Error("protocol pricing capability requires a family and edge adapters");
  }
  validateAdaptiveProbe(config);
  const capability: BlockScanStateCapability<
    ProtocolQuoteSchema,
    ProtocolQuoteSnapshot
  > = {
    ...(config.addressTouchCarryPolicy
      ? { addressTouchCarryPolicy: config.addressTouchCarryPolicy }
      : {}),
    stateKey(edge: TokenEdge): string {
      requireOwnedEdge(config.familyId, allowed, edge);
      return (config.stateKey?.(edge) ?? edgeInstanceKey(edge)).toLowerCase();
    },

    compileStaticSchema({ edges, deadlineAtMs, signal }): ProtocolQuoteSchema {
      if (signal.aborted) throw abortError(signal.reason);
      if (Date.now() >= deadlineAtMs) throw new Error(`${config.familyId} schema deadline expired`);
      for (const edge of edges) requireOwnedEdge(config.familyId, allowed, edge);
      return Object.freeze({
        familyId: config.familyId,
        edgeAdapterIds: Object.freeze([...allowed].sort()),
        amountInByToken: new Map<string, bigint>(),
      });
    },

    buildStaticSchemaReads(input): readonly StateRead[] {
      validateSchema(input.schema, config.familyId);
      const tokens = [
        ...new Set(input.edges.map((edge) => edge.tokenIn.toLowerCase())),
      ].sort();
      return Object.freeze(tokens.map((token) => tokenDecimalsStateRead(input, token)));
    },

    hydrateStaticSchema(schema, results): ProtocolQuoteSchema {
      const resultMap = successfulResultMap(results);
      const amountInByToken = new Map<string, bigint>();
      for (const id of resultMap.keys()) {
        if (!id.startsWith("decimals:")) continue;
        const token = id.slice("decimals:".length);
        amountInByToken.set(token, oneTokenAmount(resultMap, token));
      }
      if (amountInByToken.size === 0) {
        throw new Error(`${config.familyId} static schema has no token decimals`);
      }
      return Object.freeze({
        ...schema,
        amountInByToken: new Map(amountInByToken),
      });
    },

    buildCurrentBlockReads(input): readonly StateRead[] {
      validateSchema(input.schema, config.familyId);
      const reads: StateRead[] = [];
      for (const edge of sortEdges(input.edges)) {
        const amountIn = schemaAmount(input.schema, edge.tokenIn);
        const quoteReads = config.buildQuoteReads(edge, amountIn);
        if (quoteReads.length === 0) {
          throw new Error(`${config.familyId} emitted no quote reads for ${edge.adapterId}`);
        }
        pushQuoteReads(reads, input, edge, quoteReads, config.familyId);
      }
      return Object.freeze(reads);
    },

    buildDependentBlockReads(input): readonly StateRead[] {
      validateSchema(input.schema, config.familyId);
      const results = successfulResultMap(input.priorResults);
      const reads: StateRead[] = [];
      for (const edge of sortEdges(input.edges)) {
        const amountIn = schemaAmount(input.schema, edge.tokenIn);
        let quoteReads: readonly ProtocolQuoteRead[];
        if (config.adaptiveProbe) {
          quoteReads = buildAdaptiveQuoteReads(
            config,
            edge,
            amountIn,
            input.completedRound,
            results,
          );
        } else {
          quoteReads = config.buildDependentQuoteReads?.(
            edge,
            amountIn,
            input.completedRound + 1,
            (suffix) => requiredResult(results, quoteReadId(edge, suffix)),
          ) ?? [];
        }
        pushQuoteReads(reads, input, edge, quoteReads, config.familyId);
      }
      return Object.freeze(reads);
    },

    decodeState(schema, results): ProtocolQuoteSnapshot {
      return Object.freeze({
        results: successfulResultMap(results),
        amountInByToken: schema.amountInByToken,
      });
    },

    deriveMids(snapshot, edges): ReadonlyMap<string, RouteVenueMid> {
      const mids = new Map<string, RouteVenueMid>();
      for (const edge of sortEdges(edges)) {
        requireOwnedEdge(config.familyId, allowed, edge);
        const baseAmountIn = amountForToken(snapshot.amountInByToken, edge.tokenIn);
        const { amountIn, amountOut } = config.adaptiveProbe
          ? resolveAdaptiveQuote(config, snapshot, edge, baseAmountIn)
          : {
              amountIn: baseAmountIn,
              amountOut: config.deriveAmountOut(
                edge,
                baseAmountIn,
                (suffix) =>
                  requiredResult(snapshot.results, quoteReadId(edge, suffix)),
              ),
            };
        mids.set(blockScanEdgeKey(edge), protocolMid(edge, amountIn, amountOut));
      }
      return mids;
    },

    dependencies(edges): readonly string[] {
      return Object.freeze(uniqueAddresses([
        ...edges.flatMap((edge) => [edge.target, edge.tokenIn, edge.tokenOut]),
        ...(config.extraDependencies?.(edges) ?? []),
      ]));
    },
  };
  return Object.freeze(capability);
}

export function stateRead(
  input: Pick<BuildCurrentBlockReadsInput<unknown>, "sourceBlock" | "sourceBlockHash">,
  id: string,
  to: string,
  data: string,
  transport: StateRead["transport"] = "rpc-batch",
): StateRead {
  if (!id || !ethers.isAddress(to) || !ethers.isHexString(data)) {
    throw new Error(`invalid current-block read ${id} to=${to}`);
  }
  return Object.freeze({
    id,
    sourceBlock: input.sourceBlock,
    sourceBlockHash: input.sourceBlockHash,
    to: ethers.getAddress(to),
    data,
    transport,
  });
}

export function tokenDecimalsStateRead(
  input: Pick<BuildCurrentBlockReadsInput<unknown>, "sourceBlock" | "sourceBlockHash">,
  token: string,
): StateRead {
  return stateRead(
    input,
    decimalsReadId(token),
    token,
    erc20MetadataIface.encodeFunctionData("decimals"),
  );
}

export function successfulResultMap(
  results: readonly StateReadResult[],
): ReadonlyMap<string, string> {
  const out = new Map<string, string>();
  for (const result of results) {
    if (!result.ok) {
      throw new Error(`current-block read ${result.id} failed: ${result.error}`);
    }
    if (!result.data || !ethers.isHexString(result.data)) {
      throw new Error(`current-block read ${result.id} returned invalid data`);
    }
    if (out.has(result.id)) throw new Error(`duplicate current-block result ${result.id}`);
    out.set(result.id, result.data);
  }
  return out;
}

export function oneTokenAmount(
  results: ReadonlyMap<string, string>,
  token: string,
): bigint {
  const raw = requiredResult(results, decimalsReadId(token));
  const decimals = Number(erc20MetadataIface.decodeFunctionResult("decimals", raw)[0]);
  if (!Number.isSafeInteger(decimals) || decimals < 0 || decimals > 36) {
    throw new Error(`invalid decimals ${decimals} for ${token}`);
  }
  return 10n ** BigInt(decimals);
}

function schemaAmount(schema: ProtocolQuoteSchema, token: string): bigint {
  return amountForToken(schema.amountInByToken, token);
}

function amountForToken(
  amountInByToken: ReadonlyMap<string, bigint>,
  token: string,
): bigint {
  const amount = amountInByToken.get(token.toLowerCase());
  if (amount === undefined || amount <= 0n) {
    throw new Error(`static schema lacks token amount for ${token}`);
  }
  return amount;
}

function pushQuoteReads(
  output: StateRead[],
  input: Pick<
    BuildCurrentBlockReadsInput<ProtocolQuoteSchema>,
    "sourceBlock" | "sourceBlockHash"
  >,
  edge: TokenEdge,
  quoteReads: readonly ProtocolQuoteRead[],
  familyId: string,
): void {
  const suffixes = new Set<string>();
  for (const read of quoteReads) {
    if (!read.suffix || suffixes.has(read.suffix)) {
      throw new Error(
        `${familyId} emitted duplicate/empty quote suffix ${read.suffix}`,
      );
    }
    suffixes.add(read.suffix);
    output.push(stateRead(
      input,
      quoteReadId(edge, read.suffix),
      read.to,
      read.data,
      read.transport,
    ));
  }
}

export function protocolMid(
  edge: TokenEdge,
  amountIn: bigint,
  amountOut: bigint,
): RouteVenueMid {
  if (amountIn <= 0n || amountOut <= 0n) {
    throw new Error(
      `unresolved protocol mid ${edge.adapterId}: ${amountIn} -> ${amountOut}`,
    );
  }
  const mid = Number(amountOut) / Number(amountIn);
  if (!Number.isFinite(mid) || mid <= 0) {
    throw new Error(`invalid protocol mid ${mid} for ${edge.adapterId}`);
  }
  const reserveA = amountIn * 10_000n;
  const reserveB = amountOut * 10_000n;
  const depthProxy = Number(reserveA < reserveB ? reserveA : reserveB);
  if (!Number.isFinite(depthProxy) || depthProxy <= 0) {
    throw new Error(`invalid protocol depth for ${edge.adapterId}`);
  }
  return Object.freeze({
    kind: "protocol" as const,
    pool: edge.target,
    edges: Object.freeze([edge]) as unknown as TokenEdge[],
    mid,
    feeBps: 0,
    reserveA,
    reserveB,
    depthProxy,
  });
}

export function decimalsReadId(token: string): string {
  return `decimals:${token.toLowerCase()}`;
}

export function quoteReadId(edge: TokenEdge, suffix = "out"): string {
  return `quote:${blockScanEdgeKey(edge)}:${suffix}`;
}

export function requiredResult(
  results: ReadonlyMap<string, string>,
  id: string,
): string {
  const value = results.get(id);
  if (value === undefined) throw new Error(`missing current-block result ${id}`);
  return value;
}

export function decodeUintResult(
  iface: ethers.Interface,
  functionName: string,
  raw: string,
  outputIndex = 0,
): bigint {
  const value = BigInt(iface.decodeFunctionResult(functionName, raw)[outputIndex]);
  if (value <= 0n) {
    throw new Error(`${functionName} current-block quote returned ${value}`);
  }
  return value;
}

export function decodeNonnegativeUintResult(
  iface: ethers.Interface,
  functionName: string,
  raw: string,
  outputIndex = 0,
): bigint {
  const value = BigInt(iface.decodeFunctionResult(functionName, raw)[outputIndex]);
  if (value < 0n) {
    throw new Error(`${functionName} current-block quote returned ${value}`);
  }
  return value;
}

function validateSchema(schema: ProtocolQuoteSchema, familyId: string): void {
  if (schema.familyId !== familyId) {
    throw new Error(`pricing schema family mismatch: ${schema.familyId} != ${familyId}`);
  }
}

function validateAdaptiveProbe(config: ProtocolQuoteStateConfig): void {
  const adaptive = config.adaptiveProbe;
  if (!adaptive) return;
  if (config.buildDependentQuoteReads) {
    throw new Error(
      `${config.familyId} cannot combine adaptive and custom dependent quote reads`,
    );
  }
  if (
    adaptive.stepMultiplier <= 1n ||
    !Number.isSafeInteger(adaptive.maxDependentRounds) ||
    adaptive.maxDependentRounds < 1 ||
    adaptive.maxDependentRounds > 4
  ) {
    throw new Error(`${config.familyId} declared invalid adaptive probe bounds`);
  }
}

function buildAdaptiveQuoteReads(
  config: ProtocolQuoteStateConfig,
  edge: TokenEdge,
  baseAmountIn: bigint,
  completedRound: number,
  results: ReadonlyMap<string, string>,
): readonly ProtocolQuoteRead[] {
  const adaptive = config.adaptiveProbe;
  if (!adaptive) return [];
  let latestRound = -1;
  for (
    let round = 0;
    round <= Math.min(completedRound, adaptive.maxDependentRounds);
    round++
  ) {
    const amount = adaptiveProbeAmount(
      baseAmountIn,
      adaptive.stepMultiplier,
      round,
    );
    const complete = config.buildQuoteReads(edge, amount).every((read) =>
      results.has(
        quoteReadId(edge, adaptiveQuoteSuffix(round, read.suffix)),
      )
    );
    if (!complete) break;
    latestRound = round;
  }
  if (latestRound < 0) {
    throw new Error(`${config.familyId} adaptive quote lacks its initial result`);
  }
  const completedAmount = adaptiveProbeAmount(
    baseAmountIn,
    adaptive.stepMultiplier,
    latestRound,
  );
  const completedOut = config.deriveAmountOut(
    edge,
    completedAmount,
    adaptiveResultResolver(results, edge, latestRound),
  );
  if (
    completedOut > 0n ||
    latestRound >= adaptive.maxDependentRounds
  ) {
    return [];
  }
  if (latestRound < completedRound) {
    throw new Error(
      `${config.familyId} adaptive quote is missing round ${latestRound + 1}`,
    );
  }
  const nextRound = latestRound + 1;
  const nextAmount = adaptiveProbeAmount(
    baseAmountIn,
    adaptive.stepMultiplier,
    nextRound,
  );
  return config.buildQuoteReads(edge, nextAmount).map((read) =>
    Object.freeze({
      ...read,
      suffix: adaptiveQuoteSuffix(nextRound, read.suffix),
    })
  );
}

function resolveAdaptiveQuote(
  config: ProtocolQuoteStateConfig,
  snapshot: ProtocolQuoteSnapshot,
  edge: TokenEdge,
  baseAmountIn: bigint,
): { readonly amountIn: bigint; readonly amountOut: bigint } {
  const adaptive = config.adaptiveProbe;
  if (!adaptive) throw new Error(`${config.familyId} has no adaptive probe`);
  let selected: { readonly amountIn: bigint; readonly amountOut: bigint } | null =
    null;
  for (let round = 0; round <= adaptive.maxDependentRounds; round++) {
    const amountIn = adaptiveProbeAmount(
      baseAmountIn,
      adaptive.stepMultiplier,
      round,
    );
    const reads = config.buildQuoteReads(edge, amountIn);
    if (
      reads.some(
        (read) =>
          !snapshot.results.has(
            quoteReadId(edge, adaptiveQuoteSuffix(round, read.suffix)),
          ),
      )
    ) {
      break;
    }
    const amountOut = config.deriveAmountOut(
      edge,
      amountIn,
      adaptiveResultResolver(snapshot.results, edge, round),
    );
    selected = { amountIn, amountOut };
  }
  if (!selected || selected.amountOut <= 0n) {
    throw new Error(
      `${config.familyId} adaptive quote remained zero within its declared bound`,
    );
  }
  return selected;
}

function adaptiveResultResolver(
  results: ReadonlyMap<string, string>,
  edge: TokenEdge,
  round: number,
): (suffix: string) => string {
  return (suffix) =>
    requiredResult(
      results,
      quoteReadId(edge, adaptiveQuoteSuffix(round, suffix)),
    );
}

function adaptiveQuoteSuffix(round: number, suffix: string): string {
  return round === 0 ? suffix : `adaptive-${round}:${suffix}`;
}

function adaptiveProbeAmount(
  baseAmount: bigint,
  stepMultiplier: bigint,
  round: number,
): bigint {
  const amount = baseAmount * stepMultiplier ** BigInt(round);
  const maxUint256 = (1n << 256n) - 1n;
  if (amount <= 0n || amount > maxUint256) {
    throw new Error("adaptive protocol quote amount exceeds uint256");
  }
  return amount;
}

function requireOwnedEdge(
  familyId: string,
  allowed: ReadonlySet<string>,
  edge: TokenEdge,
): void {
  if (!allowed.has(edge.adapterId)) {
    throw new Error(`${familyId} cannot price edge adapter ${edge.adapterId}`);
  }
}

function sortEdges(edges: readonly TokenEdge[]): readonly TokenEdge[] {
  return [...edges].sort((a, b) => blockScanEdgeKey(a).localeCompare(blockScanEdgeKey(b)));
}

function uniqueAddresses(addresses: readonly string[]): string[] {
  return [...new Set(addresses.map((address) => ethers.getAddress(address).toLowerCase()))].sort();
}

function abortError(reason: unknown): Error {
  if (reason instanceof Error) return reason;
  return new Error("protocol pricing schema aborted");
}
