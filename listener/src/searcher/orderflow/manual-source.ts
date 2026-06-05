import { ethers } from "ethers";

export interface OrderflowEvent {
  txHash: string;
  blockNumber: number;
  transactionIndex?: number;
  rawTx: string;
  from: string;
  to: string | null;
  input: string;
  logs: Array<{ address: string; topics: string[]; data: string }>;
}

export class ManualVictimSource {
  constructor(
    private readonly provider: ethers.JsonRpcProvider,
    private readonly fixtures: Array<{ victimTxHash: string; blockNumber: number }>,
  ) {}

  async *next(): AsyncIterable<OrderflowEvent> {
    for (const fixture of this.fixtures) {
      yield await this.load(fixture.victimTxHash, fixture.blockNumber);
    }
  }

  private async load(txHash: string, blockNumber: number): Promise<OrderflowEvent> {
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
      rawTx: await this.rawTx(txHash, tx),
      from: tx.from,
      to: tx.to,
      input: tx.data,
      logs: receipt.logs.map((log) => ({
        address: log.address,
        topics: [...log.topics],
        data: log.data,
      })),
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
}
