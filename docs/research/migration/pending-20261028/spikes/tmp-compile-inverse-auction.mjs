// Run from the listener workspace:
//   cd listener && node --import tsx ../docs/research/migration/pending-20261028/spikes/tmp-compile-inverse-auction.mjs
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const LISTENER = join(HERE, "../../../../../listener");
const { createDeclarativeProtocolRuntime } = await import(
  pathToFileURL(join(LISTENER, "src/searcher/venues/declarative-protocol.ts")).href);
const raw = JSON.parse(readFileSync(join(LISTENER, "src/searcher/venues/protocols/inverse-auction-family/inverse-auction.json"), "utf8"));
const runtime = createDeclarativeProtocolRuntime(raw);
const family = runtime.definition;
console.log("compiled", family.manifest.familyId, family.manifest.domain);
console.log("discovery call", family.discovery.callPatterns[0].selector, family.discovery.callPatterns[0].signature);
console.log("discovery log", family.discovery.logPatterns[0].topic, family.discovery.logPatterns[0].signature);
console.log("module coverage", JSON.stringify(runtime.moduleCoverage, null, 1));
console.log("exact methods", family.exact.methods(undefined).map(m => ({id:m.id, kind:m.kind})));
