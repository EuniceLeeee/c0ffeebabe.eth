export interface BlockScanStageTiming {
  stateMs: number;
  enumerationMs: number;
  exactRefineMs: number;
  plannerSolverMs: number;
  finalSimMs: number;
  evMs: number;
}

export type BlockScanPhysicalStage =
  | "state"
  | "enumeration"
  | "exact_refine"
  | "planner_solver"
  | "final_sim"
  | "ev";

export interface BlockScanStageBoundary {
  status: "ran" | "failed" | "not-run";
  started_at_ms: number | null;
  finished_at_ms: number | null;
  stage_ms: number;
  cumulative_ms: number | null;
}

/**
 * Strict source-head timeline shared by ordinary and blind block-scan runs.
 * It rejects overlapping/out-of-order stages and keeps source-listener queue
 * delay inside the same end-to-end budget.
 */
export class BlockScanPassTimeline {
  readonly timing: BlockScanStageTiming = {
    stateMs: 0,
    enumerationMs: 0,
    exactRefineMs: 0,
    plannerSolverMs: 0,
    finalSimMs: 0,
    evMs: 0,
  };

  readonly boundaries = Object.fromEntries(
    ([
      "state",
      "enumeration",
      "exact_refine",
      "planner_solver",
      "final_sim",
      "ev",
    ] satisfies BlockScanPhysicalStage[]).map((stage) => [
      stage,
      {
        status: "not-run",
        started_at_ms: null,
        finished_at_ms: null,
        stage_ms: 0,
        cumulative_ms: null,
      } satisfies BlockScanStageBoundary,
    ]),
  ) as Record<BlockScanPhysicalStage, BlockScanStageBoundary>;

  private active: {
    readonly name: BlockScanPhysicalStage;
    readonly startedAtMs: number;
    readonly startedAtPerf: number;
  } | null = null;

  constructor(readonly sourceHeadSeenAtMs: number) {}

  activeStage(): BlockScanPhysicalStage | null {
    return this.active?.name ?? null;
  }

  begin(
    name: BlockScanPhysicalStage,
    started: {
      readonly atMs: number;
      readonly atPerf: number;
    } = { atMs: Date.now(), atPerf: performance.now() },
  ): void {
    if (this.active) {
      throw new Error(
        `block-scan stage ${name} began before ${this.active.name} finished`,
      );
    }
    this.active = {
      name,
      startedAtMs: started.atMs,
      startedAtPerf: started.atPerf,
    };
  }

  finish(
    name: BlockScanPhysicalStage,
    status: "ran" | "failed" = "ran",
  ): void {
    if (!this.active || this.active.name !== name) {
      throw new Error(`block-scan stage ${name} finished out of order`);
    }
    const finishedAtMs = Date.now();
    const boundary = this.boundaries[name];
    boundary.status = status;
    boundary.started_at_ms = this.active.startedAtMs;
    boundary.finished_at_ms = finishedAtMs;
    boundary.stage_ms = Math.max(
      0,
      performance.now() - this.active.startedAtPerf,
    );
    boundary.cumulative_ms = Math.max(
      0,
      finishedAtMs - this.sourceHeadSeenAtMs,
    );
    this.active = null;
    switch (name) {
      case "state":
        this.timing.stateMs = boundary.stage_ms;
        break;
      case "enumeration":
        this.timing.enumerationMs = boundary.stage_ms;
        break;
      case "exact_refine":
        this.timing.exactRefineMs = boundary.stage_ms;
        break;
      case "planner_solver":
        this.timing.plannerSolverMs = boundary.stage_ms;
        break;
      case "final_sim":
      case "ev":
        // These stages merge per-route atomic measurements below.
        break;
    }
  }

  mergeAtomic(
    name: "final_sim" | "ev",
    startedAtMs: number | null,
    finishedAtMs: number | null,
    stageMs: number,
  ): void {
    if (startedAtMs === null || finishedAtMs === null) return;
    const boundary = this.boundaries[name];
    boundary.status = "ran";
    boundary.started_at_ms = boundary.started_at_ms === null
      ? startedAtMs
      : Math.min(boundary.started_at_ms, startedAtMs);
    boundary.finished_at_ms = boundary.finished_at_ms === null
      ? finishedAtMs
      : Math.max(boundary.finished_at_ms, finishedAtMs);
    boundary.stage_ms += stageMs;
    boundary.cumulative_ms = Math.max(
      0,
      boundary.finished_at_ms - this.sourceHeadSeenAtMs,
    );
    if (name === "final_sim") this.timing.finalSimMs += stageMs;
    else this.timing.evMs += stageMs;
  }
}
