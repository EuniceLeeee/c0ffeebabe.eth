import { readFileSync } from "node:fs";
import root from "../venues/protocols/erc4626-family/erc4626.json";

/** Synthetic framework tests use the same installed child list as production. */
export const erc4626ChildFiles = root.variantFiles.map(file => ({ file,
  definition: JSON.parse(readFileSync(new URL(file, new URL("../venues/protocols/erc4626-family/erc4626.json", import.meta.url)), "utf8")) }));
export const erc4626Children = () => erc4626ChildFiles.map(row => structuredClone(row.definition));
