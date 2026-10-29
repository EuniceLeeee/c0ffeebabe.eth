import { readFileSync } from "node:fs";
import { renderDeclarativeFamilyTypes } from "../src/searcher/venues/declarative-types.js";
for (const stem of ["arcana-migration", "boring-vault-teller", "default-collateral"]) {
  const document = JSON.parse(readFileSync(`src/searcher/venues/protocols/${stem}-family/${stem}.json`, "utf8"));
  const source = renderDeclarativeFamilyTypes(document.types, []);
  console.log(stem, "types ok", source.length, "bytes;", (source.match(/^export type (\w+)/gm) ?? []).length, "types");
}
