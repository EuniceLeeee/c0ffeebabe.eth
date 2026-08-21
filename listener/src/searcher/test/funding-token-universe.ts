import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FUNDING_TOKEN_UNIVERSE_FORMAT,
  loadFundingTokenUniverse,
  writeFundingTokenUniverse,
} from "../funding-token-universe.js";

async function main(): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "funding-token-universe-"));
  try {
    const path = join(dir, "funding-token-universe.json");
    const table = Object.freeze({
      format: FUNDING_TOKEN_UNIVERSE_FORMAT,
      enumeratedAtBlock: 25_800_000,
      tokens: Object.freeze([
        "0x" + "11".repeat(20),
        "0x" + "22".repeat(20),
        "0x" + "33".repeat(20),
      ]),
    });
    await writeFundingTokenUniverse(path, table);
    const loaded = await loadFundingTokenUniverse(path);
    assert.notEqual(loaded, null);
    assert.equal(loaded!.tokens.length, 3);
    assert.deepEqual([...loaded!.tokens].sort(), [...table.tokens].sort());
    const raw = JSON.parse(await readFile(path, "utf8"));
    assert.equal(raw.format, FUNDING_TOKEN_UNIVERSE_FORMAT);

    // A missing table loads as null (first boot enumerates instead).
    assert.equal(
      await loadFundingTokenUniverse(join(dir, "missing.json")),
      null,
    );
    // Corrupt / foreign tables fail closed (never trusted as-is).
    await writeFundingTokenUniverse(path, Object.freeze({
      format: FUNDING_TOKEN_UNIVERSE_FORMAT,
      enumeratedAtBlock: 1,
      tokens: Object.freeze(["not-an-address"]),
    }));
    assert.equal(await loadFundingTokenUniverse(path), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  console.log("funding token universe PASS");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
