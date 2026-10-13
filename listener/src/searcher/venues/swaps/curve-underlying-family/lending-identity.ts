import { ethers } from "ethers";
import type { IdentitySemantics } from "../../adapter-family-plugin.js";
import type { AdapterRequestResult, CanonicalSource } from "../../adapter-request-program.js";
import { hashCanonical } from "../../canonical-value.js";
import { assertSameSource, canonicalAddress, requireSuccessfulResult } from "./codec.js";
import { CURVE_UNDERLYING_FAMILY_ID, CURVE_UNDERLYING_LENDING_LINEAGE_ID } from "./manifest.js";
import { LENDING_LOOKUP, LENDING_LP_CODE_HASH, LENDING_POOL_CODE_HASHES, lendingAddress, lendingCall, lendingKind,
  lendingPoolRequests, lendingGuardRequests, assertLendingGuards, lendingSwapRequest,
  decodeLendingSwap, lendingSimulationRequirements, lendingProjection, assertLendingSource, lendingUint } from "./lending.js";
import type { CurveUnderlyingCandidate, CurveUnderlyingIdentity, CurveUnderlyingLendingBinding,
  CurveUnderlyingVerifiedDirection } from "./types.js";

interface Evidence {
  readonly phase: "code" | "pool" | "topology" | "execution";
  readonly source: CanonicalSource;
  readonly pool: string;
  readonly kind?: CurveUnderlyingLendingBinding["kind"];
  readonly coins?: readonly string[];
  readonly binding?: CurveUnderlyingLendingBinding;
  readonly decimals?: readonly number[];
  readonly directions?: readonly CurveUnderlyingVerifiedDirection[];
  readonly requestIds: readonly string[];
  readonly rejection?: string;
}
export const curveUnderlyingLendingIdentity: IdentitySemantics<CurveUnderlyingCandidate, CurveUnderlyingIdentity>["variants"][number] = {
  id: "legacy-lending-lp-reverse", kind: "standalone-contract", lineageId: CURVE_UNDERLYING_LENDING_LINEAGE_ID,
  applies: candidate => candidate.candidateKind === "curve-underlying-pool",
  requirements({ evidence }) {
    const prior = evidence as Evidence | undefined;
    return prior?.phase === "topology" ? lendingSimulationRequirements :
      { transports: prior ? ["eth-call", "get-code", "get-storage"] : ["get-code"] };
  },
  buildRequests({ candidate, evidence }) {
    const prior = evidence as Evidence | undefined;
    if (!prior) return [{ id: "lending-pool-code", kind: "get-code", address: candidate.pool }];
    if (prior.rejection) return [];
    if (prior.phase === "code") return lendingPoolRequests(prior.pool);
    if (prior.phase === "pool") return [
      ...lendingGuardRequests(prior.pool, prior.binding!),
      ...prior.coins!.map((coin, i) => lendingCall("lending-decimals:" + i, coin, "decimals")),
    ];
    if (prior.phase === "topology") return [0, 1, 2, 3].flatMap(i => [0, 1, 2, 3].filter(j => j !== i)
      .map(j => lendingSwapRequest({ id: "lending-behavior:" + i + ":" + j, pool: prior.pool,
        tokenIn: prior.coins![i], tokenOut: prior.coins![j], i, j, amountIn: 10n ** BigInt(prior.decimals![i]) })));
    return [];
  },
  decode({ step, results }) {
    const prior = step.evidence as Evidence | undefined;
    const successful = results.filter((r): r is Extract<AdapterRequestResult, { ok: true }> => r.ok);
    if (successful.length !== results.length || !successful.length) throw new Error("lending unresolved identity reads");
    assertSameSource(successful);
    const source = successful[0].source, requestIds = results.map(r => r.id);
    const data = (id: string) => requireSuccessfulResult(results, id).data;
    if (!prior) {
      const kind = lendingKind(data("lending-pool-code"));
      return { phase: "code", pool: canonicalAddress(step.candidate.pool), source, requestIds,
        ...(kind ? { kind } : { rejection: "unsupported-lending-pool-code" }) } satisfies Evidence;
    }
    assertLendingSource(source, prior.source);
    if (prior.phase === "code") {
      if (lendingKind(data("lending-pool-code")) !== prior.kind) throw new Error("lending pool code changed during identity");
      const coins = [0, 1, 2, 3].map(i => lendingAddress(data("lending-underlying:" + i)));
      const wrappedCoins = [0, 1, 2, 3].map(i => lendingAddress(data("lending-coin:" + i)));
      if (new Set([...coins, ...wrappedCoins].map(c => c.toLowerCase())).size !== 8)
        throw new Error("lending ambiguous underlying/wrapper topology");
      // Wrapper hashes are filled by the next source-bound round. Placeholder
      // values only declare addresses for reads; they never authorize admission.
      const binding: CurveUnderlyingLendingBinding = { kind: prior.kind!, poolCodeHash: LENDING_POOL_CODE_HASHES[prior.kind!],
        lpToken: lendingAddress(data("lending-lp")), lpCodeHash: LENDING_LP_CODE_HASH,
        wrappedCoins, wrapperCodeHashes: wrappedCoins.map(() => ethers.ZeroHash) };
      return { ...prior, phase: "pool", coins, binding, requestIds } satisfies Evidence;
    }
    if (prior.phase === "pool") {
      const wrapperCodeHashes = prior.binding!.wrappedCoins.map((_, i) => {
        const code = data("lending-wrapper-code:" + i);
        if (!ethers.isHexString(code) || code === "0x") throw new Error("lending wrapper has no code");
        return ethers.keccak256(code);
      });
      const binding = { ...prior.binding!, wrapperCodeHashes };
      assertLendingGuards(prior.pool, prior.coins!, binding, source, results);
      const decimals = prior.coins!.map((_, i) => {
        const value = lendingUint(data("lending-decimals:" + i));
        if (value > 36n) throw new Error("lending unsupported token decimals");
        return Number(value);
      });
      return { ...prior, phase: "topology", binding, decimals, requestIds } satisfies Evidence;
    }
    if (prior.phase !== "topology") throw new Error("lending identity already complete");
    const directions: CurveUnderlyingVerifiedDirection[] = [];
    for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) {
      if (i === j) continue;
      const amountIn = 10n ** BigInt(prior.decimals![i]);
      const result = results.find(r => r.id === "lending-behavior:" + i + ":" + j);
      if (!result) throw new Error("lending missing behavior direction");
      const amountOut = decodeLendingSwap({ pool: prior.pool, coins: prior.coins!, binding: prior.binding!,
        i, j, amountIn, source }, result);
      if (amountOut !== null) directions.push({ i, j, tokenIn: prior.coins![i], tokenOut: prior.coins![j],
        behaviorProbeAmountIn: amountIn, behaviorProbeAmountOut: amountOut });
    }
    return { ...prior, phase: "execution", directions, requestIds } satisfies Evidence;
  },
  decide({ candidate, evidence }) {
    const prior = evidence as Evidence | undefined;
    if (!prior) return { status: "continue" };
    if (prior.rejection) return { status: "chain-proven-rejected", reasonCode: prior.rejection, evidenceRequestIds: prior.requestIds };
    if (prior.phase !== "execution") return { status: "continue" };
    if (!prior.directions?.length || (candidate.hintedI !== null && candidate.hintedJ !== null &&
        !prior.directions.some(d => d.i === candidate.hintedI && d.j === candidate.hintedJ)))
      return { status: "retryable", reasonCode: "lending-observed-direction-not-execution-proven" };
    const lending = prior.binding!;
    const facts = { pool: prior.pool, coins: prior.coins!, lending, verifiedDirections: prior.directions,
      registryBinding: { registry: lending.lpToken, handlers: [], lookupSemantics: LENDING_LOOKUP } };
    return { status: "verified", identity: { familyId: CURVE_UNDERLYING_FAMILY_ID,
      lineageId: CURVE_UNDERLYING_LENDING_LINEAGE_ID, subject: prior.pool, facts,
      provenance: [{ kind: "curve-lending-pool-lp-wrapper-reverse-execution", subject: lending.lpToken,
        evidenceHash: hashCanonical({ pool: prior.pool, coins: [...prior.coins!], lending: lendingProjection(lending),
          directions: prior.directions.map(d => ({ ...d })), source: { ...prior.source } }) }] } };
  },
};
