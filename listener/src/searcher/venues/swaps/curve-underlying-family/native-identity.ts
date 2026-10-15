import { ethers } from "ethers";
import { underlyingRecipientProbe, provesUnderlyingRecipient } from "./recipient-proof.js";
import { ADDR } from "../../../../shared/constants/addresses.js";
import { executionInputMatches, executionOutputMatches } from "../../../../shared/executor/amount-rounding.js";
import type { IdentitySemantics } from "../../adapter-family-plugin.js";
import type { AdapterRequest, AdapterRequestResult, CanonicalSource } from "../../adapter-request-program.js";
import { hashCanonical } from "../../canonical-value.js";
import { POOL, ERC20, address, addressArray, assertSource, call, probeAmount, result, resultSource, returned, uint } from "../curve-plain-family/codec.js";
import { CURVE_METAREGISTRY, CURVE_UNDERLYING_META_INTERFACE, sameAddress } from "./codec.js";
import { CURVE_UNDERLYING_FAMILY_ID, CURVE_UNDERLYING_REGISTRY_LINEAGE_ID } from "./manifest.js";
import { CURVE_UNDERLYING_NATIVE_QUOTE, underlyingNativeAliasProbe } from "./native.js";
import type { CurveUnderlyingCandidate, CurveUnderlyingIdentity, CurveUnderlyingNativeAlias, CurveUnderlyingVerifiedDirection } from "./types.js";

const DIRECT = new ethers.Interface(["function get_coins(address) view returns(address[8])"]);
const BALANCE = new ethers.Interface(["function balanceOf(address) view returns(uint256)"]);
const caller = { kind: "executor" as const };
type Quote = CurveUnderlyingVerifiedDirection;
interface Evidence {
  readonly phase: "registry" | "structure" | "quotes" | "execution";
  readonly source: CanonicalSource;
  readonly pool: string;
  readonly coins: readonly string[];
  readonly handlers: readonly string[];
  readonly alias: CurveUnderlyingNativeAlias;
  readonly decimals: readonly number[];
  readonly balances: readonly bigint[];
  readonly quotes: readonly Quote[];
  readonly directions: readonly Quote[];
  readonly requestIds: readonly string[];
  readonly executor?: string;
  readonly rejection?: string;
}
const pairs = (n: number) => Array.from({ length: n }, (_, i) =>
  Array.from({ length: n }, (_, j) => [i, j] as const).filter(([, j]) => i !== j)).flat();

/** Some registry members expose underlying through their direct uint256
 * exchange, optionally aliasing WETH to native ETH. Topology alone does not
 * prove either interpretation: every published direction must execute with
 * its declared raw assets at the source. Keep the existing variant ID. */
