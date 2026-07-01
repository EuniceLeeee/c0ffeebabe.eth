import type { Action, TokenDelta } from "../types.js";
import { decodeTransfer } from "../decode/erc20.js";
import { ADDR, PROTOCOLS, TOPICS, lower, protocolName, short, tokenMeta } from "../registry/protocols.js";

export interface LogActionResult {
  actions: Action[];
  rawDeltas: TokenDelta[];
  tokens: string[];
  venues: string[];
  protocols: string[];
}

export function actionsFromLogs(receipt: any, actorAddresses: string[]): LogActionResult {
  const actors = new Set(actorAddresses.filter(Boolean).map(lower));
  const actions: Action[] = [];
  const deltas = new Map<string, bigint>();
  const tokens = new Set<string>();
  const venues = new Set<string>();
  const protocols = new Set<string>();

  function addDelta(token: string, amount: bigint) {
    const key = lower(token);
    deltas.set(key, (deltas.get(key) ?? 0n) + amount);
    tokens.add(key);
  }

  for (const log of receipt.logs ?? []) {
    const order = Number(log.logIndex ?? 0);
    const addr = lower(log.address);
    const proto = PROTOCOLS[addr];
    if (proto) {
      venues.add(proto.name);
      protocols.add(proto.name);
    }

    const transfer = decodeTransfer(log);
    if (transfer) {
      const fromActor = actors.has(lower(transfer.from));
      const toActor = actors.has(lower(transfer.to));
      if (fromActor) addDelta(transfer.token, -transfer.amount);
      if (toActor) addDelta(transfer.token, transfer.amount);

      if (lower(transfer.from) === lower(ADDR.MORPHO) && toActor) {
        actions.push(action("fund.flashloan", "Morpho flashloan transfer", order, {
          protocol: "Morpho",
          tokenOut: transfer.token,
          amount: transfer.amount.toString(),
          confidence: "high",
        }));
      } else if (fromActor && lower(transfer.to) === lower(ADDR.MORPHO)) {
        actions.push(action("credit.repay", "repay Morpho transfer", order, {
          protocol: "Morpho",
          tokenIn: transfer.token,
          amount: transfer.amount.toString(),
          confidence: "high",
        }));
      } else if (fromActor && lower(transfer.to) === lower(ADDR.FLUID_LIQUIDITY)) {
        actions.push(action("credit.deposit_collateral", "actor -> Fluid collateral transfer", order, {
          protocol: "Fluid",
          tokenIn: transfer.token,
          amount: transfer.amount.toString(),
          confidence: "medium",
        }));
      } else if (lower(transfer.from) === lower(ADDR.FLUID_LIQUIDITY) && toActor) {
        actions.push(action("credit.borrow", "Fluid -> actor borrow transfer", order, {
          protocol: "Fluid",
          tokenOut: transfer.token,
          amount: transfer.amount.toString(),
          confidence: "medium",
        }));
      } else if (fromActor && lower(transfer.to) === lower(ADDR.SKY_PSM_LITE)) {
        actions.push(action("peg.redeem", "actor -> Sky PSM transfer", order, {
          protocol: "Sky PSM",
          tokenIn: transfer.token,
          amount: transfer.amount.toString(),
          confidence: "medium",
        }));
      } else if (lower(transfer.from) === lower(ADDR.SKY_PSM_LITE) && toActor) {
        actions.push(action("peg.mint", "Sky PSM -> actor transfer", order, {
          protocol: "Sky PSM",
          tokenOut: transfer.token,
          amount: transfer.amount.toString(),
          confidence: "medium",
        }));
      } else if (fromActor || toActor) {
        const other = fromActor ? transfer.to : transfer.from;
        if (protocolName(other)) {
          actions.push(action("trade.swap", `actor token transfer with ${protocolName(other)}`, order, {
            protocol: protocolName(other),
            tokenIn: fromActor ? transfer.token : undefined,
            tokenOut: toActor ? transfer.token : undefined,
            amount: transfer.amount.toString(),
            confidence: "low",
          }));
        }
      }
      continue;
    }

    const topic0 = lower(log.topics?.[0]);
    if (isSwapTopic(topic0)) {
      actions.push(action("trade.swap", `swap event at ${proto?.name ?? short(log.address)}`, order, {
        protocol: proto?.name,
        venue: log.address,
        confidence: "high",
      }));
    } else if (isLpMintTopic(topic0)) {
      actions.push(action("position.lp.mint", `LP mint event at ${proto?.name ?? short(log.address)}`, order, {
        protocol: proto?.name,
        venue: log.address,
        confidence: "medium",
      }));
    } else if (isLpBurnTopic(topic0)) {
      actions.push(action("position.lp.burn", `LP burn event at ${proto?.name ?? short(log.address)}`, order, {
        protocol: proto?.name,
        venue: log.address,
        confidence: "medium",
      }));
    } else if (topic0 === lower(TOPICS.wethDeposit)) {
      actions.push(action("wrap", "WETH Deposit event", order, { protocol: "WETH", confidence: "high" }));
    } else if (topic0 === lower(TOPICS.wethWithdrawal)) {
      actions.push(action("unwrap", "WETH Withdrawal event", order, { protocol: "WETH", confidence: "high" }));
    }
  }

  const rawDeltas: TokenDelta[] = [...deltas.entries()]
    .filter(([, raw]) => raw !== 0n)
    .map(([token, raw]) => {
      const meta = tokenMeta(token);
      return { token, symbol: meta.symbol, decimals: meta.decimals, raw };
    });

  return {
    actions,
    rawDeltas,
    tokens: [...tokens],
    venues: [...venues],
    protocols: [...protocols],
  };
}

function isSwapTopic(topic: string): boolean {
  return [
    TOPICS.univ2Swap,
    TOPICS.univ3Swap,
    TOPICS.univ4Swap,
    TOPICS.curveTokenExchange,
    TOPICS.curveTokenExchangeUnderlying,
  ].map(lower).includes(topic);
}

function isLpMintTopic(topic: string): boolean {
  return [TOPICS.univ2Mint, TOPICS.univ3Mint].map(lower).includes(topic);
}

function isLpBurnTopic(topic: string): boolean {
  return [TOPICS.univ2Burn, TOPICS.univ3Burn].map(lower).includes(topic);
}

function action(
  kind: Action["kind"],
  evidence: string,
  order: number,
  extra: Partial<Action>,
): Action {
  return {
    kind,
    evidence,
    order,
    confidence: extra.confidence ?? "medium",
    protocol: extra.protocol,
    venue: extra.venue,
    tokenIn: extra.tokenIn,
    tokenOut: extra.tokenOut,
    amount: extra.amount,
    address: extra.address,
  };
}
