import { ethers } from "ethers";
import type { TokenEdge } from "../../planner/token-graph.js";
import type { RouteVenueMidKind } from "../mid-readers.js";
import type {
  BlockScanStateCapability,
  BuildCurrentBlockReadsInput,
  BuildDependentBlockReadsInput,
  CompileStaticSchemaInput,
  StateRead,
  StateReadResult,
  StateReadSuccess,
} from "../blockscan-state-capability.js";
import { blockScanEdgeKey } from "../blockscan-state-capability.js";
import {
  blockScanErc20Iface,
  currentBlockRead,
  midsForDirectedEdges,
  quotedPoolMid,
} from "./blockscan-state-shared.js";
import { edgeInstanceKey } from "../route-instance-identity.js";

export interface ViewQuoteGroup<Static> {
  readonly stateKey: string;
  readonly edges: readonly TokenEdge[];
  readonly static: Static;
  readonly amountInByToken: ReadonlyMap<string, bigint>;
}

export interface ViewQuoteSchema<Static> {
  readonly groups: ReadonlyMap<string, ViewQuoteGroup<Static>>;
}

export interface ViewQuoteSnapshot {
  readonly stateKey: string;
  readonly quotes: ReadonlyMap<string, {
    readonly amountIn: bigint;
    readonly amountOut: bigint;
  }>;
  readonly unavailable: ReadonlyMap<string, string>;
}

export interface ViewQuoteReadContext<Static> {
  readonly sourceBlock: number;
  readonly sourceBlockHash: string;
  readonly stateKey: string;
  readonly edges: readonly TokenEdge[];
  readonly static: Static;
}

export interface DependentViewQuoteReadContext<Static>
  extends ViewQuoteReadContext<Static> {
  readonly edge: TokenEdge;
  readonly amountIn: bigint;
  readonly priorResults: readonly StateReadResult[];
}

export interface CurrentBlockViewQuoteConfig<Static> {
  readonly kind: Extract<
    RouteVenueMidKind,
    "curve-underlying" | "external-swap"
  >;
  readonly edgeAdapterIds: ReadonlySet<string>;
  /**
   * Family-static decimals are cheaper, but one failed metadata read prevents
   * the coordinator from compiling that whole family. Families admitting
   * non-standard tokens can instead read decimals in each state key's first
   * current-N round. The coordinator then isolates a failure to only the
   * state keys that actually depend on that token.
   */
  readonly decimalsReadScope?: "family-static" | "state-key-current";
  readonly stateKey?: (edge: TokenEdge) => string;
  compileGroup(edges: readonly TokenEdge[]): Static;
  initialReads?(ctx: ViewQuoteReadContext<Static>): readonly StateRead[];
  /**
   * Selects the executable probe amount after prerequisite state is available.
   * The default remains one whole input token. Liquidity-sensitive families
   * can cap that amount without losing the actual input used to derive the mid.
   */
  quoteAmountIn?(
    ctx: DependentViewQuoteReadContext<Static>,
  ): bigint | BehaviorProvenUnavailableViewQuote;
  quoteRead(ctx: DependentViewQuoteReadContext<Static>): StateRead;
  /**
   * Decode against the exact probe amount encoded in the read. Families whose
   * quote endpoint permits partial fills must reject incomplete consumption.
   */
  decodeQuote(edge: TokenEdge, data: string, amountIn: bigint): bigint;
  dependencies?(group: ViewQuoteGroup<Static>): readonly string[];
}

export interface BehaviorProvenUnavailableViewQuote {
  readonly status: "unavailable";
  readonly reason: string;
}

/**
 * Marks one directed quote as unavailable only when prerequisite current-N
 * reads prove that no behavior-safe input exists. A revert from the quote
 * itself is not proof and must remain a normal failed read.
 */
export function behaviorProvenUnavailableViewQuote(
  reason: string,
): BehaviorProvenUnavailableViewQuote {
  const normalized = reason.trim();
  if (!normalized) {
    throw new Error("behavior-proven unavailable quote requires a reason");
  }
  return Object.freeze({ status: "unavailable", reason: normalized });
}

