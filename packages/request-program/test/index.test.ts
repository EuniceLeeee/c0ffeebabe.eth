import assert from "node:assert/strict";
import test from "node:test";
import { assertCapabilityRef, asOwnerRef, asSchemaRef } from "../../capability-contracts/src/index.ts";
import { decodeExactObject, hashDomain } from "../../canonical-codec/src/index.ts";
import { createProgramIssuerOwner } from "../src/internal/issuer-owner.ts";
import { decodeFrozenProgramEnvelope, issueFrozenProgram, persistFrozenProgram, rehydrateFrozenProgram } from "../src/index.ts";

const h = (value: string) => hashDomain("test/request-program", value);
const schemaRef = asSchemaRef(h("schema"));
const codec = Object.freeze({
  schemaRef,
  decodeExact(value: unknown) {
    return decodeExactObject(value, {
      callerMode: (item, path) => { if (item !== "impersonated-call-frame") throw new TypeError(`caller mode at ${path}`); return item; },
      observeAccounts: (item, path) => {
        if (!Array.isArray(item) || item.some(account => typeof account !== "string")) throw new TypeError(`accounts at ${path}`);
        return Object.freeze([...item] as string[]);
      },
    }, "payload");
  },
});
const capabilityRef = assertCapabilityRef({ capabilityId: "effect.observe", version: "1.0.0", schemaHash: schemaRef, interpreterHash: h("interpreter"), ownerRef: h("owner") });
const source = { chainId: "1", number: "100", hash: h("block"), stateRoot: h("state") };

test("issue, persist, load and rehydrate preserve one exact canonical envelope", () => {
  const owner = createProgramIssuerOwner({ issuerRef: h("issuer"), capabilityRef, authorityHash: h("authority"), codec });
  const program = issueFrozenProgram(owner.capability, { source, value: { callerMode: "impersonated-call-frame", observeAccounts: ["0x1", "0x2"] } });
  const record = persistFrozenProgram(program);
  assert.deepEqual(rehydrateFrozenProgram(owner.capability, record), program);
  assert.deepEqual(decodeFrozenProgramEnvelope(program), program);
});

test("every semantic field mutation fails or changes the request fingerprint", () => {
  const owner = createProgramIssuerOwner({ issuerRef: h("issuer"), capabilityRef, authorityHash: h("authority"), codec });
  const before = issueFrozenProgram(owner.capability, { source, value: { callerMode: "impersonated-call-frame", observeAccounts: ["0x1"] } });
  const after = issueFrozenProgram(owner.capability, { source, value: { callerMode: "impersonated-call-frame", observeAccounts: ["0x2"] } });
  assert.notEqual(before.requestFingerprint, after.requestFingerprint);
  assert.throws(() => decodeFrozenProgramEnvelope({ ...before, authorityHash: h("changed") }), /fingerprint mismatch/);
  assert.throws(() => decodeFrozenProgramEnvelope({ ...before, extra: true }), /unknown field/);
});

test("fake, revoked, wrong-schema and noncanonical payloads fail closed", () => {
  assert.throws(() => issueFrozenProgram({ issuerRef: asOwnerRef(h("issuer")), capabilityRef }, { source, value: {} }), /not issued/);
  const owner = createProgramIssuerOwner({ issuerRef: h("issuer"), capabilityRef, authorityHash: h("authority"), codec });
  owner.revoke();
  assert.throws(() => issueFrozenProgram(owner.capability, { source, value: { callerMode: "impersonated-call-frame", observeAccounts: [] } }), /revoked/);
  assert.throws(() => createProgramIssuerOwner({ issuerRef: h("issuer"), capabilityRef, authorityHash: h("authority"), codec: { ...codec, schemaRef: asSchemaRef(h("other")) } }), /does not match/);
});

test("a self-consistent record cannot rehydrate under a foreign issuer", () => {
  const owner = createProgramIssuerOwner({ issuerRef: h("issuer"), capabilityRef, authorityHash: h("authority"), codec });
  const foreign = createProgramIssuerOwner({ issuerRef: h("foreign-issuer"), capabilityRef, authorityHash: h("foreign-authority"), codec });
  const program = issueFrozenProgram(owner.capability, { source, value: { callerMode: "impersonated-call-frame", observeAccounts: [] } });
  assert.throws(() => rehydrateFrozenProgram(foreign.capability, persistFrozenProgram(program)), /issuer or authority mismatch/);
  owner.revoke();
  assert.throws(() => rehydrateFrozenProgram(owner.capability, persistFrozenProgram(program)), /revoked/);
});
