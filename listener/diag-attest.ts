import { createRebuildWiring } from "./src/searcher/universe-rebuild-production.js";
const wiring = createRebuildWiring({ rpcUrl: "http://127.0.0.1:8545" });
const cutoff = { number: 25774686, hash: "0x" + "aa".repeat(32), generation: 1 };
const candidate = {
  address: "0x50d3f135681304feef9f80d1d03404e2a0707e82",
  poolId: "0x000000000000000000000000f4750f14500bf8923f105e970642ec51fe0415ca",
  adapter: "univ2",
  familyId: "univ2-standard",
};
const result = await wiring.attestFamilyInstanceOnce({ candidate, cutoff });
console.log("RESULT:", JSON.stringify(result, (k, v) => typeof v === "bigint" ? v.toString() : v).slice(0, 600));