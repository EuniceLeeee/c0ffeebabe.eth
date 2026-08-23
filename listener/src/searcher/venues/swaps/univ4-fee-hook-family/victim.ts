import { univ4VictimReplay } from "../univ4-family/victim.js";
import { deepGuardCopy } from "./guard-copy.js";

/**
 * Victim replay semantics are hook-agnostic (same manager post-state).
 * Deep copy for a distinct Family-guarded object graph.
 */
export const univ4FeeHookVictimReplay = deepGuardCopy(univ4VictimReplay);
