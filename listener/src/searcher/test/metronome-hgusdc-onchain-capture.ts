import assert from "node:assert/strict";
import {
  captureMetronomeHgUsdcOnchainCase,
  METRONOME_HGUSDC_FIXTURE_TARGET,
  metronomeHgUsdcFixtureRuntime,
  type OnchainUniv2Provider,
} from "../architecture-migration-fixture-replay.js";
import {
  METRONOME_HGUSDC_BINDINGS,
  METRONOME_HGUSDC_VAULT_INTERFACE,
} from "../venues/protocols/metronome-hgusdc-family/shared.js";
import { METRONOME_HGUSDC_FAMILY_ID } from
  "../venues/protocols/metronome-hgusdc-family/manifest.js";
import type { CanonicalSource } from
  "../venues/adapter-request-program.js";

const SOURCE: CanonicalSource = Object.freeze({
  number: 20_000_000,
  hash: `0x${"ab".repeat(32)}`,
  generation: 1,
});
const TARGET = METRONOME_HGUSDC_FIXTURE_TARGET.toLowerCase();
const VAULT = METRONOME_HGUSDC_BINDINGS.vault.toLowerCase();
const TOKEN_OUT = METRONOME_HGUSDC_BINDINGS.tokenOut.toLowerCase();

function provider(input: {
  readonly asset?: string;
  readonly fail?: boolean;
} = {}): OnchainUniv2Provider {
  return {
    async call() {
      if (input.fail === true) throw new Error("rpc down");
      return METRONOME_HGUSDC_VAULT_INTERFACE.encodeFunctionResult("asset", [
        input.asset ?? TOKEN_OUT,
      ]);
    },
  };
}

async function main(): Promise<void> {
  const capture = await captureMetronomeHgUsdcOnchainCase({
    source: SOURCE,
    provider: provider(),
    target: TARGET,
    vault: VAULT,
    tokenOut: TOKEN_OUT,
    runtime: metronomeHgUsdcFixtureRuntime(),
  });
  assert.equal(capture.familyId, METRONOME_HGUSDC_FAMILY_ID);
  for (const stage of Object.values(capture.stages)) {
    if (stage === undefined) continue;
    assert(
      stage.evidenceRefs.every((ref) =>
        ref === `onchain:1:${SOURCE.hash}:metronome-hgusdc:${TARGET}`
      ),
    );
    assert(stage.evidenceRefs.every((ref) => !ref.startsWith("fixture:")));
  }

  await assert.rejects(
    () => captureMetronomeHgUsdcOnchainCase({
      source: SOURCE,
      provider: provider({ asset: `0x${"ee".repeat(20)}` }),
      target: TARGET,
      vault: VAULT,
      tokenOut: TOKEN_OUT,
      runtime: metronomeHgUsdcFixtureRuntime(),
    }),
    /tokenOut mismatch/,
  );
  await assert.rejects(
    () => captureMetronomeHgUsdcOnchainCase({
      source: SOURCE,
      provider: provider({ asset: `0x${"00".repeat(20)}` }),
      target: TARGET,
      vault: VAULT,
      runtime: metronomeHgUsdcFixtureRuntime(),
    }),
    /zero asset/,
  );
  await assert.rejects(
    () => captureMetronomeHgUsdcOnchainCase({
      source: SOURCE,
      provider: provider({ fail: true }),
      target: TARGET,
      vault: VAULT,
      runtime: metronomeHgUsdcFixtureRuntime(),
    }),
    /rpc down/,
  );

  console.log("metronome-hgusdc onchain capture PASS");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
