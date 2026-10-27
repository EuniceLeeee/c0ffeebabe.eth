import { compileDeclarativeDiscovery } from "../../declarative-discovery.js";
import type { Erc4626Candidate } from "./types.js";
import definition from "./erc4626.json";

export const erc4626Discovery = compileDeclarativeDiscovery<Erc4626Candidate>(definition.discovery.definition);
