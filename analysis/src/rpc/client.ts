import type { Hex } from "../types.js";

export class RpcClient {
  private id = 1;

  constructor(readonly url: string) {
    if (!url) throw new Error("RPC URL required via --rpc or READONLY_RPC_URL");
  }

  isLocal(): boolean {
    const host = new URL(this.url).hostname;
    return host === "localhost" || host === "127.0.0.1" || host === "[::1]";
  }

  async call<T>(method: string, params: unknown[] = []): Promise<T> {
    const body = JSON.stringify({ jsonrpc: "2.0", id: this.id++, method, params });
    const res = await fetch(this.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    if (!res.ok) throw new Error(`RPC HTTP ${res.status} for ${method}`);
    const json = await res.json() as { result?: T; error?: { message?: string; code?: number } };
    if (json.error) throw new Error(`RPC ${method} failed: ${json.error.message ?? json.error.code}`);
    return json.result as T;
  }

  async getCode(address: string, blockTag: Hex | "latest" = "latest"): Promise<string> {
    return this.call<string>("eth_getCode", [address, blockTag]);
  }

  async getLogs(filter: Record<string, unknown>): Promise<any[]> {
    return this.call<any[]>("eth_getLogs", [filter]);
  }

  async getTransaction(hash: string): Promise<any> {
    return this.call<any>("eth_getTransactionByHash", [hash]);
  }

  async getReceipt(hash: string): Promise<any> {
    return this.call<any>("eth_getTransactionReceipt", [hash]);
  }

  async getBlockByNumber(block: number, full = true): Promise<any> {
    return this.call<any>("eth_getBlockByNumber", [toQuantity(block), full]);
  }

  async traceTransaction(hash: string): Promise<any> {
    return this.call<any>("debug_traceTransaction", [
      hash,
      { tracer: "callTracer", tracerConfig: { withLog: false } },
    ]);
  }

  /** prestateTracer diffMode → { pre: {addr:{balance,...}}, post: {addr:{balance,...}} }.
   *  Only touched fields appear; an address absent from `post` means unchanged. */
  async tracePrestate(hash: string): Promise<{ pre?: Record<string, any>; post?: Record<string, any> }> {
    return this.call("debug_traceTransaction", [
      hash,
      { tracer: "prestateTracer", tracerConfig: { diffMode: true } },
    ]);
  }
}

export function toQuantity(n: number | bigint): Hex {
  return `0x${BigInt(n).toString(16)}` as Hex;
}

export function hexToBigInt(x: string | null | undefined): bigint {
  if (!x || x === "0x") return 0n;
  return BigInt(x);
}

export function hexToNumber(x: string | null | undefined): number {
  return Number(hexToBigInt(x));
}
