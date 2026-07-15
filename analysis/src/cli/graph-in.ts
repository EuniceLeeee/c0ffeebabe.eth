// graph-in — v4-aware discovery-membership check. Uses the CANONICAL loadGraphMembership
// (which unions active-pools.json v4 poolIds, since runtime-graph-pools.json stores v4 by PoolManager
// address only). Use THIS instead of grepping runtime-graph-pools.json for a poolId — that grep is a
// systematic false-negative for every v4 pool. This does NOT prove that
// buildTokenGraph successfully emitted a routable TokenEdge.
//
// Usage: npm run graph-in -- --graph <runtime-graph-pools.json> <address-or-poolId> [<id> ...]
//   defaults --graph to listener/searcher/pools/runtime-graph-pools.json
import { loadGraphMembership } from "./bundle-postmortem.js";

function main(): void {
  const argv = process.argv.slice(2);
  let graphPath = "";
  const ids: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--graph") { graphPath = argv[++i]; continue; }
    ids.push(argv[i]);
  }
  if (!graphPath) graphPath = new URL("../../../listener/searcher/pools/runtime-graph-pools.json", import.meta.url).pathname;
  if (ids.length === 0) { console.error("usage: npm run graph-in -- [--graph <path>] <address-or-poolId> ..."); process.exit(1); }

  const g = loadGraphMembership(graphPath);
  console.log(`graph=${graphPath}`);
  console.log(`status=${g.status} members=${g.status === "loaded" ? g.entries : "n/a"}`);
  if (g.status !== "loaded") {
    console.log("(graph file unavailable — this checkout's committed snapshot is a placeholder; run against the node's /opt/MEV/listener/searcher/pools/runtime-graph-pools.json)");
  }
  for (const id of ids) {
    const inGraph = g.status === "loaded" ? g.members.has(id.toLowerCase()) : null;
    console.log(`${inGraph === null ? "UNKNOWN" : inGraph ? "DISCOVERY_IN" : "OUT"}  ${id}`);
  }
}

main();
