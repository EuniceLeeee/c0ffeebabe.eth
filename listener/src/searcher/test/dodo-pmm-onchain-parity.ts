import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { ethers } from "ethers";
import {
  dodoV2PoolIface,
  selectDodoBlockScanProbeInput,
} from "../venues/swaps/dodo-v2.js";
import {
  type DodoPmmState,
  quoteDodoPmmExactInput,
} from "../venues/swaps/dodo-pmm-math.js";

const rpcUrl = process.env.DODO_PMM_PARITY_RPC_URL?.trim();
const universePath = process.env.DODO_PMM_PARITY_UNIVERSE?.trim();
const sourceBlockRaw = process.env.DODO_PMM_PARITY_SOURCE_BLOCK?.trim();
const expectedPoolsRaw = process.env.DODO_PMM_PARITY_EXPECT_POOLS?.trim();
const quoteActorRaw = process.env.DODO_PMM_PARITY_QUOTE_ACTOR?.trim();
const expectedExactRaw = process.env.DODO_PMM_PARITY_EXPECT_EXACT?.trim();
const expectedDelegatedRaw =
  process.env.DODO_PMM_PARITY_EXPECT_DELEGATED?.trim();
const expectedUnavailableRaw =
  process.env.DODO_PMM_PARITY_EXPECT_UNAVAILABLE?.trim();
const formalEvidence = process.env.DODO_PMM_PARITY_FORMAL === "1";

const missingConfiguration = [
  ["DODO_PMM_PARITY_RPC_URL", rpcUrl],
  ["DODO_PMM_PARITY_UNIVERSE", universePath],
  ["DODO_PMM_PARITY_SOURCE_BLOCK", sourceBlockRaw],
  ["DODO_PMM_PARITY_EXPECT_POOLS", expectedPoolsRaw],
  ["DODO_PMM_PARITY_QUOTE_ACTOR", quoteActorRaw],
  ["DODO_PMM_PARITY_EXPECT_EXACT", expectedExactRaw],
  ["DODO_PMM_PARITY_EXPECT_DELEGATED", expectedDelegatedRaw],
  ["DODO_PMM_PARITY_EXPECT_UNAVAILABLE", expectedUnavailableRaw],
].filter(([, value]) => !value).map(([name]) => name);
if (missingConfiguration.length > 0) {
  if (formalEvidence) {
    throw new Error(
      `formal DODO parity is missing ${missingConfiguration.join(", ")}`,
    );
  }
  console.log(JSON.stringify({
    status: "SKIP",
    formalEvidence: false,
    reason: "missing explicit frozen-corpus configuration",
    missing: missingConfiguration,
  }));
  process.exit(0);
}

const sourceBlock = parsePositiveInteger(sourceBlockRaw!, "source block");
const expectedPools = parsePositiveInteger(expectedPoolsRaw!, "expected pools");
const quoteActor = ethers.getAddress(quoteActorRaw!);
const expectedExact = parseNonNegativeInteger(
  expectedExactRaw!,
  "expected exact directions",
);
const expectedDelegated = parseNonNegativeInteger(
  expectedDelegatedRaw!,
  "expected delegated directions",
);
const expectedUnavailable = parseNonNegativeInteger(
  expectedUnavailableRaw!,
  "expected unavailable directions",
);
if (
  expectedExact + expectedDelegated + expectedUnavailable !==
    expectedPools * 2
) {
  throw new Error(
    `DODO parity expected distribution ` +
      `${expectedExact}+${expectedDelegated}+${expectedUnavailable} does not ` +
      `cover ${expectedPools * 2} directions`,
  );
}
const universeBytes = await readFile(universePath!);
const universeHash = createHash("sha256").update(universeBytes).digest("hex");
const universe = JSON.parse(universeBytes.toString("utf8")) as {
  readonly pools?: readonly {
    readonly address?: string;
    readonly adapter?: string;
  }[];
};
if (!Array.isArray(universe.pools)) {
  throw new Error("DODO parity universe has no pools array");
}
const pools = [
  ...new Map(
    universe.pools
      .filter((pool) => pool.adapter === "dodo-v2" && pool.address)
      .map((pool) => {
        const address = ethers.getAddress(pool.address!);
        return [address.toLowerCase(), address] as const;
      }),
  ).values(),
].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
if (pools.length !== expectedPools) {
  throw new Error(
    `DODO parity corpus contains ${pools.length}/${expectedPools} pools`,
  );
}