export interface FactoryOwnedDeriveMidsPurityCase {
  readonly snapshot: ViewQuoteSnapshot;
  readonly edges: readonly TokenEdge[];
}

const FACTORY_OWNED_DERIVE_MIDS_PURITY_CASES =
  new WeakMap<object, FactoryOwnedDeriveMidsPurityCase>();

export function factoryOwnedDeriveMidsPurityCase(
  capability: BlockScanStateCapability,
): FactoryOwnedDeriveMidsPurityCase | null {
  return FACTORY_OWNED_DERIVE_MIDS_PURITY_CASES.get(capability) ?? null;
}

/**
 * Current-N view-quote family.
 *
 * Round 0 reads decimals and any family-specific prerequisite state. Round 1
 * builds one exact quote descriptor per behavior-available directed edge. The
 * default probe is one whole input token; families may cap it from prerequisite
 * current-N state. No adapter performs I/O, no stale quote is reused, and any
 * missing read makes the state key unresolved in the coordinator.
 */
export function createCurrentBlockViewQuoteCapability<Static>(
  config: CurrentBlockViewQuoteConfig<Static>,
): BlockScanStateCapability<ViewQuoteSchema<Static>, ViewQuoteSnapshot> {
  const configuredStateKey = config.stateKey;
  const stateKey = configuredStateKey ?? edgeInstanceKey;
  const kind = config.kind;
  const capability: BlockScanStateCapability<
    ViewQuoteSchema<Static>,
    ViewQuoteSnapshot
  > = {
    stateKey,

    compileStaticSchema({ edges }: CompileStaticSchemaInput) {
      const grouped = new Map<string, TokenEdge[]>();
      for (const edge of edges) {
        if (!config.edgeAdapterIds.has(edge.adapterId)) {
          throw new Error(`view-quote family does not own ${edge.adapterId}`);
        }
        const key = stateKey(edge);
        const group = grouped.get(key) ?? [];
        group.push(edge);
        grouped.set(key, group);
      }
      const groups = new Map<string, ViewQuoteGroup<Static>>();
      for (const [key, groupEdges] of grouped) {
        const ordered = Object.freeze([...groupEdges].sort(compareEdges));
        groups.set(key, Object.freeze({
          stateKey: key,
          edges: ordered,
          static: config.compileGroup(ordered),
          amountInByToken: new Map<string, bigint>(),
        }));
      }
      return Object.freeze({ groups });
    },

    buildStaticSchemaReads(
      input: BuildCurrentBlockReadsInput<ViewQuoteSchema<Static>>,
    ) {
      if (config.decimalsReadScope === "state-key-current") {
        return Object.freeze([]);
      }
      return Object.freeze(uniqueTokenIns(input.edges).map((token) =>
        currentBlockRead({
          id: staticDecimalsReadId(token),
          sourceBlock: input.sourceBlock,
          sourceBlockHash: input.sourceBlockHash,
          to: token,
          data: blockScanErc20Iface.encodeFunctionData("decimals"),
        })
      ));
    },

    hydrateStaticSchema(schema, results) {
      if (config.decimalsReadScope === "state-key-current") {
        if (results.length !== 0) {
          throw new Error(
            "state-key current decimals received unexpected static results",
          );
        }
        return schema;
      }
      const decimalsByToken = new Map<string, bigint>();
      for (const result of results) {
        if (!result.ok || !result.id.startsWith("static-decimals:")) {
          throw new Error(`unresolved static decimals read ${result.id}`);
        }
        const token = result.id.slice("static-decimals:".length);
        const decimals = decodeDecimals(result.data, token);
        decimalsByToken.set(token, 10n ** BigInt(decimals));
      }
      const groups = new Map<string, ViewQuoteGroup<Static>>();
      for (const [key, group] of schema.groups) {
        const amountInByToken = new Map<string, bigint>();
        for (const token of uniqueTokenIns(group.edges)) {
          const amount = decimalsByToken.get(token.toLowerCase());
          if (!amount) throw new Error(`static decimals missing ${token}`);
          amountInByToken.set(token.toLowerCase(), amount);
        }
        groups.set(key, Object.freeze({ ...group, amountInByToken }));
      }
      return Object.freeze({ groups });
    },

    buildCurrentBlockReads(
      input: BuildCurrentBlockReadsInput<ViewQuoteSchema<Static>>,
    ) {
      const group = requireGroup(input, stateKey);
      const decimals = config.decimalsReadScope === "state-key-current"
        ? buildCurrentDecimalsReads(input, group)
        : [];
      const custom = config.initialReads?.({
        sourceBlock: input.sourceBlock,
        sourceBlockHash: input.sourceBlockHash,
        stateKey: group.stateKey,
        edges: group.edges,
        static: group.static,
      }) ?? [];
      if (decimals.length > 0) {
        return Object.freeze([...decimals, ...custom]);
      }
      if (custom.length > 0) return Object.freeze([...custom]);
      return buildViewQuoteReads(config, input, group, []);
    },

    buildDependentBlockReads(
      input: BuildDependentBlockReadsInput<ViewQuoteSchema<Static>>,
    ) {
      const group = requireGroup(input, stateKey);
      if (input.completedRound > 0) return Object.freeze([]);
      const initial = config.initialReads?.({
        sourceBlock: input.sourceBlock,
        sourceBlockHash: input.sourceBlockHash,
        stateKey: group.stateKey,
        edges: group.edges,
        static: group.static,
      }) ?? [];
      if (
        initial.length === 0 &&
        config.decimalsReadScope !== "state-key-current"
      ) {
        return Object.freeze([]);
      }
      return buildViewQuoteReads(config, input, group, input.priorResults);
    },

    decodeState(
      schema: ViewQuoteSchema<Static>,
      results: readonly StateReadResult[],
    ) {
      const group = findResultGroup(config, schema, results);
      const quotes = new Map<string, { amountIn: bigint; amountOut: bigint }>();
      const unavailable = new Map<string, string>();
      for (const edge of group.edges) {
        const selection = selectQuoteAmount(
          config,
          sourceFromResults(results),
          group,
          edge,
          results,
        );
        if (typeof selection !== "bigint") {
          unavailable.set(routeKey(edge), selection.reason);
          continue;
        }
        const result = requireQuoteRead(results, group.stateKey, edge);
        const amountIn =
          quoteAmountFromReadId(result.id, group.stateKey, edge) ??
          selection;
        if (!amountIn || amountIn <= 0n) {
          throw new Error(`quote amount missing ${edge.tokenIn}`);
        }
        if (amountIn !== selection) {
          throw new Error(
            `current-N quote amount changed while decoding ${routeKey(edge)}`,
          );
        }
        const amountOut = config.decodeQuote(
          edge,
          result.data,
          amountIn,
        );
        if (amountOut <= 0n) {
          throw new Error(
            `current-N view quote returned zero for ${edge.tokenIn}->${edge.tokenOut}`,
          );
        }
        quotes.set(routeKey(edge), Object.freeze({ amountIn, amountOut }));
      }
      return Object.freeze({
        stateKey: group.stateKey,
        quotes,
        unavailable,
      });
    },

    deriveMids(
      snapshot: ViewQuoteSnapshot,
      edges: readonly TokenEdge[],
    ) {
      const availableEdges = edges.filter(
        (edge) => !snapshot.unavailable.has(routeKey(edge)),
      );
      return midsForDirectedEdges(availableEdges, (edge) => {
        if (stateKey(edge) !== snapshot.stateKey) {
          throw new Error(
            `view-quote snapshot ${snapshot.stateKey} used for ${stateKey(edge)}`,
          );
        }
        const quote = snapshot.quotes.get(routeKey(edge));
        if (!quote) throw new Error(`missing current-N quote for ${routeKey(edge)}`);
        return quotedPoolMid({
          kind,
          edge,
          amountIn: quote.amountIn,
          amountOut: quote.amountOut,
          depthIn: quote.amountIn * 10_000n,
          depthOut: quote.amountOut * 10_000n,
        });
      });
    },

    behaviorProvenUnavailableEdges(
      snapshot: ViewQuoteSnapshot,
      edges: readonly TokenEdge[],
    ) {
      const unavailable = new Map<string, string>();
      for (const edge of edges) {
        if (stateKey(edge) !== snapshot.stateKey) {
          throw new Error(
            `view-quote snapshot ${snapshot.stateKey} used for ${stateKey(edge)}`,
          );
        }
        const reason = snapshot.unavailable.get(routeKey(edge));
        if (reason) unavailable.set(blockScanEdgeKey(edge), reason);
      }
      return unavailable;
    },

    dependencies(edges: readonly TokenEdge[]) {
      if (edges.length === 0) {
        throw new Error("view-quote dependency group has no edges");
      }
      const key = stateKey(edges[0]);
      const group = Object.freeze({
        stateKey: key,
        edges: Object.freeze([...edges]),
        static: config.compileGroup(edges),
        amountInByToken: new Map<string, bigint>(),
      });
      return Object.freeze([
        ...new Set([
          ...edges.flatMap((edge) => [
            ethers.getAddress(edge.target).toLowerCase(),
            ethers.getAddress(edge.tokenIn).toLowerCase(),
            ethers.getAddress(edge.tokenOut).toLowerCase(),
          ]),
          ...(config.dependencies?.(group) ?? []),
        ]),
      ]);
    },
  };
  const frozen = Object.freeze(capability);
  if (configuredStateKey === undefined) {
    FACTORY_OWNED_DERIVE_MIDS_PURITY_CASES.set(
      frozen,
      createFactoryOwnedDeriveMidsPurityCase(config.edgeAdapterIds),
    );
  }
  return frozen;
}

