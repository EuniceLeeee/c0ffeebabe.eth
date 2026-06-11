import { AnvilStateBackend } from "./state-backend.js";

/**
 * AnvilSimulatorPool — EVM analog of sui-mev's `ObjectPool<Box<dyn Simulator>>`.
 *
 * Holds N independent AnvilStateBackend instances (separate processes, separate
 * ports, separate fork state). Concurrent candidates each `acquire()` their own
 * instance, run the full snapshot→send→revert lifecycle in isolation, then
 * `release()`. This is what lets us parallelize the (heavy) Anvil simulate that
 * a single shared backend cannot — see docs/v7 Stage 3b.
 *
 * Note: on Anvil each simulate is still RPC + mine bound; the pool parallelizes
 * across candidates, it does not make a single simulate cheap (that's the revm
 * path, b2).
 */
export class AnvilSimulatorPool {
  private instances: AnvilStateBackend[] = [];
  private idle: AnvilStateBackend[] = [];
  private waiters: Array<(b: AnvilStateBackend) => void> = [];

  constructor(
    private readonly rpcUrl: string,
    readonly size: number,
    private readonly basePort = 8600,
  ) {}

  /** Spawn and ready all N anvil instances (concurrently). */
  async start(): Promise<void> {
    this.instances = [];
    for (let i = 0; i < this.size; i++) {
      const port = this.basePort + i;
      this.instances.push(new AnvilStateBackend(this.rpcUrl, `http://127.0.0.1:${port}`, port));
    }
    await Promise.all(this.instances.map((b) => b.start()));
    this.idle = [...this.instances];
  }

  /** Fork every instance at the same block (concurrently). */
  async forkAll(blockNumber: number): Promise<void> {
    await Promise.all(this.instances.map((b) => b.forkAt(blockNumber)));
  }

  /** Check out an idle instance, or wait until one is released. */
  acquire(): Promise<AnvilStateBackend> {
    const b = this.idle.pop();
    if (b) return Promise.resolve(b);
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  /** Return an instance to the pool (handing it directly to any waiter). */
  release(b: AnvilStateBackend): void {
    const waiter = this.waiters.shift();
    if (waiter) waiter(b);
    else this.idle.push(b);
  }

  /** acquire → run → release (always releases, even on throw). */
  async withSim<T>(fn: (b: AnvilStateBackend) => Promise<T>): Promise<T> {
    const b = await this.acquire();
    try {
      return await fn(b);
    } finally {
      this.release(b);
    }
  }

  /**
   * Map over items with at most `size` concurrent instances in flight.
   * Each item's fn gets a dedicated, isolated backend for its whole lifetime.
   */
  async mapConcurrent<I, O>(items: I[], fn: (item: I, b: AnvilStateBackend) => Promise<O>): Promise<O[]> {
    return Promise.all(items.map((item) => this.withSim((b) => fn(item, b))));
  }

  get all(): readonly AnvilStateBackend[] {
    return this.instances;
  }

  stop(): void {
    for (const b of this.instances) b.stop();
    this.instances = [];
    this.idle = [];
    this.waiters = [];
  }
}
