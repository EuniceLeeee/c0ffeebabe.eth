const FAMILY_SOURCE_SEPARATOR = "\u001f";

export interface DiscoveryFamilySources {
  readonly familyId: string;
  readonly sourceIds: readonly string[];
}

export interface DiscoverySourceIssue {
  readonly sourceId: string;
  readonly impactedFamilyIds: readonly string[];
  readonly retryable: boolean;
}

export interface DiscoveryStartupPlan {
  /**
   * `contiguous` means the persisted cursor proves every preceding block for
   * the unchanged source registry. `positive-only` is a bounded recent scan
   * with no negative/completeness authority.
   */
  readonly mode: "contiguous" | "positive-only";
  readonly cursorBefore: number;
  readonly range: DiscoveryRange;
}

export interface DiscoveryRange {
  readonly fromBlock: number;
  readonly toBlock: number;
}

export function discoveryFamilySourceKey(
  familyId: string,
  sourceId: string,
): string {
  if (!familyId || !sourceId) {
    throw new Error("discovery family/source watermark requires non-empty ids");
  }
  return `${familyId}${FAMILY_SOURCE_SEPARATOR}${sourceId}`;
}

export function createDiscoveryFamilySourceWatermarks(
  families: readonly DiscoveryFamilySources[],
): Map<string, number> {
  const watermarks = new Map<string, number>();
  for (const family of families) {
    for (const sourceId of new Set(family.sourceIds)) {
      watermarks.set(
        discoveryFamilySourceKey(family.familyId, sourceId),
        -1,
      );
    }
  }
  return watermarks;
}

export function seedDiscoverySourceWatermark(
  watermarks: Map<string, number>,
  families: readonly DiscoveryFamilySources[],
  sourceId: string,
  completeThrough: number,
): void {
  assertCursor(completeThrough);
  for (const family of families) {
    if (!family.sourceIds.includes(sourceId)) continue;
    watermarks.set(
      discoveryFamilySourceKey(family.familyId, sourceId),
      completeThrough,
    );
  }
}

export function planDiscoveryStartup(input: {
  readonly targetBlock: number;
  readonly persistedCursor: number | null;
  readonly sourceRegistryChanged: boolean;
  readonly recentBlocks: number;
  readonly maxCatchupBlocks: number;
  /**
   * Normal live startup first scans a recent window for positive evidence,
   * then the runtime catches up contiguously from block zero in the
   * background. Strict historical preparation may request the first
   * contiguous chunk immediately.
   */
  readonly bootstrapMode?: "recent-positive" | "contiguous";
}): DiscoveryStartupPlan {
  assertBlock(input.targetBlock, "target block");
  assertPositiveSafeInteger(input.recentBlocks, "recent block window");
  assertPositiveSafeInteger(input.maxCatchupBlocks, "max catch-up blocks");
  if (input.persistedCursor !== null) {
    assertBlock(input.persistedCursor, "persisted cursor");
  }

  if (!input.sourceRegistryChanged && input.persistedCursor !== null) {
    const cursorBefore = Math.min(input.persistedCursor, input.targetBlock);
    return {
      mode: "contiguous",
      cursorBefore,
      range: planContiguousDiscoveryChunk(
        cursorBefore,
        input.targetBlock,
        input.maxCatchupBlocks,
      ) ?? {
        // Refresh current-block address/registry sources even when the event
        // cursor was already current.
        fromBlock: input.targetBlock,
        toBlock: input.targetBlock,
      },
    };
  }

  if (input.bootstrapMode === "contiguous") {
    return {
      mode: "contiguous",
      cursorBefore: -1,
      range: planContiguousDiscoveryChunk(
        -1,
        input.targetBlock,
        input.maxCatchupBlocks,
      )!,
    };
  }

  const positiveOnlyBlocks = Math.min(
    input.recentBlocks,
    input.maxCatchupBlocks,
  );
  const fromBlock = Math.max(
    0,
    input.targetBlock - positiveOnlyBlocks + 1,
  );
  return {
    mode: "positive-only",
    cursorBefore: fromBlock - 1,
    range: { fromBlock, toBlock: input.targetBlock },
  };
}

/**
 * Plan exactly the next contiguous chunk. A large restart gap is never
 * clamped from the left: repeated calls cover cursor+1..target without holes.
 */
export function planContiguousDiscoveryChunk(
  cursor: number,
  targetBlock: number,
  maxCatchupBlocks: number,
): DiscoveryRange | null {
  assertCursor(cursor);
  assertBlock(targetBlock, "target block");
  assertPositiveSafeInteger(maxCatchupBlocks, "max catch-up blocks");
  if (targetBlock <= cursor) return null;
  return {
    fromBlock: cursor + 1,
    toBlock: Math.min(targetBlock, cursor + maxCatchupBlocks),
  };
}

export function discoveryCursorForPersistence(
  mode: DiscoveryStartupPlan["mode"],
  cursor: number,
): number | null {
  assertCursor(cursor);
  return mode === "contiguous" && cursor >= 0 ? cursor : null;
}

