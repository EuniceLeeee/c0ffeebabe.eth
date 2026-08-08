import type { ExecutionSemantics } from "../../adapter-family-plugin.js";
import {
  poolKeyFingerprint,
  sameAddress,
} from "./codec.js";
import { requireAngstromRuntimeEvidence } from "./evidence.js";
import type {
  AngstromV4Descriptor,
  AngstromV4ExactEvidence,
  AngstromV4Route,
} from "./types.js";

const UINT128_MAX = (1n << 128n) - 1n;
const UINT256_MAX = (1n << 256n) - 1n;

export const angstromV4Execution = {
  buildFragment(input) {
    const runtime = requireAngstromRuntimeEvidence({
      descriptor: input.descriptor,
      source: input.exactEvidence.source,
      runtimeEvidence: input.runtimeEvidence,
    });
    assertExecutionEvidence(input, runtime);
    if (
      input.amountIn <= 0n || input.amountIn > UINT128_MAX ||
      input.quotedAmountOut <= 0n || input.quotedAmountOut > UINT128_MAX
    ) {
      throw new Error("angstrom-v4 execution amounts must fit positive uint128");
    }
    const key = input.descriptor.poolKey;
    return Object.freeze({
      requirements: Object.freeze([Object.freeze({
        kind: "approve" as const,
        token: input.route.tokenIn,
        spender: input.descriptor.immutableBinding.adapter,
        amount: UINT256_MAX,
      })]),
      nodes: Object.freeze([Object.freeze({
        adapterId: "angstrom-v4-swap",
        target: input.descriptor.immutableBinding.adapter,
        tokenIn: input.route.tokenIn,
        tokenOut: input.route.tokenOut,
        amount: input.amountIn,
        params: {
          currency0: key.currency0,
          currency1: key.currency1,
          fee: BigInt(key.fee),
          tickSpacing: BigInt(key.tickSpacing),
          hooks: key.hooks,
          zeroForOne: input.route.direction === "zero-for-one",
          amountSpecified: input.amountIn,
          minAmountOut: input.minAmountOut,
          attestationBlockNumbers: runtime.attestations.map(
            (item) => item.blockNumber,
          ),
          attestationUnlockData: runtime.attestations.map(
            (item) => item.unlockData,
          ),
          recipient: input.executor,
          deadline: UINT256_MAX,
        },
        children: [],
      })]),
    });
  },
  expectedEffects: ({ route }) => [
    {
      kind: "token-delta" as const,
      token: route.tokenIn,
      account: "executor" as const,
      direction: "decrease" as const,
    },
    {
      kind: "token-delta" as const,
      token: route.tokenOut,
      account: "executor" as const,
      direction: "increase" as const,
    },
  ],
} satisfies ExecutionSemantics<
  AngstromV4Descriptor,
  AngstromV4Route,
  AngstromV4ExactEvidence
>;

function assertExecutionEvidence(
  input: {
    readonly descriptor: AngstromV4Descriptor;
    readonly route: AngstromV4Route;
    readonly amountIn: bigint;
    readonly quotedAmountOut: bigint;
    readonly exactEvidence: AngstromV4ExactEvidence;
  },
  runtime: ReturnType<typeof requireAngstromRuntimeEvidence>,
): void {
  const evidence = input.exactEvidence;
  if (
    evidence.kind !== "angstrom-v4-tx-bound-quoter" ||
    evidence.poolId !== input.descriptor.poolId ||
    evidence.poolKeyFingerprint !== poolKeyFingerprint(input.descriptor.poolKey) ||
    !sameAddress(evidence.quoter, input.descriptor.immutableBinding.quoter) ||
    evidence.txHash.toLowerCase() !== runtime.runtime.txHash!.toLowerCase() ||
    evidence.runtimeEvidenceHash !== runtime.runtime.evidenceHash ||
    evidence.payloadHash.toLowerCase() !== runtime.payloadHash.toLowerCase() ||
    evidence.attestationEvidenceHashes.length !== runtime.attestations.length ||
    evidence.attestationEvidenceHashes.some(
      (hash, index) => hash !== runtime.attestations[index].evidenceHash
    ) ||
    !sameAddress(evidence.tokenIn, input.route.tokenIn) ||
    !sameAddress(evidence.tokenOut, input.route.tokenOut) ||
    evidence.amountIn !== input.amountIn ||
    evidence.amountOut !== input.quotedAmountOut
  ) {
    throw new Error(
      "angstrom-v4 execution received incompatible exact/runtime evidence",
    );
  }
}
