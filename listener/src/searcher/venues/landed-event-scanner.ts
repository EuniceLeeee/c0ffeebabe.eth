import { ethers } from "ethers";
import type { PoolEntry } from "../planner/token-graph.js";
import type { LandedSwapEventDescriptor } from "./landed-event-registry.js";

export interface AddressLandedSwapLog {
  readonly address: string;
  readonly blockNumber?: string | number;
}

export interface AddressLandedSwapActivity {
  readonly address: string;
  readonly adapterCounts: Map<PoolEntry["adapter"], number>;
  count: number;
  lastSwapBlock: number;
}

export interface AddressLandedSwapScanResult {
  readonly activity: Map<string, AddressLandedSwapActivity>;
  readonly logCountsByEventId: ReadonlyMap<string, number>;
}

export async function scanAddressLandedSwapActivity(input: {
  events: readonly LandedSwapEventDescriptor[];
  fromBlock: number;
  toBlock: number;
  batchSize: number;
  getLogs(
    event: LandedSwapEventDescriptor,
    fromBlock: number,
    toBlock: number,
  ): Promise<readonly AddressLandedSwapLog[]>;
}): Promise<AddressLandedSwapScanResult> {
  const activity = new Map<string, AddressLandedSwapActivity>();
  const logCountsByEventId = new Map<string, number>();
  const events = input.events.filter((event) => event.emitter.mode === "address");

  for (const event of events) {
    let eventLogs = 0;
    for (let start = input.fromBlock; start <= input.toBlock; start += input.batchSize) {
      const end = Math.min(start + input.batchSize - 1, input.toBlock);
      const logs = await input.getLogs(event, start, end);
      eventLogs += logs.length;
      for (const log of logs) recordAddressSwapActivity(activity, event, log);
    }
    logCountsByEventId.set(event.id, eventLogs);
  }

  return { activity, logCountsByEventId };
}

function recordAddressSwapActivity(
  activity: Map<string, AddressLandedSwapActivity>,
  event: LandedSwapEventDescriptor,
  log: AddressLandedSwapLog,
): void {
  const address = ethers.getAddress(log.address);
  const key = address.toLowerCase();
  const blockNumber = parseBlockNumber(log.blockNumber);
  let item = activity.get(key);
  if (!item) {
    item = {
      address,
      adapterCounts: new Map(),
      count: 0,
      lastSwapBlock: 0,
    };
    activity.set(key, item);
  }
  item.count++;
  item.lastSwapBlock = Math.max(item.lastSwapBlock, blockNumber);
  const adapter = event.discovery.poolAdapter;
  item.adapterCounts.set(adapter, (item.adapterCounts.get(adapter) ?? 0) + 1);
}

function parseBlockNumber(value: string | number | undefined): number {
  if (typeof value === "number") return Number.isSafeInteger(value) && value >= 0 ? value : 0;
  if (typeof value !== "string") return 0;
  const parsed = value.startsWith("0x") ? parseInt(value, 16) : Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}