export function advanceDiscoveryFamilySourceWatermarks(input: {
  readonly current: ReadonlyMap<string, number>;
  readonly families: readonly DiscoveryFamilySources[];
  readonly range: DiscoveryRange;
  readonly familyComplete: ReadonlyMap<string, boolean>;
  /** Optional exact family×source result; takes precedence over familyComplete. */
  readonly familySourceComplete?: ReadonlyMap<string, boolean>;
  readonly sourceComplete: ReadonlyMap<string, boolean>;
  readonly sourceIssues: readonly DiscoverySourceIssue[];
  /** Historical sources that require cursor+1 continuity. */
  readonly contiguousSourceIds: ReadonlySet<string>;
  /** Sources scanned for positive evidence only; never advance completeness. */
  readonly positiveOnlySourceIds?: ReadonlySet<string>;
}): {
  readonly watermarks: Map<string, number>;
  readonly completedKeys: ReadonlySet<string>;
} {
  validateRange(input.range);
  const watermarks = new Map(input.current);
  const completedKeys = new Set<string>();
  for (const family of input.families) {
    for (const sourceId of new Set(family.sourceIds)) {
      const key = discoveryFamilySourceKey(family.familyId, sourceId);
      const currentThrough = watermarks.get(key) ?? -1;
      if (!familySourceCompletedThisPass(
        family.familyId,
        sourceId,
        input.familyComplete,
        input.familySourceComplete,
        input.sourceComplete,
        input.sourceIssues,
      )) continue;
      completedKeys.add(key);
      if (input.positiveOnlySourceIds?.has(sourceId)) continue;
      if (
        input.contiguousSourceIds.has(sourceId) &&
        input.range.fromBlock > currentThrough + 1
      ) {
        // A bounded recent scan after a clean start/registry change may admit
        // positives, but it cannot manufacture coverage over the skipped gap.
        continue;
      }
      watermarks.set(key, Math.max(currentThrough, input.range.toBlock));
    }
  }
  return {
    watermarks,
    completedKeys,
  };
}

export function discoveryGraphCompleteThrough(
  families: readonly DiscoveryFamilySources[],
  watermarks: ReadonlyMap<string, number>,
): number {
  const values = families.map((family) =>
    discoveryFamilyCompleteThrough(family, watermarks)
  );
  return values.length > 0 ? Math.min(...values) : -1;
}

export function discoverySourceCompleteThrough(
  families: readonly DiscoveryFamilySources[],
  watermarks: ReadonlyMap<string, number>,
  sourceId: string,
  fallback: number,
): number {
  const values = families
    .filter((family) => family.sourceIds.includes(sourceId))
    .map(
      (family) =>
        watermarks.get(
          discoveryFamilySourceKey(family.familyId, sourceId),
        ) ?? -1,
    );
  return values.length > 0 ? Math.min(...values) : fallback;
}

export function discoveryFamilyCompleteThrough(
  family: DiscoveryFamilySources,
  watermarks: ReadonlyMap<string, number>,
): number {
  const values = [...new Set(family.sourceIds)].map(
    (sourceId) =>
      watermarks.get(
        discoveryFamilySourceKey(family.familyId, sourceId),
      ) ?? -1,
  );
  return values.length > 0 ? Math.min(...values) : -1;
}

function familySourceCompletedThisPass(
  familyId: string,
  sourceId: string,
  familyComplete: ReadonlyMap<string, boolean>,
  familySourceComplete: ReadonlyMap<string, boolean> | undefined,
  sourceComplete: ReadonlyMap<string, boolean>,
  sourceIssues: readonly DiscoverySourceIssue[],
): boolean {
  const exactFamilySource = familySourceComplete?.get(
    discoveryFamilySourceKey(familyId, sourceId),
  );
  if (
    exactFamilySource === undefined
      ? familyComplete.get(familyId) !== true
      : exactFamilySource !== true
  ) return false;
  const retryableForSource = sourceIssues.filter(
    (issue) => issue.retryable && issue.sourceId === sourceId,
  );
  if (
    retryableForSource.some(
      (issue) => issue.impactedFamilyIds.includes(familyId),
    )
  ) return false;
  if (sourceComplete.get(sourceId) === true) return true;
  // Aggregate source completeness can be false because one sibling family
  // failed. Explicit impacted-family attribution still lets unaffected
  // families advance independently.
  return retryableForSource.length > 0;
}

function validateRange(range: DiscoveryRange): void {
  assertBlock(range.fromBlock, "range start");
  assertBlock(range.toBlock, "range end");
  if (range.fromBlock > range.toBlock) {
    throw new Error(
      `discovery range starts after it ends ${range.fromBlock}>${range.toBlock}`,
    );
  }
}

function assertCursor(value: number): void {
  if (!Number.isSafeInteger(value) || value < -1) {
    throw new Error(`invalid discovery cursor ${value}`);
  }
}

function assertBlock(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`invalid discovery ${label} ${value}`);
  }
}

function assertPositiveSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`invalid discovery ${label} ${value}`);
  }
}
