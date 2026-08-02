import assert from "node:assert/strict";
import { LiveRethReadPriority } from "../live-reth-read-priority.js";

await criticalPreemptsDrainsAndRetriesBackground();
await foregroundPreemptsDrainsAndRetriesBackground();
await announcedCriticalClosesBackgroundAdmissionRace();
await announcedForegroundClosesBackgroundAdmissionRace();
await backgroundWaitsForQueuedCriticalWork();
await abortedQueuedCriticalNeverStartsOrBlocksItsSuccessor();
await backgroundWaitsForAllForegroundWork();
await foregroundMayNestCriticalWork();
await externalAbortWhileWaitingDoesNotStartOrRetry();
await externalAbortDuringAttemptTerminatesWithoutRetry();
await foregroundLetsOneOptedInAttemptFinishExclusively();
await foregroundRetainsAtMostOneOptedInAttempt();
await foregroundBoundsAndRetriesStuckOptedInAttempt();

console.log("[live-reth-read-priority] preemption/abort: PASS (13/13)");

async function criticalPreemptsDrainsAndRetriesBackground(): Promise<void> {
  const priority = new LiveRethReadPriority();
  const firstStarted = deferred();
  const firstAbortObserved = deferred();
  const allowFirstCleanup = deferred();
  const criticalStarted = deferred();
  const allowCritical = deferred();
  const events: string[] = [];
  let attempts = 0;

  const background = priority.runBackground(async (signal) => {
    attempts++;
    events.push(`background-${attempts}-start`);
    if (attempts === 1) {
      firstStarted.resolve();
      await aborted(signal);
      firstAbortObserved.resolve();
      await allowFirstCleanup.promise;
      events.push("background-1-cleaned");
      throw signal.reason;
    }
    events.push("background-2-complete");
    return "retried";
  });
  await firstStarted.promise;

  const critical = priority.runCritical(async () => {
    events.push("critical-start");
    criticalStarted.resolve();
    await allowCritical.promise;
    events.push("critical-complete");
  });
  await firstAbortObserved.promise;
  assert.equal(
    criticalStarted.isResolved(),
    false,
    "critical work must wait for the cancelled transport attempt to settle",
  );

  allowFirstCleanup.resolve();
  await criticalStarted.promise;
  assert.equal(attempts, 1, "background must not retry during critical work");
  allowCritical.resolve();
  await critical;
  assert.equal(await background, "retried");
  assert.equal(attempts, 2);
  assert.deepEqual(events, [
    "background-1-start",
    "background-1-cleaned",
    "critical-start",
    "critical-complete",
    "background-2-start",
    "background-2-complete",
  ]);
}

async function foregroundPreemptsDrainsAndRetriesBackground(): Promise<void> {
  const priority = new LiveRethReadPriority();
  const firstStarted = deferred();
  const firstAbortObserved = deferred();
  const allowFirstCleanup = deferred();
  const foregroundStarted = deferred();
  const allowForeground = deferred();
  const events: string[] = [];
  let attempts = 0;

  const background = priority.runBackground(async (signal) => {
    attempts++;
    events.push(`background-${attempts}-start`);
    if (attempts === 1) {
      firstStarted.resolve();
      await aborted(signal);
      firstAbortObserved.resolve();
      await allowFirstCleanup.promise;
      events.push("background-1-cleaned");
      throw signal.reason;
    }
    events.push("background-2-complete");
    return "retried";
  });
  await firstStarted.promise;

  const foreground = priority.runForeground(async () => {
    events.push("foreground-start");
    foregroundStarted.resolve();
    await allowForeground.promise;
    events.push("foreground-complete");
  });
  await firstAbortObserved.promise;
  assert.equal(
    foregroundStarted.isResolved(),
    false,
    "foreground work must drain the cancelled transport attempt first",
  );

  allowFirstCleanup.resolve();
  await foregroundStarted.promise;
  assert.equal(attempts, 1, "background must wait for foreground work");
  allowForeground.resolve();
  await foreground;
  assert.equal(await background, "retried");
  assert.deepEqual(events, [
    "background-1-start",
    "background-1-cleaned",
    "foreground-start",
    "foreground-complete",
    "background-2-start",
    "background-2-complete",
  ]);
}

async function announcedCriticalClosesBackgroundAdmissionRace(): Promise<void> {
  const priority = new LiveRethReadPriority();
  const releaseCritical = deferred();
  const events: string[] = [];

  const background = priority.runBackground(async () => {
    events.push("background");
  });
  const critical = priority.runCritical(async () => {
    events.push("critical-start");
    await releaseCritical.promise;
    events.push("critical-end");
  });

  await nextTurn();
  assert.deepEqual(events, ["critical-start"]);
  releaseCritical.resolve();
  await Promise.all([critical, background]);
  assert.deepEqual(events, ["critical-start", "critical-end", "background"]);
}

