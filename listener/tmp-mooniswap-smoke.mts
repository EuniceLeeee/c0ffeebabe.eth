import { createDeclarativeSwapRuntime } from "./src/searcher/venues/declarative-swap.js";
import { defineSwapFamily, definedFamilyPluginContractSummary } from "./src/searcher/venues/adapter-family-plugin.js";
import definition from "./src/searcher/venues/swaps/mooniswap-family/mooniswap.json" with { type: "json" };

const runtime = createDeclarativeSwapRuntime(definition as any, []);
console.log("compiled");
console.log("coverage", JSON.stringify(runtime.moduleCoverage));
const plugin = defineSwapFamily(runtime.definition as any);
console.log("defineSwapFamily ok", JSON.stringify(definedFamilyPluginContractSummary(plugin).manifest));
