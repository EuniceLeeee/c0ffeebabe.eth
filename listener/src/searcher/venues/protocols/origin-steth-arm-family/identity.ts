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
  canonicalAddress,
  codeRequest,
  lowerAddress,
  requireRuntimeCode,
  sameAddress,
  successfulResult,
} from "../standard-family/common.js";
import {
  ORIGIN_STETH_ARM_BEHAVIOR_SAMPLES,
  ORIGIN_STETH_ARM_EIP1967_IMPLEMENTATION_SLOT,
  ORIGIN_STETH_ARM_IMPLEMENTATION_CODE_HASH,
  ORIGIN_STETH_ARM_INTERFACE,
  ORIGIN_STETH_ARM_MAX_RATE,
  ORIGIN_STETH_ARM_PROBE_RECIPIENT,
  ORIGIN_STETH_ARM_PROXY_CODE_HASH,
  ORIGIN_STETH_ARM_STETH,
  ORIGIN_STETH_ARM_STETH_CODE_HASH,
  ORIGIN_STETH_ARM_TRADERATE0_SLOT,
  ORIGIN_STETH_ARM_TRADERATE1_SLOT,
  ORIGIN_STETH_ARM_WETH,
  ORIGIN_STETH_ARM_WETH_CODE_HASH,
  originStethArmQuote,
  originStethArmTokenIn,
  originStethArmTokenOut,
  storageRequest,
  storageWordToUint,
  type OriginStethArmDirection,
} from "./codec.js";
import {
  ORIGIN_STETH_ARM_FAMILY_ID,
  ORIGIN_STETH_ARM_LINEAGE_ID,
} from "./manifest.js";
import type {
  OriginStethArmCandidate,
  OriginStethArmIdentity,
  OriginStethArmIdentityEvidence,
} from "./types.js";

const caller = { kind: "executor" as const } as const;
const ERC20 = new ethers.Interface([
  "function approve(address,uint256) returns (bool)",
]);

type Proof = OriginStethArmIdentityEvidence;

interface BehaviorProbe {
  readonly request: AdapterRequest;
  readonly direction: OriginStethArmDirection;
  readonly amount: bigint;
  readonly tokenIn: string;
  readonly tokenOut: string;
  readonly expectedOut: bigint;
}

/**
 * Origin stETH ARM identity.
 *
 * Round 1 proves the EIP-1967 proxy runtime code hash, derives the current
 * implementation from the implementation slot, and pins the stETH and WETH
 * runtime code hashes.
 * Round 2 proves the implementation runtime code hash and reads the two
 * block-pinned price words (`traderate0`/`traderate1`, proxy slots 50/51) that
 * the verified swap reads.
 * Round 3 proves the real swap behavior in both directions at two amounts:
 * with only a caller-funded input balance and an exact approval, the swap
 * debits the caller (stETH transfers may deliver up to two wei less than the
 * requested amount because of share rounding), transfers the output to the
 * literal probe recipient and reproduces `floor(amountIn * rate / 1e36)`
 * against the same-block price word. A changed price, token wiring or code
 * hash cannot pass.
 */
