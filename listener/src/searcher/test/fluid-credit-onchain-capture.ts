import assert from "node:assert/strict";
import {
  captureFluidCreditOnchainCase,
  FLUID_CREDIT_FIXTURE_BORROW,
  FLUID_CREDIT_FIXTURE_SUPPLY,
  FLUID_CREDIT_FIXTURE_VAULT,
  type OnchainUniv2Provider,
} from "../architecture-migration-fixture-replay.js";
import { FLUID_VAULT_INTERFACE } from
  "../venues/credit/fluid-family/codec.js";
import { FLUID_CREDIT_FAMILY_ID } from
  "../venues/credit/fluid-family/manifest.js";
import type { CanonicalSource } from
  "../venues/adapter-request-program.js";

const SOURCE: CanonicalSource = Object.freeze({
  number: 20_000_000,
  hash: `0x${"ef".repeat(32)}`,
  generation: 1,
});
const VAULT = FLUID_CREDIT_FIXTURE_VAULT.toLowerCase();
const ZERO = `0x${"00".repeat(20)}`;
const SLOT = `0x${"11".repeat(32)}`;

function provider(input: {
  readonly supply?: string;
  readonly borrow?: string;
  readonly fail?: boolean;
} = {}): OnchainUniv2Provider {
  return {
    async call() {
      if (input.fail === true) throw new Error("rpc down");
      return FLUID_VAULT_INTERFACE.encodeFunctionResult("constantsView", [[
        ZERO,
        `0x${"f2".repeat(20)}`,
        ZERO,
        ZERO,
        input.supply ?? FLUID_CREDIT_FIXTURE_SUPPLY,
        input.borrow ?? FLUID_CREDIT_FIXTURE_BORROW,
        18,
        18,
        1n,
        SLOT,
        SLOT,
        SLOT,
        SLOT,
      ]]);
    },
  };
}

async function main(): Promise<void> {
  const capture = await captureFluidCreditOnchainCase({
    source: SOURCE,
    provider: provider(),
    vault: VAULT,
    supply: FLUID_CREDIT_FIXTURE_SUPPLY,
    borrow: FLUID_CREDIT_FIXTURE_BORROW,
  });
  assert.equal(capture.familyId, FLUID_CREDIT_FAMILY_ID);
  for (const stage of Object.values(capture.stages)) {
    if (stage === undefined) continue;
    assert(
      stage.evidenceRefs.every((ref) =>
        ref === `onchain:1:${SOURCE.hash}:credit:fluid:${VAULT}`
      ),
    );
    assert(stage.evidenceRefs.every((ref) => !ref.startsWith("fixture:")));
  }

  await assert.rejects(
    () => captureFluidCreditOnchainCase({
      source: SOURCE,
      provider: provider({ borrow: `0x${"ee".repeat(20)}` }),
      vault: VAULT,
      supply: FLUID_CREDIT_FIXTURE_SUPPLY,
      borrow: FLUID_CREDIT_FIXTURE_BORROW,
    }),
    /token mismatch/,
  );
  await assert.rejects(
    () => captureFluidCreditOnchainCase({
      source: SOURCE,
      provider: provider({ supply: ZERO }),
      vault: VAULT,
    }),
    /zero token/,
  );
  await assert.rejects(
    () => captureFluidCreditOnchainCase({
      source: SOURCE,
      provider: provider({ fail: true }),
      vault: VAULT,
    }),
    /rpc down/,
  );

  console.log("fluid-credit onchain capture PASS");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
