import assert from "node:assert/strict";
import { ethers } from "ethers";
import type { AdapterRequestResult } from "../../../adapter-request-program.js";
export const quoteBoundaryRequirements = { transports: ["eth-call"] as const, caller: "executor" as const,
  completions: ["return-or-revert-data"] as const, effects: ["revert-data"] as const };
export function assertChainQuoteRevert(result: AdapterRequestResult): void {
  assert(result.ok,"a quote transport failure is not a state rejection");
  assert.equal(result.completion,"reverted-as-declared","a failed Family quote is not an on-chain quote rejection");
  assert(ethers.isHexString(result.data,true)&&ethers.dataLength(result.data)>=4,"quote rejection must retain its revert data");
}

/** Keep genuine eth_call revert bytes for the existing central decoder. RPC
 * failures (including rate limits with a data field) carry no EVM evidence. */
export function rpcResult(method: string, id: number, body: unknown): unknown {
  assert(body && typeof body === "object" && !Array.isArray(body), "invalid RPC envelope");
  const value = body as Record<string, any>;
  assert.equal(value.jsonrpc, "2.0"); assert.equal(value.id, id);
  if (value.error !== undefined) {
    const raw = value.error;
    assert(raw && typeof raw === "object" && Number.isInteger(raw.code) && typeof raw.message === "string", "invalid RPC error");
    assert(!Object.hasOwn(value, "result"), "ambiguous RPC envelope");
    const error = Object.assign(new Error(`RPC ${method} failed (${raw.code})`), { code: raw.code });
    const evmRevert = method === "eth_call" && (raw.code === 3 ||
      [-32000, -32015, -32603].includes(raw.code) && /\bexecution reverted\b/i.test(raw.message));
    if (evmRevert && ethers.isHexString(raw.data, true)) Object.assign(error, { data: raw.data });
    throw error;
  }
  assert(Object.hasOwn(value, "result"), "missing RPC result");
  return value.result;
}
