import assert from "node:assert/strict";
import test from "node:test";
import { decodeCanonicalBytes, encodeCanonicalBytes, hashDomain, type Hash } from "../../canonical-codec/src/index.ts";
import { erc20AssetPortBindingV1 } from "../../asset-ref/src/index.ts";
import {
  sealInstanceCatalog,
  sealInstancePublication,
  decodeInstanceCatalogV1,
  encodeInstanceCatalogV1,
  validateInstanceCatalog,
  validateInstancePublication,
  type InstancePublicationDraftV1,
} from "../src/index.ts";

const h = (value: string): Hash => hashDomain("test/catalog", value);
const cutoff = { chainId: "1", number: "10", hash: h("block"), stateRoot: h("state") };
const inputAsset = erc20AssetPortBindingV1("1", "0x1111111111111111111111111111111111111111");
const outputAsset = erc20AssetPortBindingV1("1", "0x2222222222222222222222222222222222222222");

const draft = (instanceKey = "instance-a"): InstancePublicationDraftV1 => ({
  familyId: "family-a",
  familyDefinitionHash: h("definition"),
  familyCandidateKey: h(`candidate:${instanceKey}`),
  instanceKey,
  cutoff,
  identityMemo: { kind: "catalog-test-identity", instanceKey },
  identityMemoHash: hashDomain("aloha/identity-memo/v1", { kind: "catalog-test-identity", instanceKey }),
  descriptorHash: h("descriptor"),
  staticProjectionMemoHash: h("memo"),
  requestedArtifactDependencyRoot: h("artifact-dependencies"),
  validityDependencyRoot: h("validity"),
  transitions: [{
    inputAssetPorts: [{ ...inputAsset, portRef: h("in-port"), ordinal: "0" }],
    outputAssetPorts: [{ ...outputAsset, portRef: h("out-port"), ordinal: "0" }],
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

test("asset ports reject naked caller hashes, forged refs, and cross-chain identity", () => {
  const value = draft();
  const transition = value.transitions[0]!;
  assert.throws(() => sealInstancePublication({
    ...value,
    transitions: [{
      ...transition,
      inputAssetPorts: [{ assetRef: h("caller-asset"), portRef: h("in-port"), ordinal: "0" } as never],
    }],
  }), /missing field "assetIdentity"/);
  assert.throws(() => sealInstancePublication({
    ...value,
    transitions: [{
      ...transition,
      inputAssetPorts: [{ ...inputAsset, assetRef: h("forged-asset"), portRef: h("in-port"), ordinal: "0" }],
    }],
  }), /does not match identity/);
  const otherChain = erc20AssetPortBindingV1("10", inputAsset.assetIdentity.address!);
  assert.throws(() => sealInstancePublication({
    ...value,
    transitions: [{
      ...transition,
      inputAssetPorts: [{ ...otherChain, portRef: h("in-port"), ordinal: "0" }],
    }],
  }), /asset-port-chain-mismatch/);
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

test("30k catalog uses bounded linked chunks and reopens every publication without sampling", (t) => {
  const timings: Record<string, number> = {};
  let mark = Date.now();
  const publications = Array.from({ length: 30_000 }, (_, index) => (
    sealInstancePublication(draft(`ready-instance-${String(index).padStart(5, "0")}`))
  ));
  timings.sealPublications = Date.now() - mark;
  mark = Date.now();
  const catalog = sealInstanceCatalog(cutoff, publications);
  validateInstanceCatalog(catalog);
  timings.sealAndValidateCatalog = Date.now() - mark;
  mark = Date.now();
  const encoded = encodeInstanceCatalogV1(catalog);
  timings.encode = Date.now() - mark;
  assert.equal(catalog.instanceCount, "30000");
  assert.ok(encoded.chunks.length > 1);
  assert.ok(encoded.manifestBytes.byteLength <= 500_000);
  assert.ok(encoded.chunks.every(chunk => chunk.bytes.byteLength <= 500_000));
  assert.deepEqual(Object.keys(encoded.manifest).sort(), [
    "cutoff",
    "firstPublicationChunkRef",
    "instanceCatalogRoot",
    "instanceCount",
    "kind",
    "publicationChunkCount",
    "publicationSequenceRoot",
    "schemaVersion",
  ]);
  assert.deepEqual(Object.keys(encoded.chunks[0]!.ref), ["contentSha256"]);
  assert.deepEqual(Object.keys(encoded.chunks[0]!.chunk).sort(), [
    "kind",
    "nextPublicationChunkRef",
    "publications",
    "schemaVersion",
  ]);
  const bySha = new Map(encoded.chunks.map(chunk => [chunk.ref.contentSha256, chunk.bytes]));
  mark = Date.now();
  const reopened = decodeInstanceCatalogV1(encoded.manifestBytes, ref => {
    const bytes = bySha.get(ref.contentSha256);
    if (!bytes) throw new Error("missing test chunk");
    return bytes;
  });
  timings.decode = Date.now() - mark;
  assert.equal(reopened.publications.length, 30_000);
  assert.equal(reopened.instanceCatalogRoot, catalog.instanceCatalogRoot);
  for (const ordinal of [0, 14_999, 29_999]) {
    assert.equal(reopened.publications[ordinal]!.instancePublicationHash, catalog.publications[ordinal]!.instancePublicationHash);
  }
  const expanded = sealInstanceCatalog(cutoff, [...publications, sealInstancePublication(draft("ready-instance-extra"))]);
  assert.notEqual(expanded.instanceCatalogRoot, catalog.instanceCatalogRoot);
  t.diagnostic(`30k catalog timings ms ${JSON.stringify(timings)}`);
});

test("catalog linked chunks fail closed on missing, duplicate, cross-catalog, mutation, or manifest reroot", () => {
  const first = sealInstanceCatalog(cutoff, Array.from({ length: 260 }, (_, index) => (
    sealInstancePublication(draft(`chunk-a-${index}`))
  )));
  const second = sealInstanceCatalog(cutoff, Array.from({ length: 260 }, (_, index) => (
    sealInstancePublication(draft(`chunk-b-${index}`))
  )));
  const encoded = encodeInstanceCatalogV1(first);
  const foreign = encodeInstanceCatalogV1(second);
  const bySha = new Map(encoded.chunks.map(chunk => [chunk.ref.contentSha256, chunk.bytes]));
  assert.throws(() => decodeInstanceCatalogV1(encoded.manifestBytes, () => {
    throw new Error("missing");
  }), /missing/);
  const firstBytes = encoded.chunks[0]!.bytes;
  const firstChunkSha = encoded.chunks[0]!.ref.contentSha256;
  assert.throws(() => decodeInstanceCatalogV1(encoded.manifestBytes, () => firstBytes), /content mismatch/);
  assert.throws(() => decodeInstanceCatalogV1(encoded.manifestBytes, ref => (
    ref.contentSha256 === firstChunkSha ? foreign.chunks[0]!.bytes : bySha.get(ref.contentSha256)!
  )), /content mismatch/);
  const mutated = encoded.chunks[0]!.bytes.slice();
  mutated[mutated.length - 2] = mutated[mutated.length - 2]! ^ 1;
  assert.throws(() => decodeInstanceCatalogV1(encoded.manifestBytes, ref => (
    ref.contentSha256 === firstChunkSha ? mutated : bySha.get(ref.contentSha256)!
  )), /content mismatch/);
  const manifest = decodeCanonicalBytes(encoded.manifestBytes) as Record<string, unknown>;
  const rerooted = encodeCanonicalBytes({ ...manifest, instanceCatalogRoot: h("rerooted-catalog") });
  assert.throws(() => decodeInstanceCatalogV1(rerooted, ref => bySha.get(ref.contentSha256)!), /chunk binding|semantic root mismatch/);
});
