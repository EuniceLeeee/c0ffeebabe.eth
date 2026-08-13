import assert from "node:assert/strict";
import {
  captureErc4626SiloOnchainCase,
  ERC4626_SILO_FIXTURE_PAYOUT,
  ERC4626_SILO_FIXTURE_UNDERLYING,
  ERC4626_SILO_FIXTURE_VAULT,
  erc4626SiloFixtureRuntime,
  type OnchainUniv2Provider,
} from "../architecture-migration-fixture-replay.js";
import { ERC4626_SILO_INTERFACE } from
  "../venues/protocols/erc4626-silo-redeem-family/shared.js";
import { ERC4626_SILO_REDEEM_FAMILY_ID } from
  "../venues/protocols/erc4626-silo-redeem-family/manifest.js";
import type { CanonicalSource } from
  "../venues/adapter-request-program.js";

const SOURCE: CanonicalSource = Object.freeze({
  number: 20_000_000,
  hash: `0x${"c1".repeat(32)}`,
  generation: 1,
});
const VAULT = ERC4626_SILO_FIXTURE_VAULT.toLowerCase();
const PAYOUT = ERC4626_SILO_FIXTURE_PAYOUT.toLowerCase();

function provider(input: {
  readonly vaultAsset?: string;
  readonly payoutAsset?: string;
  readonly fail?: boolean;
} = {}): OnchainUniv2Provider {
  return {
    async call(tx) {
      if (input.fail === true) throw new Error("rpc down");
      const asset = tx.to === VAULT
        ? input.vaultAsset ?? ERC4626_SILO_FIXTURE_UNDERLYING
        : input.payoutAsset ?? ERC4626_SILO_FIXTURE_UNDERLYING;
      return ERC4626_SILO_INTERFACE.encodeFunctionResult("asset", [asset]);
    },
  };
}

async function main(): Promise<void> {
  const capture = await captureErc4626SiloOnchainCase({
    source: SOURCE,
    provider: provider(),
    vault: VAULT,
    payout: PAYOUT,
    underlying: ERC4626_SILO_FIXTURE_UNDERLYING,
    runtime: erc4626SiloFixtureRuntime(),
  });
  assert.equal(capture.familyId, ERC4626_SILO_REDEEM_FAMILY_ID);
  for (const stage of Object.values(capture.stages)) {
    if (stage === undefined) continue;
    assert(
      stage.evidenceRefs.every((ref) =>
        ref === `onchain:1:${SOURCE.hash}:erc4626-silo:${VAULT}`
      ),
    );
    assert(stage.evidenceRefs.every((ref) => !ref.startsWith("fixture:")));
  }

  await assert.rejects(
    () => captureErc4626SiloOnchainCase({
      source: SOURCE,
      provider: provider({ payoutAsset: `0x${"ee".repeat(20)}` }),
      vault: VAULT,
      payout: PAYOUT,
      runtime: erc4626SiloFixtureRuntime(),
    }),
    /asset mismatch/,
  );
  await assert.rejects(
    () => captureErc4626SiloOnchainCase({
      source: SOURCE,
      provider: provider({ vaultAsset: `0x${"00".repeat(20)}` }),
      vault: VAULT,
      payout: PAYOUT,
      runtime: erc4626SiloFixtureRuntime(),
    }),
    /zero asset/,
  );
  await assert.rejects(
    () => captureErc4626SiloOnchainCase({
      source: SOURCE,
      provider: provider(),
      vault: VAULT,
      payout: PAYOUT,
      underlying: `0x${"ff".repeat(20)}`,
      runtime: erc4626SiloFixtureRuntime(),
    }),
    /underlying mismatch/,
  );
  await assert.rejects(
    () => captureErc4626SiloOnchainCase({
      source: SOURCE,
      provider: provider({ fail: true }),
      vault: VAULT,
      payout: PAYOUT,
      runtime: erc4626SiloFixtureRuntime(),
    }),
    /rpc down/,
  );

  console.log("erc4626-silo onchain capture PASS");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
