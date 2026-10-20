import assert from "node:assert/strict";
import { ethers } from "ethers";

/** Parse only: this provider never sends a request or owns a retry loop. Keep
 * ethers' original RPC error/info contract for the central runtime to decide
 * execution revert versus transport failure. HTTP failure is never a revert. */
export function historicalRpcResponse(payload: ethers.JsonRpcPayload, status: number, body: any): unknown {
  if (status < 200 || status >= 300) throw Object.assign(new Error(`RPC HTTP ${status}`), {
    code: "SERVER_ERROR", status, info: { payload, error: body?.error },
  });
  assert.equal(body?.id, payload.id); assert.equal(body?.jsonrpc, "2.0");
  if (body.error) {
    assert(typeof body.error === "object" && typeof body.error.message === "string");
    const parser = new ethers.JsonRpcProvider(undefined, 1, { staticNetwork: true });
    try { throw parser.getRpcError(payload, body); } finally { parser.destroy(); }
  }
  assert(Object.hasOwn(body, "result"), "RPC response has neither result nor error"); return body.result;
}
