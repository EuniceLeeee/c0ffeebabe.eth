import assert from "node:assert/strict";
import { parsePoolUniverseJson } from "../pool-universe.js";

const supported = {
  adapter: "univ2",
  address: "0x00000000000000000000000000000000000000AA",
  venueId: "univ2",
  score: 10,
};
const removed = {
  adapter: "ekubo-core-pool-v1",
  address: "0x00000000000000000000000000000000000000BB",
  venueId: "ekubo",
  score: 10,
};
const universe = { pools: [supported, removed] };

assert.throws(
  () => parsePoolUniverseJson(JSON.stringify(universe), "fixture"),
  /adapter unsupported/,
  "the strict load must fail closed on a removed-family adapter",
);

const dropped = parsePoolUniverseJson(JSON.stringify(universe), "fixture", {
  dropUnsupportedAdapters: true,
});
assert.equal(
  dropped.length,
  1,
  "the builder load must skip removed-family retained pools",
);
assert.equal(dropped[0]?.adapter, "univ2");

const historicalProvenance = {
  ...supported,
  identitySource: "historical-plugin-provenance",
};
assert.throws(
  () => parsePoolUniverseJson(
    JSON.stringify({ pools: [historicalProvenance] }),
    "fixture",
  ),
  /unsupported identity source/,
  "unregistered provenance remains rejected by the default strict parser",
);
const retainedProvenance = parsePoolUniverseJson(
  JSON.stringify({ pools: [historicalProvenance] }),
  "fixture",
  { allowUnregisteredIdentitySource: true },
);
assert.equal(
  retainedProvenance[0]?.identitySource,
  "historical-plugin-provenance",
  "explicit provenance compatibility retains the label for immediate strict attestation",
);

console.log("pool-universe-parse PASS");
