import { ethers } from "ethers";
import { RuntimeAmountProgram } from "../../../../adapters/runtime-amount-program.js";
import { runtimeLeg, runtimeExecutor, RUNTIME_ERC20 } from "../../runtime-execution.js";
import { METRONOME_HGUSDC_PATH } from "../../../../adapters/metronome-hgusdc.js";
import { METRONOME_HGUSDC_ROUTER_INTERFACE } from "./shared.js";
import {
  NO_EXECUTION_RUNTIME_PROJECTION,
  type ExecutionSemantics,
} from "../../adapter-family-plugin.js";
import {
  assertMetronomeHgUsdcInvocation,
} from "./shared.js";
import { sameAddress } from "../standard-family/common.js";
import type {
  MetronomeHgUsdcDescriptor,
  MetronomeHgUsdcExactEvidence,
  MetronomeHgUsdcRoute,
} from "./types.js";

export const metronomeHgUsdcExecution = {
  buildRuntimeLeg(input) {
    const { descriptor: d, route: r, executor } = input;
    assertMetronomeHgUsdcInvocation(d, r); runtimeExecutor(executor, d.router, d.curve, d.vault);
    const data = METRONOME_HGUSDC_ROUTER_INTERFACE.encodeFunctionData("executePath", [METRONOME_HGUSDC_PATH, [0n], ethers.ZeroAddress]);
    // ABI offsets are encoded in the head; patch the first amounts[] value, not path bytes.
    const amountOffset = 4 + Number(BigInt(ethers.dataSlice(data, 36, 68))) + 32;
    const p = new RuntimeAmountProgram()
      .call(r.tokenIn, RUNTIME_ERC20.encodeFunctionData("transfer", [d.curve, 0n]), { patches: [{ offset: 36, reg: 0 }] })
      .call(d.router, data, { patches: [{ offset: amountOffset, reg: 0 }] });
    return runtimeLeg(r.adapterId, p);
  },
  runtimeProjection: () => NO_EXECUTION_RUNTIME_PROJECTION,
  buildFragment(input) {
    assertMetronomeHgUsdcInvocation(input.descriptor, input.route);
    const evidence = input.exactEvidence;
    if (
      input.amountIn <= 0n ||
      input.quotedAmountOut <= 0n ||
      evidence.kind !== "metronome-hgusdc-dependent-quote" ||
      evidence.amountIn !== input.amountIn ||
      evidence.amountOut !== input.quotedAmountOut ||
      evidence.curveOut <= 0n ||
      !sameAddress(evidence.router, input.descriptor.router) ||
      !sameAddress(evidence.curve, input.descriptor.curve) ||
      !sameAddress(evidence.vault, input.descriptor.vault) ||
      evidence.pathHash !== input.descriptor.pathHash ||
      evidence.bindingFingerprint !== input.route.bindingRef.fingerprint
    ) {
      throw new Error(
        "Metronome hgUSDC execution received incompatible exact evidence",
      );
    }
    return Object.freeze({
      requirements: Object.freeze([Object.freeze({
        kind: "transfer-to-pool" as const,
        token: input.descriptor.tokenIn,
        pool: input.descriptor.curve,
        amount: input.amountIn,
      })]),
      nodes: Object.freeze([Object.freeze({
        adapterId: input.route.adapterId,
        target: input.descriptor.router,
        tokenIn: input.descriptor.tokenIn,
        tokenOut: input.descriptor.tokenOut,
        amount: input.amountIn,
        params: {},
        children: [],
      })]),
    });
  },
  expectedEffects: ({ route }) => Object.freeze([
    Object.freeze({
      kind: "token-delta" as const,
      token: route.tokenIn,
      account: "executor" as const,
      direction: "decrease" as const,
    }),
    Object.freeze({
      kind: "token-delta" as const,
      token: route.tokenOut,
      account: "executor" as const,
      direction: "increase" as const,
    }),
  ]),
} satisfies ExecutionSemantics<
  MetronomeHgUsdcDescriptor,
  MetronomeHgUsdcRoute,
  MetronomeHgUsdcExactEvidence
>;
