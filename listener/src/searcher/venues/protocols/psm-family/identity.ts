import { ethers } from "ethers";
import { ADDR } from "../../../../shared/constants/addresses.js";
import type { IdentitySemantics } from "../../adapter-family-plugin.js";
import type { AdapterRequest, CanonicalSource } from "../../adapter-request-program.js";
import { hashCanonical } from "../../canonical-value.js";
import {
  assertSameSource,
  callRequest,
  canonicalAddress,
  codeRequest,
  decodeAddress,
  decodeUint,
  lowerAddress,
  requireRuntimeCode,
  sameAddress,
  assertSource,
  successfulResult,
} from "../standard-family/common.js";
import { PSM_INTERFACE, PSM_WAD, PSM_GEM_TO_DAI_SCALE, psmBuyCost, psmBuyQuote, psmSellQuote } from "./codec.js";
import { PSM_FAMILY_ID, PSM_LINEAGE_ID } from "./manifest.js";
import type {
  PsmCandidate,
  PsmIdentity,
  PsmIdentityEvidence,
} from "./types.js";
const ERC20 = new ethers.Interface(["function approve(address,uint256) returns (bool)"]);
const caller = { kind: "executor" as const };
const receiver = "0x0000000000000000000000000000000000000001";
interface Proof extends PsmIdentityEvidence {
  readonly phase: "getters" | "executed";
  readonly source: CanonicalSource;
  readonly pocket: string;
  readonly scale: bigint;
  readonly executionVerified?: boolean;
}

export const psmIdentity = {
  memoReuse: "recheck-identity" as const,
  variants: [{
    id: "lite-active-pair",
    kind: "standalone-contract" as const,
    lineageId: PSM_LINEAGE_ID,
    applies: () => true,
    requirements: ({ evidence }) => (evidence as Proof | undefined)?.phase === "getters"
      ? { transports: ["effect-delta-simulation"], caller: "executor", effects: ["return-data", "revert-data", "token-delta"] }
      : { transports: ["get-code", "eth-call"] },
    buildRequests: ({ candidate, evidence }) => evidence
      ? probes(candidate.target, evidence as Proof).map(item => item.request)
      : Object.freeze([
      codeRequest("identity-code", candidate.target),
      callRequest(
        "identity-gem",
        candidate.target,
        PSM_INTERFACE.encodeFunctionData("gem"),
      ),
      callRequest(
        "identity-dai",
        candidate.target,
        PSM_INTERFACE.encodeFunctionData("dai"),
      ),
      callRequest(
        "identity-tin",
        candidate.target,
        PSM_INTERFACE.encodeFunctionData("tin"),
      ),
      callRequest(
        "identity-tout",
        candidate.target,
        PSM_INTERFACE.encodeFunctionData("tout"),
      ),
      callRequest("identity-pocket", candidate.target, PSM_INTERFACE.encodeFunctionData("pocket")),
      callRequest("identity-scale", candidate.target, PSM_INTERFACE.encodeFunctionData("to18ConversionFactor")),
    ]),
    decode: ({ step, results }) => {
      if (step.evidence) {
        const prior = step.evidence as Proof;
        for (const result of results) assertSource(result.source, prior.source);
        const verified = probes(step.candidate.target, prior).every(({ request, deltas }) => {
          const matches = results.filter(result => result.id === request.id);
          if (matches.length !== 1) throw new Error("PSM missing/duplicate execution evidence");
          const result = successfulResult(results, request.id);
          if (result.completion !== "returned") return false;
          const actual = result.effects?.tokenDeltas;
          if (!actual || actual.length !== 4) return false;
          const input = actual.filter(delta => sameAddress(delta.token, deltas[0].token) &&
            !sameAddress(delta.account, deltas[1].account));
          if (input.length !== 1 || sameAddress(input[0].account, receiver)) return false;
          return deltas.every((expected, index) => {
            const account = index === 0 ? input[0].account : expected.account;
            const match = actual.filter(delta => sameAddress(delta.token, expected.token) && sameAddress(delta.account, account));
            return match.length === 1 && match[0].delta === expected.delta;
          });
        });
        return { ...prior, phase: "executed", executionVerified: verified } satisfies Proof;
      }
      const successful = results.map((result) => {
        if (!result.ok) {
          throw new Error(`PSM identity unresolved: ${result.failure}`);
        }
        return result;
      });
      const source = assertSameSource(successful);
      const code = requireRuntimeCode(results, "identity-code");
      return Object.freeze({
        phase: "getters", source,
        codeHash: ethers.keccak256(code),
        gem: decodeAddress(PSM_INTERFACE, "gem", results, "identity-gem"),
        dai: decodeAddress(PSM_INTERFACE, "dai", results, "identity-dai"),
        tin: decodeUint(PSM_INTERFACE, "tin", results, "identity-tin"),
        tout: decodeUint(PSM_INTERFACE, "tout", results, "identity-tout"),
        pocket: decodeAddress(PSM_INTERFACE, "pocket", results, "identity-pocket"),
        scale: decodeUint(PSM_INTERFACE, "to18ConversionFactor", results, "identity-scale"),
      }) satisfies Proof;
    },
    decide: ({ candidate, evidence }) => {
      if (evidence === undefined) return { status: "continue" as const };
      const proof = evidence as Proof;
      if (
        !sameAddress(proof.gem, ADDR.USDC) ||
        !sameAddress(proof.dai, ADDR.DAI) ||
        proof.scale !== PSM_GEM_TO_DAI_SCALE || sameAddress(proof.pocket, ethers.ZeroAddress) ||
        sameAddress(proof.pocket, receiver) || sameAddress(candidate.target, receiver)
      ) {
        return {
          status: "chain-proven-rejected" as const,
          reasonCode: "psm_active_pair_failed",
              evidenceRequestIds: ["lite-active-pair"],
        };
      }
      if (proof.tin >= PSM_WAD || proof.tout > PSM_WAD) {
        return { status: "retryable", reasonCode: "psm_direction_temporarily_unavailable" };
      }
      if (proof.phase === "getters") return { status: "continue" };
      if (proof.phase !== "executed" || !proof.executionVerified) return { status: "retryable", reasonCode: "psm_direction_execution_not_proven" };
      return {
        status: "verified" as const,
        identity: Object.freeze({
          familyId: PSM_FAMILY_ID,
          lineageId: PSM_LINEAGE_ID,
          subject: canonicalAddress(candidate.target),
          provenance: Object.freeze([Object.freeze({
            kind: "lite-psm-active-pair-proof",
            subject: canonicalAddress(candidate.target),
            evidenceHash: hashCanonical({
              codeHash: proof.codeHash,
              gem: lowerAddress(proof.gem),
              dai: lowerAddress(proof.dai),
              tin: proof.tin,
              tout: proof.tout,
              pocket: lowerAddress(proof.pocket), scale: proof.scale, executionVerified: true,
              source: { ...proof.source },
            }),
          })]),
          gem: proof.gem,
          dai: proof.dai,
        }),
      };
    },
  }],
  identityKey: (identity) => lowerAddress(identity.subject),
} satisfies IdentitySemantics<PsmCandidate, PsmIdentity>;

