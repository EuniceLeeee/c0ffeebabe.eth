import { ethers } from "ethers";
import type { IdentitySemantics } from "../../adapter-family-plugin.js";
import type {
  AdapterRequest,
  AdapterRequestResult,
  CanonicalSource,
} from "../../adapter-request-program.js";
import { hashCanonical } from "../../canonical-value.js";
import {
  assertSameSource,
  assertSource,
  callRequest,
  canonicalAddress,
  codeRequest,
  decodeAddress,
  effectsProjection,
  lowerAddress,
  returnedResult,
  sameAddress,
  successfulResult,
} from "../standard-family/common.js";
import {
  ORIGIN_OUSD_ASSET,
  ORIGIN_OUSD_BEHAVIOR_SAMPLES,
  ORIGIN_OUSD_EIP1967_IMPLEMENTATION_SLOT,
  ORIGIN_OUSD_IMPLEMENTATION_CODE_HASH,
  ORIGIN_OUSD_PROXY_CODE_HASH,
  ORIGIN_OUSD_TOKEN,
  ORIGIN_OUSD_TOKEN_CODE_HASH,
  ORIGIN_OUSD_VAULT_INTERFACE,
  originOusdMintQuote,
} from "./codec.js";
import {
  ORIGIN_OUSD_FAMILY_ID,
  ORIGIN_OUSD_LINEAGE_ID,
} from "./manifest.js";
import type {
  OriginOusdCandidate,
  OriginOusdIdentity,
  OriginOusdIdentityEvidence,
} from "./types.js";

const caller = { kind: "executor" as const };
const ERC20 = new ethers.Interface([
  "function approve(address,uint256) returns (bool)",
]);

type Proof = OriginOusdIdentityEvidence;

/**
 * Origin OUSD vault identity.
 *
 * Round 1 proves the EIP-1967 proxy runtime code hash, derives the
 * implementation address from the implementation slot, and pins the OUSD token
 * runtime code hash (the vault exposes no `ousd()` getter on this
 * implementation, so the token is bound by fixed constant + code hash).
 * Round 2 proves the implementation runtime code hash and `vault.asset()`.
 * Round 3 proves the real mint behavior: with only a caller-funded USDC balance
 * and an exact approval, `mint(amount)` debits `amount` USDC from the caller,
 * credits the vault and mints exactly `amount * 1e12` OUSD to the caller with
 * the same total-supply increase. No executor-program transport is used.
 */
