import { ethers } from "ethers";
import type { IdentitySemantics } from "../../adapter-family-plugin.js";
import type { AdapterRequestResult } from
  "../../adapter-request-program.js";
import { hashCanonical } from "../../canonical-value.js";
import {
  assertSameSource,
  callRequest,
  canonicalAddress,
  codeRequest,
  effectsProjection,
  lowerAddress,
  requireRuntimeCode,
  returnedResult,
  sameAddress,
  successfulResult,
  tokenDeltaAtLeast,
  totalSupplyDeltaAtLeast,
} from "../standard-family/common.js";
import {
  decodeEigenpieQuote,
  EIGENPIE_DEPOSIT_TOPIC,
  EIGENPIE_INTERFACE,
} from "./codec.js";
import {
  EIGENPIE_FAMILY_ID,
  EIGENPIE_LINEAGE_ID,
} from "./manifest.js";
import type {
  EigenpieActiveEvidence,
  EigenpieCandidate,
  EigenpieIdentity,
  EigenpieIdentityEvidence,
  EigenpieQuoteEvidence,
} from "./types.js";

export const eigenpieIdentity = {
  variants: [{
    id: "observed-active-pair",
    kind: "standalone-contract" as const,
    lineageId: EIGENPIE_LINEAGE_ID,
    applies: () => true,
    requirements({ evidence }) {
      if (evidence === undefined) {
        return { transports: ["get-code" as const, "eth-call" as const] };
      }
      return {
        transports: [
          "get-code" as const,
          "effect-delta-simulation" as const,
        ],
        caller: "observed-sender" as const,
        effects: [
          "return-data" as const,
          "token-delta" as const,
          "total-supply-delta" as const,
          "logs" as const,
        ],
      };
    },
    buildRequests({ candidate, evidence }) {
      if (evidence === undefined) {
        return Object.freeze([
          codeRequest("identity-target-code", candidate.target),
          codeRequest("identity-asset-code", candidate.tokenIn),
          callRequest(
            "identity-quote",
            candidate.target,
            EIGENPIE_INTERFACE.encodeFunctionData(
              "getMLRTAmountToMint",
              [candidate.tokenIn, candidate.amountIn],
            ),
          ),
        ]);
      }
      const quote = evidence as EigenpieQuoteEvidence;
      return Object.freeze([
        codeRequest("identity-receipt-code", quote.tokenOut),
        Object.freeze({
          id: "identity-active-deposit",
          kind: "effect-delta-simulation" as const,
          call: Object.freeze({
            caller: Object.freeze({ kind: "observed-sender" as const }),
            to: quote.target,
            data: EIGENPIE_INTERFACE.encodeFunctionData("depositAsset", [
              quote.tokenIn,
              quote.amountIn,
              quote.amountOut,
              ethers.ZeroAddress,
            ]),
          }),
          overrideIntent: Object.freeze({
            caller: Object.freeze({ kind: "observed-sender" as const }),
            tokenBalances: Object.freeze([Object.freeze({
              token: quote.tokenIn,
              amount: quote.amountIn,
            })]),
          }),
          observe: Object.freeze([
            "return-data" as const,
            "token-delta" as const,
            "total-supply-delta" as const,
            "logs" as const,
          ]),
        }),
      ]);
    },
    decode({ step, results }) {
      const successful = results.map((result) => {
        if (!result.ok) {
          throw new Error(`Eigenpie identity unresolved: ${result.failure}`);
        }
        return result;
      });
      assertSameSource(successful);
      if (step.evidence === undefined) {
        const targetCode = requireRuntimeCode(results, "identity-target-code");
        const assetCode = requireRuntimeCode(results, "identity-asset-code");
        const quoted = decodeEigenpieQuote(
          returnedResult(results, "identity-quote").data,
        );
        return Object.freeze({
          phase: "quote" as const,
          targetCodeHash: ethers.keccak256(targetCode),
          tokenInCodeHash: ethers.keccak256(assetCode),
          target: canonicalAddress(step.candidate.target),
          actor: canonicalAddress(step.candidate.actor),
          tokenIn: canonicalAddress(step.candidate.tokenIn),
          tokenOut: quoted.tokenOut,
          amountIn: step.candidate.amountIn,
          amountOut: quoted.amountOut,
        }) satisfies EigenpieQuoteEvidence;
      }
      const prior = step.evidence as EigenpieQuoteEvidence;
      const receiptCode = requireRuntimeCode(results, "identity-receipt-code");
      const simulation = successfulResult(results, "identity-active-deposit");
      const active = simulation.completion === "returned" &&
        tokenDeltaAtLeast({
          result: simulation,
          token: prior.tokenIn,
          account: prior.actor,
          direction: "decrease",
          amount: prior.amountIn,
        }) &&
        tokenDeltaAtLeast({
          result: simulation,
          token: prior.tokenOut,
          account: prior.actor,
          direction: "increase",
          amount: prior.amountOut,
        }) &&
        totalSupplyDeltaAtLeast({
          result: simulation,
          token: prior.tokenOut,
          direction: "increase",
          amount: prior.amountOut,
        }) &&
        assetDepositLogMatches(simulation, prior);
      return Object.freeze({
        ...prior,
        phase: "active" as const,
        tokenOutCodeHash: ethers.keccak256(receiptCode),
        behaviorProofHash: hashCanonical({
          request: "depositAsset",
          target: prior.target,
          actor: prior.actor,
          tokenIn: prior.tokenIn,
          tokenOut: prior.tokenOut,
          amountIn: prior.amountIn,
          amountOut: prior.amountOut,
          effects: effectsProjection(simulation.effects),
        }),
        active,
      }) satisfies EigenpieActiveEvidence;
    },
    decide: ({ candidate, evidence }) => {
      if (
        evidence === undefined ||
        (evidence as EigenpieIdentityEvidence).phase === "quote"
      ) {
        if (evidence !== undefined) {
          const quote = evidence as EigenpieQuoteEvidence;
          if (
            quote.amountOut <= 0n ||
            sameAddress(quote.tokenIn, quote.tokenOut) ||
            quote.amountOut < candidate.minAmountOut ||
            (candidate.observedAmountOut !== null &&
              quote.amountOut !== candidate.observedAmountOut)
          ) {
            return {
              status: "rejected" as const,
              reason: "eigenpie_quote_binding_failed",
            };
          }
        }
        return { status: "continue" as const };
      }
      const proof = evidence as EigenpieActiveEvidence;
      if (!proof.active) {
        return {
          status: "rejected" as const,
          reason: "eigenpie_active_deposit_failed",
        };
      }
      const subject = pairSubject(
        proof.target,
        proof.tokenIn,
        proof.tokenOut,
      );
      return {
        status: "verified" as const,
        identity: Object.freeze({
          familyId: EIGENPIE_FAMILY_ID,
          lineageId: EIGENPIE_LINEAGE_ID,
          subject,
          provenance: Object.freeze([Object.freeze({
            kind: "observed-active-pair-proof",
            subject: proof.target,
            evidenceHash: proof.behaviorProofHash,
          })]),
          target: proof.target,
          tokenIn: proof.tokenIn,
          tokenOut: proof.tokenOut,
          sampleAmountIn: proof.amountIn,
        }),
      };
    },
  }],
  identityKey: (identity) => identity.subject,
} satisfies IdentitySemantics<EigenpieCandidate, EigenpieIdentity>;

function pairSubject(
  target: string,
  tokenIn: string,
  tokenOut: string,
): string {
  return [
    lowerAddress(target),
    lowerAddress(tokenIn),
    lowerAddress(tokenOut),
  ].join(":");
}

function assetDepositLogMatches(
  result: Extract<AdapterRequestResult, { readonly ok: true }>,
  proof: EigenpieQuoteEvidence,
): boolean {
  return (result.effects?.logs ?? []).some((log) => {
    if (
      !sameAddress(log.address, proof.target) ||
      log.topics[0]?.toLowerCase() !== EIGENPIE_DEPOSIT_TOPIC
    ) return false;
    try {
      const parsed = EIGENPIE_INTERFACE.parseLog({
        topics: [...log.topics],
        data: log.data,
      });
      return parsed !== null &&
        sameAddress(String(parsed.args.depositor), proof.actor) &&
        sameAddress(String(parsed.args.asset), proof.tokenIn) &&
        BigInt(parsed.args.depositAmount) === proof.amountIn &&
        BigInt(parsed.args.mintedAmount) === proof.amountOut &&
        Boolean(parsed.args.isPreDeposit) === false;
    } catch {
      return false;
    }
  });
}
