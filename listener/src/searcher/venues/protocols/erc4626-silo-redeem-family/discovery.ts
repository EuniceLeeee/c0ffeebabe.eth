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

/**
 * Silo vaults emit the standard ERC4626 Withdraw event on redeem/withdraw.
 * Candidate provenance for the observed lane; admission still requires the
 * payout surface and an active state-override delta proof.
 */
const ERC4626_WITHDRAW_EVENT_TOPIC =
  "0xfbde797d201c681b91056529119e0b02407c7bb96a4a2c75c01fc9667232c8db";

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
  logPatterns: [{
    id: "silo-redeem-withdraw-log",
    topic: ERC4626_WITHDRAW_EVENT_TOPIC as `0x${string}`,
    signature: "Withdraw(address,address,address,uint256,uint256)",
  }],
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
      try {
        if (observation.opaque === null || typeof observation.opaque !== "object" ||
            Array.isArray(observation.opaque)) return null;
        const opaque = observation.opaque as Readonly<Record<string, unknown>>;
        const payoutToken = typeof opaque.payoutToken === "string"
          ? canonicalAddress(opaque.payoutToken)
          : null;
        if (payoutToken === null || payoutToken === ethers.ZeroAddress ||
            sameAddress(observation.address, payoutToken)) return null;

        // The production durable decoder restores this Family's observed-call
        // candidate, not a legacy behavior sample. Preserve its mode/units and
        // original provenance; current previews and active proof still belong
        // exclusively to identity. A malformed typed record cannot downgrade
        // to the legacy sample path, even when sample fields are also present.
        if ("candidateKind" in opaque || "vault" in opaque ||
            "observedMode" in opaque || "observedAmount" in opaque) {
          if (opaque.candidateKind !== "erc4626-silo-payout" ||
              typeof opaque.vault !== "string" ||
              (opaque.observedMode !== "redeem" && opaque.observedMode !== "withdraw") ||
              typeof opaque.observedAmount !== "bigint" ||
              opaque.observedAmount <= 0n || opaque.observedAmount >= (1n << 256n)) return null;
          const vault = canonicalAddress(opaque.vault);
          if (vault === ethers.ZeroAddress || !sameAddress(vault, observation.address)) return null;
          const { transactionHash, blockNumber, blockHash } = opaque;
          if ((transactionHash !== undefined && transactionHash !== null &&
                (typeof transactionHash !== "string" || !ethers.isHexString(transactionHash, 32))) ||
              (blockNumber !== undefined && (typeof blockNumber !== "number" ||
                !Number.isSafeInteger(blockNumber) || blockNumber < 0)) ||
              (blockHash !== undefined &&
                (typeof blockHash !== "string" || !ethers.isHexString(blockHash, 32)))) return null;
          return Object.freeze({
            candidateKind: "erc4626-silo-payout" as const,
            vault,
            payoutToken,
            observedMode: opaque.observedMode,
            observedAmount: opaque.observedAmount,
            ...(transactionHash === undefined ? {} : { transactionHash }),
            ...(blockNumber === undefined ? {} : { blockNumber }),
            ...(blockHash === undefined ? {} : { blockHash }),
          });
        }

        const shares = typeof opaque.sampleShares === "string"
          ? BigInt(opaque.sampleShares) : null;
        const assets = typeof opaque.sampleAssets === "string"
          ? BigInt(opaque.sampleAssets) : null;
        if (shares === null || assets === null || shares <= 0n || assets <= 0n) return null;
        return Object.freeze({
          candidateKind: "erc4626-silo-payout" as const,
          vault: canonicalAddress(observation.address),
          payoutToken,
          observedMode: "redeem" as const,
          observedAmount: shares,
        });
      } catch {
        return null;
      }
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
