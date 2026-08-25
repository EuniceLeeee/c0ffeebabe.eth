import type { AdapterRequestResult } from "./adapter-request-program.js";

/**
 * Shared Family/kernel contract for an optional request whose transport did
 * not resolve. Families may surface this typed uncertainty without importing
 * the central request-program issuer or scheduler implementation.
 */
export class RequiredAdapterRequestError extends Error {
  readonly failureCode: Extract<
    AdapterRequestResult,
    { readonly ok: false }
  >["failure"];

  constructor(result: Extract<AdapterRequestResult, { readonly ok: false }>) {
    super(`required adapter request ${result.id} failed: ${result.failure}`);
    this.name = "RequiredAdapterRequestError";
    this.failureCode = result.failure;
  }
}
