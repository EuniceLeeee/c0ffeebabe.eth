import assert from "node:assert/strict";
import test from "node:test";
import { assertCapabilityRef, asSchemaRef } from "../../capability-contracts/src/index.ts";
import { decodeExactObject, hashDomain, type CanonicalJson } from "../../canonical-codec/src/index.ts";
import { createProgramIssuerOwner } from "../../request-program/src/internal/issuer-owner.ts";
import { issueFrozenProgram } from "../../request-program/src/index.ts";
import { createCapabilityInterpreterRegistryOwner } from "../src/internal/registry-owner.ts";
import { interpretCapabilityProgram, type TransportFactV1 } from "../src/index.ts";

const h = (value: string) => hashDomain("test/capability-interpreters", value);
const schemaRef = asSchemaRef(h("program-schema"));
const capabilityRef = assertCapabilityRef({ capabilityId: "demo.effect", version: "1.0.0", schemaHash: schemaRef, interpreterHash: h("interpreter"), ownerRef: h("owner") });
const dependencyRef = assertCapabilityRef({ capabilityId: "demo.state", version: "1.0.0", schemaHash: h("state-schema"), interpreterHash: h("state-interpreter"), ownerRef: h("state-owner") });
const codec = { schemaRef, decodeExact: (value: unknown) => decodeExactObject(value, { expected: (item, path) => { if (typeof item !== "string") throw new TypeError(path); return item; } }, "payload") };
const source = { chainId: "1", number: "100", hash: h("block"), stateRoot: h("state") };

function setup(mode: "verified" | "rejected" | "fake-rejected" = "verified") {
  const issuer = createProgramIssuerOwner({ issuerRef: h("issuer"), capabilityRef, authorityHash: h("authority"), codec });
  const program = issueFrozenProgram(issuer.capability, { source, value: { expected: "0x01" } });
  const registry = createCapabilityInterpreterRegistryOwner({
    capabilityRefs: [capabilityRef, dependencyRef],
    releaseAuthorityRoot: h("release-authority"),
    programAuthorityHash: h("authority"),
    executorAuthorityRoot: h("executor"),
    workerEpoch: "epoch-1",
    executorSessionHash: h("session"),
    declarations: [{
      capabilityRef,
      dependencyIds: [dependencyRef.capabilityId],
      outputSchemaRef: h("output-schema"),
      implementationClosureHash: h(`implementation-${mode}`),
      outputCodecHash: h("output-codec"),
      outputCodec: { decodeExact: value => decodeExactObject(value, { accepted: (item, path) => { if (typeof item !== "boolean") throw new TypeError(path); return item; } }, "output") as CanonicalJson },
      interpret({ facts, dependencyRefs, factSet }) {
        assert.equal(dependencyRefs.length, 1);
        assert.equal(facts[0]?.kind, "returned");
        if (mode === "rejected") return { kind: "chainProvenRejected", factSet, decisionCode: "effect-mismatch" };
        if (mode === "fake-rejected") return { kind: "chainProvenRejected", factSet: { ...factSet }, decisionCode: "effect-mismatch" };
        return { kind: "verified", output: { accepted: true } };
      },
    }],
  });
  const factSource = { chainId: "1", blockNumber: "100", blockHash: source.hash, stateRoot: source.stateRoot, executorAuthorityRoot: h("executor"), workerEpoch: "epoch-1", executorSessionHash: h("session") };
  const returned: TransportFactV1 = { kind: "returned", requestId: h("request"), requestFingerprint: program.requestFingerprint, dataHex: "0x01", source: factSource };
  const factSet = registry.issueFactSet({ programRequestFingerprint: program.requestFingerprint, facts: [returned] });
  return { program, registry, returned, factSource, factSet };
}

test("qualified interpreter receives only declared dependency refs and seals verified output", () => {
  const { program, registry, factSet } = setup();
  assert.deepEqual(interpretCapabilityProgram(registry.port, { program, factSet }), { kind: "verified", output: { accepted: true }, outputSchemaRef: h("output-schema") });
});

test("transport failure is retryable and never executed as protocol truth", () => {
  const { program, registry, factSource } = setup();
  const failure: TransportFactV1 = { kind: "transportFailure", requestId: h("request"), requestFingerprint: program.requestFingerprint, failureCode: "resource-limit", source: factSource };
  const factSet = registry.issueFactSet({ programRequestFingerprint: program.requestFingerprint, facts: [failure] });
  assert.deepEqual(interpretCapabilityProgram(registry.port, { program, factSet }), { kind: "retryable", failureCode: "resource-limit" });
});

test("terminal rejection requires the exact framework-issued fact set capability", () => {
  const valid = setup("rejected");
  assert.equal(interpretCapabilityProgram(valid.registry.port, { program: valid.program, factSet: valid.factSet }).kind, "chainProvenRejected");
  const fake = setup("fake-rejected");
  assert.deepEqual(interpretCapabilityProgram(fake.registry.port, { program: fake.program, factSet: fake.factSet }), { kind: "invalidProgram", code: "rejection-fact-set-invalid" });
});

test("opaque fact-set, source, executor, duplicate fact and registry mutations fail closed", () => {
  const { program, registry, returned, factSet } = setup();
  assert.deepEqual(interpretCapabilityProgram(registry.port, { program, factSet: { ...factSet } }), { kind: "invalidProgram", code: "transport-facts-invalid" });
  const wrongRequest = registry.issueFactSet({ programRequestFingerprint: program.requestFingerprint, facts: [{ ...returned, requestFingerprint: h("other") }] });
  assert.deepEqual(interpretCapabilityProgram(registry.port, { program, factSet: wrongRequest }), { kind: "invalidProgram", code: "transport-facts-invalid" });
  const wrongExecutor = registry.issueFactSet({ programRequestFingerprint: program.requestFingerprint, facts: [{ ...returned, source: { ...returned.source, executorSessionHash: h("other-session") } }] });
  assert.deepEqual(interpretCapabilityProgram(registry.port, { program, factSet: wrongExecutor }), { kind: "invalidProgram", code: "transport-facts-invalid" });
  const duplicates = registry.issueFactSet({ programRequestFingerprint: program.requestFingerprint, facts: [returned, returned] });
  assert.deepEqual(interpretCapabilityProgram(registry.port, { program, factSet: duplicates }), { kind: "invalidProgram", code: "transport-facts-invalid" });
  registry.revoke();
  assert.deepEqual(interpretCapabilityProgram(registry.port, { program, factSet }), { kind: "invalidProgram", code: "interpreter-registry-unavailable" });
});

test("registry identity changes with release, execution, implementation or codec closure", () => {
  const left = setup("verified");
  const right = setup("rejected");
  assert.notEqual(left.registry.port.registryRoot, right.registry.port.registryRoot);
});
