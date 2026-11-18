/** Number of successful forward conversions used to prepare a priced leg's
 * input. The priced leg itself is additional; this is not the DFS route limit. */
export const DEFAULT_EFFECTIVE_INPUT_PATH_HOPS = 4;

export function effectiveInputPathHops(value: number | undefined): number {
  const hops = value ?? DEFAULT_EFFECTIVE_INPUT_PATH_HOPS;
  if (!Number.isSafeInteger(hops) || hops < 0)
    throw new Error("invalid effective input path hops");
  return hops;
}

export function resolveEffectiveInputPathHops(env: NodeJS.ProcessEnv = process.env): number {
  const value = env.SEARCHER_EFFECTIVE_MAX_INPUT_PATH_HOPS;
  if (value !== undefined && !/^(0|[1-9][0-9]*)$/.test(value))
    throw new Error("SEARCHER_EFFECTIVE_MAX_INPUT_PATH_HOPS must be a nonnegative integer");
  return effectiveInputPathHops(value === undefined ? undefined : Number(value));
}
