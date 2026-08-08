import type { DiscoverySemantics } from "../../adapter-family-plugin.js";
import { canonicalAddress, lowerAddress } from "../standard-family/common.js";
import {
  ERC4626_DEPOSIT_CALL_PATTERN_ID,
  ERC4626_DEPOSIT_LOG_PATTERN_ID,
  ERC4626_DEPOSIT_TOPIC,
  ERC4626_INTERFACE,
  ERC4626_REDEEM_CALL_PATTERN_ID,
  ERC4626_SURFACE_PATTERN_ID,
  ERC4626_WITHDRAW_LOG_PATTERN_ID,
  ERC4626_WITHDRAW_TOPIC,
} from "./abi.js";
import type { Erc4626Candidate } from "./types.js";

export const erc4626Discovery: DiscoverySemantics<Erc4626Candidate> =
  {
    sources: Object.freeze([
      "observed-call" as const,
      "landed-log" as const,
      "address-surface" as const,
    ]),
    callPatterns: Object.freeze([
      Object.freeze({
        id: ERC4626_DEPOSIT_CALL_PATTERN_ID,
        selector: ERC4626_INTERFACE.getFunction("deposit")!
          .selector as `0x${string}`,
        signature: "deposit(uint256,address)",
        candidateAddress: Object.freeze({ from: "call-target" as const }),
      }),
      Object.freeze({
        id: ERC4626_REDEEM_CALL_PATTERN_ID,
        selector: ERC4626_INTERFACE.getFunction("redeem")!
          .selector as `0x${string}`,
        signature: "redeem(uint256,address,address)",
        candidateAddress: Object.freeze({ from: "call-target" as const }),
      }),
    ]),
    logPatterns: Object.freeze([
      Object.freeze({
        id: ERC4626_DEPOSIT_LOG_PATTERN_ID,
        topic: ERC4626_DEPOSIT_TOPIC as `0x${string}`,
        signature: "Deposit(address,address,uint256,uint256)",
      }),
      Object.freeze({
        id: ERC4626_WITHDRAW_LOG_PATTERN_ID,
        topic: ERC4626_WITHDRAW_TOPIC as `0x${string}`,
        signature: "Withdraw(address,address,address,uint256,uint256)",
      }),
    ]),
    addressSurfaces: Object.freeze([Object.freeze({
      id: ERC4626_SURFACE_PATTERN_ID,
      kind: "interface" as const,
      fingerprint: "erc4626-standard-behavior-v1",
    })]),
    decodeCandidate({ observation, matchedPatternId }) {
      try {
        if (
          observation.kind === "call" &&
          (matchedPatternId === ERC4626_DEPOSIT_CALL_PATTERN_ID ||
            matchedPatternId === ERC4626_REDEEM_CALL_PATTERN_ID)
        ) {
          return Object.freeze({
            candidateKind: "erc4626-vault" as const,
            vault: canonicalAddress(observation.target),
          });
        }
        if (
          observation.kind === "log" &&
          (matchedPatternId === ERC4626_DEPOSIT_LOG_PATTERN_ID ||
            matchedPatternId === ERC4626_WITHDRAW_LOG_PATTERN_ID)
        ) {
          return Object.freeze({
            candidateKind: "erc4626-vault" as const,
            vault: canonicalAddress(observation.address),
          });
        }
        if (
          observation.kind === "address-surface" &&
          matchedPatternId === ERC4626_SURFACE_PATTERN_ID
        ) {
          return Object.freeze({
            candidateKind: "erc4626-vault" as const,
            vault: canonicalAddress(observation.address),
          });
        }
      } catch {
        return null;
      }
      return null;
    },
    candidateKey: (candidate) => lowerAddress(candidate.vault),
  };