export const originStethArmIdentity = {
  memoReuse: "recheck-identity" as const,
  variants: [{
    id: "origin-steth-arm-proxy-swap",
    kind: "standalone-contract" as const,
    lineageId: ORIGIN_STETH_ARM_LINEAGE_ID,
    applies: () => true,
    requirements: ({ evidence }) => {
      const proof = evidence as Proof | undefined;
      if (proof === undefined || proof.phase === "proxy") {
        return {
          transports: ["get-code" as const, "get-storage" as const],
        };
      }
      if (proof.phase === "binding") {
        return {
          transports: ["effect-delta-simulation" as const],
          caller: "executor" as const,
          effects: [
            "return-data" as const,
            "revert-data" as const,
            "token-delta" as const,
          ],
        };
      }
      return { transports: [] };
    },
    buildRequests: ({ candidate, evidence }) => {
      const proof = evidence as Proof | undefined;
      if (proof === undefined) {
        return Object.freeze([
          codeRequest("identity-proxy-code", candidate.target),
          storageRequest(
            "identity-implementation-slot",
            candidate.target,
            ORIGIN_STETH_ARM_EIP1967_IMPLEMENTATION_SLOT,
          ),
          codeRequest("identity-steth-code", ORIGIN_STETH_ARM_STETH),
          codeRequest("identity-weth-code", ORIGIN_STETH_ARM_WETH),
        ]);
      }
      if (proof.phase === "proxy") {
        return Object.freeze([
          codeRequest("identity-implementation-code", proof.implementation),
          storageRequest(
            "identity-traderate0",
            candidate.target,
            ORIGIN_STETH_ARM_TRADERATE0_SLOT,
          ),
          storageRequest(
            "identity-traderate1",
            candidate.target,
            ORIGIN_STETH_ARM_TRADERATE1_SLOT,
          ),
        ]);
      }
      if (proof.phase === "binding") {
        return Object.freeze(
          behaviorProbes(candidate.target, proof).map(probe => probe.request),
        );
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
        return decodeBehavior(
          canonicalAddress(step.candidate.target),
          prior,
          results,
        );
      }
      throw new Error("Origin stETH ARM identity reached an unexpected phase");
    },
    decide: ({ candidate, evidence }) => {
      const proof = evidence as Proof | undefined;
      if (proof === undefined) return { status: "continue" as const };
      if (proof.phase === "proxy") {
        if (proof.proxyCodeHash.toLowerCase() !== ORIGIN_STETH_ARM_PROXY_CODE_HASH) {
          return {
            status: "chain-proven-rejected" as const,
            reasonCode: "origin_steth_arm_proxy_code_mismatch",
            evidenceRequestIds: ["identity-proxy-code"],
          };
        }
        if (canonicalAddress(proof.implementation) === ethers.ZeroAddress) {
          return {
            status: "chain-proven-rejected" as const,
            reasonCode: "origin_steth_arm_implementation_missing",
            evidenceRequestIds: ["identity-implementation-slot"],
          };
        }
        if (
          proof.stethCodeHash.toLowerCase() !== ORIGIN_STETH_ARM_STETH_CODE_HASH ||
          proof.wethCodeHash.toLowerCase() !== ORIGIN_STETH_ARM_WETH_CODE_HASH
        ) {
          return {
            status: "chain-proven-rejected" as const,
            reasonCode: "origin_steth_arm_token_code_mismatch",
            evidenceRequestIds: ["identity-steth-code", "identity-weth-code"],
          };
        }
        return { status: "continue" as const };
      }
      if (
        proof.implementationCodeHash.toLowerCase() !==
          ORIGIN_STETH_ARM_IMPLEMENTATION_CODE_HASH
      ) {
        return {
          status: "chain-proven-rejected" as const,
          reasonCode: "origin_steth_arm_implementation_code_mismatch",
          evidenceRequestIds: ["identity-implementation-code"],
        };
      }
      if (!validRate(proof.traderate0) || !validRate(proof.traderate1)) {
        return {
          status: "retryable" as const,
          reasonCode: "origin_steth_arm_price_out_of_range",
        };
      }
      if (proof.phase === "binding") return { status: "continue" as const };
      if (!proof.behaviorValid) {
        return {
          status: "retryable" as const,
          reasonCode: "origin_steth_arm_swap_behavior_not_proven",
        };
      }
      return {
        status: "verified" as const,
        identity: Object.freeze({
          familyId: ORIGIN_STETH_ARM_FAMILY_ID,
          lineageId: ORIGIN_STETH_ARM_LINEAGE_ID,
          subject: canonicalAddress(candidate.target),
          provenance: Object.freeze([Object.freeze({
            kind: "origin-steth-arm-proxy-swap-proof",
            subject: canonicalAddress(candidate.target),
            evidenceHash: hashCanonical({
              proxyCodeHash: proof.proxyCodeHash.toLowerCase(),
              implementation: lowerAddress(proof.implementation),
              implementationCodeHash: proof.implementationCodeHash.toLowerCase(),
              stethCodeHash: proof.stethCodeHash.toLowerCase(),
              wethCodeHash: proof.wethCodeHash.toLowerCase(),
              traderate0: proof.traderate0,
              traderate1: proof.traderate1,
              behaviorProofHash: proof.behaviorProofHash,
              executionVerified: true,
              source: { ...proof.source },
            }),
          })]),
          weth: canonicalAddress(ORIGIN_STETH_ARM_WETH),
          steth: canonicalAddress(ORIGIN_STETH_ARM_STETH),
          implementation: canonicalAddress(proof.implementation),
          proxyCodeHash: proof.proxyCodeHash.toLowerCase(),
          implementationCodeHash: proof.implementationCodeHash.toLowerCase(),
          stethCodeHash: proof.stethCodeHash.toLowerCase(),
          wethCodeHash: proof.wethCodeHash.toLowerCase(),
        }),
      };
    },
  }],
  identityKey: (identity) => lowerAddress(identity.subject),
} satisfies IdentitySemantics<OriginStethArmCandidate, OriginStethArmIdentity>;