function createFactoryOwnedDeriveMidsPurityCase(
  edgeAdapterIds: ReadonlySet<string>,
): FactoryOwnedDeriveMidsPurityCase {
  const adapterId = [...edgeAdapterIds].sort()[0];
  if (!adapterId) {
    throw new Error("view-quote capability must own at least one edge adapter");
  }
  const edge: TokenEdge = Object.freeze({
    adapterId,
    target: "0x1111111111111111111111111111111111111111",
    tokenIn: "0x2222222222222222222222222222222222222222",
    tokenOut: "0x3333333333333333333333333333333333333333",
    slotKind: "swap",
    edgeKind: "swap",
    leavesStandingPosition: false,
  });
  const snapshot: ViewQuoteSnapshot = Object.freeze({
    stateKey: edgeInstanceKey(edge),
    quotes: new Map([[
      routeKey(edge),
      Object.freeze({ amountIn: 1n, amountOut: 2n }),
    ]]),
    unavailable: new Map(),
  });
  return Object.freeze({
    snapshot,
    edges: Object.freeze([edge]),
  });
}

function buildViewQuoteReads<Static>(
  config: CurrentBlockViewQuoteConfig<Static>,
  input: Pick<
    BuildCurrentBlockReadsInput<ViewQuoteSchema<Static>>,
    "sourceBlock" | "sourceBlockHash"
  >,
  group: ViewQuoteGroup<Static>,
  priorResults: readonly StateReadResult[],
): readonly StateRead[] {
  return Object.freeze(group.edges.flatMap((edge) => {
    const selection = selectQuoteAmount(
      config,
      input,
      group,
      edge,
      priorResults,
    );
    if (typeof selection !== "bigint") return [];
    const amountIn = selection;
    const read = config.quoteRead({
      sourceBlock: input.sourceBlock,
      sourceBlockHash: input.sourceBlockHash,
      stateKey: group.stateKey,
      edges: group.edges,
      static: group.static,
      edge,
      amountIn,
      priorResults,
    });
    return [config.quoteAmountIn
      ? Object.freeze({
          ...read,
          id: quoteReadId(group.stateKey, edge, amountIn),
        })
      : read];
  }));
}

