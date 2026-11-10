import { keccak256 } from "ethers";
import type { IdentitySemantics, IdentityStepInput } from "../../adapter-family-plugin.js";
import type { AdapterRequest, AdapterRequestResult } from "../../adapter-request-program.js";
import { hashCanonical } from "../../canonical-value.js";
import {
  assertSameSource,
  callRequest,
  canonicalAddress,
  codeRequest,
  lowerAddress,
  requireRuntimeCode,
  sameAddress,
  successfulResult,
} from "../standard-family/common.js";
import { ACCOUNTANT_INTERFACE, ERC20_INTERFACE, TELLER_INTERFACE, VAULT_INTERFACE } from "./abi.js";
import { FAMILY, LINEAGE } from "./manifest.js";
import type { BoringCandidate, BoringEvidence, BoringIdentity } from "./types.js";

export const boringIdentity = {
  variants: [{
    id: "boring-vault-teller",
    kind: "custom" as const,
    lineageId: LINEAGE,
    applies: () => true,
    requirements() {
      // Both phases read runtime code (Teller, then vault/accountant).
      return { transports: ["get-code" as const, "eth-call" as const] };
    },
    buildRequests({ candidate, evidence }: IdentityStepInput<BoringCandidate, unknown>) {
      const e = evidence as BoringEvidence | undefined;
      if (e === undefined) return baseRequests(candidate);
      if (e.phase === "base") return completeRequests(e);
      return [];
    },
    decode(input: {
      readonly step: IdentityStepInput<BoringCandidate, unknown>;
      readonly results: readonly AdapterRequestResult[];
    }): BoringEvidence {
      const prior = input.step.evidence as BoringEvidence | undefined;
      if (prior === undefined) return decodeBase(input.step.candidate, input.results);
      if (prior.phase === "base") return decodeComplete(prior, input.results);
      throw new Error("boring vault invalid identity phase");
    },
    decide(input: IdentityStepInput<BoringCandidate, unknown>) {
      const e = input.evidence as BoringEvidence | undefined;
      if (e === undefined || e.phase !== "complete") return { status: "continue" as const };
      if (!e.behaviorValid) {
        return {
          status: "chain-proven-rejected" as const,
          reasonCode: "boring_vault_withdraw_unavailable",
          evidenceRequestIds: ["boring-complete"],
        };
      }
      return {
        status: "verified" as const,
        identity: Object.freeze({
          familyId: FAMILY,
          lineageId: LINEAGE,
          subject: canonicalAddress(e.teller),
          provenance: Object.freeze([Object.freeze({
            kind: "boring-vault-teller",
            subject: canonicalAddress(e.teller),
            evidenceHash: e.behaviorHash,
          })]),
          teller: e.teller,
          vault: e.vault,
          accountant: e.accountant,
          asset: e.asset,
          shareDecimals: e.shareDecimals,
          shareLockPeriod: e.shareLockPeriod,
          tellerCodeHash: e.tellerCodeHash,
          vaultCodeHash: e.vaultCodeHash,
          accountantCodeHash: e.accountantCodeHash,
        }),
      };
    },
  }],
  identityKey: (i: BoringIdentity) => lowerAddress(i.subject),
} satisfies IdentitySemantics<BoringCandidate, BoringIdentity>;

function baseRequests(candidate: BoringCandidate): readonly AdapterRequest[] {
  return Object.freeze([
    codeRequest("boring-teller-code", candidate.teller),
    callRequest("boring-vault", candidate.teller, TELLER_INTERFACE.encodeFunctionData("vault")),
    callRequest("boring-accountant", candidate.teller, TELLER_INTERFACE.encodeFunctionData("accountant")),
    callRequest("boring-paused", candidate.teller, TELLER_INTERFACE.encodeFunctionData("isPaused")),
    callRequest("boring-lock", candidate.teller, TELLER_INTERFACE.encodeFunctionData("shareLockPeriod")),
  ]);
}

