import assert from "node:assert/strict";
import { ethers } from "ethers";
import {
  captureFundingOnchainCase,
  FUNDING_CAPTURE_ASSET,
  FUNDING_CAPTURE_MAX_BORROW,
  type OnchainUniv2Provider,
} from "../architecture-migration-fixture-replay.js";
import { familyId } from
  "../venues/adapter-family-identifiers.js";
import type { CanonicalSource } from
  "../venues/adapter-request-program.js";

const SOURCE: CanonicalSource = Object.freeze({
  number: 20_000_000,
  hash: `0x${"bf".repeat(32)}`,
  generation: 1,
});
const ASSET = FUNDING_CAPTURE_ASSET.toLowerCase();
const FUNDING_CONTRACT = `0x${"12".repeat(20)}`;
const FUNDING_IFACE = new ethers.Interface([
  "function balanceOf(address) view returns (uint256)",
]);

function provider(input: {
  readonly balance?: bigint;
  readonly fail?: boolean;
} = {}): OnchainUniv2Provider {
  return {
    async call() {
      if (input.fail === true) throw new Error("rpc down");
      return FUNDING_IFACE.encodeFunctionResult("balanceOf", [
        input.balance ?? FUNDING_CAPTURE_MAX_BORROW,
      ]);
    },
  };
}

async function main(): Promise<void> {
  const family = "flash-loan:balancer-v2" as const;
  const capture = await captureFundingOnchainCase({
    familyId: family,
    source: SOURCE,
    provider: provider(),
    asset: ASSET,
    fundingContract: FUNDING_CONTRACT,
  });
  assert.equal(capture.familyId, familyId(family));
  for (const stage of Object.values(capture.stages)) {
    if (stage === undefined) continue;
    assert(
      stage.evidenceRefs.every((ref) =>
        ref === `onchain:1:${SOURCE.hash}:${family}:${FUNDING_CONTRACT}`
      ),
    );
    assert(stage.evidenceRefs.every((ref) => !ref.startsWith("fixture:")));
  }

  await assert.rejects(
    () => captureFundingOnchainCase({
      familyId: family,
      source: SOURCE,
      provider: provider({ balance: 0n }),
      asset: ASSET,
      fundingContract: FUNDING_CONTRACT,
    }),
    /zero asset balance/,
  );
  await assert.rejects(
    () => captureFundingOnchainCase({
      familyId: family,
      source: SOURCE,
      provider: provider({ fail: true }),
      asset: ASSET,
      fundingContract: FUNDING_CONTRACT,
    }),
    /rpc down/,
  );

  console.log("funding onchain capture PASS");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
