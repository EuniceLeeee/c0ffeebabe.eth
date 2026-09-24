/** Missing route-composition capability, not an unhealthy Family or transport. */
export class SequentialQuoteUnsupportedError extends Error {
  readonly code = "SEQUENTIAL_QUOTE_UNSUPPORTED";
  constructor() { super("exact-sequential-prefix-unsupported"); }
}
