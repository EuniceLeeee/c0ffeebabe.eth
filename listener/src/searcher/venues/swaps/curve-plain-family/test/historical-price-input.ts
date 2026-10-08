import assert from "node:assert/strict";
import { parseBlockScanObservedHeader, type BlockScanObservedHeader } from "../../../../blockscan-observed-header.js";
import type { CanonicalSource } from "../../../adapter-request-program.js";

// The production at-block CLI stores prices and header provenance separately.
// Read both without rewriting either; old profile files have an inline header.
export function curveHistoricalHeader(saved: any, source: CanonicalSource, provenance?: any): BlockScanObservedHeader {
  let observed: BlockScanObservedHeader | undefined;
  if (provenance !== undefined) {
    assert.equal(provenance.readyPath, saved.readyPath, "price input belongs to another Ready path");
    assert.equal(provenance.readySha256, saved.readySha256, "price input Ready hash mismatch");
    assert.equal(provenance.chainId, "1", "historical Curve test is mainnet only");
    assert.equal(provenance.broadcast, false);
    assert.equal(provenance.executionMode, "source-block", "source-block execution provenance required");
    assert.equal(provenance.topologySource?.number, source.number);
    assert.equal(provenance.topologySource?.hash?.toLowerCase(), source.hash.toLowerCase());
    observed = parseBlockScanObservedHeader(provenance.sourceHeader, source.number, 1n);
    assert.equal(observed.hash, source.hash.toLowerCase(), "raw header does not match Ready source");
    const fields = ["number", "hash", "parentHash", "timestamp", "baseFeePerGas", "gasUsed", "gasLimit", "transactionHashes"] as const;
    for (const key of fields) {
      assert.deepEqual(provenance.stateSource?.[key], observed[key], `price input state/raw header ${key} mismatch`);
      if (saved.header !== undefined) assert.deepEqual(saved.header[key], observed[key], `inline/input header ${key} mismatch`);
    }
  }
  const header = (observed ?? saved.header) as BlockScanObservedHeader | undefined;
  assert(header, "prices require their production --price-input input.json (or a legacy inline header)");
  assert.equal(header.number, source.number);
  assert.equal(header.hash.toLowerCase(), source.hash.toLowerCase());
  assert(Number.isSafeInteger(header.timestamp) && header.timestamp >= 0);
  assert(typeof header.baseFeePerGas === "bigint" && header.baseFeePerGas >= 0n);
  return header;
}
