import { ethers } from "ethers";
import { ADDR } from "../../../../shared/constants/addresses.js";
import type { UnifiedObservation } from "../../adapter-family-plugin.js";
import {
  lowerAddress,
  sameAddress,
} from "../standard-family/common.js";
import {
  METRONOME_SYNTH_FORWARDER_INTERFACE,
  METRONOME_SYNTH_ORACLE_BINDING,
  METRONOME_SYNTH_SAMPLE,
} from "./shared.js";

export const metronomeSynthOracleVictim = {
  canonicalIntakeTargets: [ADDR.METRONOME_ORACLE_FORWARDER],
  callPatterns: [{
    id: "metronome-oracle-forward",
    selector: METRONOME_SYNTH_FORWARDER_INTERFACE.getFunction("forward")!
      .selector as `0x${string}`,
    signature: "forward(address,bytes)",
    candidateAddress: { from: "call-target" as const },
    argumentProjection: [
      { index: 0, type: "address", name: "oracle" },
      { index: 1, type: "bytes", name: "payload" },
    ],
  }],
  runtimeDetection: {
    id: "metronome-eth-usd",
    affectedEdges: [{
      adapterId: "metronome-synth-swap",
      target: ADDR.METRONOME_SYNTH_POOL,
    }],
    priceProbe: {
      signature:
        "quoteSwapOut(address syntheticTokenIn, address syntheticTokenOut, uint256 amountIn) " +
        "view returns (uint256 amountOut, uint256 fee)",
      functionName: "quoteSwapOut",
      amountIn: METRONOME_SYNTH_SAMPLE,
      outputIndex: 0,
    },
    maxSearchHops: 8,
  },
  decode({ observation }: { readonly observation: UnifiedObservation }) {
    if (
      observation.kind !== "call" ||
      !sameAddress(observation.target, ADDR.METRONOME_ORACLE_FORWARDER)
    ) return null;
    try {
      const decoded = METRONOME_SYNTH_FORWARDER_INTERFACE.decodeFunctionData(
        "forward",
        observation.data,
      );
      const oracle = ethers.getAddress(String(decoded[0]));
      const payload = String(decoded[1]).toLowerCase();
      if (
        !sameAddress(oracle, ADDR.METRONOME_ORACLE) ||
        !payload.startsWith("0xb1dc65a4")
      ) return null;
      return {
        forwarder: lowerAddress(observation.target),
        oracle: lowerAddress(oracle),
        selector: payload.slice(0, 10),
        payloadHash: ethers.keccak256(payload),
        oracleBinding: METRONOME_SYNTH_ORACLE_BINDING,
      };
    } catch {
      return null;
    }
  },
};
