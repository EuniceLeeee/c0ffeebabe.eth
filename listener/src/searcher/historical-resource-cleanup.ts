/** The same cleanup routine is used by the historical CLI and its isolated
 * process-liveness regression; importing it does not initialize a catalog. */
export async function cleanupHistoricalResources(actions: readonly (() => unknown | Promise<unknown>)[], runFailed: boolean): Promise<void> {
  // A run deadline may already have fired. An unresolved Promise and the
  // production worker's unref'ed timers do not keep a CLI process alive.
  const keepAlive = setInterval(() => {}, 60_000);
  const errors: unknown[] = [];
  try {
    for (const action of actions) { try { await action(); } catch (error) { errors.push(error); } }
  } finally { clearInterval(keepAlive); }
  // Preserve the original pass failure, but a failed evidence drain must never
  // turn an otherwise successful run into a successful receipt.
  if (errors.length && !runFailed) throw errors[0];
}
