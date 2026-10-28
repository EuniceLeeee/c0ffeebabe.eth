import { AsyncLocalStorage } from "node:async_hooks";

/** Diagnostic evidence only. No scheduling, decoding, or admission authority. */
export interface AdapterRequestObservation {
  revertedResults: number;
}
const observation = new AsyncLocalStorage<AdapterRequestObservation>();

export function observeAdapterRequests<T>(
  counters: AdapterRequestObservation,
  operation: () => Promise<T>,
): Promise<T> {
  return observation.run(counters, operation);
}

/** Call only after the request's source/generation fence passed. A declared
 * revert may encode a successful quote, so this is not a quote-failure count. */
export function recordAdapterRequestCompletion(completion: string): void {
  const counters = observation.getStore();
  if (counters && completion === "reverted-as-declared") counters.revertedResults++;
}
