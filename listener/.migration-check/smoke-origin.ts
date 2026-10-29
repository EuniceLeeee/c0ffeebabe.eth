import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createDeclarativeProtocolRuntime } from "../src/searcher/venues/declarative-protocol.js";
import { defineProtocolFamily } from "../src/searcher/venues/adapter-family-plugin.js";
import { declarativeMathRegistry } from "../src/searcher/venues/declarative-math-models.js";
import { declarativeRuntimeMathRegistry } from "../src/searcher/venues/declarative-runtime-math-models.js";

const stem = process.argv[2]!;
const file = resolve(import.meta.dirname, `../src/searcher/venues/protocols/${stem}-family/${stem}.json`);
const document = JSON.parse(readFileSync(file, "utf8"));
const runtime = createDeclarativeProtocolRuntime(document, [], { math: declarativeMathRegistry, executionMath: declarativeRuntimeMathRegistry });
const plugin = defineProtocolFamily(runtime.definition as any);
console.log("compiled", plugin.manifest.familyId, "lineage", plugin.manifest.supportedLineages.join(","));
console.log("modules", runtime.moduleCoverage.map(v => v.variant + ":" + v.modules.map(m => m.key + "=" + m.state).join(",")).join(" | "));
