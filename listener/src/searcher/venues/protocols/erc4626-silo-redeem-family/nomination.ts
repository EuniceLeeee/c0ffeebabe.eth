import { ethers } from "ethers";
import type {
  CaptureNominationInput,
  CaptureNominationProvider,
  UnifiedObservation,
} from "../../adapter-family-plugin.js";
import type { CanonicalSource } from "../../adapter-request-program.js";
import { ERC4626_SILO_INTERFACE } from "./shared.js";
import { canonicalAddress, lowerAddress } from "../standard-family/common.js";

const EIP1967_IMPLEMENTATION_SLOT =
  "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";

/**
 * Plugin-owned nomination for the silo-redeem Family. Graph/cache pool entries
 * are opaque nominations. The capability reads the vault's real code hash +
 * EIP-1967 word and its real `asset()` at the source block, and re-materializes
 * one address-surface observation. When the cache candidate carries a real
 * behavior-probe result (erc4626-silo-payout-candidate with sampleShares /
 * sampleAssets from an actual on-chain previewRedeem), those values ride in the
 * plugin-owned opaque payload so decodeCandidate can build a complete candidate;
 * the identity stage still re-verifies behavior at the source block before
 * admission. Nothing is fabricated: probe values without a cache-backed
 * evidence record are rejected.
 */
export async function nominateErc4626SiloRedeem(input: {
  readonly nominations: readonly CaptureNominationInput[];
  readonly source: CanonicalSource;
  readonly provider: CaptureNominationProvider;
}): Promise<readonly UnifiedObservation[]> {
  const results: UnifiedObservation[] = [];
  for (const nomination of input.nominations) {
    const opaque = nomination.opaque as Readonly<Record<string, unknown>>;
    if (!isSiloOpaqueLabel(opaque)) continue;
    const vault = lowerAddress(nomination.address);
    try {
      const [code, implementationWord, assetWord] = await Promise.all([
        input.provider.getCode(vault, input.source.number),
        input.provider.getStorage(
          vault,
          EIP1967_IMPLEMENTATION_SLOT,
          input.source.number,
        ),
        input.provider.call(
          {
            to: vault,
            data: ERC4626_SILO_INTERFACE.encodeFunctionData("asset"),
          },
          input.source.number,
        ),
      ]);
      if (!ethers.isHexString(code) || code === "0x") continue;
      if (
        !ethers.isHexString(assetWord) || ethers.dataLength(assetWord) !== 32
      ) continue;
      const asset = canonicalAddress(String(
        ERC4626_SILO_INTERFACE.decodeFunctionResult("asset", assetWord)[0],
      )).toLowerCase();
      if (asset === ethers.ZeroAddress || asset === vault) continue;
      // A behavior-probe sample is only admissible when the cache carries a
      // real previewRedeem result for this vault; never synthesized here.
      const probe = probeEvidence(opaque, asset);
      if (probe === null) continue;
      results.push(Object.freeze({
        kind: "address-surface" as const,
        source: input.source,
        address: vault,
        codeHash: ethers.keccak256(code).toLowerCase(),
        implementationWord: ethers.zeroPadValue(implementationWord, 32)
          .toLowerCase(),
        interfaceFingerprints: Object.freeze(["erc4626-silo-redeem:vault-surface-v1"]),
        opaque: Object.freeze({
          payoutToken: asset,
          sampleShares: probe.sampleShares.toString(),
          sampleAssets: probe.sampleAssets.toString(),
          evidenceKind: "erc4626-silo-payout-candidate",
        }),
      } as never));
    } catch {
      // One unreadable nomination must not block the next one.
    }
  }
  return Object.freeze(results);
}

function probeEvidence(
  opaque: Readonly<Record<string, unknown>>,
  asset: string,
): { readonly sampleShares: bigint; readonly sampleAssets: bigint } | null {
  // The verified_candidates evidence list rides inside the opaque pool record.
  const evidence = opaque.evidence ?? opaque.candidateEvidence;
  const records = Array.isArray(evidence)
    ? evidence
    : (opaque.candidate as Readonly<Record<string, unknown>> | undefined)
      ?.evidence;
  if (!Array.isArray(records)) return null;
  for (const record of records) {
    if (record === null || typeof record !== "object") continue;
    const entry = record as Readonly<Record<string, unknown>>;
    if (
      entry.kind !== "erc4626-silo-payout-candidate" &&
      entry.kind !== "silo-payout-candidate"
    ) continue;
    const underlying = entry.underlyingAsset;
    if (typeof underlying !== "string" ||
        underlying.toLowerCase() !== asset) continue;
    const shares = sampleBigint(entry.sampleShares);
    const assets = sampleBigint(entry.sampleAssets);
    if (shares === null || assets === null || shares <= 0n || assets <= 0n) {
      continue;
    }
    return { sampleShares: shares, sampleAssets: assets };
  }
  return null;
}

function sampleBigint(value: unknown): bigint | null {
  if (typeof value === "string" && /^[0-9]+$/.test(value)) return BigInt(value);
  if (value !== null && typeof value === "object") {
    const record = value as Readonly<Record<string, unknown>>;
    const marker = record.__mev_protocol_bigint__;
    if (typeof marker === "string" && /^[0-9]+$/.test(marker)) {
      return BigInt(marker);
    }
  }
  return null;
}

function isSiloOpaqueLabel(
  opaque: Readonly<Record<string, unknown>>,
): boolean {
  const label = opaque.adapter ?? opaque.adapterId ?? opaque.venueId;
  return typeof label === "string" &&
    (label === "erc4626-silo-redeem" ||
      label === "protocol:erc4626-silo-redeem");
}