const block = await rpcSingle<{
  readonly number: string;
  readonly hash: string;
}>(
  rpcUrl!,
  "eth_getBlockByNumber",
  [ethers.toQuantity(sourceBlock), false],
);
if (
  Number(BigInt(block.number)) !== sourceBlock ||
  !/^0x[0-9a-fA-F]{64}$/.test(block.hash)
) {
  throw new Error(`DODO parity source block mismatch ${block.number}/${block.hash}`);
}
const sourceBlockHash = block.hash;
const blockSpecifier = Object.freeze({
  blockHash: sourceBlockHash,
  requireCanonical: true,
});
const decimalsIface = new ethers.Interface([
  "function decimals() view returns (uint8)",
]);

const initialCalls: RpcEthCall[] = [];
for (const pool of pools) {
  initialCalls.push(
    poolCall(pool, "base-token", "_BASE_TOKEN_"),
    poolCall(pool, "quote-token", "_QUOTE_TOKEN_"),
    poolCall(pool, "pmm-state", "getPMMStateForCall"),
    {
      key: key(pool, "user-fee-rate"),
      request: {
        to: pool,
        data: dodoV2PoolIface.encodeFunctionData("getUserFeeRate", [
          quoteActor,
        ]),
      },
    },
    poolCall(pool, "base-input", "getBaseInput"),
    poolCall(pool, "quote-input", "getQuoteInput"),
  );
}
const initial = await rpcEthCallBatch(
  rpcUrl!,
  initialCalls,
  blockSpecifier,
);

const tokenSet = new Map<string, string>();
const staticByPool = new Map<string, {
  readonly baseToken: string;
  readonly quoteToken: string;
  readonly pmm: DodoPmmState;
  readonly lpFeeRate: bigint;
  readonly mtFeeRate: bigint;
  readonly baseInput: bigint;
  readonly quoteInput: bigint;
}>();
for (const pool of pools) {
  const baseToken = decodeAddress(
    dodoV2PoolIface.decodeFunctionResult(
      "_BASE_TOKEN_",
      requireRpc(initial, key(pool, "base-token")),
    )[0],
  );
  const quoteToken = decodeAddress(
    dodoV2PoolIface.decodeFunctionResult(
      "_QUOTE_TOKEN_",
      requireRpc(initial, key(pool, "quote-token")),
    )[0],
  );
  tokenSet.set(baseToken.toLowerCase(), baseToken);
  tokenSet.set(quoteToken.toLowerCase(), quoteToken);
  const decodedPmm = dodoV2PoolIface.decodeFunctionResult(
    "getPMMStateForCall",
    requireRpc(initial, key(pool, "pmm-state")),
  );
  const R = Number(decodedPmm[6]);
  if (R !== 0 && R !== 1 && R !== 2) {
    throw new Error(`DODO parity pool ${pool} returned invalid R ${R}`);
  }
  const fee = dodoV2PoolIface.decodeFunctionResult(
    "getUserFeeRate",
    requireRpc(initial, key(pool, "user-fee-rate")),
  );
  staticByPool.set(pool.toLowerCase(), Object.freeze({
    baseToken,
    quoteToken,
    pmm: Object.freeze({
      i: BigInt(decodedPmm[0]),
      K: BigInt(decodedPmm[1]),
      B: BigInt(decodedPmm[2]),
      Q: BigInt(decodedPmm[3]),
      B0: BigInt(decodedPmm[4]),
      Q0: BigInt(decodedPmm[5]),
      R,
    }),
    lpFeeRate: BigInt(fee[0]),
    mtFeeRate: BigInt(fee[1]),
    baseInput: decodeUint(
      dodoV2PoolIface,
      "getBaseInput",
      requireRpc(initial, key(pool, "base-input")),
    ),
    quoteInput: decodeUint(
      dodoV2PoolIface,
      "getQuoteInput",
      requireRpc(initial, key(pool, "quote-input")),
    ),
  }));
}

const decimalCalls = [...tokenSet.values()].map((token) => ({
  key: `decimals:${token.toLowerCase()}`,
  request: {
    to: token,
    data: decimalsIface.encodeFunctionData("decimals"),
  },
}));
const decimalResults = await rpcEthCallBatch(
  rpcUrl!,
  decimalCalls,
  blockSpecifier,
);
const oneToken = new Map<string, bigint>();
for (const token of tokenSet.values()) {
  const decimals = Number(decimalsIface.decodeFunctionResult(
    "decimals",
    requireRpc(decimalResults, `decimals:${token.toLowerCase()}`),
  )[0]);
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) {
    throw new Error(`DODO parity token ${token} returned decimals ${decimals}`);
  }
  oneToken.set(token.toLowerCase(), 10n ** BigInt(decimals));
}

