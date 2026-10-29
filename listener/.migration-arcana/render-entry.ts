import { readFileSync } from "node:fs";
import { renderDeclarativeProductionEntry } from "../src/searcher/build-declarative-production.js";
const ROOT = new URL("..", import.meta.url).pathname;
const stem = process.argv[2]!;
const definitionFile = `${ROOT}src/searcher/venues/protocols/${stem}-family/${stem}.json`;
const document = JSON.parse(readFileSync(definitionFile, "utf8"));
const entry = renderDeclarativeProductionEntry({ rootDirectory: ROOT, definitionFile, document });
process.stdout.write(entry.source);
