import assert from "node:assert/strict";
import { test } from "node:test";
import { createProbeWiring, rebuildFamilyCandidateKey } from "../universe-rebuild-production.js";

const source = { number: 26222895, hash: "0x" + "39".repeat(32), generation: 26222895 };
const candidate = { familyId: "univ2-standard", adapter: "univ2", address: "0x" + "11".repeat(20) };
const result = { accepted: { familyId: candidate.familyId, lineageId: "fixture", subject: candidate.address },
  authorityFingerprint: "fixture-authority", instance: { instanceKey: "fixture-instance", routes: [], evidenceRefs: [] } };
const probe = createProbeWiring({ rpcUrl: "http://127.0.0.1:1" });
const input = { candidate, result, proofSource: source, familyCandidateKey: rebuildFamilyCandidateKey(candidate) };

test("memo sealer preserves the requested Family and canonical candidate key without RPC", () => {
  const memo = probe.sealDurableVerifiedMemo(input);
  assert.equal(memo.familyId, candidate.familyId);
  assert.equal(memo.familyCandidateKey, input.familyCandidateKey);
});

test("memo sealer rejects a foreign successful lifecycle result", () => {
  assert.throws(() => probe.sealDurableVerifiedMemo({ ...input,
    result: { ...result, accepted: { ...result.accepted, familyId: "protocol:wsteth" } } }),
  /changed candidate Family\/key/);
});

test("memo sealer rejects a supplied key that differs from the requested candidate", () => {
  assert.throws(() => probe.sealDurableVerifiedMemo({ ...input, familyCandidateKey: "wrong-key" }),
    /candidate key mismatch/);
});

test("funding results cannot be sealed under another Family candidate", () => {
  assert.throws(() => probe.sealDurableVerifiedMemo({ ...input,
    result: { domain: "funding", familyId: "flash-loan:morpho", asset: candidate.address } }),
  /changed candidate Family\/key/);
});
