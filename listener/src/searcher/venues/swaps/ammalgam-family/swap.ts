import type { SwapDomainSemantics } from "../../adapter-family-plugin.js";
import { createStrictSwapObservation, type PoolImpact, type SwapEventLog } from "../../swap-observation.js";
import { ACTION } from "./manifest.js";
import { LOG } from "./discovery.js";
import { SWAP_TOPIC, address } from "./codec.js";
import { decodeSwapLog } from "./simulation.js";
import type { Descriptor, Route } from "./types.js";

const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

interface Transfer {
  readonly token: string;
  readonly from: string;
  readonly to: string;
  readonly amount: bigint;
}

function transfers(logs: readonly SwapEventLog[]): readonly Transfer[] {
  const out: Transfer[] = [];
  for (const log of logs) {
    if (log.topics.length !== 3 || log.topics[0].toLowerCase() !== TRANSFER_TOPIC) continue;
    try {
      out.push({
        token: address(log.address),
        from: address(`0x${log.topics[1].slice(26)}`),
        to: address(`0x${log.topics[2].slice(26)}`),
        amount: BigInt(log.data),
      });
    } catch {
      // Noncanonical transfer logs are not evidence for this family.
    }
  }
  return out;
}

/**
 * Ammalgam `Swap(sender, amountXIn, amountYIn, amountXOut, amountYOut, to)`
 * carries the pair's own post-hoc input measurement. The two directed graph
 * edges share the pool, so the tokens are resolved from the receipt's own
 * transfers (output leaving the pair, input entering it) instead of assuming a
 * token order. Ambiguous receipts degrade to a mutation-only refresh, never a
 * guessed edge.
 */
function impactFor(
  pair: string,
  swap: NonNullable<ReturnType<typeof decodeSwapLog>>,
  all: readonly Transfer[],
  graph: readonly { adapterId: string; target: string; tokenIn: string; tokenOut: string }[],
): PoolImpact | null {
  const outAmount = swap.amountXOut > 0n ? swap.amountXOut : swap.amountYOut;
  const inAmount = swap.amountXIn > 0n ? swap.amountXIn : swap.amountYIn;
  if (outAmount <= 0n || inAmount <= 0n) return null;
  const outputTokens = new Set(all
    .filter(transfer => transfer.from === pair && transfer.to === swap.to && transfer.amount === outAmount)
    .map(transfer => transfer.token));
  const inputTokens = new Set(all
    .filter(transfer => transfer.to === pair && transfer.from === swap.sender && transfer.amount === inAmount)
    .map(transfer => transfer.token));
  const matched = graph.filter(edge => edge.adapterId === ACTION && address(edge.target) === pair &&
    outputTokens.has(address(edge.tokenOut)) && inputTokens.has(address(edge.tokenIn)));
  if (matched.length !== 1) return null;
  return {
    pool: pair,
    tokenIn: address(matched[0].tokenIn),
    tokenOut: address(matched[0].tokenOut),
    amountIn: inAmount,
    amountOut: outAmount,
    matchedAdapterId: ACTION,
  };
}

export const swap = {
  landedEvents: {
    patternIds: [LOG],
    classify: ({ observation }: { readonly observation: { readonly kind: string } }) =>
      observation.kind === "log" ? "swap" as const : null,
  },
  observation: {
    patternIds: [LOG],
    decode({ observation: o }: { readonly observation: { readonly kind: string; readonly address?: string; readonly topics?: readonly string[]; readonly data?: string } }) {
      if (o.kind !== "log") return [];
      const found = decodeSwapLog({ topics: o.topics ?? [], data: o.data ?? "0x" });
      if (!found) return [];
      return [{
        kind: "swap" as const,
        canonicalPayload: {
          pool: address(o.address!),
          sender: found.sender,
          to: found.to,
          amountXIn: found.amountXIn,
          amountYIn: found.amountYIn,
          amountXOut: found.amountXOut,
          amountYOut: found.amountYOut,
        },
      }];
    },
  },
  receiptObservation: createStrictSwapObservation({
    topics: [SWAP_TOPIC],
    canonicalIntakeTargets: [],
    observedPoolIdentity: log => (decodeSwapLog(log) ? log.address.toLowerCase() : null),
    async decodeSwapImpacts(ctx) {
      const received = transfers(ctx.logs);
      return ctx.matchedOwnedTriggers.map(trigger => {
        const log = ctx.logs[trigger.logIndex];
        const found = decodeSwapLog(log);
        if (!found) throw new Error("ammalgam malformed owned log");
        const pair = address(log.address);
        const impact = impactFor(pair, found, received, ctx.graph);
        return impact !== null
          ? { logIndex: trigger.logIndex, impact }
          : {
            logIndex: trigger.logIndex,
            mutationOnlyReason:
              "ammalgam pair swap tokens were not unambiguously resolvable from the receipt; refresh the pair state",
          };
      });
    },
  }),
  victimSupport: "detect-only" as const,
} satisfies SwapDomainSemantics<Descriptor, Route>;
