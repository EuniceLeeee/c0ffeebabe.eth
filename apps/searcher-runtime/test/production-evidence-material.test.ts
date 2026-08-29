import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  encodeCanonicalBytes,
  decodeCanonicalBytes,
  hashDomain,
  type CanonicalJson,
  type Hash,
} from "../../../packages/canonical-codec/src/index.ts";
import { createSqliteDurableStore } from "../../../packages/durable-store/src/index.ts";
import {
  persistSearcherProductionEvidenceMaterialV1,
  readSearcherProductionEvidenceMaterialV1,
} from "../src/production-evidence-material.ts";

function h(label: string): Hash {
  return hashDomain("aloha/test/production-evidence-material/v1", label);
}

function makeEntries(count: number): readonly CanonicalJson[] {
  return Object.freeze(Array.from({ length: count }, (_, ordinal) => Object.freeze({
    ordinal: String(ordinal),
    candidateId: h(`candidate-${ordinal.toString().padStart(6, "0")}`),
    disposition: ordinal % 7 === 0 ? "selected" : "pruned",
  })));
}

function roots(entries: readonly CanonicalJson[]): readonly Hash[] {
  return entries.map((entry, ordinal) => hashDomain("aloha/test/production-evidence-material-entry/v1", { ordinal: String(ordinal), entry }));
}

