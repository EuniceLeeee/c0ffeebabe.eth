import { ethers } from "ethers";
import type { TokenEdge } from "../../../planner/token-graph.js";
import type {
  ExactQuoteContext,
  PreparedRouteContext,
  PreparedRouteQuoteResult,
} from "../../route-leg-adapter.js";
import { currentBlockRead } from "../blockscan-state-shared.js";
import {
  createCurrentBlockViewQuoteCapability,
  quoteReadId,
} from "../view-quote-blockscan-state.js";
import {
  decodeEkuboQuoteOutput,
  EKUBO_CORE,
  EKUBO_ROUTER,
  encodeEkuboQuote,
} from "./abi.js";
import { EKUBO_EDGE_ADAPTER_ID } from "./ids.js";
import {
  decodeEkuboPoolKeyBinding,
  ekuboDirection,
  ekuboPoolExtension,
  ekuboPoolId,
  type EkuboPoolKey,
} from "./pool-key.js";

export interface EkuboStateSchema {
  readonly router: string;
  readonly poolId: string;
  readonly poolKey: EkuboPoolKey;
  readonly bindingHash: string;
}

export const ekuboBlockScanState =
  createCurrentBlockViewQuoteCapability<EkuboStateSchema>({
    kind: "external-swap",
    edgeAdapterIds: new Set([EKUBO_EDGE_ADAPTER_ID]),
    compileGroup(edges) {
      const first = edges[0];
      const schema = ekuboSchemaForEdge(first);
      for (const edge of edges) {
        const current = ekuboSchemaForEdge(edge);
        if (
          current.router !== schema.router ||
          current.poolId !== schema.poolId ||
          current.bindingHash !== schema.bindingHash
        ) {
          throw new Error(
            `Ekubo block-scan group ${schema.poolId} has inconsistent metadata`,
          );
        }
      }
      return Object.freeze(schema);
    },
    quoteRead(ctx) {
      const isToken1 = ekuboDirection(
        ctx.edge.tokenIn,
        ctx.edge.tokenOut,
        ctx.static.poolKey,
      );
      return currentBlockRead({
        id: quoteReadId(ctx.stateKey, ctx.edge),
        sourceBlock: ctx.sourceBlock,
        sourceBlockHash: ctx.sourceBlockHash,
        to: ctx.static.router,
        data: encodeEkuboQuote(
          ctx.static.poolKey,
          isToken1,
          ctx.amountIn,
        ),
        transport: "multicall-safe",
      });
    },
    decodeQuote(edge, data, amountIn) {
      return decodeEkuboQuoteOutput(edge, data, amountIn);
    },
    dependencies(group) {
      const addresses = [
        group.static.router,
        EKUBO_CORE,
        group.static.poolKey.token0,
        group.static.poolKey.token1,
        ekuboPoolExtension(group.static.poolKey.config),
      ].filter(
        (address) =>
          address.toLowerCase() !== ethers.ZeroAddress.toLowerCase(),
      );
      return Object.freeze([...new Set(addresses.map((address) =>
        ethers.getAddress(address).toLowerCase()
      ))]);
    },
  });

export async function quoteEkuboExact(
  ctx: ExactQuoteContext,
): Promise<bigint> {
  const edge = requireEkuboEdge(ctx.edge);
  return quoteEkuboWith(
    edge,
    ctx.amountIn,
    (to, data) => ctx.state.call({ to, data }),
  );
}

export async function quoteEkuboPrepared(
  ctx: PreparedRouteContext,
): Promise<PreparedRouteQuoteResult> {
  const edge = requireEkuboEdge(ctx.edge);
  const started = Date.now();
  const result = await quoteEkuboWith(
    edge,
    ctx.request.amountIn,
    async (to, data) => (await ctx.callPrepared(to, data)).output,
  );
  return Object.freeze({
    amountOut: result,
    latencyMs: Date.now() - started,
  });
}

export function encodeEkuboPreparedQuote(
  edge: TokenEdge | undefined,
  amountIn: bigint,
): { readonly to: string; readonly data: string } {
  const required = requireEkuboEdge(edge);
  const schema = ekuboSchemaForEdge(required);
  return Object.freeze({
    to: schema.router,
    data: encodeEkuboQuote(
      schema.poolKey,
      ekuboDirection(required.tokenIn, required.tokenOut, schema.poolKey),
      amountIn,
    ),
  });
}

function ekuboSchemaForEdge(edge: TokenEdge): EkuboStateSchema {
  if (
    edge.adapterId !== EKUBO_EDGE_ADAPTER_ID ||
    !edge.poolId ||
    !edge.routeBinding
  ) {
    throw new Error("Ekubo edge is missing pool identity metadata");
  }
  const router = ethers.getAddress(edge.target).toLowerCase();
  if (router !== EKUBO_ROUTER.toLowerCase()) {
    throw new Error(`Ekubo edge has foreign router ${edge.target}`);
  }
  const poolKey = decodeEkuboPoolKeyBinding(edge.routeBinding);
  const poolId = ekuboPoolId(poolKey);
  if (poolId !== edge.poolId.toLowerCase()) {
    throw new Error(`Ekubo edge PoolKey hash mismatch ${edge.poolId}`);
  }
  ekuboDirection(edge.tokenIn, edge.tokenOut, poolKey);
  return Object.freeze({
    router,
    poolId,
    poolKey,
    bindingHash: edge.routeBinding.hash.toLowerCase(),
  });
}

async function quoteEkuboWith(
  edge: TokenEdge,
  amountIn: bigint,
  call: (to: string, data: string) => Promise<string>,
): Promise<bigint> {
  if (amountIn <= 0n) return 0n;
  const schema = ekuboSchemaForEdge(edge);
  const result = await call(
    schema.router,
    encodeEkuboQuote(
      schema.poolKey,
      ekuboDirection(edge.tokenIn, edge.tokenOut, schema.poolKey),
      amountIn,
    ),
  );
  return decodeEkuboQuoteOutput(edge, result, amountIn);
}

function requireEkuboEdge(edge: TokenEdge | undefined): TokenEdge {
  if (!edge) {
    throw new Error(
      "Ekubo quote requires the admitted edge with its PoolKey binding",
    );
  }
  return edge;
}
