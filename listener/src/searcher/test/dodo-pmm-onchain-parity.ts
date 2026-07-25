import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { ethers } from "ethers";
import {
  applyDodoTransferToInput,
  decodeDodoBoundedProbeCall,
  decodeDodoInputSemanticsCall,
  encodeDodoBoundedProbeCall,
  type DodoBoundedProbePlan,
  type DodoInputPosition,
  dodoV2PoolIface,
  encodeDodoInputSemanticsCall,
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
const expectedBlockHashRaw =
  process.env.DODO_PMM_PARITY_EXPECT_BLOCK_HASH?.trim();
const expectedUniverseSha256Raw =
  process.env.DODO_PMM_PARITY_EXPECT_UNIVERSE_SHA256?.trim();
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
  ["DODO_PMM_PARITY_EXPECT_BLOCK_HASH", expectedBlockHashRaw],
  ["DODO_PMM_PARITY_EXPECT_UNIVERSE_SHA256", expectedUniverseSha256Raw],
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
const expectedBlockHash = parseHash(
  expectedBlockHashRaw!,
  "expected block hash",
);
const expectedUniverseSha256 = parseSha256(
  expectedUniverseSha256Raw!,
  "expected universe sha256",
);
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
if (universeHash !== expectedUniverseSha256) {
  throw new Error(
    `DODO parity universe hash mismatch ${universeHash}/${expectedUniverseSha256}`,
  );
}
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
if (sourceBlockHash.toLowerCase() !== expectedBlockHash) {
  throw new Error(
    `DODO parity block hash mismatch ${sourceBlockHash}/${expectedBlockHash}`,
  );
}
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
  );
}
const initial = await rpcEthCallBatch(
  rpcUrl!,
  initialCalls,
  blockSpecifier,
);

const tokenSet = new Map<string, string>();
const baseStateByPool = new Map<string, {
  readonly baseToken: string;
  readonly quoteToken: string;
  readonly pmm: DodoPmmState;
  readonly lpFeeRate: bigint;
  readonly mtFeeRate: bigint;
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
  baseStateByPool.set(pool.toLowerCase(), Object.freeze({
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
  }));
}

