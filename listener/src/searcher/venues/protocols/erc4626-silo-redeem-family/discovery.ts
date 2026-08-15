import { ethers } from "ethers";
import type { DiscoverySemantics } from "../../adapter-family-plugin.js";
import { explicitReverseBindingUnsupported } from
  "../../adapter-family-plugin.js";
import {
  canonicalAddress,
  lowerAddress,
  sameAddress,
} from "../standard-family/common.js";
import { ERC4626_SILO_INTERFACE } from "./shared.js";
import type { Erc4626SiloRedeemCandidate } from "./types.js";
import { nominateErc4626SiloRedeem } from "./nomination.js";

const REDEEM_PATTERN_ID = "silo-redeem-call";
const WITHDRAW_PATTERN_ID = "silo-withdraw-call";

export const erc4626SiloRedeemDiscovery = {
  evidenceChannel: "nominate" as const,
  sources: ["observed-call", "address-surface"],
  candidateSources: ["dex-token-domain", "observed-interaction"],
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
  addressSurfaces: [{
    id: "silo-redeem-vault-surface",
    kind: "interface" as const,
    fingerprint: "erc4626-silo-redeem:vault-surface-v1",
  }],
  decodeCandidate({ observation, matchedPatternId }) {
    if (
      observation.kind === "address-surface" &&
      matchedPatternId === "silo-redeem-vault-surface"
    ) {
      const opaque = observation.opaque as
        Readonly<Record<string, unknown>> | undefined;
      const payoutToken = typeof opaque?.payoutToken === "string"
        ? canonicalAddress(String(opaque.payoutToken))
        : null;
      const shares = typeof opaque?.sampleShares === "string"
        ? BigInt(opaque.sampleShares)
        : null;
      const assets = typeof opaque?.sampleAssets === "string"
        ? BigInt(opaque.sampleAssets)
        : null;
      if (
        payoutToken === null || shares === null || assets === null ||
        shares <= 0n || assets <= 0n ||
        sameAddress(observation.address, payoutToken) ||
        payoutToken === ethers.ZeroAddress
      ) return null;
      return Object.freeze({
        candidateKind: "erc4626-silo-payout" as const,
        vault: canonicalAddress(observation.address),
        payoutToken,
        observedMode: "redeem" as const,
        observedAmount: shares,
      });
    }
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
  nominate: { nominate: nominateErc4626SiloRedeem },
  reverseBinding: explicitReverseBindingUnsupported(
    "no reverse-binding registry declared (explicit unsupported)",
  ),
} satisfies DiscoverySemantics<Erc4626SiloRedeemCandidate>;
