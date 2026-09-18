import { ethers } from "ethers";
import type { IdentityDecision, IdentitySemantics } from "../../adapter-family-plugin.js";
import type { AdapterRequest, AdapterRequestResult, CanonicalSource } from "../../adapter-request-program.js";
import { hashCanonical } from "../../canonical-value.js";
import { CURVE_METAREGISTRY, META, POOL, ERC20, GETTER_ABIS, INT_MODES, address, addressArray, assertSource,
  call, executionData, getterPool, getterReadId, hasReceiver, lower, probeAmount, quotePool, result, resultSource, returned, same, uint } from "./codec.js";
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
}

function identityVariant(quoteAbi: CurveIndexAbi): IdentitySemantics<CurvePlainCandidate, CurvePlainIdentity>["variants"][number] {
  const modes: readonly CurvePlainMode[] = quoteAbi === "int128" ? INT_MODES : ["received-uint"];
  return {
    id: `registry-direct-coin-behavior-${quoteAbi}`, kind: "registry-member", lineageId: CURVE_PLAIN_LINEAGE,
    applies: candidate => candidate.candidateKind === "curve-plain-pool",
    requirements({ evidence }) {
      return (evidence as Evidence | undefined)?.phase === "quotes"
        ? { transports: ["effect-delta-simulation"], caller: "executor", effects: ["return-data", "revert-data", "token-delta"] }
        : { transports: evidence === undefined ? ["eth-call", "get-code"] : ["eth-call"] };
    },
    buildRequests({ candidate, evidence }) {
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
          call(`decimals:${i}`, coin, ERC20.encodeFunctionData("decimals")),
          ...GETTER_ABIS.flatMap(abi => [
            call(getterReadId("coin", abi, i), prior.pool, getterPool(abi).encodeFunctionData("coins", [i])),
            call(getterReadId("balance", abi, i), prior.pool, getterPool(abi).encodeFunctionData("balances", [i])),
          ]),
        ]),
      ];
      if (prior.phase === "structure") return pairs(prior.binding.coins.length).flatMap(([i, j]) => {
        const amount = probeAmount(prior.binding.decimals[i], prior.balances[i]);
        return [amount, amount * 10n].map((dx, probe) =>
          call(`quote:${i}:${j}:${probe}`, prior.pool, quotePool(quoteAbi).encodeFunctionData("get_dy", [i, j, dx])));
      });
      if (prior.phase === "quotes") return prior.quotes.flatMap(quote =>
        modes.map(mode => executionProbe(prior.pool, quote, mode)));
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
          coins.length < 2 ? "unsupported-direct-coin-domain" : undefined;
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
        for (const id of ["amplification", "fee", ...prior.binding.coins.map((_, i) => `decimals:${i}`)]) {
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
            const d = Number(uint(returned(results, `decimals:${i}`).data));
            const balance = balancesRead.values[i];
            if (!Number.isSafeInteger(d) || d < 0 || d > 36) rejection = "unsupported-token-scale";
            decimals.push(d); balances.push(balance);
          });
        }
        return { ...prior, phase: "structure", binding: { ...prior.binding, decimals,
          coinAbi: coinsRead?.abi ?? null, balanceAbi: balancesRead?.abi ?? null }, balances, requestIds,
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
          quotes.push({ i, j, tokenIn: prior.binding.coins[i], tokenOut: prior.binding.coins[j], amountIn, amountOut });
        }
        return { ...prior, phase: "quotes", quotes, requestIds } satisfies Evidence;
      }
      if (prior.phase !== "quotes") throw new Error("curve-plain identity already completed");
      const directions: CurvePlainDirection[] = [];
      for (const quote of prior.quotes) {
        // Stable preference is independent of the discovery call/log and its receiver.
        // Only proved modes are eligible. An unavailable alternative does not
        // invalidate another mode's complete proof or create a fallback edge.
        const supported = modes.filter(mode => provesExecution(results, prior.pool, quote, mode));
        if (supported.length) directions.push({ ...quote, executionMode: supported[0] });
      }
      if (directions.length === 0 && results.some(read => !read.ok)) {
        throw new Error("curve-plain unresolved execution proof");
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
      data: ERC20.encodeFunctionData(mode === "exchange" ? "approve" : "transfer", [pool, quote.amountIn]) }],
    call: { caller, executionMode: "impersonated-call-frame", to: pool,
      data: executionData(mode, quote.i, quote.j, quote.amountIn, quote.amountOut, PROBE_RECEIVER) },
    overrideIntent: { caller, tokenBalances: [{ token: quote.tokenIn, amount: quote.amountIn }] },
    observeTokenBalances: [
      { token: quote.tokenIn, account: caller }, { token: quote.tokenIn, account: pool },
      { token: quote.tokenOut, account: hasReceiver(mode) ? PROBE_RECEIVER : caller },
      { token: quote.tokenOut, account: pool },
    ],
    observe: ["return-data", "revert-data", "token-delta"],
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
  return poolIn.length === 1 && poolIn[0].delta === quote.amountIn &&
    poolOut.length === 1 && poolOut[0].delta === -quote.amountOut &&
    input.length === 1 && input[0].delta === -quote.amountIn &&
    output.length === 1 && output[0].delta === quote.amountOut &&
    (hasReceiver(mode) ? same(output[0].account, PROBE_RECEIVER) : same(output[0].account, input[0].account));
}
