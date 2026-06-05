import { spawn, type ChildProcess } from "node:child_process";
import { ethers } from "ethers";

export interface StateBackend {
  forkAt(blockNumber: number): Promise<void>;
  applyRawTx(rawTx: string): Promise<string>;
  snapshot(): Promise<string>;
  revert(snapshotId: string): Promise<void>;
  call(req: { to: string; data: string; from?: string }): Promise<string>;
  send(req: { from: string; to: string; data: string; gas?: string }): Promise<string>;
  getTokenBalance(token: string, account: string): Promise<bigint>;
}

const ERC20 = new ethers.Interface(["function balanceOf(address) view returns (uint256)"]);

export class AnvilStateBackend implements StateBackend {
  readonly provider: ethers.JsonRpcProvider;
  private proc: ChildProcess | null = null;

  constructor(
    private readonly rpcUrl: string,
    readonly anvilUrl = "http://127.0.0.1:8555",
    private readonly port = 8555,
  ) {
    this.provider = new ethers.JsonRpcProvider(anvilUrl);
  }

  async start(): Promise<void> {
    if (this.proc) return;
    this.proc = spawn("anvil", [
      "--fork-url", this.rpcUrl,
      "--port", String(this.port),
      "--silent",
      "--no-mining",
      "--order", "fifo",
    ], { stdio: "ignore" });
    this.proc.on("exit", () => { this.proc = null; });

    for (let i = 0; i < 30; i++) {
      try {
        await this.provider.getBlockNumber();
        return;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 400));
      }
    }
    throw new Error("anvil did not start");
  }

  stop(): void {
    if (!this.proc) return;
    this.proc.kill();
    this.proc = null;
  }

  async forkAt(blockNumber: number): Promise<void> {
    await withTimeout(this.provider.send("anvil_reset", [{
      forking: { jsonRpcUrl: this.rpcUrl, blockNumber },
    }]), 60_000, `anvil_reset block ${blockNumber}`);
  }

  async applyRawTx(rawTx: string): Promise<string> {
    const hash = await withTimeout(
      this.provider.send("eth_sendRawTransaction", [rawTx]),
      45_000,
      "eth_sendRawTransaction victim",
    );
    await mineOne(this.provider, "victim", 120_000);
    const receipt = await this.provider.getTransactionReceipt(hash);
    if (!receipt || receipt.status !== 1) {
      throw new Error(`victim apply failed: ${hash}`);
    }
    return hash;
  }

  async snapshot(): Promise<string> {
    return this.provider.send("evm_snapshot", []);
  }

  async revert(snapshotId: string): Promise<void> {
    await this.provider.send("evm_revert", [snapshotId]);
  }

  async call(req: { to: string; data: string; from?: string }): Promise<string> {
    return withTimeout(this.provider.call(req), 30_000, `eth_call ${req.to}`);
  }

  async send(req: { from: string; to: string; data: string; gas?: string }): Promise<string> {
    const hash = await withTimeout(
      this.provider.send("eth_sendTransaction", [req]),
      45_000,
      `eth_sendTransaction ${req.to}`,
    );
    await mineOne(this.provider, "send", 120_000);
    const receipt = await this.provider.getTransactionReceipt(hash);
    if (!receipt || receipt.status !== 1) {
      const detail = await traceRevert(this.provider, hash);
      throw new Error(`transaction reverted: ${hash}${detail ? ` ${detail}` : ""}`);
    }
    return hash;
  }

  async getTokenBalance(token: string, account: string): Promise<bigint> {
    const data = ERC20.encodeFunctionData("balanceOf", [account]);
    const result = await this.call({ to: token, data });
    return BigInt(result);
  }
}

async function traceRevert(provider: ethers.JsonRpcProvider, txHash: string): Promise<string> {
  try {
    const trace = await provider.send("debug_traceTransaction", [
      txHash,
      { tracer: "callTracer" },
    ]);
    const failed = findFailedCall(trace);
    if (!failed) return "";
    const to = typeof failed.to === "string" ? failed.to : "unknown";
    const input = typeof failed.input === "string" ? failed.input.slice(0, 10) : "0x";
    const err = typeof failed.error === "string" ? failed.error : "call failed";
    return `[failed to=${to} selector=${input} error=${err}]`;
  } catch {
    return "";
  }
}

function findFailedCall(node: any): any | null {
  if (!node || typeof node !== "object") return null;
  const calls = Array.isArray(node.calls) ? node.calls : [];
  for (const child of calls) {
    const found = findFailedCall(child);
    if (found) return found;
  }
  if (node.error) return node;
  return null;
}

async function mineOne(provider: ethers.JsonRpcProvider, label: string, timeoutMs: number): Promise<void> {
  try {
    await withTimeout(provider.send("anvil_mine", ["0x1"]), timeoutMs, `anvil_mine ${label}`);
  } catch {
    await withTimeout(provider.send("evm_mine", []), timeoutMs, `evm_mine ${label}`);
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}
