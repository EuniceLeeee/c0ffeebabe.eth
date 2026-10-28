import { ethers } from "ethers";
import { instanceKey } from "../../../adapter-family-identifiers.js";
import { key } from "../instance.js";
import { FAMILY, LINEAGE } from "../manifest.js";
import type { Descriptor } from "../types.js";
export const addr = (n: number) => ethers.toBeHex(n, 20);
export const ACTOR = addr(201), RECEIVER = addr(202), SET_TOKEN = addr(301), MODULE = addr(302), CONTROLLER = addr(303);
export const SOURCE = { number: 100, hash: ethers.toBeHex(100, 32), generation: 100 };
export function fixture(count = 4): Descriptor {
  return { familyId: FAMILY, lineageId: LINEAGE, instanceKey: instanceKey(key({ set: SET_TOKEN, module: MODULE })),
    set: SET_TOKEN, module: MODULE, controller: CONTROLLER, controllerCodeHash: ethers.keccak256("0x6000"),
    components: Array.from({ length: count }, (_, n) => addr(1000 + n)), provenance: [], runtimeRequirements: [] };
}
