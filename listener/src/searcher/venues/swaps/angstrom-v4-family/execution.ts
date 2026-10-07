import { ethers } from "ethers";
import { RuntimeAmountProgram } from "../../../../adapters/runtime-amount-program.js";
import { runtimeLeg, runtimeExecutor, assertProjectedRuntimeRoute } from "../../runtime-execution.js";
import { ANGSTROM_ADAPTER_SWAP_ABI } from "../angstrom-attestation.js";
import { angstromV4Routes } from "./routes.js";
import type { ExecutionSemantics } from "../../adapter-family-plugin.js";
import { ANGSTROM_MAINNET_ADAPTER } from "../angstrom-attestation.js";
import {
  poolKeyFingerprint,
  sameAddress,
} from "./codec.js";
import { requireAngstromRuntimeEvidence } from "./evidence.js";
import { hashCanonical } from "../../canonical-value.js";
import { angstromV4StaticBindingProjection } from "./binding.js";
import type {
  AngstromV4Descriptor,
  AngstromV4ExactEvidence,
  AngstromV4Route,
} from "./types.js";

const UINT128_MAX = (1n << 128n) - 1n;
const UINT256_MAX = (1n << 256n) - 1n;

export const angstromV4Execution = {
  buildRuntimeLeg(input) {
    const { descriptor: d, route: r, executor } = input;
    assertProjectedRuntimeRoute(r, angstromV4Routes.project({ descriptor: d })); runtimeExecutor(executor, d.immutableBinding.adapter);
    if (!input.source) throw new Error("angstrom-v4 runtime requires canonical source");
    const runtime = input.runtimeEvidence.length ? requireAngstromRuntimeEvidence({
      descriptor: d, source: input.source, runtimeEvidence: input.runtimeEvidence,
    }) : undefined;
    const entries = runtime ? runtime.attestations.map(a => ({ blockNumber: a.blockNumber, unlockData: a.unlockData }))
      : [{ blockNumber: BigInt(input.source.number), unlockData: "0x" }];
    const p = new RuntimeAmountProgram().constant(1, 128n).math("shr", 2, 0, 1).constant(3, 0n).equal(2, 3)
      .allowance(r.tokenIn, d.immutableBinding.adapter, 0, UINT256_MAX)
      .call(d.immutableBinding.adapter, new ethers.Interface(ANGSTROM_ADAPTER_SWAP_ABI).encodeFunctionData("swap",
        [d.poolKey, r.direction === "zero-for-one", 0n, 1n, entries, executor, UINT256_MAX]),
        { patches: [{ offset: 196, reg: 0 }] });
    return runtimeLeg("angstrom-v4-swap", p);
  },
  runtimeProjection: () => Object.freeze({
    allowanceSpender: ANGSTROM_MAINNET_ADAPTER,
    prewarmQuoteCalls: Object.freeze([]),
  }),
  buildFragment(input) {
    const runtime = input.exactEvidence.kind === "angstrom-v4-tx-bound-quoter"
      ? requireAngstromRuntimeEvidence({
        descriptor: input.descriptor,
        source: input.exactEvidence.source,
        runtimeEvidence: input.runtimeEvidence,
      }) : undefined;
    if (runtime === undefined &&
        (!Array.isArray(input.runtimeEvidence) || input.runtimeEvidence.length !== 0)) {
      throw new Error("angstrom-v4 source-unlocked execution requires empty runtime evidence");
    }
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
          ...(runtime === undefined ? {
            unlockMode: "source-unlocked",
            // The adapter selects the entry matching block.number. B+1 must
            // fail its real lock checks; never relabel this quote's source.
            sourceBlock: BigInt(input.exactEvidence.source.number),
          } : {
            attestationBlockNumbers: runtime.attestations.map(
              (item) => item.blockNumber,
            ),
            attestationUnlockData: runtime.attestations.map(
              (item) => item.unlockData,
            ),
          }),
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
    readonly executor: string;
  },
  runtime: ReturnType<typeof requireAngstromRuntimeEvidence> | undefined,
): void {
  const evidence = input.exactEvidence;
  if (
    evidence.poolId !== input.descriptor.poolId ||
    evidence.poolKeyFingerprint !== poolKeyFingerprint(input.descriptor.poolKey) ||
    !sameAddress(evidence.quoter, input.descriptor.immutableBinding.quoter) ||
    !sameAddress(evidence.tokenIn, input.route.tokenIn) ||
    !sameAddress(evidence.tokenOut, input.route.tokenOut) ||
    evidence.amountIn !== input.amountIn ||
    evidence.amountOut !== input.quotedAmountOut
  ) {
    throw new Error(
      "angstrom-v4 execution received incompatible exact/runtime evidence",
    );
  }
  if (evidence.kind === "angstrom-v4-source-unlocked-quoter" && runtime === undefined &&
      evidence.bindingFingerprint === hashCanonical(angstromV4StaticBindingProjection(input.descriptor)) &&
      sameAddress(evidence.executor, input.executor)) return;
  if (evidence.kind === "angstrom-v4-tx-bound-quoter" && runtime !== undefined &&
      evidence.txHash.toLowerCase() === runtime.runtime.txHash!.toLowerCase() &&
      evidence.runtimeEvidenceHash === runtime.runtime.evidenceHash &&
      evidence.payloadHash.toLowerCase() === runtime.payloadHash.toLowerCase() &&
      evidence.attestationEvidenceHashes.length === runtime.attestations.length &&
      evidence.attestationEvidenceHashes.every((hash, index) => hash === runtime.attestations[index].evidenceHash)) return;
  // In particular, local-zero evidence is never an executable unlock proof.
  throw new Error("angstrom-v4 execution received incompatible exact/runtime evidence");
}