function buildCurrentDecimalsReads<Static>(
  input: Pick<
    BuildCurrentBlockReadsInput<ViewQuoteSchema<Static>>,
    "sourceBlock" | "sourceBlockHash"
  >,
  group: ViewQuoteGroup<Static>,
): readonly StateRead[] {
  return Object.freeze(uniqueTokenIns(group.edges).map((token) =>
    currentBlockRead({
      id: decimalsReadId(group.stateKey, token),
      sourceBlock: input.sourceBlock,
      sourceBlockHash: input.sourceBlockHash,
      to: token,
      data: blockScanErc20Iface.encodeFunctionData("decimals"),
    })
  ));
}

export function quoteReadId(
  stateKey: string,
  edge: TokenEdge,
  amountIn?: bigint,
): string {
  const base = `quote:${stateKey}:${routeKey(edge)}`;
  return amountIn === undefined ? base : `${base}:amount=${amountIn}`;
}

export function decimalsReadId(stateKey: string, token: string): string {
  return `decimals:${stateKey}:${ethers.getAddress(token).toLowerCase()}`;
}

export function staticDecimalsReadId(token: string): string {
  return `static-decimals:${ethers.getAddress(token).toLowerCase()}`;
}

function requireGroup<Static>(
  input: BuildCurrentBlockReadsInput<ViewQuoteSchema<Static>>,
  stateKey: (edge: TokenEdge) => string,
): ViewQuoteGroup<Static> {
  if (input.edges.length === 0) throw new Error("view-quote state group has no edges");
  const key = stateKey(input.edges[0]);
  if (input.edges.some((edge) => stateKey(edge) !== key)) {
    throw new Error(`mixed view-quote state group ${key}`);
  }
  const group = input.schema.groups.get(key);
  if (!group) throw new Error(`view-quote schema missing ${key}`);
  return group;
}

