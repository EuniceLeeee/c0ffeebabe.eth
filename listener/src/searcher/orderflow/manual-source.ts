import { ethers } from "ethers";
import type {
  ReceiptLogsCompleteness,
  SwapEventLog,
} from "../venues/swap-observation.js";

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
  logs: SwapEventLog[];
  minProfit?: bigint;
  preferSequentialPrefix?: boolean;
  /** Canonical hash of blockNumber - 1, the pre-victim state generation. */
  sourceBlockHash?: string;
  /** Receipt identity used to bind complete logs to the pre-victim source. */
  receiptBlockNumber?: number;
  receiptBlockHash?: string;
  receiptParentBlockHash?: string;
  receiptTransactionHash?: string;
  /** Whether logs contain the complete successful receipt or only a hint. */
  logsCompleteness?: ReceiptLogsCompleteness;
  /** State provenance at the detector boundary. `must-overlay` is fail-closed;
   *  callers may claim `materialized` only after applying the full victim. */
  victimState: "materialized" | "must-overlay";
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
    const sourceBlock = await this.provider.getBlock(Math.max(0, blockNumber - 1));
    if (!sourceBlock?.hash) {
      throw new Error(`victim source block unavailable: ${Math.max(0, blockNumber - 1)}`);
    }
    const receiptBlock = await this.provider.getBlock(receipt.blockNumber);
    if (
      !receiptBlock?.hash ||
      receiptBlock.hash.toLowerCase() !== receipt.blockHash.toLowerCase() ||
      receiptBlock.parentHash.toLowerCase() !== sourceBlock.hash.toLowerCase()
    ) {
      throw new Error("victim receipt block is not a child of the source block");
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
        blockNumber: log.blockNumber,
        blockHash: log.blockHash,
        transactionHash: log.transactionHash,
      })),
      minProfit,
      preferSequentialPrefix,
      sourceBlockHash: sourceBlock.hash.toLowerCase(),
      receiptBlockNumber: receipt.blockNumber,
      receiptBlockHash: receipt.blockHash.toLowerCase(),
      receiptParentBlockHash: receiptBlock.parentHash.toLowerCase(),
      receiptTransactionHash: receipt.hash.toLowerCase(),
      logsCompleteness: "complete-receipt",
      victimState: "must-overlay",
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
