/** Deterministic rejection of one amount, not a source/transport/adapter fault.
 * Only the boundary with concrete amount evidence may construct this error. */
export class AmountNotExecutableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AmountNotExecutableError";
  }
}