export const curveUnderlyingNativeIdentity: IdentitySemantics<CurveUnderlyingCandidate, CurveUnderlyingIdentity>["variants"][number] = {
  id: "metaregistry-uint-native-alias", kind: "registry-member", lineageId: CURVE_UNDERLYING_REGISTRY_LINEAGE_ID,
  applies: candidate => candidate.candidateKind === "curve-underlying-pool",
  requirements({ evidence }) {
    const prior = evidence as Evidence | undefined;
    if (prior?.phase === "registry") return { transports: ["eth-call", "effect-delta-simulation"], caller: "executor",
      effects: ["return-data", "revert-data", "token-delta", "native-delta"] };
    if (prior?.phase === "quotes") return { transports: ["effect-delta-simulation"], caller: "executor",
      effects: ["return-data", "revert-data", "token-delta", "native-delta", "logs"] };
    return { transports: prior ? ["eth-call"] : ["eth-call", "get-code"] };
  },
  buildRequests({ candidate, evidence, executionRoundingRawUnits = 0n }) {
    const prior = evidence as Evidence | undefined;
    if (!prior) return [
      { id: "pool-code", kind: "get-code", address: candidate.pool },
      call("registry-handlers", CURVE_METAREGISTRY, CURVE_UNDERLYING_META_INTERFACE.encodeFunctionData("get_registry_handlers_from_pool", [candidate.pool])),
      call("registry-underlying", CURVE_METAREGISTRY, CURVE_UNDERLYING_META_INTERFACE.encodeFunctionData("get_underlying_coins", [candidate.pool])),
      call("registry-direct", CURVE_METAREGISTRY, DIRECT.encodeFunctionData("get_coins", [candidate.pool])),
    ];
    if (prior.rejection) return [];
    if (prior.phase === "registry") return [
      ...prior.coins.flatMap((coin, i) => [
        call(`coin:${i}`, prior.pool, POOL.encodeFunctionData("coins", [i])),
        call(`balance:${i}`, prior.pool, POOL.encodeFunctionData("balances", [i])),
        call(`decimals:${i}`, coin, ERC20.encodeFunctionData("decimals")),
      ]), executorRequest(),
    ];
    if (prior.phase === "structure") return pairs(prior.coins.length).filter(([i, j]) => prior.balances[i] > 0n && prior.balances[j] > 0n)
      .flatMap(([i, j]) => {
        const amount = probeAmount(prior.decimals[i], prior.balances[i]);
        return [amount, amount * 10n].map((dx, probe) => call(`quote:${i}:${j}:${probe}`, prior.pool,
          CURVE_UNDERLYING_NATIVE_QUOTE.encodeFunctionData("get_dy", [i, j, dx])));
      });
    if (prior.phase === "quotes") return prior.quotes.flatMap(quote => [
      underlyingNativeAliasProbe(prior.pool, prior.coins, prior.alias, quote, prior.executor!, executionRoundingRawUnits),
      ...(quote.j === prior.alias.nativeIndex ? [] : [underlyingRecipientProbe(prior.pool, prior.coins,
        prior.alias, quote, prior.executor!, executionRoundingRawUnits)]),
    ]);
    return [];
  },
  decode({ step, results }) {
    const prior = step.evidence as Evidence | undefined, source = resultSource(results), requestIds = results.map(r => r.id);
    if (!prior) {
      const code = returned(results, "pool-code").data;
      const handlersRead = result(results, "registry-handlers"), underlying = result(results, "registry-underlying"), direct = result(results, "registry-direct");
      const handlers = handlersRead.completion === "returned" ? addressArray(handlersRead.data, 10) : [];
      const coins = underlying.completion === "returned" ? addressArray(underlying.data, 8) : [];
      const directCoins = direct.completion === "returned" ? addressArray(direct.data, 8) : [];
      const nativePosition = coins.findIndex(c => sameAddress(c, ADDR.WETH));
      const nativeIndex = nativePosition < 0 ? null : nativePosition;
      const rejection = code === "0x" ? "no-pool-code" : handlers.length === 0 ? "no-registry-membership" :
        coins.length < 2 || coins.length > 8 || new Set(coins.map(c => c.toLowerCase())).size !== coins.length ||
        directCoins.length !== coins.length || coins.some((coin, i) => !sameAddress(coin, directCoins[i]))
          ? "not-a-registry-uint-alias-topology" : undefined;
      return { phase: "registry", source, pool: ethers.getAddress(step.candidate.pool), coins, handlers,
        alias: { nativeIndex, poolCodeHash: ethers.keccak256(code) }, decimals: [], balances: [], quotes: [], directions: [], requestIds,
        ...(rejection ? { rejection } : {}) } satisfies Evidence;
    }
    assertSource(source, prior.source);
    if (prior.phase === "registry") {
      const decimals: number[] = [], balances: bigint[] = [];
      let rejection: string | undefined;
      prior.coins.forEach((coin, i) => {
        const c = returned(results, `coin:${i}`), b = returned(results, `balance:${i}`), d = returned(results, `decimals:${i}`);
        const scale = Number(uint(d.data));
        if (!sameAddress(address(c.data), coin)) rejection = "registry-direct-coin-mismatch";
        if (!Number.isInteger(scale) || scale < 0 || scale > 36) rejection = "unsupported-token-scale";
        decimals.push(scale); balances.push(uint(b.data));
      });
      return { ...prior, phase: "structure", decimals, balances, executor: probeExecutor(results, prior.pool), requestIds,
        ...(rejection ? { rejection } : {}) } satisfies Evidence;
    }
    if (prior.phase === "structure") {
      const quotes: Quote[] = [];
      for (const [i, j] of pairs(prior.coins.length)) {
        if (prior.balances[i] <= 0n || prior.balances[j] <= 0n) continue;
        const small = result(results, `quote:${i}:${j}:0`), large = result(results, `quote:${i}:${j}:1`);
        if (small.completion !== "returned" || large.completion !== "returned" ||
            !ethers.isHexString(small.data, 32) || !ethers.isHexString(large.data, 32)) continue;
        const amountOut = uint(small.data), larger = uint(large.data);
        if (amountOut <= 0n || larger <= amountOut || larger >= prior.balances[j]) continue;
        quotes.push({ i, j, tokenIn: prior.coins[i], tokenOut: prior.coins[j],
          behaviorProbeAmountIn: probeAmount(prior.decimals[i], prior.balances[i]), behaviorProbeAmountOut: amountOut });
      }
      return { ...prior, phase: "quotes", quotes, requestIds } satisfies Evidence;
    }
    if (prior.phase !== "quotes") throw new Error("curve-underlying native identity already completed");
    const directions: Quote[] = [];
    for (const quote of prior.quotes) {
      const read = result(results, `native-execution:${quote.i}:${quote.j}`);
      if (read.completion !== "returned") continue;
      if (read.data !== "0x") throw new Error("curve-underlying native executor return");
      const rows = read.effects?.tokenDeltas, native = read.effects?.nativeDeltas;
      if (rows?.length !== 2 || native?.length !== 1 || !sameAddress(native[0].account, prior.executor!) || native[0].delta !== 0n) continue;
      const input = rows.filter(r => sameAddress(r.token, quote.tokenIn) && sameAddress(r.account, prior.executor!));
      const output = rows.filter(r => sameAddress(r.token, quote.tokenOut) && sameAddress(r.account, prior.executor!));
      if (input.length === 1 && output.length === 1 &&
          executionInputMatches(-input[0].delta, quote.behaviorProbeAmountIn, step.executionRoundingRawUnits ?? 0n) &&
          executionOutputMatches(output[0].delta, quote.behaviorProbeAmountOut, step.executionRoundingRawUnits ?? 0n)) {
        const recipient = quote.j !== prior.alias.nativeIndex && provesUnderlyingRecipient(results, quote,
          prior.alias, prior.executor!, step.executionRoundingRawUnits ?? 0n);
        directions.push({ ...quote, ...(recipient ? { recipient: true as const } : {}) });
      }
    }
    return { ...prior, phase: "execution", directions, requestIds } satisfies Evidence;
  },
  decide({ candidate, evidence }) {
    const prior = evidence as Evidence | undefined;
    if (!prior) return { status: "continue" };
    if (prior.rejection) return { status: "chain-proven-rejected", reasonCode: prior.rejection, evidenceRequestIds: prior.requestIds };
    if (prior.phase === "quotes" && prior.quotes.length === 0) return { status: "retryable", reasonCode: "no-positive-native-alias-quote" };
    if (prior.phase !== "execution") return { status: "continue" };
    if (!prior.directions.length || (candidate.hintedI !== null && candidate.hintedJ !== null &&
        !prior.directions.some(d => d.i === candidate.hintedI && d.j === candidate.hintedJ)))
      return { status: "retryable", reasonCode: "native-alias-direction-not-execution-proven" };
    const facts = { pool: prior.pool, coins: prior.coins, nativeAlias: prior.alias,
      registryBinding: { registry: CURVE_METAREGISTRY, handlers: prior.handlers,
        lookupSemantics: "get_registry_handlers_from_pool+get_underlying_coins" as const }, verifiedDirections: prior.directions };
    return { status: "verified", identity: { familyId: CURVE_UNDERLYING_FAMILY_ID, lineageId: CURVE_UNDERLYING_REGISTRY_LINEAGE_ID,
      subject: prior.pool, facts, provenance: [{ kind: "curve-underlying-native-alias-registry-execution", subject: CURVE_METAREGISTRY,
        evidenceHash: hashCanonical({ pool: prior.pool, coins: [...prior.coins], nativeAlias: { ...prior.alias },
          handlers: [...prior.handlers], directions: prior.directions.map(q => ({ ...q })), source: { ...prior.source } }) }] } };
  },
};

function executorRequest(): AdapterRequest {
  return { id: "probe-executor", kind: "effect-delta-simulation",
    call: { caller, executionMode: "impersonated-call-frame", to: ADDR.WETH, data: BALANCE.encodeFunctionData("balanceOf", [ethers.ZeroAddress]) },
    overrideIntent: { caller }, observeTokenBalances: [{ token: ADDR.WETH, account: caller }],
    observe: ["return-data", "revert-data", "token-delta", "native-delta"] };
}
function probeExecutor(results: readonly AdapterRequestResult[], pool: string): string {
  const read = returned(results, "probe-executor"); uint(read.data);
  const rows = read.effects?.tokenDeltas, native = read.effects?.nativeDeltas;
  if (rows?.length !== 1 || !sameAddress(rows[0].token, ADDR.WETH) || rows[0].delta !== 0n || native?.length !== 1 ||
      !sameAddress(native[0].account, rows[0].account) || native[0].delta !== 0n ||
      sameAddress(rows[0].account, ethers.ZeroAddress) || sameAddress(rows[0].account, pool)) throw new Error("curve-underlying missing executor authority");
  return ethers.getAddress(rows[0].account);
}
