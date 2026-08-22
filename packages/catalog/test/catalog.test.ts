import assert from "node:assert/strict";
import test from "node:test";
import { hashDomain, type Hash } from "../../canonical-codec/src/index.ts";
import {
  sealInstanceCatalog,
  sealInstancePublication,
  validateInstanceCatalog,
  validateInstancePublication,
  type InstancePublicationDraftV1,
} from "../src/index.ts";

const h = (value: string): Hash => hashDomain("test/catalog", value);
const cutoff = { chainId: "1", number: "10", hash: h("block"), stateRoot: h("state") };

const draft = (instanceKey = "instance-a"): InstancePublicationDraftV1 => ({
  familyId: "family-a",
  familyDefinitionHash: h("definition"),
  familyCandidateKey: h(`candidate:${instanceKey}`),
  instanceKey,
  cutoff,
  identityMemoHash: h("identity"),
  descriptorHash: h("descriptor"),
  staticProjectionMemoHash: h("memo"),
  requestedArtifactDependencyRoot: h("artifact-dependencies"),
  validityDependencyRoot: h("validity"),
  transitions: [{
    inputAssetPorts: [{ assetRef: h("in"), portRef: h("in-port"), ordinal: "0" }],
    outputAssetPorts: [{ assetRef: h("out"), portRef: h("out-port"), ordinal: "0" }],
    opaqueTransitionRef: h("transition"),
    constraintRefs: [h("constraint")],
    staticProjectionHash: h("projection"),
  }],
  evidenceRoot: h("evidence"),
});

test("publication and catalog roots are deterministic and protocol neutral", () => {
  const first = sealInstancePublication(draft("a"));
  const second = sealInstancePublication(draft("b"));
  assert.equal(first.instancePublicationHash, sealInstancePublication(draft("a")).instancePublicationHash);
  assert.equal(
    sealInstanceCatalog(cutoff, [first, second]).instanceCatalogRoot,
    sealInstanceCatalog(cutoff, [second, first]).instanceCatalogRoot,
  );
  assert.equal("v3Fee" in first.transitions[0]!, false);
});

test("unknown protocol fields cannot be silently dropped by publication freeze", () => {
  const mutated = {
    ...draft(),
    transitions: [{ ...draft().transitions[0]!, v3Fee: 3000 }],
  } as unknown as InstancePublicationDraftV1;
  assert.throws(() => sealInstancePublication(mutated), /unknown field/);
});

test("catalog decoders reject accessors, proxies, malformed hashes, and non-arrays", () => {
  const value = draft();
  const accessor = { ...value } as Record<string, unknown>;
  let getterCalled = false;
  Object.defineProperty(accessor, "familyId", {
    enumerable: true,
    configurable: true,
    get: () => {
      getterCalled = true;
      throw new Error("accessor was invoked");
    },
  });
  assert.throws(() => sealInstancePublication(accessor as unknown as InstancePublicationDraftV1), /accessor/);
  assert.equal(getterCalled, false);
  assert.throws(
    () => sealInstancePublication(new Proxy(value, { get: () => { throw new Error("proxy trap"); } })),
    /Proxy/,
  );
  assert.throws(
    () => sealInstancePublication({ ...value, evidenceRoot: "0x" } as unknown as InstancePublicationDraftV1),
    /hash/,
  );
  assert.throws(
    () => sealInstancePublication({ ...value, transitions: { 0: value.transitions[0] } } as unknown as InstancePublicationDraftV1),
    /array/,
  );
});

test("duplicate canonical instance publication fails closed", () => {
  const publication = sealInstancePublication(draft());
  assert.throws(
    () => sealInstanceCatalog(cutoff, [publication, publication]),
    /duplicate-instance-publication/,
  );
});

test("persisted publication and catalog hashes are re-derived, not trusted", () => {
  const publication = sealInstancePublication(draft());
  validateInstancePublication(publication);
  assert.throws(
    () => validateInstancePublication({ ...publication, instancePublicationHash: h("forged") }),
    /hash-mismatch/,
  );
  const catalog = sealInstanceCatalog(cutoff, [publication]);
  assert.throws(
    () => validateInstanceCatalog({ ...catalog, instanceCatalogRoot: h("forged") }),
    /root-mismatch/,
  );
});