interface LocalDirection {
  readonly classification: "local";
  readonly pool: string;
  readonly sellBase: boolean;
  readonly transferAmount: bigint;
  readonly effectiveInput: bigint;
  readonly local: ReturnType<typeof quoteDodoPmmExactInput>;
}
interface UnavailableDirection {
  readonly classification: "behavior-unavailable";
  readonly pool: string;
  readonly sellBase: boolean;
  readonly transferAmount: bigint;
  readonly effectiveInput: bigint;
  readonly reason: string;
}
type Direction = LocalDirection | UnavailableDirection;
const directions: Direction[] = [];
const queryCalls: RpcEthCall[] = [];
let behaviorUnavailable = 0;
const behaviorUnavailableReasons = new Map<string, number>();
for (const pool of pools) {
  const state = staticByPool.get(pool.toLowerCase())!;
  for (const sellBase of [true, false]) {
    const token = sellBase ? state.baseToken : state.quoteToken;
    const reserve = sellBase ? state.pmm.B : state.pmm.Q;
    const currentInput = sellBase ? state.baseInput : state.quoteInput;
    const selected = selectDodoBlockScanProbeInput({
      oneToken: oneToken.get(token.toLowerCase())!,
      currentInput,
      reserve,
      pmm: state.pmm,
      sellBase,
      pool,
    });
    if (typeof selected !== "bigint") {
      const transferAmount = selectUnavailableTransferAmount({
        oneToken: oneToken.get(token.toLowerCase())!,
        reserve,
      });
      const direction = Object.freeze({
        classification: "behavior-unavailable" as const,
        pool,
        sellBase,
        transferAmount,
        effectiveInput: checkedAdd(currentInput, transferAmount),
        reason: selected.reason,
      });
      directions.push(direction);
    } else {
      const transferAmount = selected;
      const effectiveInput = checkedAdd(currentInput, transferAmount);
      const local = quoteDodoPmmExactInput({
        state: state.pmm,
        sellBase,
        payAmount: effectiveInput,
        lpFeeRate: state.lpFeeRate,
        mtFeeRate: state.mtFeeRate,
      });
      directions.push(Object.freeze({
        classification: "local" as const,
        pool,
        sellBase,
        transferAmount,
        effectiveInput,
        local,
      }));
    }
    const direction = directions[directions.length - 1];
    const queryFunction = sellBase ? "querySellBase" : "querySellQuote";
    queryCalls.push({
      key: queryKey(direction),
      request: {
        from: quoteActor,
        to: pool,
        data: dodoV2PoolIface.encodeFunctionData(queryFunction, [
          quoteActor,
          direction.effectiveInput,
        ]),
      },
    });
  }
}

const queries = await rpcEthCallBatch(
  rpcUrl!,
  queryCalls,
  blockSpecifier,
  true,
);
let exact = 0;
let delegated = 0;
let delegatedReverts = 0;
const delegatedByReason = new Map<string, number>();
const failures: string[] = [];
for (const direction of directions) {
  const result = queries.get(queryKey(direction));
  if (!result) {
    failures.push(`${queryKey(direction)} missing RPC result`);
    continue;
  }
  if (direction.classification === "behavior-unavailable") {
    if (result.ok) {
      failures.push(
        `${queryKey(direction)} was marked unavailable but query succeeded`,
      );
      continue;
    }
    if (!isExecutionRevert(result.error)) {
      failures.push(
        `${queryKey(direction)} unavailable proof had infrastructure failure: ` +
          result.error,
      );
      continue;
    }
    behaviorUnavailable++;
    behaviorUnavailableReasons.set(
      direction.reason,
      (behaviorUnavailableReasons.get(direction.reason) ?? 0) + 1,
    );
    continue;
  }
  if (direction.local.status === "needs-onchain-quote") {
    delegated++;
    delegatedByReason.set(
      direction.local.reason,
      (delegatedByReason.get(direction.local.reason) ?? 0) + 1,
    );
    if (!result.ok) {
      if (isExecutionRevert(result.error)) {
        delegatedReverts++;
      }
      failures.push(
        `${queryKey(direction)} delegated query failed: ${result.error}`,
      );
    }
    continue;
  }
  if (!result.ok) {
    failures.push(
      `${queryKey(direction)} query reverted while local math returned ` +
        `${direction.local.amountOut}: ${result.error}`,
    );
    continue;
  }
  const onchain = decodeFirstWord(result.data);
  if (onchain !== direction.local.amountOut) {
    failures.push(
      `${queryKey(direction)} local=${direction.local.amountOut} chain=${onchain}`,
    );
    continue;
  }
  exact++;
}

