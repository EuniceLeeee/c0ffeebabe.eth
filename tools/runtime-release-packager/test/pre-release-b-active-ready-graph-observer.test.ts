import assert from "node:assert/strict";
import {
  closeSync,
  constants,
  mkdtempSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

test("descriptor-bound SQLite reads cannot be redirected by atomic path replacement", () => {
  const root = mkdtempSync(join(tmpdir(), "aloha-ready-graph-fd-"));
  const expectedPath = join(root, "frozen-b.sqlite");
  const replacementPath = join(root, "replacement.sqlite");
  const create = (path: string, marker: string): void => {
    const database = new DatabaseSync(path);
    try {
      database.exec("CREATE TABLE marker(value TEXT NOT NULL)");
      database.prepare("INSERT INTO marker(value) VALUES (?)").run(marker);
    } finally {
      database.close();
    }
  };
  create(expectedPath, "published-a");
  create(replacementPath, "foreign-b");
  const descriptor = openSync(expectedPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    renameSync(replacementPath, expectedPath);
    const bound = new DatabaseSync(`/dev/fd/${descriptor}`, { readOnly: true });
    const redirected = new DatabaseSync(expectedPath, { readOnly: true });
    try {
      assert.equal((bound.prepare("SELECT value FROM marker").get() as Record<string, unknown>).value, "published-a");
      assert.equal((redirected.prepare("SELECT value FROM marker").get() as Record<string, unknown>).value, "foreign-b");
    } finally {
      bound.close();
      redirected.close();
    }
    const source = readFileSync(
      join(import.meta.dirname, "../src/internal/pre-release-b-active-ready-graph-owner.ts"),
      "utf8",
    );
    assert.match(source, /openPublishedRootSnapshot\(publication, expectedPath\)/);
    assert.match(source, /new DatabaseSync\(`\/dev\/fd\/\$\{snapshotFd\}`/);
    assert.ok((source.match(/assertPublishedDescriptor\(snapshotFd, publication, expectedPath\)/g) ?? []).length >= 1);
    assert.match(source, /pathAfter\.dev !== after\.dev \|\| pathAfter\.ino !== after\.ino/);
  } finally {
    closeSync(descriptor);
    rmSync(root, { recursive: true, force: true });
  }
});
