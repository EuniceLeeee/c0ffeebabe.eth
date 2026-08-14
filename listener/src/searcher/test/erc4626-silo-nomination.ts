import assert from "node:assert/strict";
import { ethers } from "ethers";
import { nominateErc4626SiloRedeem } from
  "../venues/protocols/erc4626-silo-redeem-family/nomination.js";
import type {
  CaptureNominationProvider,
  UnifiedObservation,
} from "../venues/adapter-family-plugin.js";
import type { CanonicalSource } from
  "../venues/adapter-request-program.js";
import { ERC4626_SILO_INTERFACE } from
  "../venues/protocols/erc4626-silo-redeem-family/shared.js";

const SOURCE: CanonicalSource = Object.freeze({
  number: 25_750_000,
  hash: `0x${"a1".repeat(32)}`,
  generation: 1,
});
const VAULT = `0x${"a2".repeat(20)}`;
const ASSET = `0x${"b1".repeat(20)}`;

function mockProvider(options: {
  readonly reads?: Readonly<Record<string, string>>;
}): CaptureNominationProvider {
  const reads = options.reads ?? {};
  return {
    call: async (transaction) => {
      const selector = transaction.data.slice(0, 10).toLowerCase();
      const fn = ERC4626_SILO_INTERFACE.getFunction(
        ERC4626_SILO_INTERFACE.getFunctionName(selector),
      )!;
      const value = reads[fn.name];
      if (value === undefined) throw new Error(`unexpected read ${fn.name}`);
      return ethers.AbiCoder.defaultAbiCoder().encode(["address"], [value]);
    },
    getCode: async () => "0x60806040",
    getStorage: async () => `0x${"00".repeat(32)}`,
    getLogs: async () => Object.freeze([]),
  };
}

function evidenceRecord() {
  return Object.freeze({
    kind: "erc4626-silo-payout-candidate",
    underlyingAsset: ASSET,
    payoutTokens: Object.freeze([ASSET]),
    sampleShares: { __mev_protocol_bigint__: "1000000000000000000" },
    sampleAssets: { __mev_protocol_bigint__: "950000000000000000" },
    codeHash: "0x1234",
    implementationWord: `0x${"00".repeat(32)}`,
    source: "address-behavior",
  });
}

async function main(): Promise<void> {
  // Positive: cache behavior-probe evidence rides in the opaque payload while
  // the vault code hash + asset are re-read at the source block.
  const positive = await nominateErc4626SiloRedeem({
    nominations: Object.freeze([Object.freeze({
      address: VAULT,
      opaque: Object.freeze({
        adapterId: "protocol:erc4626-silo-redeem",
        evidence: Object.freeze([evidenceRecord()]),
      }),
    })]),
    source: SOURCE,
    provider: mockProvider({ reads: { asset: ASSET } }),
  });
  assert.equal(positive.length, 1);
  const observation = positive[0] as Extract<
    UnifiedObservation,
    { readonly kind: "address-surface" }
  >;
  assert.equal(observation.kind, "address-surface");
  assert.equal(observation.address, VAULT.toLowerCase());
  const opaque = observation.opaque as Readonly<Record<string, unknown>>;
  assert.equal(opaque.payoutToken, ASSET.toLowerCase());
  assert.equal(opaque.sampleShares, "1000000000000000000");
  assert.equal(opaque.sampleAssets, "950000000000000000");

  // Cache probe without a matching underlying asset is rejected (no
  // fabrication of behavior evidence).
  const wrongAsset = await nominateErc4626SiloRedeem({
    nominations: Object.freeze([Object.freeze({
      address: VAULT,
      opaque: Object.freeze({
        adapterId: "protocol:erc4626-silo-redeem",
        evidence: Object.freeze([Object.freeze({
          ...evidenceRecord(),
          underlyingAsset: `0x${"c1".repeat(20)}`,
        })]),
      }),
    })]),
    source: SOURCE,
    provider: mockProvider({ reads: { asset: ASSET } }),
  });
  assert.equal(wrongAsset.length, 0);

  // No cache evidence at all is rejected (cache is nomination-only).
  const noEvidence = await nominateErc4626SiloRedeem({
    nominations: Object.freeze([Object.freeze({
      address: VAULT,
      opaque: Object.freeze({ adapterId: "protocol:erc4626-silo-redeem" }),
    })]),
    source: SOURCE,
    provider: mockProvider({ reads: { asset: ASSET } }),
  });
  assert.equal(noEvidence.length, 0);

  // Chain asset() differs from cache underlying -> rejected (identity
  // re-verification boundary pinned by the plugin).
  const chainDiffers = await nominateErc4626SiloRedeem({
    nominations: Object.freeze([Object.freeze({
      address: VAULT,
      opaque: Object.freeze({
        adapterId: "protocol:erc4626-silo-redeem",
        evidence: Object.freeze([evidenceRecord()]),
      }),
    })]),
    source: SOURCE,
    provider: mockProvider({
      reads: { asset: `0x${"c2".repeat(20)}` },
    }),
  });
  assert.equal(chainDiffers.length, 0);

  // Zero/negative probe samples are rejected.
  const zeroProbe = await nominateErc4626SiloRedeem({
    nominations: Object.freeze([Object.freeze({
      address: VAULT,
      opaque: Object.freeze({
        adapterId: "protocol:erc4626-silo-redeem",
        evidence: Object.freeze([Object.freeze({
          ...evidenceRecord(),
          sampleShares: { __mev_protocol_bigint__: "0" },
          sampleAssets: { __mev_protocol_bigint__: "0" },
        })]),
      }),
    })]),
    source: SOURCE,
    provider: mockProvider({ reads: { asset: ASSET } }),
  });
  assert.equal(zeroProbe.length, 0);

  console.log("erc4626-silo nomination PASS");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
