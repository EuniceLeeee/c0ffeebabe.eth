import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { checkPins, reviewFailures, validateInventory, evidenceFailures, assertSourceCoverage, type FamilyReview, type SettlementReview } from "./family-settlement-review.js";
const sha = "a".repeat(64);
const row = (): FamilyReview => ({ familyId: "test:family", domain: "swap", coverage: "complete",
  source: [{ path: "listener/src/test.ts", sha256: sha }], review: { path: "docs/research/reports/review.json", sha256: sha }, variants: [{ id: "both-directions",
    interface: "verified", identity: "verified", callback: "output-first", recipient: "yes",
    wiring: "verified", execution: "verified", evidence: [{ path: "review.json", sha256: sha }], gaps: [] }] });
const report = (): SettlementReview => ({ schema: "family-settlement-interface-review-v1", commonSource: row().source, families: [row()] });

test("acceptance requires complete identity, interface, wiring and real execution evidence", () => {
  assert.deepEqual(reviewFailures(row()), []);
  for (const field of ["interface", "identity", "callback", "recipient", "wiring", "execution"] as const) {
    const r = row(); (r.variants[0] as any)[field] = "unverified"; assert(reviewFailures(r).length, field);
  }
  for (const patch of [{ coverage: "partial" as const }, { variants: [{ ...row().variants[0], gaps: ["new mode not executed"] }] },
    { variants: [{ ...row().variants[0], evidence: [] }] }]) assert(reviewFailures({ ...row(), ...patch }).length);
});

test("unsupported operations need interface evidence, while callbacks and receiver modes cannot skip execution", () => {
  for (const callback of ["none"] as const) {
    const r = row(); Object.assign(r.variants[0], { callback, recipient: "no", execution: "not-required" });
    assert.deepEqual(reviewFailures(r), []);
    r.variants[0].interface = "unverified"; assert(reviewFailures(r).length);
  }
  for (const patch of [{ recipient: "yes" }, { recipient: "conditional" }, { callback: "output-first" }, { callback: "separate-funding" }, { callback: "input-first" }]) {
    const r = row(); Object.assign(r.variants[0], { callback: "none", recipient: "no", execution: "not-required" }, patch);
    assert(reviewFailures(r).length);
  }
});

test("installed coverage cannot omit disabled entries, duplicate Families or silently add variants", () => {
  const installed = [{ familyId: "test:family", domain: "swap" }]; validateInventory(report(), installed);
  assert.throws(() => validateInventory(report(), [...installed, { familyId: "disabled:family", domain: "funding" }]));
  const duplicate = report(); duplicate.families.push(row()); assert.throws(() => validateInventory(duplicate, installed));
  const bad = report(); bad.families[0].variants.push({ ...bad.families[0].variants[0] });
  assert.throws(() => validateInventory(bad, installed));
  const numeric = report(); (numeric.families[0].variants[0] as any).id = 123; assert.throws(() => validateInventory(numeric, installed));
  const empty = report(); empty.families[0].variants = []; assert.throws(() => validateInventory(empty, installed));
});

test("changed or missing production code invalidates saved acceptance without overwriting old evidence", () => {
  const bytes = Buffer.from("reviewed source");
  const pins = [{ path: "listener/src/test.ts", sha256: createHash("sha256").update(bytes).digest("hex") }];
  assert.deepEqual(checkPins(pins, () => bytes), []);
  assert.match(checkPins(pins, () => Buffer.from("changed"))[0], /stale source/);
  assert.match(checkPins(pins, () => { throw new Error("missing"); })[0], /missing source/);
});


test("omitted reviewed variants and interface-only files cannot manufacture execution acceptance", () => {
  const r = row(), store = new Map<string, Buffer>();
  const pin = (path: string, data: unknown) => {
    const bytes = Buffer.from(JSON.stringify(data)); store.set(path, bytes);
    return { path, sha256: createHash("sha256").update(bytes).digest("hex") };
  };
  const read = (path: string) => { const bytes = store.get(path); assert(bytes, "missing evidence"); return bytes; };
  r.review = pin("docs/research/reports/review.json", { families: [{ familyId: r.familyId, variants: [{ id: "both-directions" }] }] });
  r.variants[0].evidence = [r.review];
  r.variants[0].executionEvidence = pin("docs/research/reports/execution.json", {
    kind: "family-settlement-behavior-evidence-v1", familyId: r.familyId, variantIds: ["both-directions"], result: "pass",
    source: r.source, commonSource: [], positiveExecutions: 2, rejections: 3, verifiedAssertions: ["actual-input-debit", "actual-output-receipt", "old-inventory",
      "rollback", "callback-caller", "callback-debt", "output-before-payment"], evidence: [r.review],
  });
  assert.deepEqual(evidenceFailures(r, [], read), []);
  const good = r.variants[0].executionEvidence;
  const goodBytes = Buffer.from(store.get(good.path)!);
  for (const patch of [{ variantIds: "both-directions" }, { verifiedAssertions: "actual-input-debit actual-output-receipt old-inventory rollback callback-caller callback-debt output-before-payment" },
    { positiveExecutions: "2" }, { rejections: true }, { source: [] }, { commonSource: r.source }]) {
    r.variants[0].executionEvidence = pin(good.path, { ...JSON.parse(goodBytes.toString()), ...patch });
    assert(evidenceFailures(r, [], read).length);
  }
  store.set(good.path, goodBytes); r.variants[0].executionEvidence = good;
  r.variants[0].executionEvidence = r.review; assert(evidenceFailures(r, [], read).length);
  r.variants[0].executionEvidence = good;
  r.review = pin(r.review.path, { families: [{ familyId: r.familyId, variants: [{ id: "both-directions" }, { id: "second-profile" }] }] });
  r.variants[0].evidence = [r.review]; assert(evidenceFailures(r, [], read).length);
  store.set(r.review.path, Buffer.from("changed evidence")); assert.match(evidenceFailures(r, [], read)[0], /stale source/);
});

