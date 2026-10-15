import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { BuilderEvidence, BuilderEvidenceSink } from "./builder-observations.js";

// Only local timing evidence that cannot be reconstructed later. No builder polling.
const CLOCK_INTERVAL_MS = 300_000;
type ClockReading = {
  status: "synchronized" | "unsynchronized" | "unavailable";
  system_time_offset_seconds: number | null;
  last_offset_seconds: number | null;
  rms_offset_seconds: number | null;
  root_delay_seconds: number | null;
  root_dispersion_seconds: number | null;
  reference_updated_at_ms: number | null;
};
const unavailable = (): ClockReading => ({ status: "unavailable", system_time_offset_seconds: null,
  last_offset_seconds: null, rms_offset_seconds: null, root_delay_seconds: null,
  root_dispersion_seconds: null, reference_updated_at_ms: null });

/** chronyc CSV includes an address: only numeric timing fields leave this parser. */
export function parseChronyTracking(text: string): ClockReading {
  const fields = text.trim().split(",");
  if (fields.length !== 14) return unavailable();
  const positions = [2, 3, 4, 5, 6, 10, 11];
  if (positions.some(i => !fields[i]!.trim() || !Number.isFinite(Number(fields[i])))) return unavailable();
  const [stratum, reference, system, last, rms, delay, dispersion] = positions.map(i => Number(fields[i]));
  if (!Number.isInteger(stratum) || stratum! < 0 || stratum! > 16 || reference! < 0 ||
      rms! < 0 || delay! < 0 || dispersion! < 0) return unavailable();
  return { status: fields[13] === "Normal" && stratum! > 0 && stratum! < 16 ? "synchronized" : "unsynchronized",
    system_time_offset_seconds: system!, last_offset_seconds: last!, rms_offset_seconds: rms!,
    root_delay_seconds: delay!, root_dispersion_seconds: dispersion!, reference_updated_at_ms: reference! * 1000 };
}

export function readHostClock(): Promise<ClockReading> {
  return new Promise(resolve => {
    execFile("chronyc", ["-n", "-c", "tracking"], { timeout: 1_000, maxBuffer: 8_192, encoding: "utf8",
      env: { PATH: process.env.PATH, LC_ALL: "C" } },
      (error, stdout) => resolve(error ? unavailable() : parseChronyTracking(stdout)));
  });
}

/** Local clock/head observations only. Builder state is queried offline during postmortem. */
export class SubmissionFollowup {
  private readonly heads = new Set<string>();
  private clockTimer?: ReturnType<typeof setInterval>;
  private clockActive?: Promise<void>;
  private stopped = false;
  private clockId: string | null = null;
  private readonly now: () => number;

  constructor(private readonly input: {
    evidence: BuilderEvidenceSink;
    onError: () => void;
    monotonicNow?: () => number;
    readClock?: () => Promise<ClockReading>;
  }) { this.now = input.monotonicNow ?? (() => performance.now()); }

  start(): void {
    if (this.clockTimer || this.stopped) return;
    const background = (task: Promise<void>): void => { void task.catch(() => this.input.onError()); };
    this.clockTimer = setInterval(() => background(this.sampleClock()), CLOCK_INTERVAL_MS);
    this.clockTimer.unref();
    background(this.sampleClock());
  }

  sampleClock(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.clockActive) return this.clockActive;
    this.clockActive = (async () => {
      const reading = await (this.input.readClock ?? readHostClock)();
      if (this.stopped) return;
      this.clockId = randomUUID();
      this.emit({ type: "submission_clock_snapshot", clock_snapshot_id: this.clockId,
        source: "chronyc_tracking", offset_convention: "chronyc_signed_system_time_seconds",
        ...reading });
    })().finally(() => { this.clockActive = undefined; });
    return this.clockActive;
  }

  noteHead(number: number, hash: string | null, transport: "ws" | "http" | "startup"): void {
    if (this.stopped || !Number.isSafeInteger(number) || number <= 0 ||
      (hash !== null && !/^0x[0-9a-f]{64}$/i.test(hash))) return;
    const key = `${number}:${hash?.toLowerCase() ?? "unknown"}:${transport}`;
    if (this.heads.has(key)) return;
    this.heads.add(key);
    if (this.heads.size > 512) this.heads.delete(this.heads.values().next().value!);
    this.emit({ type: "submission_head_observed", block_number: number, block_hash: hash?.toLowerCase() ?? null,
      transport, authority: "local_advisory_observation_not_canonical_or_builder_time",
      clock_snapshot_id: this.clockId });
  }

  async close(): Promise<void> {
    this.stopped = true;
    clearInterval(this.clockTimer);
    await this.clockActive;
  }

  private emit(event: BuilderEvidence): void {
    this.input.evidence({ ...event, observed_at_ms: Date.now(), observed_at_monotonic_ms: this.now(),
      monotonic_time_origin_ms: performance.timeOrigin });
  }
}
