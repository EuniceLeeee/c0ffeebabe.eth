interface BlockTouchedLog {
  readonly address: string;
  readonly topics: readonly string[];
}

export interface BlockTouchedProvider {
  getLogs(filter: {
    readonly fromBlock: number;
    readonly toBlock: number;
  }): Promise<readonly BlockTouchedLog[]>;
  send(method: string, params: Array<unknown>): Promise<unknown>;
}

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const ADDRESS_TOPIC_RE = /^0x0{24}[0-9a-fA-F]{40}$/;
const ERC20_TRANSFER_TOPIC =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

/**
 * Reads one block's log identities and call targets into the single refresh
 * set consumed by block-scan pricing. Logs retain singleton pool identities;
 * callTracer adds contracts reached through top-level or internal calls.
 */
export async function readBlockTouchedStateKeys(
  provider: BlockTouchedProvider,
  blockNumber: number,
  uniswapV4PoolManager: string,
): Promise<ReadonlySet<string>> {
  const [logsResult, tracesResult] = await Promise.allSettled([
    Promise.resolve().then(() => provider.getLogs({ fromBlock: blockNumber, toBlock: blockNumber })),
    Promise.resolve().then(() => provider.send("debug_traceBlockByNumber", [
      `0x${blockNumber.toString(16)}`,
      { tracer: "callTracer", tracerConfig: { onlyTopCall: false } },
    ])),
  ]);
  // The pass owns both reads. A failed sibling must not leave activity I/O
  // running after this generation has been settled and its Funding drained.
  if (logsResult.status === "rejected") throw logsResult.reason;
  if (tracesResult.status === "rejected") throw tracesResult.reason;
  const logs = logsResult.value;
  const traces = tracesResult.value;
  const touched = new Set<string>();
  const manager = uniswapV4PoolManager.toLowerCase();

  for (const log of logs) {
    if (log.address.toLowerCase() === manager) {
      const poolId = log.topics[1];
      if (poolId !== undefined) touched.add(poolId.toLowerCase());
    } else {
      touched.add(log.address.toLowerCase());
    }
    // A direct token donation changes a pool's balance headroom without a
    // pool call or Sync. Reuse these already-fetched logs; ERC721 Transfer
    // has four topics and must not be interpreted as an ERC20 balance move.
    if (log.topics.length === 3 &&
      log.topics[0]?.toLowerCase() === ERC20_TRANSFER_TOPIC) {
      for (const topic of [log.topics[1]!, log.topics[2]!]) {
        if (ADDRESS_TOPIC_RE.test(topic)) {
          touched.add(`0x${topic.slice(-40).toLowerCase()}`);
        }
      }
    }
  }

  if (!Array.isArray(traces)) {
    throw new Error("debug_traceBlockByNumber must return an array");
  }
  for (const [index, trace] of traces.entries()) {
    if (!isRecord(trace) || !("result" in trace)) {
      throw new Error(`block trace ${index} is missing its callTracer result`);
    }
    if (trace.error !== undefined && trace.error !== null) {
      throw new Error(`block trace ${index} failed`);
    }
    addCallTargets(trace.result, touched);
  }

  return touched;
}

function addCallTargets(frame: unknown, touched: Set<string>): void {
  if (!isRecord(frame)) {
    throw new Error("block trace contains a malformed call frame");
  }
  if (typeof frame.to === "string" && ADDRESS_RE.test(frame.to)) {
    touched.add(frame.to.toLowerCase());
  } else if (
    frame.to !== undefined ||
    (frame.type !== "CREATE" && frame.type !== "CREATE2")
  ) {
    throw new Error("block trace contains a malformed call target");
  }
  // A failed creation may not have a destination yet, but its nested calls
  // still contribute activity. Malformed responses never prove clean state.
  if (frame.calls === undefined) return;
  if (!Array.isArray(frame.calls)) {
    throw new Error("block trace contains malformed nested calls");
  }
  for (const child of frame.calls) addCallTargets(child, touched);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
