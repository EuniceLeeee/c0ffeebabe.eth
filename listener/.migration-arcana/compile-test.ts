import { readFileSync } from "node:fs";
import { renderDeclarativeProductionEntry } from "../src/searcher/build-declarative-production.js";
import { createDeclarativeProtocolRuntime } from "../src/searcher/venues/declarative-protocol.js";
import { declarativeMathRegistry } from "../src/searcher/venues/declarative-math-models.js";
import { declarativeRuntimeMathRegistry } from "../src/searcher/venues/declarative-runtime-math-models.js";
import { defineProtocolFamily, definedFamilyPluginContractSummary } from "../src/searcher/venues/adapter-family-plugin.js";

const ROOT = new URL("..", import.meta.url).pathname;
const stem = process.argv[2]!;
const definitionFile = `${ROOT}src/searcher/venues/protocols/${stem}-family/${stem}.json`;
const document = JSON.parse(readFileSync(definitionFile, "utf8"));
const rendered = renderDeclarativeProductionEntry({ rootDirectory: ROOT, definitionFile, document });
console.log("render ok", rendered.format, rendered.familyId, rendered.childFiles.length);
const runtime = createDeclarativeProtocolRuntime(document, [], { math: declarativeMathRegistry, executionMath: declarativeRuntimeMathRegistry });
const plugin = defineProtocolFamily(runtime.definition as never);
const summary = definedFamilyPluginContractSummary(plugin);
console.log("compile ok", summary.familyId, JSON.stringify(runtime.moduleCoverage));