function findResultGroup<Static>(
  config: CurrentBlockViewQuoteConfig<Static>,
  schema: ViewQuoteSchema<Static>,
  results: readonly StateReadResult[],
): ViewQuoteGroup<Static> {
  const matches = [...schema.groups.values()].filter((group) =>
    group.edges.some((edge) =>
      results.some((result) =>
        isQuoteReadId(result.id, group.stateKey, edge)
      )
    )
  );
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    throw new Error(`view-quote results matched ${matches.length} state groups`);
  }
  if (!config.quoteAmountIn) {
    throw new Error("view-quote results matched no state group");
  }
  const source = sourceFromResults(results);
  const unavailableMatches = [...schema.groups.values()].filter((group) => {
    try {
      return group.edges.length > 0 &&
        group.edges.every((edge) =>
          typeof selectQuoteAmount(
            config,
            source,
            group,
            edge,
            results,
          ) !== "bigint"
        );
    } catch {
      return false;
    }
  });
  if (unavailableMatches.length !== 1) {
    throw new Error(
      `view-quote unavailable results matched ${unavailableMatches.length} state groups`,
    );
  }
  return unavailableMatches[0];
}

function selectQuoteAmount<Static>(
  config: CurrentBlockViewQuoteConfig<Static>,
  source: { readonly sourceBlock: number; readonly sourceBlockHash: string },
  group: ViewQuoteGroup<Static>,
  edge: TokenEdge,
  priorResults: readonly StateReadResult[],
): bigint | BehaviorProvenUnavailableViewQuote {
  const defaultAmountIn = resolveTokenUnit(
    config,
    group,
    edge.tokenIn,
    priorResults,
  );
  const selection = config.quoteAmountIn?.({
    sourceBlock: source.sourceBlock,
    sourceBlockHash: source.sourceBlockHash,
    stateKey: group.stateKey,
    edges: group.edges,
    static: group.static,
    edge,
    amountIn: defaultAmountIn,
    priorResults,
  }) ?? defaultAmountIn;
  if (typeof selection === "bigint") {
    if (selection <= 0n) {
      throw new Error(
        `view-quote family selected non-positive input for ${routeKey(edge)}`,
      );
    }
    return selection;
  }
  if (
    selection?.status !== "unavailable" ||
    typeof selection.reason !== "string" ||
    selection.reason.trim().length === 0
  ) {
    throw new Error(
      `view-quote family returned invalid availability for ${routeKey(edge)}`,
    );
  }
  return selection;
}

