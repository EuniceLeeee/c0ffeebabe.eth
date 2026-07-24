import assert from "node:assert/strict";
import {
  awaitBlockScanDeadline,
  BlockScanPassDeadlineError,
} from "../blockscan-pass-deadline.js";

assert.equal(
  await awaitBlockScanDeadline(Promise.resolve(7), Date.now() + 100, "fast"),
  7,
);

let reaped = false;
const never = new Promise<number>(() => {});
const startedAt = Date.now();
await assert.rejects(
  awaitBlockScanDeadline(
    never,
    startedAt + 20,
    "final simulation",
    () => {
      reaped = true;
    },
  ),
  (error) =>
    error instanceof BlockScanPassDeadlineError &&
    error.stage === "final simulation",
);
assert.equal(reaped, true, "deadline must synchronously start worker reaping");
assert(
  Date.now() - startedAt < 250,
  "a never-settling stage must not hold the pass terminal",
);

let lateResolve!: (value: number) => void;
const late = new Promise<number>((resolve) => {
  lateResolve = resolve;
});
await assert.rejects(
  awaitBlockScanDeadline(late, Date.now() - 1, "EV evaluation"),
  BlockScanPassDeadlineError,
);
lateResolve(9);
await new Promise((resolve) => setTimeout(resolve, 0));

console.log("blockscan-pass-deadline PASS (3/3)");
