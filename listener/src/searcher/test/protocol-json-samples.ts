import assert from "node:assert/strict";
import { readFileSync, readdirSync, realpathSync } from "node:fs";
import { dirname, relative, resolve, isAbsolute } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseProtocolJsonAcceptanceCase, type ProtocolJsonAcceptanceCase } from "./protocol-json-acceptance-facts.js";

export const protocolJsonSamplesPath = fileURLToPath(new URL("./fixtures/protocol-json/index.json", import.meta.url));
const nonempty = (value: unknown): value is string => typeof value === "string" && value.trim() === value && value.length > 0;
const hash = (value: unknown): value is string => typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value);
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
export interface ProtocolJsonSampleSummary {
  readonly familyId: string; readonly references: number; readonly withTransaction: number;
  readonly caseInputsReady: number; readonly pending: readonly { id: string; missing: string[] }[];
  readonly missingSamples: readonly string[]; readonly execution: "not-run";
}

/** The library contains historical inputs and provenance, never admission or a
 * passing test decision. Only the common runner may produce new execution facts. */
export function loadProtocolJsonSamples(indexPath = protocolJsonSamplesPath) {
  const root = realpathSync(dirname(indexPath)), index: any = JSON.parse(readFileSync(indexPath, "utf8"));
  assert.equal(index.version, 1); assert(Array.isArray(index.families) && index.families.length > 0);
  const families = new Set<string>(), paths = new Set<string>();
  const cases: { familyId: string; sampleId: string; path: string; data: ProtocolJsonAcceptanceCase }[] = [];
  const summary: ProtocolJsonSampleSummary[] = index.families.map((family: any) => {
    assert(nonempty(family.familyId) && family.familyId.startsWith("protocol:") && !families.has(family.familyId), "invalid/duplicate sample Family");
    families.add(family.familyId);
    assert(Array.isArray(family.samples) && Array.isArray(family.missing));
    assert(family.samples.length > 0 || family.missing.length > 0, "missing samples must be explicit");
    const ids = new Set<string>(); let ready = 0, withTx = 0;
    const pending: { id: string; missing: string[] }[] = [];
    for (const sample of family.samples) {
      assert(nonempty(sample.id) && !ids.has(sample.id), "invalid/duplicate sample id"); ids.add(sample.id);
      assert(Array.isArray(sample.provenance) && sample.provenance.length > 0, "sample requires provenance");
      const pins = new Map<string, string>();
      for (const origin of sample.provenance) {
        assert(nonempty(origin.file) && /^[a-f0-9]{64}$/.test(origin.sha256), "invalid provenance pin");
        assert(!pins.has(origin.file) || pins.get(origin.file) === origin.sha256, "conflicting provenance pin");
        pins.set(origin.file, origin.sha256);
      }
      assert(Array.isArray(sample.amounts));
      for (const amount of sample.amounts) if (amount.provenance !== undefined) {
        const origin = amount.provenance;
        assert(origin && nonempty(origin.file) && pins.get(origin.file) === origin.sha256, "amount provenance must match a sample source pin");
      } // Absent per-amount provenance explicitly inherits the sample sources.
      assert(Array.isArray(sample.missing) && sample.missing.every(nonempty));
      assert(sample.transactionHash === null || hash(sample.transactionHash), "invalid reference transaction");
      if (sample.transactionHash) withTx++;
      if (sample.casePath === null) {
        assert(sample.missing.length > 0, "incomplete case requires a missing-field reason");
        pending.push({ id: sample.id, missing: sample.missing }); continue;
      }
      assert.equal(sample.classification, "real-historical-evidence", "runnable cases require historical evidence");
      assert.equal(sample.stateScope, "canonical-block-end", "runner requires explicit canonical block-end state");
      assert(nonempty(sample.casePath) && !isAbsolute(sample.casePath), "sample case must be library relative");
      const path = realpathSync(resolve(root, sample.casePath)), rel = relative(root, path);
      assert(rel !== ".." && !rel.startsWith("../") && !isAbsolute(rel) && rel.endsWith(".json"), "case escapes sample library");
      assert(rel.startsWith("cases/"), "case must be inside the cases directory");
      assert(!paths.has(path), "duplicate case file"); paths.add(path);
      const data = parseProtocolJsonAcceptanceCase(JSON.parse(readFileSync(path, "utf8")));
      assert.equal(data.familyId, family.familyId); assert.equal(data.instanceKey, sample.instanceKey);
      assert.equal(data.lineageId, sample.lineageId); assert.deepEqual(data.source, sample.source);
      assert(sample.actors && same(data.executor, sample.actors.executor) && same(data.owner, sample.actors.owner), "case/test actor mismatch");
      assert(data.transactionHash && sample.transactionHash && same(data.transactionHash, sample.transactionHash), "case/reference transaction mismatch");
      assert.equal(sample.missing.length, 0, "runnable input cannot retain missing fields");
      assert(Array.isArray(sample.amounts) && sample.amounts.length > 0);
      for (const trial of data.trials) {
        assert(trial.expectedAmountOut === undefined, "historical library borrows input only; do not promote recorded outputs across states");
        assert(sample.amounts.some((amount: any) => same(amount.tokenIn, trial.tokenIn) && same(amount.tokenOut, trial.tokenOut) &&
          amount.amountIn === trial.amountIn), "case amount/direction has no recorded input source");
      }
      cases.push({ familyId: family.familyId, sampleId: sample.id, path, data }); ready++;
    }
    assert.equal(family.completeCases, ready, "stale sample count");
    return { familyId: family.familyId, references: family.samples.length, withTransaction: withTx,
      caseInputsReady: ready, pending, missingSamples: family.missing, execution: "not-run" as const };
  });
  assert(index.scopeReference && Array.isArray(index.scopeReference.familyIds), "sample scope reference required");
  assert.deepEqual([...families].sort(), [...index.scopeReference.familyIds].sort(), "sample Family scope changed");
  const walk = (directory: string) => {
    for (const item of readdirSync(directory, { withFileTypes: true })) {
      const path = resolve(directory, item.name);
      assert(!item.isSymbolicLink(), "sample case symlink unsupported");
      if (item.isDirectory()) walk(path);
      else if (item.name.endsWith(".json")) assert(paths.has(realpathSync(path)), "unindexed case file");
    }
  };
  walk(resolve(root, "cases"));
  return { index, cases, summary, execution: "not-run" as const };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  assert.equal(process.argv.length, 2, "sample inventory takes no RPC or execution arguments");
  const result = loadProtocolJsonSamples();
  console.log(JSON.stringify({ families: result.summary, totalCaseInputs: result.cases.length,
    claim: "Input library integrity only; no Family correctness acceptance or historical execution performed" }, null, 2));
}