function probes(target: string, proof: Proof) {
  // Behavioral identity probes, not the production P. Two sizes prevent an
  // amount-independent getter response from granting the reverse executable edge.
  return [1n, 10n].flatMap(multiplier => [true, false].map(sell => {
    const amountIn = multiplier * (sell ? 10n ** 6n : PSM_WAD);
    const amountOut = (sell ? psmSellQuote : psmBuyQuote)(amountIn, sell ? proof.tin : proof.tout, proof.scale);
    const spent = sell ? amountIn : psmBuyCost(amountOut, proof.tout, proof.scale);
    const tokenIn = sell ? proof.gem : proof.dai, tokenOut = sell ? proof.dai : proof.gem;
    const inAccount = sell ? proof.pocket : target, outAccount = sell ? target : proof.pocket;
    const request: AdapterRequest = {
      id: `identity-execute:${sell ? "sell" : "buy"}:${multiplier}`, kind: "effect-delta-simulation",
      preCalls: [{ caller, to: tokenIn, data: ERC20.encodeFunctionData("approve", [target, amountIn]) }],
      call: { caller, executionMode: "impersonated-call-frame", to: target,
        data: PSM_INTERFACE.encodeFunctionData(sell ? "sellGem" : "buyGem", [receiver, sell ? amountIn : amountOut]) },
      overrideIntent: { caller, tokenBalances: [{ token: tokenIn, amount: amountIn }] },
      observeTokenBalances: [{ token: tokenIn, account: caller }, { token: tokenIn, account: inAccount },
        { token: tokenOut, account: receiver }, { token: tokenOut, account: outAccount }],
      observe: ["return-data", "revert-data", "token-delta"],
    };
    return { request, deltas: [{ token: tokenIn, account: "", delta: -spent },
      { token: tokenIn, account: inAccount, delta: spent }, { token: tokenOut, account: receiver, delta: amountOut },
      { token: tokenOut, account: outAccount, delta: -amountOut }] };
  }));
}
