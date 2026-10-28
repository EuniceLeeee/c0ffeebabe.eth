import { ethers } from "ethers";
import type { IdentityVariant } from "../../adapter-family-plugin.js";
import type { AdapterRequestResult, CanonicalSource } from "../../adapter-request-program.js";
import { RequiredAdapterRequestError } from "../../adapter-request-failure.js";
import { hashCanonical } from "../../canonical-value.js";
import { assertSameSource, assertSource, callRequest, codeRequest, effectsProjection, requireRuntimeCode, returnedResult, sameAddress, successfulResult } from "../standard-family/common.js";
import { ERC4626_INTERFACE, ERC4626_PROBE_ACTOR } from "./abi.js";
import { ERC4626_FAMILY_ID, INFINIFI_LINEAGE_ID } from "./manifest.js";
import { INFINIFI_ABI as ABI, INFINIFI_GATEWAY, INFINIFI_VARIANT, infinifiProjection,
  infinifiSurfaceRequests, decodeInfiniFiSurface, infinifiDependencyRequests, decodeInfiniFiDependencies,
  infinifiPermissionReason, infinifiQuoteRequest, decodeInfiniFiQuote, type InfiniFiSurface, type InfiniFiBinding } from "./infinifi.js";
import type { Erc4626Candidate, Erc4626Identity } from "./types.js";

type Direction = "deposit" | "redeem";
type Sample = { direction: Direction; amount: bigint; expected: bigint };
type PartialBinding = ReturnType<typeof decodeInfiniFiDependencies>;
type Proof = { phase: "registry"; source: CanonicalSource } | { phase: "surface"; surface: InfiniFiSurface } |
  { phase: "probe"; partial: PartialBinding; samples: Sample[] } |
  { phase: "verified"; binding: InfiniFiBinding; directions: { deposit: boolean; redeem: boolean }; proofHash: string } |
  { phase: "retry"; reason: string } | { phase: "other"; evidenceRequestIds: string[]; reason: string };
const actor = ERC4626_PROBE_ACTOR, caller = { kind: "verified-actor" as const, evidenceId: "erc4626-probe-actor" };
const effects = ["return-data", "revert-data", "token-delta", "logs"] as const;
const prefix = "infinifi";

