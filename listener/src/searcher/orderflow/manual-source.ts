import { ethers } from "ethers";

export interface OrderflowEvent {
  txHash: string;
  blockNumber: number;
  transactionIndex?: number;
  previousTxHash?: string;
  rawTx: string;
  from: string;
  nonce: number;
  to: string | null;
  input: string;
  logs: Array<{ address: string; topics: string[]; data: string }>;
  minProfit?: bigint;
  preferSequentialPrefix?: boolean;
}

export class ManualVictimSource {
  constructor(
    private readonly provider: ethers.JsonRpcProvider,
    private readonly fixtures: Array<{
      victimTxHash: string;
      blockNumber: number;
      minProfit?: bigint;
      requiresPrefix?: boolean;
    }>,
  ) {}

  async *next(): AsyncIterable<OrderflowEvent> {
    for (const fixture of this.fixtures) {
      yield await this.load(
        fixture.victimTxHash,
        fixture.blockNumber,
        fixture.minProfit,
        fixture.requiresPrefix,
      );
    }
  }

  private async load(
    txHash: string,
    blockNumber: number,
    minProfit?: bigint,
    preferSequentialPrefix?: boolean,
  ): Promise<OrderflowEvent> {
    const tx = await this.provider.getTransaction(txHash);
    if (!tx) throw new Error(`victim tx not found: ${txHash}`);
    const receipt = await this.provider.getTransactionReceipt(txHash);
    if (!receipt) throw new Error(`victim receipt not found: ${txHash}`);
    if (receipt.blockNumber !== blockNumber) {
      throw new Error(`victim block mismatch: expected ${blockNumber}, got ${receipt.blockNumber}`);
    }

    return {
      txHash,
      blockNumber,
      transactionIndex: Number(receipt.index),
      previousTxHash: await this.previousTxHash(blockNumber, Number(receipt.index)),
      rawTx: await this.rawTx(txHash, tx),
      from: tx.from,
      nonce: tx.nonce,
      to: tx.to,
      input: tx.data,
      logs: receipt.logs.map((log) => ({
        address: log.address,
        topics: [...log.topics],
        data: log.data,
      })),
      minProfit,
      preferSequentialPrefix,
    };
  }

  private async rawTx(txHash: string, tx: ethers.TransactionResponse): Promise<string> {
    try {
      const raw = await this.provider.send("eth_getRawTransactionByHash", [txHash]);
      if (typeof raw === "string" && raw.startsWith("0x")) return raw;
    } catch {
      // Fall through to local reconstruction.
    }

    return ethers.Transaction.from({
      type: tx.type,
      to: tx.to,
      nonce: tx.nonce,
      gasLimit: tx.gasLimit,
      gasPrice: tx.gasPrice,
      maxFeePerGas: tx.maxFeePerGas,
      maxPriorityFeePerGas: tx.maxPriorityFeePerGas,
      data: tx.data,
      value: tx.value,
      chainId: tx.chainId,
      accessList: tx.accessList,
      signature: tx.signature,
    }).serialized;
  }

  private async previousTxHash(blockNumber: number, txIndex: number): Promise<string | undefined> {
    if (txIndex <= 0) return undefined;
    const block = await this.provider.send("eth_getBlockByNumber", [
      "0x" + blockNumber.toString(16),
      true,
    ]);
    const txs = Array.isArray(block?.transactions) ? block.transactions : [];
    const prev = txs[txIndex - 1];
    const hash = typeof prev === "string" ? prev : prev?.hash;
    if (typeof hash !== "string" || !hash.startsWith("0x")) {
      throw new Error(`missing previous tx hash for block ${blockNumber} index ${txIndex}`);
    }
    return hash;
  }
}
