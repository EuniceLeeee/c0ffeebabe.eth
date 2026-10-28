import { readFileSync } from "node:fs";
import { ethers } from "ethers";
import { instanceKey } from "../../../adapter-family-identifiers.js";
import { ID, LINEAGE } from "../manifest.js";
import { decodeFactoryRuntime, decodePoolRuntime } from "../runtime.js";
import type { Descriptor } from "../types.js";
export const fixture = JSON.parse(readFileSync(new URL("./runtime-fixture.json", import.meta.url), "utf8"));
/** Recorded public bytecode used as an offline fixture, not current admission. */
export function descriptor(): Descriptor {
  const pool = decodePoolRuntime(fixture.poolRuntime), factory = decodeFactoryRuntime(fixture.factoryRuntime);
  if (!pool || !factory) throw Error("precision-pool fixture runtime");
  return { familyId: ID, lineageId: LINEAGE, instanceKey: instanceKey(fixture.pool), pool: fixture.pool, ...pool, ...factory,
    codeHash: ethers.keccak256(fixture.poolRuntime), factoryCodeHash: ethers.keccak256(fixture.factoryRuntime),
    provenance: [], runtimeRequirements: [] };
}