const inputSemanticsCalls = pools.map((pool) => {
  const state = baseStateByPool.get(pool.toLowerCase())!;
  const call = encodeDodoInputSemanticsCall(
    pool,
    state.baseToken,
    state.quoteToken,
  );
  return {
    key: key(pool, "input-semantics"),
    request: call,
  };
});
const inputSemanticsResults = await rpcEthCallBatch(
  rpcUrl!,
  inputSemanticsCalls,
  blockSpecifier,
);
const staticByPool = new Map<string, {
  readonly baseToken: string;
  readonly quoteToken: string;
  readonly pmm: DodoPmmState;
  readonly lpFeeRate: bigint;
  readonly mtFeeRate: bigint;
  readonly baseInput: DodoInputPosition;
  readonly quoteInput: DodoInputPosition;
}>();
for (const pool of pools) {
  const base = baseStateByPool.get(pool.toLowerCase())!;
  const inputs = decodeDodoInputSemanticsCall(
    requireRpc(inputSemanticsResults, key(pool, "input-semantics")),
    pool,
    base.baseToken,
    base.quoteToken,
  );
  staticByPool.set(pool.toLowerCase(), Object.freeze({
    ...base,
    ...inputs,
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

type DodoLocalQuote = Extract<
  ReturnType<typeof quoteDodoPmmExactInput>,
  { readonly status: "quote" }
>;

interface LocalDirection {
  readonly classification: "local";
  readonly pool: string;
  readonly sellBase: boolean;
  readonly transferAmount: bigint;
  readonly effectiveInput: bigint;
  readonly local: DodoLocalQuote;
}
interface BoundedProbeDirection {
  readonly classification: "bounded-probe";
  readonly pool: string;
  readonly sellBase: boolean;
  readonly plan: DodoBoundedProbePlan;
}
type Direction = LocalDirection | BoundedProbeDirection;
const directions: Direction[] = [];
const queryCalls: RpcEthCall[] = [];
for (const pool of pools) {
  const state = staticByPool.get(pool.toLowerCase())!;
  for (const sellBase of [true, false]) {
    const token = sellBase ? state.baseToken : state.quoteToken;
    const reserve = sellBase ? state.pmm.B : state.pmm.Q;
    const inputPosition = sellBase ? state.baseInput : state.quoteInput;
    const selected = selectDodoBlockScanProbeInput({
      oneToken: oneToken.get(token.toLowerCase())!,
      currentInput: inputPosition.surplus,
      inputDeficit: inputPosition.deficit,
      reserve,
      pmm: state.pmm,
      sellBase,
      pool,
      lpFeeRate: state.lpFeeRate,
      mtFeeRate: state.mtFeeRate,
    });
    if (typeof selected !== "bigint") {
      const direction = Object.freeze({
        classification: "bounded-probe" as const,
        pool,
        sellBase,
        plan: selected,
      });
      directions.push(direction);
    } else {
      const transferAmount = selected;
      const effectiveInput = applyDodoTransferToInput(
        inputPosition,
        transferAmount,
        pool,
      );
      const local = quoteDodoPmmExactInput({
        state: state.pmm,
        sellBase,
        payAmount: effectiveInput,
        lpFeeRate: state.lpFeeRate,
        mtFeeRate: state.mtFeeRate,
      });
      if (local.status !== "quote" || local.amountOut <= 0n) {
        throw new Error(
          `DODO parity selector returned a non-local probe for ${pool} ` +
            `${sellBase ? "sell-base" : "sell-quote"}`,
        );
      }
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
    if (direction.classification === "bounded-probe") {
      const encoded = encodeDodoBoundedProbeCall(
        pool,
        sellBase,
        direction.plan,
        quoteActor,
      );
      queryCalls.push({
        key: queryKey(direction),
        request: encoded,
      });
    } else {
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
}

const queries = await rpcEthCallBatch(
  rpcUrl!,
  queryCalls,
  blockSpecifier,
  true,
);
let exact = 0;
let delegated = 0;
const delegatedByReason = new Map<string, number>();
const failures: string[] = [];
for (const direction of directions) {
  const result = queries.get(queryKey(direction));
  if (!result) {
    failures.push(`${queryKey(direction)} missing RPC result`);
    continue;
  }
  if (direction.classification === "bounded-probe") {
    delegated++;
    delegatedByReason.set(
      direction.plan.reason,
      (delegatedByReason.get(direction.plan.reason) ?? 0) + 1,
    );
    if (!result.ok) {
      failures.push(
        `${queryKey(direction)} bounded probe infrastructure failure: ` +
          result.error,
      );
      continue;
    }
    const quote = decodeDodoBoundedProbeCall(
      result.data,
      direction.pool,
      direction.sellBase,
      direction.plan,
    );
    if (!quote) {
      failures.push(
        `${queryKey(direction)} bounded probe found no positive quote`,
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
  if (onchain <= 0n) {
    failures.push(`${queryKey(direction)} exact query returned zero`);
    continue;
  }
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
const behaviorUnavailable = 0;
if (exact + delegated !== expectedPools * 2) {
  throw new Error(
    `DODO parity classified ${exact + delegated}/` +
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
  behaviorUnavailable,
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
    | "getPMMStateForCall",
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

function decodeAddress(value: unknown): string {
  return ethers.getAddress(String(value));
}

function decodeFirstWord(data: string): bigint {
  if (!/^0x[0-9a-fA-F]{64,}$/.test(data)) {
    throw new Error("DODO parity query returned malformed data");
  }
  return BigInt(`0x${data.slice(2, 66)}`);
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

function parseHash(value: string, label: string): string {
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error(`invalid DODO parity ${label}: ${value}`);
  }
  return value.toLowerCase();
}

function parseSha256(value: string, label: string): string {
  if (!/^[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error(`invalid DODO parity ${label}: ${value}`);
  }
  return value.toLowerCase();
}

function parseOptionalPositiveInteger(
  value: string | undefined,
  fallback: number,
  label: string,
): number {
  return value === undefined ? fallback : parsePositiveInteger(value, label);
}