if (directions.length !== expectedPools * 2) {
  throw new Error(
    `DODO parity evaluated ${directions.length}/` +
      `${expectedPools * 2} directions`,
  );
}
if (failures.length > 0) {
  throw new Error(
    `DODO PMM parity failed ${failures.length}/${directions.length}: ` +
      failures.slice(0, 20).join("; "),
  );
}
if (exact + delegated + behaviorUnavailable !== expectedPools * 2) {
  throw new Error(
    `DODO parity classified ${exact + delegated + behaviorUnavailable}/` +
      `${expectedPools * 2} directions`,
  );
}
if (
  exact !== expectedExact ||
  delegated !== expectedDelegated ||
  behaviorUnavailable !== expectedUnavailable
) {
  throw new Error(
    `DODO parity distribution changed: actual ` +
      `${exact}/${delegated}/${behaviorUnavailable}, expected ` +
      `${expectedExact}/${expectedDelegated}/${expectedUnavailable} ` +
      `(exact/delegated/unavailable)`,
  );
}
console.log(JSON.stringify({
  status: "PASS",
  formalEvidence,
  sourceBlock,
  sourceBlockHash,
  universeSha256: universeHash,
  quoteActor,
  pools: pools.length,
  directions: expectedPools * 2,
  exactPerWei: exact,
  delegated,
  delegatedByReason: Object.fromEntries(
    [...delegatedByReason].sort(([a], [b]) => a.localeCompare(b)),
  ),
  delegatedReverts,
  behaviorUnavailable,
  behaviorUnavailableReasons: Object.fromEntries(
    [...behaviorUnavailableReasons].sort(([a], [b]) => a.localeCompare(b)),
  ),
}));

interface RpcEthCall {
  readonly key: string;
  readonly request: {
    readonly from?: string;
    readonly to: string;
    readonly data: string;
  };
}

type RpcCallResult =
  | { readonly ok: true; readonly data: string }
  | { readonly ok: false; readonly error: string };

function poolCall(
  pool: string,
  field: string,
  functionName:
    | "_BASE_TOKEN_"
    | "_QUOTE_TOKEN_"
    | "getPMMStateForCall"
    | "getBaseInput"
    | "getQuoteInput",
): RpcEthCall {
  return {
    key: key(pool, field),
    request: {
      to: pool,
      data: dodoV2PoolIface.encodeFunctionData(functionName),
    },
  };
}

async function rpcEthCallBatch(
  url: string,
  calls: readonly RpcEthCall[],
  blockSpecifier: Readonly<{
    readonly blockHash: string;
    readonly requireCanonical: true;
  }>,
  retainErrors = false,
): Promise<ReadonlyMap<string, RpcCallResult>> {
  const chunkSize = parseOptionalPositiveInteger(
    process.env.DODO_PMM_PARITY_BATCH_SIZE,
    100,
    "batch size",
  );
  const concurrency = parseOptionalPositiveInteger(
    process.env.DODO_PMM_PARITY_CONCURRENCY,
    4,
    "batch concurrency",
  );
  const chunks: RpcEthCall[][] = [];
  for (let index = 0; index < calls.length; index += chunkSize) {
    chunks.push(calls.slice(index, index + chunkSize));
  }
  const output = new Map<string, RpcCallResult>();
  let next = 0;
  await Promise.all(Array.from(
    { length: Math.min(concurrency, chunks.length) },
    async () => {
      while (next < chunks.length) {
        const chunk = chunks[next++];
        const idToKey = new Map<number, string>();
        const body = chunk.map((call, index) => {
          const id = index + 1;
          idToKey.set(id, call.key);
          return {
            jsonrpc: "2.0",
            id,
            method: "eth_call",
            params: [call.request, blockSpecifier],
          };
        });
        const response = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        if (!response.ok) {
          throw new Error(`DODO parity RPC HTTP ${response.status}`);
        }
        const payload = await response.json() as readonly {
          readonly id: number;
          readonly result?: string;
          readonly error?: { readonly code?: number; readonly message?: string };
        }[];
        if (!Array.isArray(payload)) {
          throw new Error("DODO parity RPC does not support JSON-RPC batching");
        }
        for (const item of payload) {
          const key = idToKey.get(item.id);
          if (!key) throw new Error(`DODO parity RPC returned unknown id ${item.id}`);
          if (typeof item.result === "string") {
            output.set(key, Object.freeze({ ok: true, data: item.result }));
          } else {
            output.set(key, Object.freeze({
              ok: false,
              error: item.error?.message ?? `RPC error ${String(item.error?.code)}`,
            }));
          }
        }
        for (const key of idToKey.values()) {
          if (!output.has(key)) {
            output.set(key, Object.freeze({
              ok: false,
              error: "RPC omitted batch result",
            }));
          }
        }
      }
    },
  ));
  if (!retainErrors) {
    const failed = [...output].filter(([, result]) => !result.ok);
    if (failed.length > 0) {
      throw new Error(
        `DODO parity prerequisite reads failed ${failed.length}/${calls.length}: ` +
          failed.slice(0, 20).map(([key, result]) =>
            `${key}: ${result.ok ? "" : result.error}`
          ).join("; "),
      );
    }
  }
  return output;
}

