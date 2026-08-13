import assert from "node:assert/strict";
import {
  captureErc4626OnchainCase,
  ERC4626_FIXTURE_ASSET,
  ERC4626_FIXTURE_VAULT,
  erc4626FixtureRuntime,
  type OnchainUniv2Provider,
} from "../architecture-migration-fixture-replay.js";
import {
  ERC4626_INTERFACE,
} from "../venues/protocols/erc4626-family/abi.js";
import { ERC4626_FAMILY_ID } from
  "../venues/protocols/erc4626-family/manifest.js";
import type { CanonicalSource } from
  "../venues/adapter-request-program.js";

const SOURCE: CanonicalSource = Object.freeze({
  number: 20_000_000,
  hash: `0x${"b1".repeat(32)}`,
  generation: 1,
});
const VAULT = ERC4626_FIXTURE_VAULT.toLowerCase();

function provider(input: {
  readonly asset?: string;
  readonly fail?: boolean;
} = {}): OnchainUniv2Provider {
  return {
    async call(tx) {
      if (input.fail === true) throw new Error("rpc down");
      return ERC4626_INTERFACE.encodeFunctionResult("asset", [
        input.asset ?? ERC4626_FIXTURE_ASSET,
      ]);
    },
  };
}

async function main(): Promise<void> {
  const capture = await captureErc4626OnchainCase({
    source: SOURCE,
    provider: provider(),
    vault: VAULT,
    asset: ERC4626_FIXTURE_ASSET,
    runtime: erc4626FixtureRuntime(),
  });
  assert.equal(capture.familyId, ERC4626_FAMILY_ID);
  assert.equal(capture.stateAnchorNumber, SOURCE.number);
  for (const stage of Object.values(capture.stages)) {
    if (stage === undefined) continue;
    assert(
      stage.evidenceRefs.every((ref) =>
        ref === `onchain:1:${SOURCE.hash}:erc4626:${VAULT}`
      ),
      "erc4626 onchain capture must carry onchain evidence refs only",
    );
    assert(
      stage.evidenceRefs.every((ref) => !ref.startsWith("fixture:")),
      "erc4626 onchain capture must not carry fixture provenance",
    );
  }

  await assert.rejects(
    () => captureErc4626OnchainCase({
      source: SOURCE,
      provider: provider({ asset: `0x${"ee".repeat(20)}` }),
      vault: VAULT,
      asset: ERC4626_FIXTURE_ASSET,
      runtime: erc4626FixtureRuntime(),
    }),
    /asset mismatch/,
  );
  await assert.rejects(
    () => captureErc4626OnchainCase({
      source: SOURCE,
      provider: provider({ asset: `0x${"00".repeat(20)}` }),
      vault: VAULT,
      runtime: erc4626FixtureRuntime(),
    }),
    /zero asset/,
  );
  await assert.rejects(
    () => captureErc4626OnchainCase({
      source: SOURCE,
      provider: provider({ fail: true }),
      vault: VAULT,
      runtime: erc4626FixtureRuntime(),
    }),
    /rpc down/,
  );

  console.log("erc4626 onchain capture PASS");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
