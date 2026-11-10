import assert from "node:assert/strict";
import { test } from "node:test";
import { Interface } from "ethers";
import { plugin } from "../venues/production-families/angstrom-v4.production.js";
import definition from "../venues/swaps/angstrom-v4-family/angstrom-v4.json" with { type: "json" };
import sample from "./fixtures/adapter-families/angstrom-signed-tx85-call.json" with { type: "json" };
import { checkAngstromTwoWaySpot, checkAngstromPoolIsolation } from "./angstrom-price-fixture.js";
import { checkDirectedProtocolPrices } from "./directed-protocol-price-fixture.js";

test("[family=custom-swap:angstrom-v4] the production spot reads price both directions on the observed pool", checkAngstromTwoWaySpot);
test("[family=custom-swap:angstrom-v4] two pools on the same manager refresh independently", checkAngstromPoolIsolation);

test("[family=custom-swap:angstrom-v4] pending intake declines stale, mixed-signature and unproved contract-validator bundles", async () => {
  const abi = new Interface([definition.modules.signedBlockEvidence.call.signature]);
  const args = abi.decodeFunctionData("swap", sample.data).toArray(true);
  const n = BigInt(sample.source.number);
  const signed = args[4].find(([block]: [bigint, string]) => block === n);
  assert(signed);
  const future = n + 1n;
  const source = { ...sample.source, number: Number(future) };
  const observation = { kind: "call" as const, source, sender: sample.from, target: sample.target, transactionHash: sample.transactionHash };
  async function pending(rows: readonly [bigint, string][]) {
    const data = abi.encodeFunctionData("swap", args.map((arg, i) => i === 4 ? rows : arg));
    return plugin.discovery!.pendingRuntimeEvidenceFromObservation!({ source, observation: { ...observation, data },
      call: async () => assert.fail("invalid signatures cannot start node authorization reads") });
  }
  assert.deepEqual(await pending([[n, signed[1]]]), []);
  assert.deepEqual(await pending([[n, signed[1]], [future, signed[1]]]), []);
  const contractNode = "0x5555555555555555555555555555555555555555";
  assert.deepEqual(await pending([[future, contractNode + "cd".repeat(103)]]), []);
});

test("[family=protocol:astra-multitoken,protocol:eigenpie] Astra and Eigenpie keep the directed quotes of the published contracts", checkDirectedProtocolPrices);
