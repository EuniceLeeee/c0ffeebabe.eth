import { readFile } from "node:fs/promises";
import { extractVenueCandidates, type VenueScanInput } from "../discovery/venue-evidence.js";
import { parseArgs } from "../util.js";

interface FixtureInput {
  txHash?: string;
  tx?: { from?: string; to?: string };
  receiptLogs?: VenueScanInput["receiptLogs"];
}

const args = parseArgs(process.argv.slice(2));
const fixturePath = typeof args.fixture === "string" ? args.fixture : "";

if (!fixturePath) {
  console.error("Usage: npm run venue-discovery-scan -- --fixture <path>");
  process.exit(1);
}

const fixture = JSON.parse(await readFile(fixturePath, "utf8")) as FixtureInput;
const input: VenueScanInput = {
  txHash: fixture.txHash,
  from: fixture.tx?.from,
  to: fixture.tx?.to,
  receiptLogs: Array.isArray(fixture.receiptLogs) ? fixture.receiptLogs : [],
};

console.log(JSON.stringify(extractVenueCandidates(input), null, 2));
