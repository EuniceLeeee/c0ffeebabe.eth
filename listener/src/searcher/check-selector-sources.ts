// Read-only gate: the SQL producer and live runtime import the generated IR.
// Never silently regenerate a stale source as part of a live build.
import { fileURLToPath } from "node:url";
import { syncDeclarativeProductionEntries } from "./build-declarative-production.js";

const rootDirectory = fileURLToPath(new URL("../../", import.meta.url));
const entries = await syncDeclarativeProductionEntries({ rootDirectory, mode: "check" });
console.log("selector sources verified:", entries.size);
