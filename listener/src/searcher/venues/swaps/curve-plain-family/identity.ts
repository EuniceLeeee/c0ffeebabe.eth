import { ethers } from "ethers";
import { ADDR } from "../../../../shared/constants/addresses.js";
import type { IdentityDecision, IdentitySemantics } from "../../adapter-family-plugin.js";
import type { AdapterRequest, AdapterRequestResult, CanonicalSource } from "../../adapter-request-program.js";
import { hashCanonical } from "../../canonical-value.js";
import { CURVE_METAREGISTRY, META, POOL, ERC20, GETTER_ABIS, INT_MODES, UINT_MODES, pullsInput, address, addressArray, assertSource,
  call, executionData, getterPool, getterReadId, hasReceiver, lower, probeAmount, quotePool, result, resultSource, returned, same, uint,
  isNativeCoin, isNativeMode, routeToken } from "./codec.js";
import { nativeExecutionProbe } from "./native.js";
import { executionInputMatches, executionOutputMatches } from "../../../../shared/executor/amount-rounding.js";
import { CURVE_PLAIN_FAMILY_ID, CURVE_PLAIN_LINEAGE } from "./manifest.js";
import type { CurveIndexAbi, CurvePlainBinding, CurvePlainCandidate, CurvePlainDirection, CurvePlainIdentity, CurvePlainMode } from "./types.js";

// Only the receiver for an isolated behavior probe. Caller authority remains the
// framework's executor, and this address never admits a pool or routes real funds.
export const PROBE_RECEIVER = "0x0000000000000000000000000000000000000001";
const caller = Object.freeze({ kind: "executor" as const });
type QuoteDirection = Omit<CurvePlainDirection, "executionMode">;
interface Evidence {
  readonly phase: "registry" | "structure" | "quotes" | "execution";
  readonly source: CanonicalSource;
  readonly pool: string;
  readonly binding: Omit<CurvePlainBinding, "coinAbi" | "balanceAbi"> & {
    readonly coinAbi: CurveIndexAbi | null;
    readonly balanceAbi: CurveIndexAbi | null;
  };
  readonly balances: readonly bigint[];
  readonly quotes: readonly QuoteDirection[];
  readonly directions: readonly CurvePlainDirection[];
  readonly requestIds: readonly string[];
  readonly rejection?: string;
  readonly executor?: string;
}