function resolveTokenUnit<Static>(
  config: CurrentBlockViewQuoteConfig<Static>,
  group: ViewQuoteGroup<Static>,
  token: string,
  priorResults: readonly StateReadResult[],
): bigint {
  if (config.decimalsReadScope !== "state-key-current") {
    const amount = group.amountInByToken.get(token.toLowerCase());
    if (!amount) throw new Error(`static amount missing ${token}`);
    return amount;
  }
  const expectedId = decimalsReadId(group.stateKey, token);
  const matches = priorResults.filter((result) => result.id === expectedId);
  if (matches.length !== 1) {
    throw new Error(
      `expected one current-N decimals read ${expectedId}, got ${matches.length}`,
    );
  }
  const result = matches[0];
  if (!result.ok) {
    throw new Error(
      `current-N decimals read ${expectedId} failed: ${result.error}`,
    );
  }
  return 10n ** BigInt(decodeDecimals(result.data, token));
}

function sourceFromResults(
  results: readonly StateReadResult[],
): { readonly sourceBlock: number; readonly sourceBlockHash: string } {
  const first = results[0];
  if (!first) throw new Error("view-quote state has no current-N results");
  return Object.freeze({
    sourceBlock: first.sourceBlock,
    sourceBlockHash: first.sourceBlockHash,
  });
}

function requireQuoteRead(
  results: readonly StateReadResult[],
  stateKey: string,
  edge: TokenEdge,
): StateReadSuccess {
  const matches: StateReadSuccess[] = [];
  for (const result of results) {
    if (result.ok && isQuoteReadId(result.id, stateKey, edge)) {
      matches.push(result);
    }
  }
  if (matches.length !== 1) {
    throw new Error(
      `expected one current-N quote for ${routeKey(edge)}, got ${matches.length}`,
    );
  }
  return matches[0];
}

function isQuoteReadId(
  id: string,
  stateKey: string,
  edge: TokenEdge,
): boolean {
  const base = quoteReadId(stateKey, edge);
  return id === base || id.startsWith(`${base}:amount=`);
}

function quoteAmountFromReadId(
  id: string,
  stateKey: string,
  edge: TokenEdge,
): bigint | null {
  const base = quoteReadId(stateKey, edge);
  if (id === base) return null;
  const prefix = `${base}:amount=`;
  if (!id.startsWith(prefix)) return null;
  const encoded = id.slice(prefix.length);
  if (!/^[1-9][0-9]*$/.test(encoded)) {
    throw new Error(`invalid current-N quote amount in read id ${id}`);
  }
  return BigInt(encoded);
}

function decodeDecimals(data: string, token: string): number {
  const decimals = Number(
    blockScanErc20Iface.decodeFunctionResult("decimals", data)[0],
  );
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) {
    throw new Error(`token ${token} returned invalid decimals ${decimals}`);
  }
  return decimals;
}

function uniqueTokenIns(edges: readonly TokenEdge[]): string[] {
  return [
    ...new Map(
      edges.map((edge) => [
        ethers.getAddress(edge.tokenIn).toLowerCase(),
        ethers.getAddress(edge.tokenIn),
      ]),
    ).values(),
  ].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
}

function routeKey(edge: TokenEdge): string {
  return [
    edge.adapterId,
    ethers.getAddress(edge.tokenIn).toLowerCase(),
    ethers.getAddress(edge.tokenOut).toLowerCase(),
    edge.curveI ?? "",
    edge.curveJ ?? "",
  ].join(":");
}

function compareEdges(a: TokenEdge, b: TokenEdge): number {
  return routeKey(a).localeCompare(routeKey(b));
}