function decodeBase(candidate: BoringCandidate, results: readonly AdapterRequestResult[]): BoringEvidence {
  const code = requireRuntimeCode(results, "boring-teller-code");
  const vault = canonicalAddress(String(TELLER_INTERFACE.decodeFunctionResult("vault", successfulResult(results, "boring-vault").data)[0]));
  const accountant = canonicalAddress(String(TELLER_INTERFACE.decodeFunctionResult("accountant", successfulResult(results, "boring-accountant").data)[0]));
  const paused = Boolean(TELLER_INTERFACE.decodeFunctionResult("isPaused", successfulResult(results, "boring-paused").data)[0]);
  const shareLockPeriod = BigInt(TELLER_INTERFACE.decodeFunctionResult("shareLockPeriod", successfulResult(results, "boring-lock").data)[0]);
  if (paused) throw new Error("boring vault teller is paused");
  return Object.freeze({
    phase: "base" as const,
    source: assertSameSource([successfulResult(results, "boring-teller-code")]),
    teller: canonicalAddress(candidate.teller),
    vault,
    accountant,
    paused: false,
    shareLockPeriod,
    tellerCodeHash: keccak256(code),
  });
}

function completeRequests(e: Extract<BoringEvidence, { phase: "base" }>): readonly AdapterRequest[] {
  return Object.freeze([
    codeRequest("boring-vault-code", e.vault),
    codeRequest("boring-accountant-code", e.accountant),
    callRequest("boring-authority", e.vault, VAULT_INTERFACE.encodeFunctionData("authority")),
    callRequest("boring-hook", e.vault, VAULT_INTERFACE.encodeFunctionData("hook")),
    callRequest("boring-accountant-vault", e.accountant, ACCOUNTANT_INTERFACE.encodeFunctionData("vault")),
    callRequest("boring-base", e.accountant, ACCOUNTANT_INTERFACE.encodeFunctionData("base")),
    callRequest("boring-share-decimals", e.vault, ERC20_INTERFACE.encodeFunctionData("decimals")),
  ]);
}

function decodeComplete(
  e: Extract<BoringEvidence, { phase: "base" }>,
  results: readonly AdapterRequestResult[],
): BoringEvidence {
  const vaultCode = requireRuntimeCode(results, "boring-vault-code");
  const accountantCode = requireRuntimeCode(results, "boring-accountant-code");
  const hook = canonicalAddress(String(VAULT_INTERFACE.decodeFunctionResult("hook", successfulResult(results, "boring-hook").data)[0]));
  const accountantVault = canonicalAddress(String(ACCOUNTANT_INTERFACE.decodeFunctionResult("vault", successfulResult(results, "boring-accountant-vault").data)[0]));
  const asset = canonicalAddress(String(ACCOUNTANT_INTERFACE.decodeFunctionResult("base", successfulResult(results, "boring-base").data)[0]));
  const shareDecimals = Number(BigInt(ERC20_INTERFACE.decodeFunctionResult("decimals", successfulResult(results, "boring-share-decimals").data)[0]));
  if (!sameAddress(hook, e.teller)) throw new Error("boring vault hook is not the Teller");
  if (!sameAddress(accountantVault, e.vault)) throw new Error("boring accountant vault mismatch");
  if (!Number.isInteger(shareDecimals) || shareDecimals > 36) throw new Error("boring share decimals out of range");
  const behaviorValid = true;
  return Object.freeze({
    phase: "complete" as const,
    source: assertSameSource([successfulResult(results, "boring-vault-code")]),
    teller: e.teller,
    vault: e.vault,
    accountant: e.accountant,
    asset,
    shareDecimals,
    paused: e.paused,
    shareLockPeriod: e.shareLockPeriod,
    tellerCodeHash: e.tellerCodeHash,
    vaultCodeHash: keccak256(vaultCode),
    accountantCodeHash: keccak256(accountantCode),
    behaviorValid,
    behaviorHash: hashCanonical({
      teller: e.teller, vault: e.vault, accountant: e.accountant, asset,
      shareDecimals: String(shareDecimals), hook, accountantVault,
    }),
  });
}
