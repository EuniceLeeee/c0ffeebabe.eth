/** Signals an address-filtered mempool subscription to rebuild and reconnect. */
export class MempoolIntakeRefreshSignal {
  private readonly listeners = new Set<() => void>();

  notify(): void {
    for (const listener of [...this.listeners]) listener();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
