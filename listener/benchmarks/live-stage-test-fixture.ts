import { LatestHeadScheduler } from "../src/searcher/latest-head-scheduler.js";
import type { BlockScanRuntimeLoop } from "../src/searcher/blockscan-runtime-loop.js";

/** Fake I/O stages, but the real scheduler/drain for timer-boundary unit tests. */
export function scheduledFixture(stages: Pick<BlockScanRuntimeLoop, "runHead">) {
  type Diagnostic = NonNullable<Parameters<BlockScanRuntimeLoop["runHead"]>[2]>;
  let diagnostic: Diagnostic | undefined;
  const loop = new LatestHeadScheduler((number, observation) => stages.runHead(number, observation, diagnostic),
    (_number, error) => { throw error; });
  return { loop, setDiagnostic: (value: Diagnostic | undefined) => { diagnostic = value; } };
}