test("reviewers cannot replace relevant source closure with arbitrary unchanged files", () => {
  const r = row(), requiredCommon = ["src/BotVM.sol", "src/Constants.sol", "listener/src/shared-helper.ts"],
    common = requiredCommon.map(path => ({ path, sha256: sha }));
  assertSourceCoverage(r, ["listener/src/test.ts"], common, requiredCommon);
  assert.throws(() => assertSourceCoverage(r, ["listener/src/test.ts", "listener/src/actual-execution.ts"], common, requiredCommon));
  assert.throws(() => assertSourceCoverage(r, ["listener/src/test.ts"], common.slice(1), requiredCommon));
  assert.throws(() => assertSourceCoverage(r, ["listener/src/test.ts"], common, [...requiredCommon, "listener/src/new-helper.ts"]));
});


test("internal-only caller hooks require independent classification and ordinary real execution", () => {
  const r = row(), store = new Map<string, Buffer>();
  const pin = (path: string, data: unknown) => {
    const bytes = Buffer.from(JSON.stringify(data)); store.set(path, bytes);
    return { path, sha256: createHash("sha256").update(bytes).digest("hex") };
  };
  const read = (path: string) => { const bytes = store.get(path); assert(bytes); return bytes; };
  const v = r.variants[0];
  Object.assign(v, { callback: "internal-only", recipient: "no", execution: "not-required" });
  assert(reviewFailures(r).length, "ordinary execution cannot be omitted");
  const classification = { id: v.id, callback: "internal-only", recipient: "no", callerContinuation: false };
  const review = (patch: object = {}) => {
    r.review = pin("docs/research/reports/review.json", { families: [{ familyId: r.familyId,
      variants: [{ ...classification, ...patch }] }] }); v.evidence = [r.review];
  };
  const saved = pin("saved-execution.json", { actual: "immutable historical execution" });
  const ordinary = { kind: "family-ordinary-execution-evidence-v1", familyId: r.familyId,
    variantIds: [v.id], result: "pass", source: r.source, commonSource: [], positiveExecutions: 2,
    rejections: 0, verifiedAssertions: ["actual-input-debit", "actual-output-receipt", "old-inventory"], evidence: [saved] };
  const execution = (patch: object = {}) => {
    v.ordinaryExecutionEvidence = pin("ordinary.json", { ...ordinary, ...patch });
  };
  review(); execution();
  assert.deepEqual(reviewFailures(r), []); assert.deepEqual(evidenceFailures(r, [], read), []);
  execution({ rejections: 12 }); assert.deepEqual(evidenceFailures(r, [], read), []);
  for (const patch of [{ positiveExecutions: true }, { positiveExecutions: "2" }, { positiveExecutions: 0 },
    { positiveExecutions: 1.5 }, { rejections: true }, { rejections: "0" }, { rejections: -1 }, { rejections: 0.5 },
    { result: "partial" }, { familyId: "other" }, { kind: "family-settlement-behavior-evidence-v1" },
    { variantIds: ["other"] }, { variantIds: v.id }, { source: [] }, { commonSource: r.source },
    { verifiedAssertions: "actual-input-debit actual-output-receipt old-inventory" }, { evidence: [] },
    { evidence: [{ path: saved.path, sha256: "bad" }] }]) {
    execution(patch); assert(evidenceFailures(r, [], read).length, JSON.stringify(patch));
  }
  for (const required of ordinary.verifiedAssertions) {
    execution({ verifiedAssertions: ordinary.verifiedAssertions.filter(x => x !== required) });
    assert(evidenceFailures(r, [], read).length, required);
  }
  execution();
  for (const patch of [{ callback: "output-first" }, { callback: "input-first" }, { callback: "separate-funding" },
    { callback: undefined }, { recipient: "yes" }, { recipient: "conditional" }, { recipient: undefined },
    { callerContinuation: true }, { callerContinuation: undefined }, { callerContinuation: "false" }]) {
    review(patch); assert(evidenceFailures(r, [], read).length, JSON.stringify(patch));
  }
  review();
  const ordinaryPin = v.ordinaryExecutionEvidence; delete v.ordinaryExecutionEvidence;
  assert(evidenceFailures(r, [], read).length); v.ordinaryExecutionEvidence = ordinaryPin;
  const bytes = store.get(saved.path)!; store.set(saved.path, Buffer.from("changed"));
  assert(evidenceFailures(r, [], read).some(x => x.includes("stale source"))); store.set(saved.path, bytes);
  const savedOrdinary = store.get(ordinaryPin!.path)!; store.set(ordinaryPin!.path, Buffer.from("changed"));
  assert(evidenceFailures(r, [], read).some(x => x.includes("stale source"))); store.set(ordinaryPin!.path, savedOrdinary);
  // A real settlement mode cannot substitute the ordinary certificate for its own execution evidence.
  Object.assign(v, { callback: "output-first", recipient: "yes", execution: "not-required" });
  assert(reviewFailures(r).length);
  v.execution = "verified"; v.executionEvidence = ordinaryPin;
  assert(evidenceFailures(r, [], read).length);
});