export const originOusdIdentity = {
  memoReuse: "recheck-identity" as const,
  variants: [{
    id: "origin-ousd-proxy-mint",
    kind: "standalone-contract" as const,
    lineageId: ORIGIN_OUSD_LINEAGE_ID,
    applies: () => true,
    requirements: ({ evidence }) => {
      const proof = evidence as Proof | undefined;
      if (proof === undefined) {
        return { transports: ["get-code" as const, "get-storage" as const] };
      }
      if (proof.phase === "proxy") {
        return { transports: ["get-code" as const, "eth-call" as const] };
      }
      return {
        transports: ["effect-delta-simulation" as const],
        caller: "executor" as const,
        effects: [
          "return-data" as const,
          "revert-data" as const,
          "token-delta" as const,
          "total-supply-delta" as const,
        ],
      };
    },
    buildRequests: ({ candidate, evidence }) => {
      const proof = evidence as Proof | undefined;
      if (proof === undefined) {
        return Object.freeze([
          codeRequest("identity-proxy-code", candidate.target),
          Object.freeze({
            id: "identity-implementation-slot",
            kind: "get-storage" as const,
            address: canonicalAddress(candidate.target),
            slot: ORIGIN_OUSD_EIP1967_IMPLEMENTATION_SLOT,
          }) satisfies AdapterRequest,
          codeRequest("identity-token-code", ORIGIN_OUSD_TOKEN),
        ]);
      }
      if (proof.phase === "proxy") {
        return Object.freeze([
          codeRequest("identity-implementation-code", proof.implementation),
          callRequest(
            "identity-asset",
            candidate.target,
            ORIGIN_OUSD_VAULT_INTERFACE.encodeFunctionData("asset"),
          ),
        ]);
      }
      if (proof.phase === "binding") {
        return Object.freeze(ORIGIN_OUSD_BEHAVIOR_SAMPLES.map(amount =>
          mintSimulation(candidate.target, amount)));
      }
      return Object.freeze([]);
    },
    decode: ({ step, results }) => {
      const prior = step.evidence as Proof | undefined;
      if (prior === undefined) return decodeProxy(results);
      for (const result of results) {
        assertSource(successfulResult(results, result.id).source, prior.source);
      }
      if (prior.phase === "proxy") return decodeBinding(prior, results);
      if (prior.phase === "binding") {
        return decodeBehavior(canonicalAddress(step.candidate.target), prior, results);
      }
      throw new Error("Origin OUSD identity reached an unexpected phase");
    },
    decide: ({ candidate, evidence }) => {
      const proof = evidence as Proof | undefined;
      if (proof === undefined) return { status: "continue" as const };
      if (proof.phase === "proxy") {
        if (proof.proxyCodeHash.toLowerCase() !== ORIGIN_OUSD_PROXY_CODE_HASH) {
          return {
            status: "chain-proven-rejected" as const,
            reasonCode: "origin_ousd_proxy_code_mismatch",
            evidenceRequestIds: ["identity-proxy-code"],
          };
        }
        if (canonicalAddress(proof.implementation) === ethers.ZeroAddress) {
          return {
            status: "chain-proven-rejected" as const,
            reasonCode: "origin_ousd_implementation_missing",
            evidenceRequestIds: ["identity-implementation-slot"],
          };
        }
        if (proof.tokenCodeHash.toLowerCase() !== ORIGIN_OUSD_TOKEN_CODE_HASH) {
          return {
            status: "chain-proven-rejected" as const,
            reasonCode: "origin_ousd_token_code_mismatch",
            evidenceRequestIds: ["identity-token-code"],
          };
        }
        return { status: "continue" as const };
      }
      if (proof.implementationCodeHash.toLowerCase() !== ORIGIN_OUSD_IMPLEMENTATION_CODE_HASH) {
        return {
          status: "chain-proven-rejected" as const,
          reasonCode: "origin_ousd_implementation_code_mismatch",
          evidenceRequestIds: ["identity-implementation-code"],
        };
      }
      if (!sameAddress(proof.asset, ORIGIN_OUSD_ASSET)) {
        return {
          status: "chain-proven-rejected" as const,
          reasonCode: "origin_ousd_asset_mismatch",
          evidenceRequestIds: ["identity-asset"],
        };
      }
      if (proof.phase === "binding") return { status: "continue" as const };
      if (!proof.behaviorValid) {
        return {
          status: "retryable" as const,
          reasonCode: "origin_ousd_mint_behavior_not_proven",
        };
      }
      return {
        status: "verified" as const,
        identity: Object.freeze({
          familyId: ORIGIN_OUSD_FAMILY_ID,
          lineageId: ORIGIN_OUSD_LINEAGE_ID,
          subject: canonicalAddress(candidate.target),
          provenance: Object.freeze([Object.freeze({
            kind: "origin-ousd-proxy-mint-proof",
            subject: canonicalAddress(candidate.target),
            evidenceHash: hashCanonical({
              proxyCodeHash: proof.proxyCodeHash.toLowerCase(),
              implementation: lowerAddress(proof.implementation),
              implementationCodeHash: proof.implementationCodeHash.toLowerCase(),
              tokenCodeHash: proof.tokenCodeHash.toLowerCase(),
              asset: lowerAddress(proof.asset),
              behaviorProofHash: proof.behaviorProofHash,
              executionVerified: true,
              source: { ...proof.source },
            }),
          })]),
          asset: canonicalAddress(proof.asset),
          implementation: canonicalAddress(proof.implementation),
          proxyCodeHash: proof.proxyCodeHash.toLowerCase(),
          implementationCodeHash: proof.implementationCodeHash.toLowerCase(),
          tokenCodeHash: proof.tokenCodeHash.toLowerCase(),
        }),
      };
    },
  }],
  identityKey: (identity) => lowerAddress(identity.subject),
} satisfies IdentitySemantics<OriginOusdCandidate, OriginOusdIdentity>;

function decodeProxy(
  results: readonly AdapterRequestResult[],
): OriginOusdIdentityEvidence {
  const successful = results.map((result) => {
    if (!result.ok) {
      throw new Error(`Origin OUSD identity unresolved: ${result.failure}`);
    }
    return result;
  });
  const source: CanonicalSource = assertSameSource(successful);
  const proxyCodeHash = ethers.keccak256(
    returnedResult(results, "identity-proxy-code").data,
  ).toLowerCase();
  const tokenCodeHash = ethers.keccak256(
    returnedResult(results, "identity-token-code").data,
  ).toLowerCase();
  const word = returnedResult(results, "identity-implementation-slot").data;
  if (!/^0x[0-9a-fA-F]{64}$/.test(word)) {
    throw new Error("Origin OUSD identity implementation slot is malformed");
  }
  return Object.freeze({
    phase: "proxy" as const,
    source,
    proxyCodeHash,
    implementation: canonicalAddress(`0x${word.slice(-40)}`),
    tokenCodeHash,
  });
}

function decodeBinding(
  prior: Proof & { readonly phase: "proxy" },
  results: readonly AdapterRequestResult[],
): OriginOusdIdentityEvidence {
  const implementationCodeHash = ethers.keccak256(
    returnedResult(results, "identity-implementation-code").data,
  ).toLowerCase();
  return Object.freeze({
    phase: "binding" as const,
    source: prior.source,
    proxyCodeHash: prior.proxyCodeHash,
    implementation: prior.implementation,
    tokenCodeHash: prior.tokenCodeHash,
    implementationCodeHash,
    asset: decodeAddress(
      ORIGIN_OUSD_VAULT_INTERFACE,
      "asset",
      results,
      "identity-asset",
    ),
  });
}

