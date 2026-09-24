import { ethers } from "ethers";
import type { CanonicalSource } from "./venues/adapter-request-program.js";

interface CodeProvider {
  getCode(address: string, blockTag?: number): Promise<string>;
}

/**
 * Raw bytecode only: never cache calls, identity decisions or mutable state.
 * One owner/underlying provider supplies the RPC/chain namespace. Callers keep
 * their canonical-head/publication fences; every hit still checks owner liveness.
 */
export function createSourceCodeProviders<Provider extends CodeProvider>(
  provider: Provider,
  assertOpen: () => void,
  limits: { readonly maxEntries?: number; readonly maxBytes?: number } = {},
): (source: CanonicalSource) => Provider {
  const maxEntries = limits.maxEntries ?? 2048;
  const maxBytes = limits.maxBytes ?? 32 * 1024 * 1024;
  if (!Number.isSafeInteger(maxEntries) || maxEntries <= 0 ||
      !Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new Error("invalid source code cache limits");
  }
  type Entry = { pending: Promise<string>; bytes: number };
  const entries = new Map<string, Entry>();
  const providers = new Map<string, Provider>();
  let retainedBytes = 0;
  const remove = (key: string, entry: Entry): void => {
    if (entries.get(key) !== entry) return;
    entries.delete(key);
    retainedBytes -= entry.bytes;
  };
  const trim = (): void => {
    while (entries.size > maxEntries || retainedBytes > maxBytes) {
      const [key, entry] = entries.entries().next().value!;
      // Evicting a pending entry only disables reuse, never cancels its readers.
      remove(key, entry);
    }
  };
  return (source) => {
    assertOpen();
    const pinned = Object.freeze({ ...source });
    const sourceKey = `${pinned.number}:${pinned.hash.toLowerCase()}:${pinned.generation}`;
    const existing = providers.get(sourceKey);
    if (existing) {
      providers.delete(sourceKey);
      providers.set(sourceKey, existing);
      return existing;
    }
    const scoped: Provider = {
      ...provider,
      async getCode(address: string, blockTag?: number): Promise<string> {
        assertOpen();
        if (blockTag !== pinned.number) {
          throw new Error("code read escaped the fixed canonical cutoff");
        }
        const canonical = ethers.getAddress(address);
        const key = sourceKey + ":" + canonical.toLowerCase();
        let entry = entries.get(key);
        if (entry === undefined) {
          const fresh: Entry = {
            bytes: 0,
            pending: Promise.resolve().then(async () => {
              assertOpen();
              const code = await provider.getCode(canonical, pinned.number);
              assertOpen();
              if (!ethers.isHexString(code) || code.length % 2 !== 0) {
                throw new Error("invalid deployed bytecode result");
              }
              if (entries.get(key) === fresh) {
                // Bound retained JS string storage, not just decoded code bytes.
                fresh.bytes = code.length * 2;
                retainedBytes += fresh.bytes;
                trim();
              }
              return code;
            }).catch((error: unknown) => {
              remove(key, fresh);
              throw error;
            }),
          };
          entry = fresh;
          entries.set(key, fresh);
          trim();
        } else {
          entries.delete(key);
          entries.set(key, entry);
        }
        const code = await entry.pending;
        assertOpen();
        return code;
      },
    };
    // Stable across candidates at a source, preserving nomination-provider caches.
    providers.set(sourceKey, scoped);
    if (providers.size > 8) providers.delete(providers.keys().next().value!);
    return scoped;
  };
}
