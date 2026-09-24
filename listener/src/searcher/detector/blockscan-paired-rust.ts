import { createRequire } from "node:module";
import { resolvePairedEnumerationOptions, type DfsQuote, type enumeratePairedDfs, type PairedEnumerationInput, type PairedEnumerationMethod } from "./blockscan-paired-dfs.js";
import { RUST_ENUMERATOR_API_VERSION, RUST_ENUMERATOR_BINARY, verifyRustEnumerationArtifact } from "./blockscan-rust-artifact.js";

type EnumerationStats = ReturnType<typeof enumeratePairedDfs>;
type NativeQuote = Omit<DfsQuote, "value"> & { readonly value?: NonNullable<DfsQuote["value"]> };
type NativeInput = Omit<PairedEnumerationInput, "onCycle" | "quotes"> & {
  quotes: readonly NativeQuote[]; traversal: PairedEnumerationMethod;
  threads: number; memoryLimitBytes: number;
};
interface NativeEnumerator {
  apiVersion(): number;
  enumerate(input: NativeInput, onCycle: (indices: number[], num: bigint, den: bigint) => void): EnumerationStats;
}
let native: NativeEnumerator | undefined;
const require = createRequire(import.meta.url);

function load(): NativeEnumerator {
  if (!native) {
    try {
      verifyRustEnumerationArtifact();
      const candidate = require(RUST_ENUMERATOR_BINARY) as NativeEnumerator;
      if (candidate.apiVersion() !== RUST_ENUMERATOR_API_VERSION || typeof candidate.enumerate !== "function") {
        throw new Error("unsupported Rust enumeration interface");
      }
      native = candidate;
    } catch (cause) {
      // Never silently fall back: that would hide which engine a timed run used.
      throw new Error("Rust enumeration is unavailable; run npm run build:enumerator in listener, or explicitly select SEARCHER_BLOCKSCAN_ENUMERATION_BACKEND=typescript", { cause });
    }
  }
  return native;
}

/** Only successful cycles cross the native boundary. The synchronous callback's
 * admission/ranking cost still consumes the caller's original absolute deadline. */
export function enumerateRustPaired(input: PairedEnumerationInput, traversal: PairedEnumerationMethod): EnumerationStats {
  const { onCycle, ...data } = input;
  const options = resolvePairedEnumerationOptions(input);
  return load().enumerate({
    ...data, ...options, traversal,
    threads: options.rustThreads, memoryLimitBytes: options.rustScratchMb * 1024 * 1024,
    // napi-rs optional objects use undefined, while the TS contract uses null.
    // Keep original quote objects for callbacks and normalize only the wire shape.
    quotes: input.quotes.map(quote => ({ ...quote, value: quote.value ?? undefined })),
  }, (indices, num, den) => {
    const spread = (Number(num) / Number(den) - 1) * 10000;
    onCycle(indices.map(index => input.quotes[index]!), Number.isFinite(spread) ? spread
      : Number(num * 1_000_000_000n / den - 1_000_000_000n) / 100_000);
  });
}
