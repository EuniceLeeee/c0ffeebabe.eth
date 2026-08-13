import assert from "node:assert/strict";
import {
  deriveLiveDiscoveryEventObservations,
} from "../live-discovery-event-observations.js";
import {
  PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG,
} from "../venues/production-family-composition.js";
import { WSTETH_INTERFACE } from
  "../venues/protocols/wsteth-family/codec.js";
import { WSTETH_FAMILY_ID } from
  "../venues/protocols/wsteth-family/manifest.js";
import type { CanonicalSource } from
  "../venues/adapter-request-program.js";

const SOURCE: CanonicalSource = Object.freeze({
  number: 25_700_444,
  hash: `0x${"71".repeat(32)}`,
  generation: 44,
});

function main(): void {
  const catalog = PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG;
  const wrap = WSTETH_INTERFACE.encodeFunctionData("wrap", [1_000_000n]);

  // A wsteth wrap call buckets under its Family by selector.
  const buckets = deriveLiveDiscoveryEventObservations({
    catalog,
    source: SOURCE,
    events: Object.freeze([{
      kind: "call",
      address: "0x7f39c581f595b53c5cb19bd0b3f8da6c935e2ca0",
      data: wrap,
      blockNumber: SOURCE.number,
    }]),
  });
  assert.equal(buckets.size, 1);
  const wsteth = buckets.get(WSTETH_FAMILY_ID);
  assert(wsteth, "wsteth wrap call must bucket under the wsteth Family");
  assert.equal(wsteth.length, 1);
  assert.equal(wsteth[0].kind, "call");
  assert(wsteth[0] !== undefined && wsteth[0].kind === "call");

  // Duplicate events collapse; events beyond the source are skipped; an
  // unknown selector produces no bucket.
  const mixed = deriveLiveDiscoveryEventObservations({
    catalog,
    source: SOURCE,
    events: Object.freeze([
      {
        kind: "call",
        address: "0x7f39c581f595b53c5cb19bd0b3f8da6c935e2ca0",
        data: wrap,
        blockNumber: SOURCE.number,
      },
      {
        kind: "call",
        address: "0x7f39c581f595b53c5cb19bd0b3f8da6c935e2ca0",
        data: wrap,
        blockNumber: SOURCE.number,
      },
      {
        kind: "call",
        address: "0x7f39c581f595b53c5cb19bd0b3f8da6c935e2ca0",
        data: wrap,
        blockNumber: SOURCE.number + 1,
      },
      {
        kind: "call",
        address: "0x7f39c581f595b53c5cb19bd0b3f8da6c935e2ca0",
        data: "0xdeadbeef",
        blockNumber: SOURCE.number,
      },
    ]),
  });
  assert.equal(mixed.get(WSTETH_FAMILY_ID)?.length, 1);

  console.log("live discovery event observations PASS");
}

main();
