import { univ4VictimReplay } from "../univ4-family/victim.js";
import type { VictimReplaySpec } from "../../adapter-family-plugin.js";
import type { FeeHookDescriptor, FeeHookRoute } from "./types.js";

/**
 * Sat1's supply/curve/cooldown cannot be represented by PoolManager slot0.
 * Blockscan uses full pinned state; local victim replay must fail closed.
 */
export const univ4FeeHookVictimReplay = {
  bind: input => input.descriptor.hookModel === "sat1" ? null : univ4VictimReplay.bind(input),
  applyLocal: input => input.descriptor.hookModel === "sat1" ? null : univ4VictimReplay.applyLocal(input),
  exactPostState: input => input.descriptor.hookModel === "sat1" ? null : univ4VictimReplay.exactPostState(input),
  buildOverlay: input => input.descriptor.hookModel === "sat1" ? null : univ4VictimReplay.buildOverlay(input),
} satisfies VictimReplaySpec<FeeHookDescriptor, FeeHookRoute>;