async function announcedForegroundClosesBackgroundAdmissionRace(): Promise<void> {
  const priority = new LiveRethReadPriority();
  const releaseForeground = deferred();
  const events: string[] = [];

  const background = priority.runBackground(async () => {
    events.push("background");
  });
  const foreground = priority.runForeground(async () => {
    events.push("foreground-start");
    await releaseForeground.promise;
    events.push("foreground-end");
  });

  await nextTurn();
  assert.deepEqual(events, ["foreground-start"]);
  releaseForeground.resolve();
  await Promise.all([foreground, background]);
  assert.deepEqual(events, [
    "foreground-start",
    "foreground-end",
    "background",
  ]);
}

async function backgroundWaitsForQueuedCriticalWork(): Promise<void> {
  const priority = new LiveRethReadPriority();
  const releaseFirst = deferred();
  const firstStarted = deferred();
  const secondStarted = deferred();
  const events: string[] = [];

  const first = priority.runCritical(async () => {
    events.push("critical-1-start");
    firstStarted.resolve();
    await releaseFirst.promise;
    events.push("critical-1-end");
  });
  await firstStarted.promise;
  const second = priority.runCritical(async () => {
    events.push("critical-2");
    secondStarted.resolve();
  });
  let backgroundStarted = false;
  const background = priority.runBackground(async () => {
    backgroundStarted = true;
    events.push("background");
    return 7;
  });

  await nextTurn();
  assert.equal(backgroundStarted, false);
  releaseFirst.resolve();
  await secondStarted.promise;
  assert.equal(backgroundStarted, false, "queued critical work keeps priority");
  await Promise.all([first, second]);
  assert.equal(await background, 7);
  assert.deepEqual(events, [
    "critical-1-start",
    "critical-1-end",
    "critical-2",
    "background",
  ]);
}

async function abortedQueuedCriticalNeverStartsOrBlocksItsSuccessor(): Promise<void> {
  const priority = new LiveRethReadPriority();
  const firstStarted = deferred();
  const releaseFirst = deferred();
  const thirdStarted = deferred();
  const events: string[] = [];

  const first = priority.runCritical(async () => {
    events.push("critical-1-start");
    firstStarted.resolve();
    await releaseFirst.promise;
    events.push("critical-1-end");
  });
  await firstStarted.promise;

  const cancelled = new AbortController();
  let cancelledWorkStarted = false;
  const second = priority.runCritical(async () => {
    cancelledWorkStarted = true;
    events.push("critical-2");
  }, cancelled.signal);
  const third = priority.runCritical(async () => {
    events.push("critical-3");
    thirdStarted.resolve();
  });

  cancelled.abort(new Error("queued critical deadline reached"));
  await assert.rejects(
    settlesBefore(second, 20),
    /queued critical deadline reached/,
  );
  assert.equal(cancelledWorkStarted, false);
  assert.equal(
    thirdStarted.isResolved(),
    false,
    "a cancelled queued turn must not let its successor overlap active work",
  );

  releaseFirst.resolve();
  await Promise.all([first, thirdStarted.promise, third]);
  assert.equal(cancelledWorkStarted, false);
  assert.deepEqual(events, [
    "critical-1-start",
    "critical-1-end",
    "critical-3",
  ]);
}

async function backgroundWaitsForAllForegroundWork(): Promise<void> {
  const priority = new LiveRethReadPriority();
  const firstStarted = deferred();
  const secondStarted = deferred();
  const releaseFirst = deferred();
  const releaseSecond = deferred();
  let backgroundStarted = false;

  const first = priority.runForeground(async () => {
    firstStarted.resolve();
    await releaseFirst.promise;
  });
  const second = priority.runForeground(async () => {
    secondStarted.resolve();
    await releaseSecond.promise;
  });
  await Promise.all([firstStarted.promise, secondStarted.promise]);
  const background = priority.runBackground(async () => {
    backgroundStarted = true;
  });

  releaseFirst.resolve();
  await first;
  await nextTurn();
  assert.equal(
    backgroundStarted,
    false,
    "one remaining foreground lease must keep background work paused",
  );
  releaseSecond.resolve();
  await Promise.all([second, background]);
  assert.equal(backgroundStarted, true);
}

async function foregroundMayNestCriticalWork(): Promise<void> {
  const priority = new LiveRethReadPriority();
  const events: string[] = [];
  await priority.runForeground(async () => {
    events.push("foreground-start");
    await priority.runCritical(async () => {
      events.push("critical");
    });
    events.push("foreground-end");
  });
  assert.deepEqual(events, [
    "foreground-start",
    "critical",
    "foreground-end",
  ]);
}

async function externalAbortWhileWaitingDoesNotStartOrRetry(): Promise<void> {
  const priority = new LiveRethReadPriority();
  const criticalStarted = deferred();
  const releaseCritical = deferred();
  const critical = priority.runCritical(async () => {
    criticalStarted.resolve();
    await releaseCritical.promise;
  });
  await criticalStarted.promise;

  const parent = new AbortController();
  let attempts = 0;
  const background = priority.runBackground(async () => {
    attempts++;
    return "unexpected";
  }, parent.signal);
  parent.abort(new Error("caller stopped while waiting"));
  await assert.rejects(background, /caller stopped while waiting/);
  assert.equal(attempts, 0);

  releaseCritical.resolve();
  await critical;
  await nextTurn();
  assert.equal(attempts, 0, "external abort must never schedule a retry");
}