async function rpcSingle<T>(
  url: string,
  method: string,
  params: readonly unknown[],
): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!response.ok) throw new Error(`DODO parity RPC HTTP ${response.status}`);
  const payload = await response.json() as {
    readonly result?: T;
    readonly error?: { readonly message?: string };
  };
  if (payload.result === undefined) {
    throw new Error(payload.error?.message ?? `DODO parity ${method} failed`);
  }
  return payload.result;
}

function requireRpc(
  results: ReadonlyMap<string, RpcCallResult>,
  key: string,
): string {
  const result = results.get(key);
  if (!result) throw new Error(`DODO parity missing ${key}`);
  if (!result.ok) throw new Error(`DODO parity ${key}: ${result.error}`);
  return result.data;
}

function decodeUint(
  iface: ethers.Interface,
  functionName: string,
  data: string,
): bigint {
  return BigInt(iface.decodeFunctionResult(functionName, data)[0]);
}

function decodeAddress(value: unknown): string {
  return ethers.getAddress(String(value));
}

function decodeFirstWord(data: string): bigint {
  if (!/^0x[0-9a-fA-F]{64,}$/.test(data)) {
    throw new Error("DODO parity query returned malformed data");
  }
  return BigInt(`0x${data.slice(2, 66)}`);
}

function isExecutionRevert(error: string): boolean {
  if (/timeout|timed out|rate|limit|busy|429|unavailable|connection/i.test(error)) {
    return false;
  }
  return /revert|execution error|invalid opcode|panic|arithmetic/i.test(error);
}

function checkedAdd(a: bigint, b: bigint): bigint {
  const result = a + b;
  if (a < 0n || b < 0n || result >= 1n << 256n) {
    throw new Error("DODO parity effective input overflow");
  }
  return result;
}

function selectUnavailableTransferAmount(input: {
  readonly oneToken: bigint;
  readonly reserve: bigint;
}): bigint {
  const reserveProbe = input.reserve > 0n
    ? (input.reserve >= 100n ? input.reserve / 100n : 1n)
    : 1n;
  const amount = input.oneToken > 0n && input.oneToken < reserveProbe
    ? input.oneToken
    : reserveProbe;
  return amount > 0n ? amount : 1n;
}

function key(pool: string, field: string): string {
  return `${pool.toLowerCase()}:${field}`;
}

function queryKey(direction: {
  readonly pool: string;
  readonly sellBase: boolean;
}): string {
  return key(direction.pool, direction.sellBase ? "sell-base" : "sell-quote");
}

function parsePositiveInteger(value: string, label: string): number {
  const parsed = value.startsWith("0x")
    ? Number(BigInt(value))
    : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`invalid DODO parity ${label}: ${value}`);
  }
  return parsed;
}

function parseNonNegativeInteger(value: string, label: string): number {
  const parsed = value.startsWith("0x")
    ? Number(BigInt(value))
    : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`invalid DODO parity ${label}: ${value}`);
  }
  return parsed;
}

function parseOptionalPositiveInteger(
  value: string | undefined,
  fallback: number,
  label: string,
): number {
  return value === undefined ? fallback : parsePositiveInteger(value, label);
}