export const infinifiIdentity: IdentityVariant<Erc4626Candidate, Erc4626Identity, unknown> = {
  id: INFINIFI_VARIANT, kind: "standalone-contract", lineageId: INFINIFI_LINEAGE_ID, applies: () => true,
  requirements({ evidence }) {
    const p = evidence as Proof | undefined;
    return { transports: p === undefined ? ["get-code", "eth-call"] : p.phase === "probe" ? ["get-code", "effect-delta-simulation"] :
      ["get-code", "get-storage", "eth-call"], ...(p?.phase === "probe" ? { caller: "verified-actor", effects } : {}) };
  },
  buildRequests({ candidate, evidence }) {
    const p = evidence as Proof | undefined;
    if (p === undefined) return [codeRequest("infinifi-registry-code", INFINIFI_GATEWAY),
      { ...callRequest("infinifi-registry", INFINIFI_GATEWAY, ABI.encodeFunctionData("getAddress", ["stakedToken"])),
        required: false, completion: "return-or-revert-data" },
    ];
    if (p.phase === "registry") return infinifiSurfaceRequests(prefix, candidate.vault);
    if (p.phase === "surface") return [
      ...infinifiDependencyRequests(prefix, p.surface),
      ...(["deposit", "redeem"] as const).map(d => infinifiQuoteRequest("infinifi-preview-" + d, p.surface, d, 10n ** 18n)),
    ];
    if (p.phase !== "probe") return [];
    const b = p.partial;
    return [codeRequest("infinifi-code-yieldSharingImplementation", b.yieldSharingImplementation),
      ...p.samples.map(s => {
        const deposit = s.direction === "deposit", input = deposit ? b.asset : b.vault, output = deposit ? b.vault : b.asset;
        return { id: "infinifi-active-" + s.direction, required: false, kind: "effect-delta-simulation" as const,
          preCalls: [0n, s.amount].map(amount => ({ caller, to: input, data: ABI.encodeFunctionData("approve", [b.gateway, amount]) })),
          call: { caller, to: b.gateway, data: ABI.encodeFunctionData(deposit ? "stake" : "unstake", [actor, s.amount]) },
          overrideIntent: { caller, tokenBalances: [{ token: input, amount: s.amount }, { token: output, amount: 0n }] },
          observeTokenBalances: [b.vault, b.asset].flatMap(token => [{ token, account: caller }, { token, account: b.gateway }]),
          observe: effects };
      })];
  },
  decode({ step, results }): Proof {
    for (const r of results) if (!r.ok) throw new RequiredAdapterRequestError(r);
    const source = assertSameSource(results.map(r => successfulResult(results, r.id)));
    const p = step.evidence as Proof | undefined;
    try {
      if (p === undefined) {
        // Absence before deployment is a source-bound variant nonmatch. An
        // existing but unreadable registry remains retryable, never a rejection.
        if (returnedResult(results, "infinifi-registry-code").data === "0x")
          return { phase: "other", reason: "infinifi_registry_not_deployed", evidenceRequestIds: ["infinifi-registry-code"] };
        const data = returnedResult(results, "infinifi-registry").data;
        if (!/^0x[0-9a-fA-F]{64}$/.test(data)) throw new Error("InfiniFi malformed registry response");
        const value = String(ABI.decodeFunctionResult("getAddress", data)[0]);
        return sameAddress(value, step.candidate.vault) ? { phase: "registry", source } :
          { phase: "other", reason: "infinifi_registry_not_matched", evidenceRequestIds: ["infinifi-registry"] };
      }
      if (p.phase === "registry") {
        assertSource(source, p.source); return { phase: "surface", surface: decodeInfiniFiSurface(results, prefix, step.candidate.vault) };
      }
      if (p.phase === "surface") {
        const partial = decodeInfiniFiDependencies(results, prefix, p.surface);
        // Do not freeze a temporary loss state into permanent deposit-only
        // directions. Retry the variant after the state recovers.
        const reason = infinifiPermissionReason(results, prefix, true);
        if (reason) return { phase: "retry", reason };
        const samples = (["deposit", "redeem"] as const).map(direction => ({
          direction, amount: 10n ** 18n, expected: decodeInfiniFiQuote(returnedResult(results, "infinifi-preview-" + direction).data),
        }));
        return { phase: "probe", partial, samples };
      }
      if (p.phase !== "probe") throw new Error("InfiniFi unexpected identity phase");
      assertSource(source, p.partial.proofSource);
      const binding: InfiniFiBinding = { ...p.partial, codeHashes: { ...p.partial.codeHashes,
        yieldSharingImplementation: ethers.keccak256(requireRuntimeCode(results, "infinifi-code-yieldSharingImplementation")) } };
      const directions = { deposit: false, redeem: false };
      for (const s of p.samples) {
        const result = successfulResult(results, "infinifi-active-" + s.direction);
        if (result.completion !== "returned") continue;
        verifyEffects(result, binding, s); directions[s.direction] = true;
      }
      if (!directions.deposit && !directions.redeem) return { phase: "retry", reason: "infinifi_gateway_execution_unavailable" };
      return { phase: "verified", binding, directions,
        proofHash: hashCanonical({ binding: infinifiProjection(binding), samples: p.samples.map(s => ({ ...s })), directions,
          results: results.filter(r => r.ok).map(r => ({ id: r.id, completion: r.completion, effects: effectsProjection(r.effects) })) }) };
    } catch (e) { if (e instanceof RequiredAdapterRequestError) throw e;
      return { phase: "retry", reason: "infinifi_unavailable:" + (e instanceof Error ? e.message : String(e)) }; }
  },
  decide({ candidate, evidence }) {
    const p = evidence as Proof | undefined;
    if (p?.phase === "other") return { status: "chain-proven-rejected", reasonCode: p.reason, evidenceRequestIds: p.evidenceRequestIds };
    if (p?.phase === "retry") return { status: "retryable", reasonCode: p.reason };
    if (p?.phase !== "verified") return { status: "continue" };
    return { status: "verified", identity: { familyId: ERC4626_FAMILY_ID, lineageId: INFINIFI_LINEAGE_ID, subject: candidate.vault,
      asset: p.binding.asset, infinifi: p.binding, verifiedDirections: p.directions,
      provenance: [{ kind: "infinifi-registry-and-gateway-active-proof", subject: candidate.vault, evidenceHash: p.proofHash }] } };
  },
};
function verifyEffects(result: Extract<AdapterRequestResult, { ok: true }>, b: InfiniFiBinding, s: Sample): void {
  const deposit = s.direction === "deposit";
  if (BigInt(result.data) !== s.expected) throw new Error("InfiniFi Gateway return/quote mismatch");
  for (const [token, account, expected] of [
    [b.vault, actor, deposit ? s.expected : -s.amount], [b.asset, actor, deposit ? -s.amount : s.expected],
    [b.vault, b.gateway, 0n], [b.asset, b.gateway, 0n],
  ] as const) {
    const rows = result.effects?.tokenDeltas?.filter(r => sameAddress(r.token, token) && sameAddress(r.account, account)) ?? [];
    if (rows.length !== 1 || rows[0]!.delta !== expected) throw new Error("InfiniFi independent balance mismatch");
  }
  const logs = result.effects?.logs ?? [];
  if (!logs.some(log => {
    if (!sameAddress(log.address, b.vault)) return false;
    try {
      const e = ERC4626_INTERFACE.parseLog({ topics: [...log.topics], data: log.data });
      return e?.name === (deposit ? "Deposit" : "Withdraw") && sameAddress(String(e.args.sender), b.gateway) &&
        sameAddress(String(deposit ? e.args.owner : e.args.receiver), actor) &&
        (deposit || sameAddress(String(e.args.owner), b.gateway)) &&
        BigInt(e.args.assets) === (deposit ? s.amount : s.expected) && BigInt(e.args.shares) === (deposit ? s.expected : s.amount);
    } catch { return false; }
  })) throw new Error("InfiniFi synchronous vault event missing");
  if (!logs.some(log => {
    if (!sameAddress(log.address, b.vault)) return false;
    try { const e = ABI.parseLog({ topics: [...log.topics], data: log.data });
      return e?.name === "Transfer" && sameAddress(String(e.args.from), deposit ? ethers.ZeroAddress : b.gateway) &&
        sameAddress(String(e.args.to), deposit ? actor : ethers.ZeroAddress) && BigInt(e.args.value) === (deposit ? s.expected : s.amount);
    } catch { return false; }
  })) throw new Error("InfiniFi mint/burn event missing");
}
