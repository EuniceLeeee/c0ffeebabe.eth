import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { PRODUCTION_STRICT_SHADOW_FAMILY_LOAD as load } from "../venues/production-family-composition.js";

// Read-only construction audit, NOT admission, quote parity, or EVM evidence.
// Never writes/reissues the input Ready or creates a production route handle.
const path = process.argv[2];
assert(path, "usage: family-runtime-audit <saved-ready.json>");
const bytes = readFileSync(path), hash = createHash("sha256").update(bytes).digest("hex");
const ready = JSON.parse(bytes.toString("utf8"), (_key, value) =>
  value?.$durableType === "bigint" ? BigInt(value.value) : value);
assert(ready.readyGeneration && ready.verifiedMemos, "completed Ready required");
const installed = [...load.plugins, ...load.disabledPlugins];
const reports = new Map(installed.map(entry => [String(entry.familyId), {
  family: String(entry.familyId), domain: entry.plugin.manifest.domain,
  instances: 0, routes: 0, constructed: 0, declined: 0, failed: 0,
  variants: {} as Record<string, number>, errors: [] as string[],
}]));
const executor = "0x1000000000000000000000000000000000000002";
const transactionOrigin = "0x1000000000000000000000000000000000000003";
for (const memo of Object.values(ready.verifiedMemos) as any[]) {
  const row = reports.get(memo.familyId); if (!row) continue;
  row.instances++;
  if (row.domain !== "swap" && row.domain !== "protocol") continue;
  const plugin: any = installed.find(x => x.familyId === memo.familyId)!.plugin;
  const descriptor = memo.compiledDescriptor;
  const proof = memo.validity.proofSource;
  const source = { number: proof.number, hash: proof.hash, generation: ready.readyGeneration.generation };
  try {
    for (const route of plugin.routes.project({ descriptor })) {
      row.routes++;
      const variant = String(route.executionMode ?? descriptor.variant ?? descriptor.hookModel ?? descriptor.quoteModel?.kind ?? route.direction ?? "default");
      row.variants[variant] = (row.variants[variant] ?? 0) + 1;
      try {
        assert.equal(typeof plugin.exact.methods, "function");
        const leg = plugin.execution.buildRuntimeLeg({ descriptor, route, executor, transactionOrigin, runtimeEvidence: [], source });
        if (leg === null) row.declined++;
        else { assert(leg && /^0x01(?:[a-fA-F0-9]{2})+$/.test(leg.program)); row.constructed++; }
      } catch (error) {
        row.failed++; if (row.errors.length < 3) row.errors.push(String(error));
      }
    }
  } catch (error) { row.failed++; if (row.errors.length < 3) row.errors.push(String(error)); }
}
console.log(JSON.stringify({ evidence: "offline-construction-only", readySha256: hash,
  range: ready.readyGeneration.universeRange, cutoff: ready.readyGeneration.cutoff,
  rows: [...reports.values()], caveat: "Saved descriptors do not grant current-source strict admission; no chain quote or EVM simulation performed." }, null, 2));
if ([...reports.values()].some(x => x.failed || x.declined)) process.exitCode = 1;
