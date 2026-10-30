import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseProtocolJsonAcceptanceCase, acceptanceFamilyDomain } from "./protocol-json-acceptance-facts.js";

/** Thin preparation CLI. The sample selects a source block and one installed
 * Family; no pool, expected route, output or admission enters production scan. */
export async function familyJsonReadyMain(argv = process.argv.slice(2)) {
  const args = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 2) {
    assert(["--case", "--rpc-file", "--revm-bin", "--out"].includes(argv[i]) && !args.has(argv[i]) && argv[i + 1], "invalid Ready arguments");
    args.set(argv[i], resolve(argv[i + 1]));
  }
  assert(args.size === 4, "--case --rpc-file --revm-bin --out are required");
  const bytes = readFileSync(args.get("--case")!), sample = parseProtocolJsonAcceptanceCase(JSON.parse(bytes.toString()));
  const out = args.get("--out")!, runId = `family-json-${createHash("sha256").update(bytes).digest("hex").slice(0, 20)}`;
  const manifestPath = `${out}.request.json`;
  const request = { version: 1, familyId: sample.familyId, source: sample.source,
    sampleSha256: createHash("sha256").update(bytes).digest("hex"), runId,
    range: { fromBlock: sample.source.number, toBlock: sample.source.number },
    claim: "single-block production discovery/strict/Graph; no manual candidates, no live or broadcast" };
  if (existsSync(manifestPath)) assert.deepEqual(JSON.parse(readFileSync(manifestPath, "utf8")), request, "Ready preparation request changed");
  else { assert(!existsSync(out), "refusing an unrelated existing checkpoint"); writeFileSync(manifestPath, JSON.stringify(request, null, 2) + "\n", { flag: "wx", mode: 0o600 }); }
  const rpc = JSON.parse(readFileSync(args.get("--rpc-file")!, "utf8"));
  assert(typeof rpc.MAINNET_RPC_URL === "string", "RPC configuration lacks MAINNET_RPC_URL");
  const url = new URL(rpc.MAINNET_RPC_URL); assert(["http:", "https:"].includes(url.protocol), "invalid archive transport");
  process.env.SEARCHER_DRY_RUN = "1";
  process.env.SEARCHER_READY_REVM_SIM_BIN = args.get("--revm-bin")!;
  process.env.SEARCHER_REVM_SIM_BIN = args.get("--revm-bin")!;
  const [{ createRebuildWiring }, { rebuildUniverse }, { UniverseRebuildCheckpointStore }, { PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG: familyCapabilityCatalog }] = await Promise.all([
    import("../universe-rebuild-production.js"), import("../universe-rebuild-runner.js"),
    import("../universe-rebuild-checkpoint.js"), import("../venues/production-family-composition.js"),
  ]);
  const family = familyCapabilityCatalog.forStrictFamily(sample.familyId as never);
  assert.equal(family.plugin.manifest.domain, acceptanceFamilyDomain(sample.familyId, sample.domain));
  const wiring = createRebuildWiring({ rpcUrl: rpc.MAINNET_RPC_URL, familyIds: [sample.familyId],
    executionIdentity: { executor: sample.executor, transactionOrigin: sample.owner } });
  // A requested number is independently fenced against the public sample hash.
  const freeze = wiring.freezeCanonicalHead;
  const ready = await rebuildUniverse({ ...wiring, store: new UniverseRebuildCheckpointStore({ path: out }), runId,
    observationRange: request.range, attestationConcurrency: 1,
    freezeCanonicalHead: async requested => { const source = await freeze(requested);
      assert.equal(source.number, sample.source.number); assert.equal(source.hash.toLowerCase(), sample.source.hash); return source; },
    log: message => console.log(message.replaceAll(rpc.MAINNET_RPC_URL, "[REDACTED]")),
  });
  assert.equal(ready.cutoff.number, sample.source.number); assert.equal(ready.cutoff.hash.toLowerCase(), sample.source.hash);
  console.log(JSON.stringify({ readyPath: out, generation: ready.generation, source: ready.cutoff,
    activeInstances: ready.activeInstanceKeys.length, graphHash: ready.graphHash }));
  // A sealed empty generation is a valid rebuild artifact, but not successful
  // preparation for this scoped Family acceptance. Keep it for diagnosis.
  assert(ready.activeInstanceKeys.length > 0, "scoped Ready contains no admitted instances; inspect retained candidate outcomes");
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  familyJsonReadyMain().catch(error => {
    const message = String(error instanceof Error ? error.message : error).replace(/https?:\/\/[^\s"'<>]+/g, "[REDACTED_RPC]").slice(0, 4000);
    console.error(`Family JSON Ready preparation failed: ${message}; checkpoint and request retained`);
    process.exitCode = 1;
  });
