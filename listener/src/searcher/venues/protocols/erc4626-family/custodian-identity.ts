import { ethers } from "ethers";
import type { IdentityVariant } from "../../adapter-family-plugin.js";
import type { AdapterRequestResult, CanonicalSource } from "../../adapter-request-program.js";
import { RequiredAdapterRequestError } from "../../adapter-request-failure.js";
import { hashCanonical } from "../../canonical-value.js";
import { assertSameSource, assertSource, callRequest, codeRequest, effectsProjection, requireRuntimeCode, returnedResult, sameAddress, successfulResult } from "../standard-family/common.js";
import { ERC4626_INTERFACE, ERC4626_PROBE_ACTOR } from "./abi.js";
import { CUSTODIAN_LINEAGE_ID, ERC4626_FAMILY_ID } from "./manifest.js";
import { CUSTODIAN_ABI, CUSTODIAN_TOKEN, CUSTODIAN_VARIANT, proveCustodianProxy,
  custodianDependencyRequests, custodianPermissionReason, custodianSurfaceRequests, custodianWord,
  decodeCustodianDependencies, decodeCustodianSurface, type CustodianBinding, type CustodianSurface } from "./custodian.js";
import type { Erc4626Candidate, Erc4626Identity } from "./types.js";

type Direction = "deposit" | "redeem";
type Sample = { direction: Direction; amount: bigint; expected?: bigint };
type Proof = { phase: "proxy"; source: CanonicalSource } |
  { phase: "surface"; surface: CustodianSurface; samples: Sample[] } |
  { phase: "probe"; surface: CustodianSurface; binding: CustodianBinding; samples: Sample[] } |
  { phase: "verified"; binding: CustodianBinding; directions: { deposit: boolean; redeem: boolean }; proofHash: string } |
  { phase: "retry"; reason: string } | { phase: "other" };
const actor = ERC4626_PROBE_ACTOR;
const caller = { kind: "verified-actor" as const, evidenceId: "erc4626-probe-actor" };
const effects = ["return-data", "revert-data", "token-delta", "total-supply-delta", "logs"] as const;

export const custodianIdentity: IdentityVariant<Erc4626Candidate, Erc4626Identity, unknown> = {
  id: CUSTODIAN_VARIANT, kind: "standalone-contract", lineageId: CUSTODIAN_LINEAGE_ID,
  applies: () => true,
  requirements({ evidence }) {
    const proof = evidence as Proof | undefined;
    if (proof === undefined) return { transports: ["get-code"] };
    if (proof.phase === "probe") return { transports: ["effect-delta-simulation"], caller: "verified-actor", effects };
    return { transports: proof.phase === "proxy" ? ["get-code", "get-storage", "eth-call"] : ["get-code", "eth-call"], caller: "verified-actor" };
  },
  buildRequests({ candidate, evidence }) {
    const proof = evidence as Proof | undefined;
    if (proof === undefined) return [codeRequest("custodian-proxy", candidate.vault)];
    if (proof.phase === "proxy") return custodianSurfaceRequests("custodian", candidate.vault, caller);
    if (proof.phase === "surface") return [
      ...custodianDependencyRequests("custodian", proof.surface, candidate.vault, actor),
      ...proof.samples.map(sample => callRequest(`custodian-preview-${sample.direction}`, candidate.vault,
        CUSTODIAN_ABI.encodeFunctionData(sample.direction === "deposit" ? "previewDeposit" : "previewRedeem", [sample.amount]), caller)),
    ];
    if (proof.phase !== "probe") return [];
    const s = proof.surface;
    return proof.samples.map(sample => {
      const deposit = sample.direction === "deposit", tokenIn = deposit ? s.asset : s.share, tokenOut = deposit ? s.share : s.asset;
      return { id: `custodian-active-${sample.direction}`, required: false, kind: "effect-delta-simulation" as const,
        preCalls: [0n, sample.amount].map(amount => ({ caller, to: tokenIn,
          data: CUSTODIAN_TOKEN.encodeFunctionData("approve", [s.vault, amount]) })),
        call: { caller, executionMode: "impersonated-call-frame" as const, to: s.vault,
          data: CUSTODIAN_ABI.encodeFunctionData(sample.direction, deposit ? [sample.amount, actor] : [sample.amount, actor, actor]) },
        overrideIntent: { caller, tokenBalances: [{ token: tokenIn, amount: sample.amount }, { token: tokenOut, amount: 0n }] },
        observeTokenBalances: [{ token: s.share, account: caller }, { token: s.asset, account: caller }, { token: s.asset, account: s.vault }],
        observe: effects };
    });
  },
  decode({ step, results }): Proof {
    // Required transport failures keep their original class, not a permanent
    // protocol rejection. A completed redeem failure is stateful too.
    for (const r of results) if (!r.ok) throw new RequiredAdapterRequestError(r);
    try {
      const source = assertSameSource(results.map(r => successfulResult(results, r.id)));
      const proof = step.evidence as Proof | undefined;
      if (proof === undefined) {
        try { proveCustodianProxy(requireRuntimeCode(results, "custodian-proxy")); return { phase: "proxy", source }; }
        catch { return { phase: "other" }; }
      }
      if (proof.phase === "proxy") {
        assertSource(source, proof.source);
        const surface = decodeCustodianSurface(results, "custodian", step.candidate.vault);
        if (sameAddress(surface.proxyAdmin, actor)) throw new Error("Custodian probe actor is proxy admin");
        const samples: Sample[] = [];
        for (const direction of ["deposit", "redeem"] as const) {
          const unit = 10n ** BigInt(direction === "deposit" ? surface.assetDecimals : surface.shareDecimals);
          const capacity = direction === "deposit" ? surface.depositCapacity : surface.capacity;
          const available = direction === "deposit" ? surface.mintCapacity : surface.inventory;
          const amount = capacity < unit ? capacity : unit;
          if (amount > 0n && available > 0n) samples.push({ direction, amount });
        }
        return samples.length ? { phase: "surface", surface, samples } :
          { phase: "retry", reason: "custodian_capacity_unavailable" };
      }
      if (proof.phase === "surface") {
        const binding = decodeCustodianDependencies(results, "custodian", proof.surface);
        const reason = custodianPermissionReason(results, "custodian", true);
        if (reason !== null) return { phase: "retry", reason };
        const samples = proof.samples.map(sample => ({ ...sample, expected: custodianWord(results, `custodian-preview-${sample.direction}`) }))
          .filter(sample => sample.expected > 0n && sample.expected <= (sample.direction === "deposit" ? proof.surface.mintCapacity : proof.surface.inventory));
        if (!samples.length) return { phase: "retry", reason: "custodian_sample_unavailable" };
        return { ...proof, phase: "probe", binding, samples };
      }
      if (proof.phase !== "probe") throw new Error("Custodian unexpected identity phase");
      assertSource(source, proof.surface.source);
      const directions = { deposit: false, redeem: false };
      for (const sample of proof.samples) {
        const result = successfulResult(results, `custodian-active-${sample.direction}`);
        if (result.completion !== "returned") continue;
        verifyEffects(result, proof.surface, sample);
        directions[sample.direction] = true;
      }
      if (!directions.deposit && !directions.redeem) return { phase: "retry", reason: "custodian_execution_unavailable" };
      return { phase: "verified", binding: proof.binding, directions,
        proofHash: hashCanonical({ source: { ...source }, binding: { ...proof.binding, proofSource: { ...proof.binding.proofSource } },
          samples: proof.samples.map(sample => ({ ...sample })), directions,
          results: results.filter(r => r.ok).map(r => ({ id: r.id, completion: r.completion, effects: effectsProjection(r.effects) })) }) };
    } catch (error) {
      if (error instanceof RequiredAdapterRequestError) throw error;
      return { phase: "retry", reason: `custodian_unavailable:${error instanceof Error ? error.message : String(error)}` };
    }
  },
  decide({ candidate, evidence }) {
    const proof = evidence as Proof | undefined;
    if (proof?.phase === "other") return { status: "chain-proven-rejected", reasonCode: "custodian_proxy_not_matched", evidenceRequestIds: ["custodian-proxy"] };
    if (proof?.phase === "retry") return { status: "retryable", reasonCode: proof.reason };
    if (proof?.phase !== "verified") return { status: "continue" };
    return { status: "verified", identity: {
      familyId: ERC4626_FAMILY_ID, lineageId: CUSTODIAN_LINEAGE_ID, subject: ethers.getAddress(candidate.vault),
      provenance: [{ kind: "frax-custodian-source-and-conversion-proof", subject: ethers.getAddress(candidate.vault), evidenceHash: proof.proofHash }],
      asset: proof.binding.asset, custodian: proof.binding, verifiedDirections: proof.directions,
    } };
  },
};

