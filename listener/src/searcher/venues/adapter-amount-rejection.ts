/** The Family proved this amount unavailable at the supplied trial state. */
export class ExactAmountRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExactAmountRejectedError";
  }
}