function identityVariant(quoteAbi: CurveIndexAbi): IdentitySemantics<CurvePlainCandidate, CurvePlainIdentity>["variants"][number] {
  const modes: readonly CurvePlainMode[] = quoteAbi === "int128" ? INT_MODES : UINT_MODES;
  return {
    id: `registry-direct-coin-behavior-${quoteAbi}`, kind: "registry-member", lineageId: CURVE_PLAIN_LINEAGE,
    applies: candidate => candidate.candidateKind === "curve-plain-pool",
    requirements({ evidence }) {
      const prior = evidence as Evidence | undefined;
      if (prior?.phase === "registry" && prior.binding.coins.some(isNativeCoin))
        return { transports: ["eth-call", "effect-delta-simulation"], caller: "executor",
          effects: ["return-data", "revert-data", "token-delta", "native-delta"] };
      if (prior?.phase === "quotes" && prior.quotes.some(q =>
          isNativeCoin(prior.binding.coins[q.i]) || isNativeCoin(prior.binding.coins[q.j])))
        return { transports: ["effect-delta-simulation"], caller: "executor",
          effects: ["return-data", "revert-data", "token-delta", "native-delta", "logs"] };
      if (prior?.phase === "quotes")
        return { transports: ["effect-delta-simulation"], caller: "executor",
          effects: ["return-data", "revert-data", "token-delta", "logs"] };
      return { transports: evidence === undefined ? ["eth-call", "get-code"] : ["eth-call"] };
    },
    buildRequests({ candidate, evidence, executionRoundingRawUnits = 0n }) {
      const prior = evidence as Evidence | undefined;
      if (!prior) return [
        { id: "pool-code", kind: "get-code", address: candidate.pool },
        call("registry-handlers", CURVE_METAREGISTRY, META.encodeFunctionData("get_registry_handlers_from_pool", [candidate.pool])),
        call("registry-coins", CURVE_METAREGISTRY, META.encodeFunctionData("get_coins", [candidate.pool])),
      ];
      if (prior.rejection) return [];
      if (prior.phase === "registry") return [
        call("amplification", prior.pool, POOL.encodeFunctionData("A")),
        call("fee", prior.pool, POOL.encodeFunctionData("fee")),
        ...prior.binding.coins.flatMap((coin, i) => [
          ...(isNativeCoin(coin) ? [] : [call(`decimals:${i}`, coin, ERC20.encodeFunctionData("decimals"))]),
          ...GETTER_ABIS.flatMap(abi => [
            call(getterReadId("coin", abi, i), prior.pool, getterPool(abi).encodeFunctionData("coins", [i])),
            call(getterReadId("balance", abi, i), prior.pool, getterPool(abi).encodeFunctionData("balances", [i])),
          ]),
        ]),
        ...(prior.binding.coins.some(isNativeCoin) ? [nativeExecutorRequest()] : []),
      ];
      if (prior.phase === "structure") return pairs(prior.binding.coins.length).flatMap(([i, j]) => {
        const amount = probeAmount(prior.binding.decimals[i], prior.balances[i]);
        return [amount, amount * 10n].map((dx, probe) =>
          call(`quote:${i}:${j}:${probe}`, prior.pool, quotePool(quoteAbi).encodeFunctionData("get_dy", [i, j, dx])));
      });
      if (prior.phase === "quotes") return prior.quotes.flatMap(quote =>
        (isNativeCoin(prior.binding.coins[quote.i]) || isNativeCoin(prior.binding.coins[quote.j]))
          ? [nativeExecutionProbe(prior.pool, quote, quoteAbi === "int128" ? "native-exchange" : "native-exchange-uint",
            prior.executor!, prior.binding.coins, executionRoundingRawUnits)]
          : modes.map(mode => executionProbe(prior.pool, quote, mode)));
      return [];
    },
    decode({ step, results }) {
      const source = resultSource(results);
      const prior = step.evidence as Evidence | undefined;
      const requestIds = results.map(item => item.id);
      if (!prior) {
        const code = returned(results, "pool-code").data;
        const handlersResult = result(results, "registry-handlers");
        const coinsResult = result(results, "registry-coins");
        const handlers = handlersResult.completion === "returned" ? addressArray(handlersResult.data, 10) : [];
        const coins = coinsResult.completion === "returned" ? addressArray(coinsResult.data, 8) : [];
        const rejection = code === "0x" ? "no-pool-code" : handlers.length === 0 ? "no-registry-membership" :
          coins.length < 2 || new Set(coins.map(coin => lower(routeToken(coin)))).size !== coins.length
            ? "unsupported-direct-coin-domain" : undefined;
        return { phase: "registry", source, pool: ethers.getAddress(step.candidate.pool),
          binding: { quoteAbi, coinAbi: null, balanceAbi: null, registry: CURVE_METAREGISTRY,
            handlers, codeHash: ethers.keccak256(code), coins, decimals: [] },
          balances: [], quotes: [], directions: [], requestIds,
          ...(rejection ? { rejection } : {}) } satisfies Evidence;
      }
      assertSource(source, prior.source);
      if (prior.phase === "registry") {
        const decimals: number[] = [], balances: bigint[] = [];
        let rejection: string | undefined;
        const coinsRead = selectGetter(results, "coin", prior.binding.coins.length, address);
        const balancesRead = selectGetter(results, "balance", prior.binding.coins.length, uint);
        for (const id of ["amplification", "fee", ...prior.binding.coins.flatMap((coin, i) => isNativeCoin(coin) ? [] : [`decimals:${i}`])]) {
          const read = result(results, id);
          if (read.completion !== "returned") rejection = "unsupported-direct-state-surface";
        }
        if (!coinsRead || !balancesRead) rejection = "unsupported-direct-state-surface";
        if (!rejection && coinsRead && balancesRead) {
          const amplification = uint(returned(results, "amplification").data);
          const fee = uint(returned(results, "fee").data);
          if (amplification === 0n || fee >= 10_000_000_000n) rejection = "invalid-stableswap-state";
          prior.binding.coins.forEach((coin, i) => {
            if (!same(coinsRead.values[i], coin)) rejection = "registry-direct-coin-mismatch";
            const d = isNativeCoin(coin) ? 18 : Number(uint(returned(results, `decimals:${i}`).data));
            const balance = balancesRead.values[i];
            if (!Number.isSafeInteger(d) || d < 0 || d > 36) rejection = "unsupported-token-scale";
            decimals.push(d); balances.push(balance);
          });
        }
        return { ...prior, phase: "structure", binding: { ...prior.binding, decimals,
          coinAbi: coinsRead?.abi ?? null, balanceAbi: balancesRead?.abi ?? null }, balances, requestIds,
          ...(prior.binding.coins.some(isNativeCoin) ? { executor: nativeExecutor(results, prior.pool) } : {}),
          ...(rejection ? { rejection } : {}) } satisfies Evidence;
      }
      if (prior.phase === "structure") {
        const quotes: QuoteDirection[] = [];
        for (const [i, j] of pairs(prior.binding.coins.length)) {
          const amountIn = probeAmount(prior.binding.decimals[i], prior.balances[i]);
          const small = result(results, `quote:${i}:${j}:0`);
          const large = result(results, `quote:${i}:${j}:1`);
          if (small.completion !== "returned" || large.completion !== "returned") continue;
          const amountOut = uint(small.data), largerOut = uint(large.data);
          if (amountOut <= 0n || largerOut <= amountOut || largerOut >= prior.balances[j]) continue;
          quotes.push({ i, j, tokenIn: routeToken(prior.binding.coins[i]), tokenOut: routeToken(prior.binding.coins[j]), amountIn, amountOut });
        }
        return { ...prior, phase: "quotes", quotes, requestIds } satisfies Evidence;
      }
      if (prior.phase !== "quotes") throw new Error("curve-plain identity already completed");
      const directions: CurvePlainDirection[] = [];
      for (const quote of prior.quotes) {
        // Stable preference is independent of the discovery call/log and its receiver.
        // Only proved modes are eligible. An unavailable alternative does not
        // invalidate another mode's complete proof or create a fallback edge.
        const quoteModes: readonly CurvePlainMode[] = isNativeCoin(prior.binding.coins[quote.i]) || isNativeCoin(prior.binding.coins[quote.j])
          ? [quoteAbi === "int128" ? "native-exchange" : "native-exchange-uint"] : modes;
        const supported = quoteModes.filter(mode => isNativeMode(mode)
          ? provesNativeExecution(results, quote, mode, prior.executor!, step.executionRoundingRawUnits ?? 0n)
          : provesExecution(results, prior.pool, quote, mode));
        if (supported.length) directions.push({ ...quote, executionMode: supported[0] });
        // Another direction's success cannot turn unknown execution evidence
        // for this positive quote into proof that the direction is unsupported.
        else if (results.some(read => !read.ok && quoteModes.some(mode =>
          read.id === `execution:${quote.i}:${quote.j}:${mode}`))) {
          throw new Error("curve-plain unresolved execution proof");
        }
      }
      return { ...prior, phase: "execution", directions, requestIds } satisfies Evidence;
    },
    decide({ candidate, evidence }): IdentityDecision<CurvePlainIdentity> {
      const prior = evidence as Evidence | undefined;
      if (!prior) return { status: "continue" };
      if (prior.rejection) return { status: "chain-proven-rejected", reasonCode: prior.rejection, evidenceRequestIds: prior.requestIds };
      if (prior.phase === "structure" && prior.balances.some(balance => balance === 0n)) {
        return { status: "retryable", reasonCode: "no-current-liquidity" };
      }
      if (prior.phase === "quotes" && prior.quotes.length === 0) {
        return { status: "retryable", reasonCode: `no-positive-${quoteAbi}-quote-pair` };
      }
      if (prior.phase !== "execution") return { status: "continue" };
      if (prior.directions.length === 0) return { status: "retryable", reasonCode: "no-execution-proven-direction" };
      if (candidate.hintedI !== null && !prior.directions.some(direction =>
        direction.i === candidate.hintedI && direction.j === candidate.hintedJ)) {
        return { status: "retryable", reasonCode: "observed-direction-not-executable" };
      }
      if (prior.binding.coinAbi === null || prior.binding.balanceAbi === null) {
        throw new Error("curve-plain missing proved getter ABI");
      }
      const facts = { pool: prior.pool, binding: { ...prior.binding,
        coinAbi: prior.binding.coinAbi, balanceAbi: prior.binding.balanceAbi }, directions: prior.directions };
      return { status: "verified", identity: { familyId: CURVE_PLAIN_FAMILY_ID,
        lineageId: CURVE_PLAIN_LINEAGE, subject: prior.pool, facts,
        provenance: [{ kind: "curve-direct-registry-and-execution-proof", subject: CURVE_METAREGISTRY,
          evidenceHash: hashCanonical({ pool: facts.pool, binding: { ...facts.binding },
            directions: facts.directions.map(direction => ({ ...direction })), source: { ...prior.source } }) }],
      } };
    },
  };
}
export const curvePlainIdentity: IdentitySemantics<CurvePlainCandidate, CurvePlainIdentity> = {
  variants: [identityVariant("int128"), identityVariant("uint256")],
  identityKey: identity => lower(identity.subject),
};
// Bind symbolic authority through a read-only observed call in the existing
// structure round. No candidate-supplied address or extra identity round.
function nativeExecutorRequest(): AdapterRequest {
  const balance = new ethers.Interface(["function balanceOf(address) view returns(uint256)"]);
  return { id: "native-executor", kind: "effect-delta-simulation",
    call: { caller, executionMode: "impersonated-call-frame", to: ADDR.WETH,
      data: balance.encodeFunctionData("balanceOf", [ethers.ZeroAddress]) },
    overrideIntent: { caller }, observeTokenBalances: [{ token: ADDR.WETH, account: caller }],
    observe: ["return-data", "revert-data", "token-delta", "native-delta"] };
}
function nativeExecutor(results: readonly AdapterRequestResult[], pool: string): string {
  const read = returned(results, "native-executor");
  uint(read.data);
  const rows = read.effects?.tokenDeltas, native = read.effects?.nativeDeltas;
  if (rows?.length !== 1 || !same(rows[0].token, ADDR.WETH) || rows[0].delta !== 0n ||
      native?.length !== 1 || !same(native[0].account, rows[0].account) || native[0].delta !== 0n ||
      same(rows[0].account, ethers.ZeroAddress) || same(rows[0].account, pool))
    throw new Error("curve-plain missing native executor authority");
  return ethers.getAddress(rows[0].account);
}
function provesNativeExecution(results: readonly AdapterRequestResult[], quote: QuoteDirection, mode: CurvePlainMode, actor: string, toleranceRawUnits: bigint): boolean {
  const read = result(results, `execution:${quote.i}:${quote.j}:${mode}`);
  if (read.completion !== "returned") return false;
  if (read.data !== "0x") throw new Error("curve-plain native executor return");
  const rows = read.effects?.tokenDeltas, native = read.effects?.nativeDeltas;
  if (rows?.length !== 2 || native?.length !== 1 || !same(native[0].account, actor) || native[0].delta !== 0n) return false;
  const input = rows.filter(row => same(row.token, quote.tokenIn) && same(row.account, actor));
  const output = rows.filter(row => same(row.token, quote.tokenOut) && same(row.account, actor));
  return input.length === 1 && output.length === 1 &&
    executionInputMatches(-input[0].delta, quote.amountIn, toleranceRawUnits) &&
    executionOutputMatches(output[0].delta, quote.amountOut, toleranceRawUnits);
}
function selectGetter<T extends string | bigint>(
  results: readonly AdapterRequestResult[], kind: "coin" | "balance", length: number, decode: (data: string) => T,
): { readonly abi: CurveIndexAbi; readonly values: readonly T[] } | null {
  const alternatives = GETTER_ABIS.map(abi => ({ abi, values: Array.from({ length }, (_, i) => {
    const read = result(results, getterReadId(kind, abi, i));
    // Revert/empty are selector absence. Malformed bytes or uncertain transport
    // cannot be hidden behind the other ABI and cannot prove terminal rejection.
    return read.completion === "returned" && read.data !== "0x" ? decode(read.data) : null;
  }) }));
  for (let i = 0; i < length; i++) {
    const [unsigned, signed] = alternatives.map(item => item.values[i]);
    if (unsigned !== null && signed !== null && unsigned !== signed) {
      throw new Error(`curve-plain ambiguous ${kind} getters at index ${i}`);
    }
  }
  for (const alternative of alternatives) {
    const { abi, values } = alternative;
    if (values.every((value): value is T => value !== null)) return { abi, values };
  }
  return null;
}
function pairs(length: number): readonly [number, number][] {
  return Array.from({ length }, (_, i) => Array.from({ length }, (_, j) => [i, j] as [number, number]))
    .flat().filter(([i, j]) => i !== j);
}
function executionProbe(pool: string, quote: QuoteDirection, mode: CurvePlainMode): AdapterRequest {
  return {
    id: `execution:${quote.i}:${quote.j}:${mode}`, kind: "effect-delta-simulation", required: false,
    preCalls: [{ caller, to: quote.tokenIn,
      data: ERC20.encodeFunctionData(pullsInput(mode) ? "approve" : "transfer", [pool, quote.amountIn]) }],
    call: { caller, executionMode: "impersonated-call-frame", to: pool,
      data: executionData(mode, quote.i, quote.j, quote.amountIn, quote.amountOut, PROBE_RECEIVER) },
    overrideIntent: { caller, tokenBalances: [{ token: quote.tokenIn, amount: quote.amountIn }] },
    observeTokenBalances: [
      { token: quote.tokenIn, account: caller }, { token: quote.tokenIn, account: pool },
      { token: quote.tokenOut, account: hasReceiver(mode) ? PROBE_RECEIVER : caller },
      { token: quote.tokenOut, account: pool },
    ],
    observe: ["return-data", "revert-data", "token-delta", "logs"],
  };
}
function provesExecution(results: readonly AdapterRequestResult[], pool: string, quote: QuoteDirection, mode: CurvePlainMode): boolean {
  const id = `execution:${quote.i}:${quote.j}:${mode}`;
  const matches = results.filter(read => read.id === id);
  if (matches.length !== 1) throw new Error(`curve-plain missing/duplicate result ${id}`);
  const read = matches[0];
  if (!read.ok || read.completion !== "returned") return false;
  // Older exchange implementations return no bytes. The exact observed effects
  // are still mandatory; empty return data alone is never a success witness.
  if (read.data !== "0x" && uint(read.data) !== quote.amountOut) return false;
  const deltas = read.effects?.tokenDeltas;
  if (!deltas || deltas.length !== 4) return false;
  const poolIn = deltas.filter(d => same(d.token, quote.tokenIn) && same(d.account, pool));
  const poolOut = deltas.filter(d => same(d.token, quote.tokenOut) && same(d.account, pool));
  const input = deltas.filter(d => same(d.token, quote.tokenIn) && !same(d.account, pool));
  const output = deltas.filter(d => same(d.token, quote.tokenOut) && !same(d.account, pool));
  return poolIn.length === 1 && poolEffect(poolIn[0], quote.amountIn, mode, pool, read) &&
    poolOut.length === 1 && poolEffect(poolOut[0], -quote.amountOut, mode, pool, read) &&
    input.length === 1 && input[0].delta === -quote.amountIn &&
    output.length === 1 && output[0].delta === quote.amountOut &&
    (hasReceiver(mode) ? same(output[0].account, PROBE_RECEIVER) : same(output[0].account, input[0].account));
}

// Tricrypto keeps native ETH internally even for its ERC20-only exchange ABI.
// A zero pool WETH delta is valid only with the independently observed wrapping
// effects from THIS simulation. Executor debits/receipts stay exact above.
function poolEffect(delta: { token: string; delta: bigint }, expected: bigint,
  mode: CurvePlainMode, pool: string, read: Extract<AdapterRequestResult, { ok: true }>): boolean {
  if (delta.delta === expected) return true;
  if (mode !== "exchange-uint" || !same(delta.token, ADDR.WETH) || delta.delta !== 0n) return false;
  const deposit = ethers.id("Deposit(address,uint256)"), withdrawal = ethers.id("Withdrawal(address,uint256)");
  let wrapped = 0n;
  for (const log of read.effects?.logs ?? []) {
    if (!same(log.address, ADDR.WETH) || log.topics.length !== 2 ||
      log.topics[1].toLowerCase() !== ethers.zeroPadValue(pool, 32).toLowerCase()) continue;
    if (log.topics[0] === deposit) wrapped += uint(log.data);
    if (log.topics[0] === withdrawal) wrapped -= uint(log.data);
  }
  return wrapped === -expected;
}