function verifyEffects(result: Extract<AdapterRequestResult, { ok: true }>, surface: CustodianSurface, sample: Sample): void {
      const expected = sample.expected!, deposit = sample.direction === "deposit";
      if (custodianWord([result], result.id) !== expected) throw new Error("Custodian return amount mismatch");
      const deltas = result.effects?.tokenDeltas ?? [];
      for (const [token, account, delta] of [[surface.share, actor, deposit ? expected : -sample.amount],
        [surface.asset, actor, deposit ? -sample.amount : expected], [surface.asset, surface.vault, deposit ? sample.amount : -expected]] as const) {
        const rows = deltas.filter(row => sameAddress(row.token, token) && sameAddress(row.account, account));
        if (rows.length !== 1 || rows[0]!.delta !== delta) throw new Error("Custodian independent token effect mismatch");
      }
      // The shared strict transport observes totalSupply on the call target.
      // This source-bound implementation forwards vault.totalSupply() directly
      // to its immutable frxUSD token. Keep the observed address truthful; do not
      // relabel it as a direct token read or infer supply from the actor balance.
      const supplies = result.effects?.totalSupplyDeltas?.filter(row => sameAddress(row.token, surface.vault)) ?? [];
      if (supplies.length !== 1 || supplies[0]!.delta !== (deposit ? expected : -sample.amount)) throw new Error("Custodian external share supply mismatch");
      const logs = result.effects?.logs ?? [];
      if (!logs.some(log => {
        if (!sameAddress(log.address, surface.vault)) return false;
        try {
          const event = ERC4626_INTERFACE.parseLog({ topics: [...log.topics], data: log.data });
          return event?.name === (deposit ? "Deposit" : "Withdraw") &&
            (deposit ? [event.args.sender, event.args.owner] : [event.args.sender, event.args.receiver, event.args.owner]).every(x => sameAddress(String(x), actor)) &&
            BigInt(event.args.assets) === (deposit ? sample.amount : expected) && BigInt(event.args.shares) === (deposit ? expected : sample.amount);
        } catch { return false; }
      })) throw new Error("Custodian synchronous lifecycle event missing");
}