async function externalAbortDuringAttemptTerminatesWithoutRetry(): Promise<void> {
  const priority = new LiveRethReadPriority();
  const parent = new AbortController();
  const started = deferred();
  const allowTransportCleanup = deferred();
  let attempts = 0;
  const background = priority.runBackground(async (signal) => {
    attempts++;
    started.resolve();
    await aborted(signal);
    await allowTransportCleanup.promise;
    throw signal.reason;
  }, parent.signal);
  await started.promise;

  parent.abort(new Error("caller stopped active attempt"));
  await assert.rejects(
    settlesBefore(background, 20),
    /timed out after 20ms/,
    "caller cancellation must retain the transport settle barrier",
  );
  assert.equal(attempts, 1);
  allowTransportCleanup.resolve();
  await assert.rejects(background, /caller stopped active attempt/);
  assert.equal(attempts, 1, "caller cancellation must not be retried");
}

async function foregroundLetsOneOptedInAttemptFinishExclusively(): Promise<void> {
  const priority = new LiveRethReadPriority();
  const backgroundStarted = deferred();
  const releaseBackground = deferred();
  const foregroundStarted = deferred();
  const events: string[] = [];

  const background = priority.runBackground(async (signal) => {
    events.push("background-start");
    backgroundStarted.resolve();
    await releaseBackground.promise;
    assert.equal(signal.aborted, false);
    events.push("background-complete");
    return 7;
  }, undefined, { foregroundHandoffMs: 50 });
  await backgroundStarted.promise;

  const foreground = priority.runForeground(async () => {
    events.push("foreground");
    foregroundStarted.resolve();
  });
  await nextTurn();
  assert.equal(
    foregroundStarted.isResolved(),
    false,
    "foreground must wait for the one retained background RPC",
  );
  releaseBackground.resolve();
  assert.equal(await background, 7);
  await foreground;
  assert.deepEqual(events, [
    "background-start",
    "background-complete",
    "foreground",
  ]);
}

async function foregroundRetainsAtMostOneOptedInAttempt(): Promise<void> {
  const priority = new LiveRethReadPriority();
  const firstStarted = deferred();
  const secondStarted = deferred();
  const secondAborted = deferred();
  const releaseFirst = deferred();
  const releaseForeground = deferred();
  const foregroundStarted = deferred();
  let secondAttempts = 0;

  const first = priority.runBackground(async (signal) => {
    firstStarted.resolve();
    await releaseFirst.promise;
    assert.equal(signal.aborted, false);
    return "first";
  }, undefined, { foregroundHandoffMs: 50 });
  await firstStarted.promise;

  const second = priority.runBackground(async (signal) => {
    secondAttempts++;
    if (secondAttempts === 1) {
      secondStarted.resolve();
      await aborted(signal);
      secondAborted.resolve();
      throw signal.reason;
    }
    return "second-retried";
  }, undefined, { foregroundHandoffMs: 50 });
  await secondStarted.promise;

  const foreground = priority.runForeground(async () => {
    foregroundStarted.resolve();
    await releaseForeground.promise;
  });
  await settlesBefore(secondAborted.promise, 20);
  assert.equal(
    foregroundStarted.isResolved(),
    false,
    "only one background RPC may receive the exclusive handoff",
  );
  releaseFirst.resolve();
  assert.equal(await first, "first");
  await foregroundStarted.promise;
  assert.equal(secondAttempts, 1);
  releaseForeground.resolve();
  await foreground;
  assert.equal(await second, "second-retried");
  assert.equal(secondAttempts, 2);
}

async function foregroundBoundsAndRetriesStuckOptedInAttempt(): Promise<void> {
  const priority = new LiveRethReadPriority();
  const firstStarted = deferred();
  const firstAborted = deferred();
  const releaseForeground = deferred();
  const foregroundStarted = deferred();
  let attempts = 0;

  const background = priority.runBackground(async (signal) => {
    attempts++;
    if (attempts === 1) {
      firstStarted.resolve();
      await aborted(signal);
      firstAborted.resolve();
      throw signal.reason;
    }
    return "retried";
  }, undefined, { foregroundHandoffMs: 5 });
  await firstStarted.promise;

  const foreground = priority.runForeground(async () => {
    foregroundStarted.resolve();
    await releaseForeground.promise;
  });
  await settlesBefore(firstAborted.promise, 50);
  await foregroundStarted.promise;
  assert.equal(attempts, 1, "retry must wait until foreground releases reth");
  releaseForeground.resolve();
  await foreground;
  assert.equal(await background, "retried");
  assert.equal(attempts, 2);
}

function aborted(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

function deferred(): {
  readonly promise: Promise<void>;
  resolve(): void;
  isResolved(): boolean;
} {
  let resolved = false;
  let resolvePromise!: () => void;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve() {
      resolved = true;
      resolvePromise();
    },
    isResolved: () => resolved,
  };
}

async function nextTurn(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

async function settlesBefore<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`timed out after ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