test("30k physical material is complete, bounded, indexed, and restart-reopenable without sampling", () => {
  const directory = mkdtempSync(join(tmpdir(), "aloha-production-material-30k-"));
  const databasePath = join(directory, "evidence.sqlite");
  try {
    const entries = makeEntries(30_000);
    const entryRoots = roots(entries);
    const bindingRoot = h("binding-30k");
    const store = createSqliteDurableStore(databasePath);
    store.bindStoreRole("searcher-production-evidence");
    const manifest = persistSearcherProductionEvidenceMaterialV1(store, {
      materialKind: "route-accounting-entries",
      bindingRoot,
      entries,
      entryRoots,
    });
    assert.equal(manifest.entryCount, "30000");
    assert.ok(BigInt(manifest.chunkCount) > 1n);
    assert.ok(encodeCanonicalBytes(manifest as unknown as CanonicalJson).byteLength < 16_000);
    store.close();

    const reopened = createSqliteDurableStore(databasePath);
    reopened.bindStoreRole("searcher-production-evidence");
    const material = readSearcherProductionEvidenceMaterialV1(reopened, manifest, {
      materialKind: "route-accounting-entries",
      bindingRoot,
      decodeEntry(value, ordinal) {
        assert.equal(typeof value, "object", `entry ${ordinal}`);
        return value as CanonicalJson;
      },
      entryRoot: (entry, ordinal) => hashDomain("aloha/test/production-evidence-material-entry/v1", { ordinal: String(ordinal), entry }),
    });
    assert.equal(material.entries.length, 30_000);
    assert.deepEqual(material.entries[0], entries[0]);
    assert.deepEqual(material.entries[14_999], entries[14_999]);
    assert.deepEqual(material.entries[29_999], entries[29_999]);
    reopened.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("material reader rejects cross-binding, reordered, duplicated, and self-consistent deleted closures", () => {
  const directory = mkdtempSync(join(tmpdir(), "aloha-production-material-mutations-"));
  const databasePath = join(directory, "evidence.sqlite");
  try {
    const original = makeEntries(600);
    const originalRoots = roots(original);
    const bindingRoot = h("binding-original");
    const store = createSqliteDurableStore(databasePath);
    store.bindStoreRole("searcher-production-evidence");
    const originalManifest = persistSearcherProductionEvidenceMaterialV1(store, {
      materialKind: "route-accounting-entries",
      bindingRoot,
      entries: original,
      entryRoots: originalRoots,
    });
    assert.deepEqual(persistSearcherProductionEvidenceMaterialV1(store, {
      materialKind: "route-accounting-entries",
      bindingRoot,
      entries: original,
      entryRoots: originalRoots,
    }), originalManifest);
    const crossBinding = h("binding-cross-head");
    const crossManifest = persistSearcherProductionEvidenceMaterialV1(store, {
      materialKind: "route-accounting-entries",
      bindingRoot: crossBinding,
      entries: original,
      entryRoots: originalRoots,
    });
    assert.throws(() => readSearcherProductionEvidenceMaterialV1(store, crossManifest, {
      materialKind: "route-accounting-entries",
      bindingRoot,
      decodeEntry: value => value as CanonicalJson,
      entryRoot: (entry, ordinal) => hashDomain("aloha/test/production-evidence-material-entry/v1", { ordinal: String(ordinal), entry }),
    }), /binding mismatch/);

    const reordered = Object.freeze([original[1]!, original[0]!, ...original.slice(2)]);
    assert.throws(() => persistSearcherProductionEvidenceMaterialV1(store, {
      materialKind: "route-accounting-entries",
      bindingRoot,
      entries: reordered,
      entryRoots: roots(reordered),
    }), /already sealed to different content/);
    assert.equal(readSearcherProductionEvidenceMaterialV1(store, originalManifest, {
      materialKind: "route-accounting-entries",
      bindingRoot,
      decodeEntry: value => value as CanonicalJson,
      entryRoot: (entry, ordinal) => hashDomain("aloha/test/production-evidence-material-entry/v1", { ordinal: String(ordinal), entry }),
    }).entries.length, original.length);

    const duplicated = Object.freeze([original[0]!, original[0]!, ...original.slice(2)]);
    const duplicateManifest = persistSearcherProductionEvidenceMaterialV1(store, {
      materialKind: "route-accounting-entries",
      bindingRoot: h("binding-duplicate"),
      entries: duplicated,
      entryRoots: roots(duplicated),
    });
    assert.throws(() => readSearcherProductionEvidenceMaterialV1(store, duplicateManifest, {
      materialKind: "route-accounting-entries",
      bindingRoot: h("binding-duplicate"),
      decodeEntry(value, ordinal) {
        const entry = value as { readonly ordinal: string };
        if (entry.ordinal !== String(ordinal)) throw new TypeError("entry semantic ordinal mismatch");
        return entry;
      },
      entryRoot: (entry, ordinal) => hashDomain("aloha/test/production-evidence-material-entry/v1", { ordinal: String(ordinal), entry }),
    }), /semantic ordinal mismatch/);

    const deleted = Object.freeze(original.slice(0, -1));
    const deletionBinding = h("binding-self-consistent-deletion");
    const deletedManifest = persistSearcherProductionEvidenceMaterialV1(store, {
      materialKind: "route-accounting-entries",
      bindingRoot: deletionBinding,
      entries: deleted,
      entryRoots: roots(deleted),
    });
    assert.throws(() => readSearcherProductionEvidenceMaterialV1(store, deletedManifest, {
      materialKind: "route-accounting-entries",
      // The frozen external denominator binding is not changed when an
      // attacker reroots only its material closure.
      bindingRoot,
      decodeEntry: value => value as CanonicalJson,
      entryRoot: (entry, ordinal) => hashDomain("aloha/test/production-evidence-material-entry/v1", { ordinal: String(ordinal), entry }),
    }), /binding mismatch/);
    store.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("restart reader fails closed when any physically linked chunk is missing", () => {
  const directory = mkdtempSync(join(tmpdir(), "aloha-production-material-missing-"));
  const databasePath = join(directory, "evidence.sqlite");
  try {
    const entries = makeEntries(600);
    const bindingRoot = h("binding-missing");
    const store = createSqliteDurableStore(databasePath);
    store.bindStoreRole("searcher-production-evidence");
    const manifest = persistSearcherProductionEvidenceMaterialV1(store, {
      materialKind: "route-accounting-entries",
      bindingRoot,
      entries,
      entryRoots: roots(entries),
    });
    const first = store.readContent(manifest.firstChunkHash!);
    assert.ok(first !== null);
    const firstChunk = decodeCanonicalBytes(first.bytes) as Record<string, unknown>;
    const missingHash = firstChunk.nextChunkHash as Hash;
    assert.equal(typeof missingHash, "string");
    store.close();

    const raw = new DatabaseSync(databasePath);
    raw.prepare("DELETE FROM durable_content WHERE hash=?").run(missingHash);
    raw.close();

    const reopened = createSqliteDurableStore(databasePath);
    reopened.bindStoreRole("searcher-production-evidence");
    assert.throws(() => readSearcherProductionEvidenceMaterialV1(reopened, manifest, {
      materialKind: "route-accounting-entries",
      bindingRoot,
      decodeEntry: value => value as CanonicalJson,
      entryRoot: (entry, ordinal) => hashDomain("aloha/test/production-evidence-material-entry/v1", { ordinal: String(ordinal), entry }),
    }), /chunk is missing/);
    reopened.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
