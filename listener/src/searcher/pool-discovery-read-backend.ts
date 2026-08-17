import { ethers } from "ethers";
import type {
  LandedPoolDiscoveryLogFilter,
  LandedPoolDiscoveryReadBackend,
} from "./venues/landed-pool-discovery.js";

/**
 * Bind metadata reads to one canonical block hash. This is transport only;
 * it does not discover, admit, rank, or publish pools.
 */
export function pinProviderCallsToBlock(
  provider: ethers.JsonRpcProvider,
  blockNumber: number,
  blockHash: string,
): ethers.JsonRpcProvider {
  if (!Number.isSafeInteger(blockNumber) || blockNumber < 0) {
    throw new Error("pool metadata block must be a non-negative safe integer");
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(blockHash)) {
    throw new Error("pool metadata block hash must be bytes32");
  }
  const blockTag = Object.freeze({
    blockHash: blockHash.toLowerCase(),
    requireCanonical: true,
  });
  return new Proxy(provider, {
    get(target, property) {
      if (property === "call") {
        return (request: ethers.TransactionRequest) =>
          target.send("eth_call", [pinnedRpcTransaction(request), blockTag]);
      }
      if (property === "getCode") {
        return (address: string) =>
          target.send("eth_getCode", [address, blockTag]);
      }
      if (property === "send") {
        return (method: string, params: unknown[]) => {
          if (method === "eth_call") {
            const pinned = [...params];
            pinned[1] = blockTag;
            return target.send(method, pinned);
          }
          return target.send(method, params);
        };
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function pinnedRpcTransaction(
  request: ethers.TransactionRequest,
): Record<string, string> {
  const transaction: Record<string, string> = {};
  if (request.to !== undefined && request.to !== null) {
    transaction.to = String(request.to);
  }
  if (request.from !== undefined && request.from !== null) {
    transaction.from = String(request.from);
  }
  if (request.data !== undefined && request.data !== null) {
    transaction.data = ethers.hexlify(request.data);
  }
  if (request.value !== undefined && request.value !== null) {
    transaction.value = ethers.toQuantity(request.value);
  }
  if (request.gasLimit !== undefined && request.gasLimit !== null) {
    transaction.gas = ethers.toQuantity(request.gasLimit);
  }
  if (request.gasPrice !== undefined && request.gasPrice !== null) {
    transaction.gasPrice = ethers.toQuantity(request.gasPrice);
  }
  return transaction;
}

/** Route logs to the historical provider only below the explicit boundary. */
export function createSplitHorizonPoolDiscoveryBackend(
  stateProvider: Pick<ethers.JsonRpcProvider, "call" | "getCode" | "send">,
  logProvider: Pick<ethers.JsonRpcProvider, "send"> = stateProvider,
  historicalLogProvider: Pick<ethers.JsonRpcProvider, "send"> = logProvider,
  historicalBeforeBlock = 0,
): LandedPoolDiscoveryReadBackend {
  return {
    getLogs(filter: LandedPoolDiscoveryLogFilter) {
      const selectedLogProvider = filter.fromBlock < historicalBeforeBlock
        ? historicalLogProvider
        : logProvider;
      return selectedLogProvider.send("eth_getLogs", [{
        ...(filter.address === undefined ? {} : { address: filter.address }),
        topics: [...filter.topics],
        fromBlock: ethers.toQuantity(filter.fromBlock),
        toBlock: ethers.toQuantity(filter.toBlock),
      }]);
    },
    call(req) {
      return stateProvider.call(req);
    },
    getCode(address) {
      return stateProvider.getCode(address);
    },
  };
}
