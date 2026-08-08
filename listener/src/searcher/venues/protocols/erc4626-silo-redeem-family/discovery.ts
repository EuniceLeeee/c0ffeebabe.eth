import { ethers } from "ethers";
import type { DiscoverySemantics } from "../../adapter-family-plugin.js";
import {
  canonicalAddress,
  lowerAddress,
  sameAddress,
} from "../standard-family/common.js";
import { ERC4626_SILO_INTERFACE } from "./shared.js";
import type { Erc4626SiloRedeemCandidate } from "./types.js";

const REDEEM_PATTERN_ID = "silo-redeem-call";
const WITHDRAW_PATTERN_ID = "silo-withdraw-call";

export const erc4626SiloRedeemDiscovery = {
  sources: ["observed-call"],
  callPatterns: [
    {
      id: REDEEM_PATTERN_ID,
      selector: ERC4626_SILO_INTERFACE.getFunction("redeem")!
        .selector as `0x${string}`,
      signature: "redeem(address,uint256,address,address)",
      candidateAddress: { from: "call-target" },
      argumentProjection: [
        { index: 0, type: "address", name: "payoutToken" },
        { index: 1, type: "uint256", name: "shares" },
      ],
    },
    {
      id: WITHDRAW_PATTERN_ID,
      selector: ERC4626_SILO_INTERFACE.getFunction("withdraw")!
        .selector as `0x${string}`,
      signature: "withdraw(address,uint256,address,address)",
      candidateAddress: { from: "call-target" },
      argumentProjection: [
        { index: 0, type: "address", name: "payoutToken" },
        { index: 1, type: "uint256", name: "assets" },
      ],
    },
  ],
  decodeCandidate({ observation, matchedPatternId }) {
    if (observation.kind !== "call") return null;
    const mode = matchedPatternId === REDEEM_PATTERN_ID
      ? "redeem" as const
      : matchedPatternId === WITHDRAW_PATTERN_ID
        ? "withdraw" as const
        : null;
    if (mode === null) return null;
    try {
      const decoded = ERC4626_SILO_INTERFACE.decodeFunctionData(
        mode,
        observation.data,
      );
      const vault = canonicalAddress(observation.target);
      const payoutToken = canonicalAddress(String(decoded[0]));
      const observedAmount = BigInt(decoded[1]);
      if (
        observedAmount <= 0n ||
        sameAddress(vault, payoutToken) ||
        payoutToken === ethers.ZeroAddress
      ) return null;
      return Object.freeze({
        candidateKind: "erc4626-silo-payout" as const,
        vault,
        payoutToken,
        observedMode: mode,
        observedAmount,
      });
    } catch {
      return null;
    }
  },
  candidateKey: (candidate) =>
    `${lowerAddress(candidate.vault)}:${lowerAddress(candidate.payoutToken)}`,
} satisfies DiscoverySemantics<Erc4626SiloRedeemCandidate>;
