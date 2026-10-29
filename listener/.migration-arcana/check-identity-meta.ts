import { readFileSync } from "node:fs";
import { createDeclarativeProtocolRuntime } from "../src/searcher/venues/declarative-protocol.js";
import { declarativeMathRegistry } from "../src/searcher/venues/declarative-math-models.js";
import { defineProtocolFamily } from "../src/searcher/venues/adapter-family-plugin.js";
for (const stem of ["arcana-migration", "boring-vault-teller", "default-collateral"]) {
  const document = JSON.parse(readFileSync(`src/searcher/venues/protocols/${stem}-family/${stem}.json`, "utf8"));
  const runtime = createDeclarativeProtocolRuntime(document, [], { math: declarativeMathRegistry });
  const plugin = defineProtocolFamily(runtime.definition as never);
  const v = plugin.identity.variants[0]!;
  console.log(stem, { memoReuse: plugin.identity.memoReuse, id: v.id, kind: v.kind, lineage: v.lineageId });
  const handwritten = (await import(`../src/searcher/venues/production-families/${stem}.production.js`)).plugin;
  const hv = handwritten.identity.variants[0]!;
  console.log("  ts", { memoReuse: handwritten.identity.memoReuse, id: hv.id, kind: hv.kind, lineage: hv.lineageId });
}