function validRate(rate: bigint): boolean {
  return rate > 0n && rate <= ORIGIN_STETH_ARM_MAX_RATE;
}

function decodeProxy(
  results: readonly AdapterRequestResult[],
): OriginStethArmIdentityEvidence {
  const successful = results.map((result) => {
    if (!result.ok) {
      throw new Error(`Origin stETH ARM identity unresolved: ${result.failure}`);
    }
    return result;
  });
  const source: CanonicalSource = assertSameSource(successful);
  const proxyCodeHash = ethers.keccak256(
    requireRuntimeCode(results, "identity-proxy-code"),
  ).toLowerCase();
  const stethCodeHash = ethers.keccak256(
    requireRuntimeCode(results, "identity-steth-code"),
  ).toLowerCase();
  const wethCodeHash = ethers.keccak256(
    requireRuntimeCode(results, "identity-weth-code"),
  ).toLowerCase();
  const word = successfulResult(results, "identity-implementation-slot").data;
  if (!/^0x[0-9a-fA-F]{64}$/.test(word)) {
    throw new Error("Origin stETH ARM implementation slot is malformed");
  }
  return Object.freeze({
    phase: "proxy" as const,
    source,
    proxyCodeHash,
    implementation: canonicalAddress(`0x${word.slice(-40)}`),
    stethCodeHash,
    wethCodeHash,
  });
}

function decodeBinding(
  prior: Extract<Proof, { readonly phase: "proxy" }>,
  results: readonly AdapterRequestResult[],
): OriginStethArmIdentityEvidence {
  const implementationCodeHash = ethers.keccak256(
    requireRuntimeCode(results, "identity-implementation-code"),
  ).toLowerCase();
  const traderate0 = storageWordToUint(
    successfulResult(results, "identity-traderate0").data,
  );
  const traderate1 = storageWordToUint(
    successfulResult(results, "identity-traderate1").data,
  );
  return Object.freeze({
    ...prior,
    phase: "binding" as const,
    implementationCodeHash,
    traderate0,
    traderate1,
  });
}

function behaviorProbes(
  target: string,
  proof: Extract<Proof, { readonly phase: "binding" }>,
): readonly BehaviorProbe[] {
  const probes: BehaviorProbe[] = [];
  for (const direction of ["steth-to-weth", "weth-to-steth"] as const) {
    const rate = direction === "steth-to-weth"
      ? proof.traderate1
      : proof.traderate0;
    for (const amount of ORIGIN_STETH_ARM_BEHAVIOR_SAMPLES) {
      const tokenIn = originStethArmTokenIn(direction);
      const tokenOut = originStethArmTokenOut(direction);
      const expectedOut = originStethArmQuote(amount, rate);
      const id = `identity-swap:${direction}:${amount}`;
      probes.push(Object.freeze({
        request: Object.freeze({
          id,
          kind: "effect-delta-simulation" as const,
          preCalls: Object.freeze([Object.freeze({
            caller,
            to: canonicalAddress(tokenIn),
            data: ERC20.encodeFunctionData("approve", [
              canonicalAddress(target),
              amount,
            ]),
          })]),
          call: Object.freeze({
            caller,
            executionMode: "impersonated-call-frame" as const,
            to: canonicalAddress(target),
            data: ORIGIN_STETH_ARM_INTERFACE.encodeFunctionData(
              "swapExactTokensForTokens",
              [
                canonicalAddress(tokenIn),
                canonicalAddress(tokenOut),
                amount,
                0n,
                canonicalAddress(ORIGIN_STETH_ARM_PROBE_RECIPIENT),
              ],
            ),
          }),
          overrideIntent: Object.freeze({
            caller,
            tokenBalances: Object.freeze([Object.freeze({
              token: canonicalAddress(tokenIn),
              amount,
            })]),
          }),
          observeTokenBalances: Object.freeze([
            Object.freeze({ token: canonicalAddress(tokenIn), account: caller }),
            Object.freeze({ token: canonicalAddress(tokenIn), account: canonicalAddress(target) }),
            Object.freeze({ token: canonicalAddress(tokenOut), account: canonicalAddress(ORIGIN_STETH_ARM_PROBE_RECIPIENT) }),
            Object.freeze({ token: canonicalAddress(tokenOut), account: canonicalAddress(target) }),
          ]),
          observe: Object.freeze([
            "return-data" as const,
            "revert-data" as const,
            "token-delta" as const,
          ]),
        }),
        direction,
        amount,
        tokenIn,
        tokenOut,
        expectedOut,
      }));
    }
  }
  return probes;
}

