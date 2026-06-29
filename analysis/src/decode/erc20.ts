import { TOPICS, lower, tokenMeta } from "../registry/protocols.js";

export interface TransferLog {
  token: string;
  from: string;
  to: string;
  amount: bigint;
}

export function decodeTransfer(log: any): TransferLog | null {
  if (lower(log.topics?.[0]) !== lower(TOPICS.transfer)) return null;
  if ((log.topics?.length ?? 0) !== 3) return null; // ERC721 Transfer has 4 topics.
  return {
    token: log.address,
    from: topicAddress(log.topics[1]),
    to: topicAddress(log.topics[2]),
    amount: BigInt(log.data === "0x" ? "0" : log.data),
  };
}

export function topicAddress(topic: string): string {
  return `0x${topic.slice(-40)}`.toLowerCase();
}

export function formatTokenAmount(token: string, raw: bigint): string {
  const meta = tokenMeta(token);
  const neg = raw < 0n;
  const x = neg ? -raw : raw;
  const scale = 10n ** BigInt(meta.decimals);
  const whole = x / scale;
  const frac = (x % scale).toString().padStart(meta.decimals, "0").replace(/0+$/g, "");
  return `${neg ? "-" : ""}${whole.toString()}${frac ? `.${frac}` : ""} ${meta.symbol}`;
}
