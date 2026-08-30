import { DODO_V2_SWAP_TOPIC } from "./manifest.ts";

export interface DodoV2SwapLogV1 {
  readonly soldToken: string;
  readonly boughtToken: string;
  readonly soldAmount: bigint;
  readonly boughtAmount: bigint;
  readonly seller: string;
  readonly receiver: string;
}

function addressWord(value: string, path: string): string {
  const match = /^0{24}([0-9a-f]{40})$/.exec(value);
  if (match === null || /^0{40}$/.test(match[1]!)) throw new TypeError(`${path} must be a canonical padded nonzero address`);
  return `0x${match[1]!}`;
}

export function decodeDodoV2SwapLog(
  raw: { readonly topics: readonly string[]; readonly data: string },
  path = "dodo-v2.DODOSwap",
): DodoV2SwapLogV1 {
  if (raw.topics.length !== 1 || raw.topics[0] !== DODO_V2_SWAP_TOPIC) throw new TypeError(`${path} topic layout mismatch`);
  if (!/^0x(?:[0-9a-f]{64}){6}$/.test(raw.data)) throw new TypeError(`${path}.data must contain exactly 6 ABI words`);
  const words = Object.freeze(Array.from({ length: 6 }, (_, index) => raw.data.slice(2 + index * 64, 2 + (index + 1) * 64)));
  const soldAmount = BigInt(`0x${words[2]!}`);
  const boughtAmount = BigInt(`0x${words[3]!}`);
  if (soldAmount === 0n || boughtAmount === 0n) throw new TypeError(`${path} contains a zero amount`);
  return Object.freeze({
    soldToken: addressWord(words[0]!, `${path}.soldToken`),
    boughtToken: addressWord(words[1]!, `${path}.boughtToken`),
    soldAmount,
    boughtAmount,
    seller: addressWord(words[4]!, `${path}.seller`),
    receiver: addressWord(words[5]!, `${path}.receiver`),
  });
}