function decodeBehavior(
  target: string,
  prior: Extract<Proof, { readonly phase: "binding" }>,
  results: readonly AdapterRequestResult[],
): OriginStethArmIdentityEvidence {
  const probes = behaviorProbes(target, prior);
  const outcomes = probes.map((probe) => ({
    probe,
    result: singleResult(results, probe.request.id),
  }));
  const behaviorValid = outcomes.every(({ probe, result }) =>
    validateBehaviorProbe(target, probe, result)
  );
  return Object.freeze({
    ...prior,
    phase: "verified" as const,
    behaviorValid,
    behaviorProofHash: hashCanonical({
      implementationCodeHash: prior.implementationCodeHash.toLowerCase(),
      target: lowerAddress(target),
      traderate0: prior.traderate0,
      traderate1: prior.traderate1,
      probes: probes.map((probe) => ({
        direction: probe.direction,
        amount: probe.amount,
        expectedOut: probe.expectedOut,
        requestId: probe.request.id,
      })),
    }),
  });
}

function singleResult(
  results: readonly AdapterRequestResult[],
  id: string,
): AdapterRequestResult {
  const matches = results.filter((result) => result.id === id);
  if (matches.length !== 1) {
    throw new Error(`Origin stETH ARM behavior evidence ${id} is missing or duplicated`);
  }
  return matches[0];
}

function validateBehaviorProbe(
  target: string,
  probe: BehaviorProbe,
  result: AdapterRequestResult,
): boolean {
  if (!result.ok || result.completion !== "returned") return false;
  const deltas = result.effects?.tokenDeltas ?? [];
  const inputIsWeth =
    probe.tokenIn.toLowerCase() === ORIGIN_STETH_ARM_WETH.toLowerCase();
  const outputIsWeth =
    probe.tokenOut.toLowerCase() === ORIGIN_STETH_ARM_WETH.toLowerCase();
  if (inputIsWeth === outputIsWeth) return false;
  const inputDeltas = deltas.filter((delta) =>
    sameAddress(delta.token, probe.tokenIn)
  );
  const payers = inputDeltas.filter((delta) => delta.delta < 0n);
  if (payers.length !== 1) return false;
  const payer = payers[0];
  if (
    sameAddress(payer.account, target) ||
    sameAddress(payer.account, ORIGIN_STETH_ARM_PROBE_RECIPIENT) ||
    sameAddress(payer.account, ethers.ZeroAddress)
  ) {
    return false;
  }
  const deliveredInput = -payer.delta;
  if (deliveredInput <= 0n) return false;
  const inputTargets = inputDeltas.filter((delta) =>
    sameAddress(delta.account, target)
  );
  if (inputTargets.length !== 1) return false;
  const targetInputCredit = inputTargets[0].delta;
  if (inputIsWeth) {
    // WETH is exact: the payer is debited the requested amount and the ARM is
    // credited the same amount.
    if (deliveredInput !== probe.amount ||
        targetInputCredit !== deliveredInput) {
      return false;
    }
  } else {
    // stETH routes transfers through shares: the payer can be debited up to
    // two wei less than requested, and the ARM's large balance can round its
    // own credit one wei below the payer's debit.
    if (deliveredInput > probe.amount || probe.amount - deliveredInput > 2n) {
      return false;
    }
    if (targetInputCredit > deliveredInput ||
        deliveredInput - targetInputCredit > 1n) {
      return false;
    }
  }
  const outputDeltas = deltas.filter((delta) =>
    sameAddress(delta.token, probe.tokenOut)
  );
  const recipients = outputDeltas.filter((delta) =>
    sameAddress(delta.account, ORIGIN_STETH_ARM_PROBE_RECIPIENT)
  );
  const targetOutputs = outputDeltas.filter((delta) =>
    sameAddress(delta.account, target)
  );
  if (
    outputDeltas.length !== 2 ||
    recipients.length !== 1 ||
    targetOutputs.length !== 1
  ) {
    return false;
  }
  const deliveredOutput = recipients[0].delta;
  const targetDebit = -targetOutputs[0].delta;
  if (deliveredOutput <= 0n || targetDebit <= 0n) return false;
  if (outputIsWeth) {
    if (deliveredOutput !== probe.expectedOut ||
        targetDebit !== deliveredOutput) {
      return false;
    }
  } else {
    // The swap call returns `expectedOut` (the protocol's own integer amount);
    // the share-based stETH transfer can move one wei less at either side.
    if (deliveredOutput > probe.expectedOut ||
        probe.expectedOut - deliveredOutput > 1n) {
      return false;
    }
    if (targetDebit > deliveredOutput ||
        deliveredOutput - targetDebit > 1n) {
      return false;
    }
  }
  return true;
}
