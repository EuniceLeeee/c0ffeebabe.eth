import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

export type LiveFixturePath = "hash-only" | "rawTx" | "mined";

export type LiveFinalState =
  | "expired-before-solver"
  | "quote-timeout"
  | "no-profitable-quote"
  | "sim-revert"
  | "final-verify-failed"
  | "would-submit";

export interface LiveFixtureReport {
  txHash: string;
  receivedAt: number;
  path: LiveFixturePath;
  blockNumber: number;
  pool: string;
  tokenIn: string;
  tokenOut: string;
  amountIn: string;
  opportunities: number;
  plans: number;
  stageMs: Record<string, number>;
  finalState: LiveFinalState;
  error?: string;
  calldata?: string;
  profitToken?: string;
  netProfit?: string;
  gasUsed?: string;
  counters: Record<string, number>;
}

export interface LiveFixtureInput {
  report: LiveFixtureReport;
  hintPayload: unknown;
  eventLogs: Array<{ address: string; topics: string[]; data: string }>;
}

export class LiveFixtureRecorder {
  private readonly baseDir: string;

  constructor(
    baseDir: string,
    private readonly enabled: boolean,
  ) {
    this.baseDir = resolve(baseDir);
  }

  record(input: LiveFixtureInput): void {
    if (!this.enabled) return;

    mkdirSync(join(this.baseDir, "hints"), { recursive: true });
    mkdirSync(join(this.baseDir, "receipts"), { recursive: true });
    mkdirSync(join(this.baseDir, "reports"), { recursive: true });

    const id = `${input.report.receivedAt}-${input.report.txHash.slice(2, 10)}`;
    writeJson(join(this.baseDir, "hints", `${id}.json`), {
      txHash: input.report.txHash,
      receivedAt: input.report.receivedAt,
      payload: input.hintPayload,
    });
    writeJson(join(this.baseDir, "receipts", `${id}.json`), {
      txHash: input.report.txHash,
      blockNumber: input.report.blockNumber,
      logs: input.eventLogs,
    });
    writeJson(join(this.baseDir, "reports", `${id}.json`), input.report);
  }
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, jsonReplacer, 2)}\n`);
}

function jsonReplacer(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}
