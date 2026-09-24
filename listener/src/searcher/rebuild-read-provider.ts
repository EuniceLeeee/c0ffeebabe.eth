import { ethers } from "ethers";

const MAX_PHYSICAL_REQUESTS = 8;

export type RebuildReadProviderOptions = ethers.JsonRpcApiProviderOptions & {
  /** Infinity retains concurrency already bounded by a dedicated caller. */
  readonly maxPhysicalRequests?: number;
};

/** Read fencing and bounded HTTP transport shared by rebuild providers. */
export class RebuildReadProvider extends ethers.JsonRpcProvider {
  private activeRequests = 0;
  private readonly maxPhysicalRequests: number;
  private readonly waiting: {
    resolve: () => void;
    reject: (error: Error) => void;
  }[] = [];

  constructor(
    private readonly read: <T>(operation: () => Promise<T>) => Promise<T>,
    url?: ConstructorParameters<typeof ethers.JsonRpcProvider>[0],
    network?: ConstructorParameters<typeof ethers.JsonRpcProvider>[1],
    options?: RebuildReadProviderOptions,
  ) {
    const { maxPhysicalRequests = MAX_PHYSICAL_REQUESTS, ...rpcOptions } = options ?? {};
    if (maxPhysicalRequests !== Infinity &&
        (!Number.isSafeInteger(maxPhysicalRequests) || maxPhysicalRequests < 1)) {
      throw new Error("maxPhysicalRequests must be a positive integer or Infinity");
    }
    super(url, network, { batchMaxCount: 8, ...rpcOptions });
    this.maxPhysicalRequests = maxPhysicalRequests;
  }

  private assertOpen(): void {
    if (this.destroyed) throw this.destroyedError();
  }

  private destroyedError(): Error {
    return ethers.makeError("provider destroyed; cancelled request", "UNSUPPORTED_OPERATION", {
      operation: "_send",
    });
  }

  private async acquire(): Promise<void> {
    this.assertOpen();
    if (this.activeRequests < this.maxPhysicalRequests) {
      this.activeRequests++;
      return;
    }
    await new Promise<void>((resolve, reject) => this.waiting.push({ resolve, reject }));
  }

  private release(): void {
    const next = this.waiting.shift();
    if (next) {
      // Transfer the occupied slot directly, so later arrivals cannot jump
      // ahead of this waiter between its resolution and continuation.
      next.resolve();
    } else {
      this.activeRequests--;
    }
  }

  // Limit only the physical transport: public methods and network detection
  // can call send/_send recursively and must never hold another queue slot.
  override _send(...args: Parameters<ethers.JsonRpcProvider["_send"]>) {
    return this.read(async () => {
      await this.acquire();
      try {
        // The fatal latch may have changed while ethers batched the request
        // or while this batch waited for a slot. Recheck before any HTTP I/O.
        return await this.read(() => {
          this.assertOpen();
          return super._send(...args);
        });
      } finally {
        this.release();
      }
    });
  }

  override send(...args: Parameters<ethers.JsonRpcProvider["send"]>) {
    return this.read(() => super.send(...args));
  }
  override getBlock(...args: Parameters<ethers.JsonRpcProvider["getBlock"]>) {
    return this.read(() => super.getBlock(...args));
  }
  override getCode(...args: Parameters<ethers.JsonRpcProvider["getCode"]>) {
    return this.read(() => super.getCode(...args));
  }
  override getStorage(...args: Parameters<ethers.JsonRpcProvider["getStorage"]>) {
    return this.read(() => super.getStorage(...args));
  }
  override getLogs(...args: Parameters<ethers.JsonRpcProvider["getLogs"]>) {
    return this.read(() => super.getLogs(...args));
  }

  override destroy(): void {
    super.destroy();
    for (const waiter of this.waiting.splice(0)) waiter.reject(this.destroyedError());
  }
}
