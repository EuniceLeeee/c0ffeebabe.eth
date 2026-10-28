import { FetchRequest, JsonRpcProvider } from "ethers";
import type { BlockTouchedProvider } from "./blockscan-touched-state.js";

/** Independent batch queues: a slow trace response cannot hold a log/header
 * response in the same HTTP batch. Both lanes retain ordinary RPC batching.
 * Effective/Exact quote transports and their CU scheduler are unchanged. */
export function createBlockScanActivityTransport(rpcUrl: string): BlockTouchedProvider & { destroy(): void } {
  const provider = () => {
    const request = new FetchRequest(rpcUrl);
    request.timeout = 30_000;
    return new JsonRpcProvider(request);
  };
  const light = provider(), trace = provider();
  return {
    getLogs: filter => light.getLogs(filter),
    send: (method, params) => (method.startsWith("debug_trace") || method.startsWith("trace_")
      ? trace : light).send(method, params),
    destroy() { light.destroy(); trace.destroy(); },
  };
}
