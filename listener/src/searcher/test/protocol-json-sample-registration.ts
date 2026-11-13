import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { loadFamilyJsonSamples } from "./protocol-json-samples.js";
import { parseProtocolJsonAcceptanceCase } from "./protocol-json-acceptance-facts.js";
import { readFamilyTransaction, familyTransactionLegMissing, type FamilyTransaction, type FamilyTransactionLeg } from "./family-transaction-registry.js";

import { validateTransactionStateSelection, type TransactionStateSelection } from "./family-transaction-source.js";

const fixtures = fileURLToPath(new URL("./fixtures", import.meta.url));
const sha = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");
const authorities = new WeakMap<object, { sample: unknown; pins: readonly { path: string; sha256: string }[] }>();
export interface SampleRegistration {
  readonly kind: "index" | "fixture" | "transaction";
  readonly path: string;
  readonly sha256: string;
  readonly index?: string;
  readonly indexSha256?: string;
  readonly sampleId?: string;
  readonly transactionHash?: string;
  readonly legId?: string;
}

export function transactionTestActors(leg: FamilyTransactionLeg) {
  return leg.actors ?? { executor: "0x1000000000000000000000000000000000000002", owner: "0x1000000000000000000000000000000000000001" };
}

/** Historical output is deliberately excluded. Only current quote/simulation
 * effects determine the result for this immutable input seed. */
export function transactionSimulationCase(transaction: FamilyTransaction, leg: FamilyTransactionLeg, stateSelection?: TransactionStateSelection) {
  assert.notEqual(leg.domain, "funding", "Funding uses its own production capabilities");
  assert.deepEqual(familyTransactionLegMissing(leg), [], "incomplete simulation seed");
  assert(transaction.legs.some(item => isDeepStrictEqual(item, leg)), "transaction does not register this leg");
  return parseProtocolJsonAcceptanceCase({ version: 1, familyId: leg.familyId, domain: leg.domain,
    instanceKey: leg.instanceKey, lineageId: leg.lineageId, source: validateTransactionStateSelection(leg.source!, stateSelection).executionSource, ...transactionTestActors(leg),
    transactionHash: transaction.transactionHash, trials: [{ id: leg.id, tokenIn: leg.tokenIn, tokenOut: leg.tokenOut,
      amountIn: leg.amountIn, inputToleranceRawUnits: 0, outputToleranceRawUnits: 1,
      ...(leg.routeKey ? { routeKey: leg.routeKey } : {}), ...(leg.credit ? { credit: leg.credit } : {}) }] });
}

export function registerTransactionAcceptanceSample(sample: unknown, transactionPath: string, legId: string,
  fixtureRoot = fixtures, stateSelection?: TransactionStateSelection): SampleRegistration {
  const root = realpathSync(resolve(fixtureRoot, "family-transactions")), path = realpathSync(transactionPath);
  assert.equal(resolve(path, ".."), root, "transaction seed must be in the centralized registry");
  const transaction = readFamilyTransaction(path), leg = transaction.legs.find(item => item.id === legId);
  assert(leg, "registered transaction leg missing");
  assert.deepEqual(sample, transactionSimulationCase(transaction, leg, stateSelection), "case differs from registered simulation input");
  const pin = { path, sha256: sha(readFileSync(path)) };
  const token = Object.freeze({ kind: "transaction" as const, ...pin, transactionHash: transaction.transactionHash, legId });
  authorities.set(token, { sample: JSON.parse(JSON.stringify(sample)), pins: [pin] });
  return token;
}

/** Registration is input evidence, never an execution result. A later-added
 * sample is valid for a new run; no historical registration-time policy exists.
 */
export function registerAcceptanceSample(sample: any, casePath: string, fixtureRoot = fixtures): SampleRegistration {
  const root = realpathSync(fixtureRoot), file = realpathSync(casePath);
  const inside = (path: string) => { const r = relative(root, path); return r !== "" && r !== ".." && !r.startsWith(".." + sep) && !r.startsWith(sep); };
  assert(statSync(file).isFile() && file.endsWith(".json"), "sample must be a JSON file");
  const supplied = JSON.parse(readFileSync(file, "utf8"));
  assert.deepEqual(sample.version === 1 && Array.isArray(sample.trials) ? parseProtocolJsonAcceptanceCase(supplied) : supplied,
    sample, "case file differs from the executed sample");
  const pins: { path: string; sha256: string }[] = [];
  const pin = (path: string) => { const value = { path, sha256: sha(readFileSync(path)) }; pins.push(value); return value; };
  let record: SampleRegistration | undefined;
  // Indexed libraries retain their full provenance/identity/amount validator.
  // An unindexed file in cases/ cannot fall through to standalone-fixture mode.
  if (sample.version === 1 && Array.isArray(sample.trials)) {
    for (const domain of ["protocol", "swap"] as const) {
      const index = resolve(root, `${domain}-json/index.json`);
      if (!existsSync(index)) continue;
      const raw = JSON.parse(readFileSync(index, "utf8"));
      if (!raw.families.some((f: any) => f.familyId === sample.familyId)) continue;
      const found = loadFamilyJsonSamples(index, domain).cases.find(c => isDeepStrictEqual(c.data, sample));
      if (!found) continue;
      const p = pin(found.path), i = pin(index);
      record = { kind: "index", ...p, index: i.path, indexSha256: i.sha256, sampleId: found.sampleId };
      break;
    }
  }
  if (!record) {
    assert(inside(file), "acceptance sample is not registered in the test fixture library");
    const rel = relative(root, file).split(sep);
    assert(!["protocol-json", "swap-json"].includes(rel[0]!), "acceptance case is absent from its sample index");
    const raw = JSON.parse(readFileSync(file, "utf8"));
    const declared = sample.version === 1 && Array.isArray(sample.trials) ? parseProtocolJsonAcceptanceCase(raw) : raw;
    assert.deepEqual(declared, sample, "registered fixture differs from the executed sample");
    record = { kind: "fixture", ...pin(file) };
  }
  // Also bind a supplied copy: it must not change during acceptance.
  if (!pins.some(p => p.path === file)) pin(file);
  const token = Object.freeze(record);
  authorities.set(token, { sample: JSON.parse(JSON.stringify(sample)), pins });
  return token;
}
export function assertRegisteredAcceptanceSample(sample: unknown, registration: SampleRegistration | undefined): void {
  const proof = registration && authorities.get(registration);
  assert(proof, "acceptance requires a registered sample before execution");
  assert.deepEqual(sample, proof.sample, "executed sample differs from registration");
  for (const pin of proof.pins) assert.equal(sha(readFileSync(pin.path)), pin.sha256, "registered sample/index changed during acceptance");
}
