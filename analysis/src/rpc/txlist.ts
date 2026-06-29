import { RpcClient } from "./client.js";

interface AssetTransfer {
  hash: string;
  blockNum?: string;
  from?: string;
  to?: string;
}

interface AssetTransferResponse {
  transfers: AssetTransfer[];
  pageKey?: string;
}

export async function txHashesForAddress(
  rpc: RpcClient,
  address: string,
  limit: number,
): Promise<string[]> {
  const hashes = new Set<string>();
  for (const direction of ["fromAddress", "toAddress"] as const) {
    let pageKey: string | undefined;
    while (hashes.size < limit) {
      const params: any = [{
        fromBlock: "0x0",
        toBlock: "latest",
        category: ["external", "erc20", "internal"],
        withMetadata: false,
        maxCount: `0x${Math.min(100, limit).toString(16)}`,
        order: "desc",
        excludeZeroValue: false,
        [direction]: address,
      }];
      if (pageKey) params[0].pageKey = pageKey;
      let res: AssetTransferResponse;
      try {
        res = await rpc.call<AssetTransferResponse>("alchemy_getAssetTransfers", params);
      } catch (err) {
        if (direction === "fromAddress" && hashes.size === 0) {
          throw new Error(
            "txlist requires an Alchemy-compatible RPC for now (alchemy_getAssetTransfers unavailable)",
          );
        }
        break;
      }
      for (const t of res.transfers) {
        if (t.hash) hashes.add(t.hash);
        if (hashes.size >= limit) break;
      }
      pageKey = res.pageKey;
      if (!pageKey) break;
    }
  }
  return [...hashes].slice(0, limit);
}