function decodeBehavior(
  vault: string,
  prior: Proof & { readonly phase: "binding" },
  results: readonly AdapterRequestResult[],
): OriginOusdIdentityEvidence {
  const probes = ORIGIN_OUSD_BEHAVIOR_SAMPLES.map((amount) => {
    const result = successfulResult(results, mintProbeId(amount));
    assertSource(result.source, prior.source);
    return { amount, amountOut: originOusdMintQuote(amount), result };
  });
  const behaviorValid = probes.every(probe =>
    validateMintProbe(probe.result, vault, probe.amount, probe.amountOut));
  return Object.freeze({
    phase: "verified" as const,
    source: prior.source,
    proxyCodeHash: prior.proxyCodeHash,
    implementation: prior.implementation,
    tokenCodeHash: prior.tokenCodeHash,
    implementationCodeHash: prior.implementationCodeHash,
    asset: prior.asset,
    behaviorValid,
    behaviorProofHash: hashCanonical({
      proxyCodeHash: prior.proxyCodeHash,
      implementation: lowerAddress(prior.implementation),
      implementationCodeHash: prior.implementationCodeHash,
      tokenCodeHash: prior.tokenCodeHash,
      asset: lowerAddress(prior.asset),
      probes: probes.map(probe => ({
        amount: probe.amount,
        amountOut: probe.amountOut,
        completion: probe.result.completion,
        effects: effectsProjection(probe.result.effects),
      })),
    }),
  });
}

function mintProbeId(amount: bigint): string {
  return `identity-mint:${amount}`;
}

/**
 * Caller balance and allowance are the only overrides; the vault itself is
 * never mocked. Two amounts are probed so an amount-independent response
 * cannot pass.
 */
function mintSimulation(target: string, amount: bigint): AdapterRequest {
  const vault = canonicalAddress(target);
  return Object.freeze({
    id: mintProbeId(amount),
    kind: "effect-delta-simulation" as const,
    preCalls: Object.freeze([Object.freeze({
      caller,
      to: canonicalAddress(ORIGIN_OUSD_ASSET),
      data: ERC20.encodeFunctionData("approve", [vault, amount]),
    })]),
    call: Object.freeze({
      caller,
      executionMode: "impersonated-call-frame" as const,
      to: vault,
      data: ORIGIN_OUSD_VAULT_INTERFACE.encodeFunctionData("mint", [amount]),
    }),
    overrideIntent: Object.freeze({
      caller,
      tokenBalances: Object.freeze([Object.freeze({
        token: canonicalAddress(ORIGIN_OUSD_ASSET),
        amount,
      })]),
    }),
    observeTokenBalances: Object.freeze([
      Object.freeze({ token: canonicalAddress(ORIGIN_OUSD_ASSET), account: caller }),
      Object.freeze({ token: canonicalAddress(ORIGIN_OUSD_ASSET), account: vault }),
      Object.freeze({ token: canonicalAddress(ORIGIN_OUSD_TOKEN), account: caller }),
    ]),
    observeTotalSupplies: Object.freeze([canonicalAddress(ORIGIN_OUSD_TOKEN)]),
    observe: Object.freeze([
      "return-data" as const,
      "revert-data" as const,
      "token-delta" as const,
      "total-supply-delta" as const,
    ]),
  });
}

function validateMintProbe(
  result: Extract<AdapterRequestResult, { readonly ok: true }>,
  vault: string,
  amount: bigint,
  amountOut: bigint,
): boolean {
  if (result.completion !== "returned") return false;
  const deltas = result.effects?.tokenDeltas ?? [];
  const supplies = result.effects?.totalSupplyDeltas ?? [];
  const vaultDebit = deltas.filter(delta =>
    sameAddress(delta.token, ORIGIN_OUSD_ASSET) &&
    sameAddress(delta.account, vault));
  if (vaultDebit.length !== 1 || vaultDebit[0].delta !== amount) return false;
  const payerDebit = deltas.filter(delta =>
    sameAddress(delta.token, ORIGIN_OUSD_ASSET) && delta.delta === -amount);
  if (payerDebit.length !== 1) return false;
  const payer = payerDebit[0].account;
  if (sameAddress(payer, vault)) return false;
  const minted = deltas.filter(delta =>
    sameAddress(delta.token, ORIGIN_OUSD_TOKEN) && sameAddress(delta.account, payer));
  if (minted.length !== 1 || minted[0].delta !== amountOut) return false;
  const supply = supplies.filter(delta =>
    sameAddress(delta.token, ORIGIN_OUSD_TOKEN));
  return supply.length === 1 && supply[0].delta === amountOut;
}
