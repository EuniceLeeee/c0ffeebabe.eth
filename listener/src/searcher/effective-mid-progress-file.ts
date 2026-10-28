import { randomUUID } from "node:crypto";
import { closeSync, openSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { EffectiveMidProgress } from "./blockscan-effective-mid.js";

/** A bounded snapshot independent of the child stdout pipe. The existing
 * private event directory owns its lifecycle; this adds no quote authority. */
export function writeEffectiveMidProgress(eventsPath: string, progress: EffectiveMidProgress): void {
  if (!eventsPath) return;
  const path = join(dirname(eventsPath), "effective-mid-progress.json");
  const temporary = path + "." + randomUUID();
  let created = false;
  try {
    const fd = openSync(temporary, "wx", 0o600);
    created = true;
    try { writeFileSync(fd, JSON.stringify(progress) + "\n"); }
    finally { closeSync(fd); }
    renameSync(temporary, path);
  } finally {
    if (created) {
      try { unlinkSync(temporary); } catch { /* Renamed or already gone. */ }
    }
  }
}
