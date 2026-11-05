import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { generateRuntimeSourceClosure } from "../venues/capability-content-hash.js";
import { inactiveDeclarativeModules, OPTIONAL_DECLARATIVE_MODULE_SOURCES, dormantDeclarativeModuleSource } from "../venues/declarative-module-dependencies.js";

for (const [file, modules] of Object.entries(OPTIONAL_DECLARATIVE_MODULE_SOURCES)) {
  test(`${file}: only declared users depend on optional implementation changes`, async () => {
    const root = await mkdtemp(resolve(tmpdir(), "family-module-dependencies-"));
    try {
      const directory = resolve(root, "src/searcher/venues"); await mkdir(directory, { recursive: true });
      await writeFile(resolve(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { target: "ES2022", module: "ESNext" } }));
      await writeFile(resolve(root, "package-lock.json"), JSON.stringify({ packages: {} }));
      const entry = resolve(directory, "entry.ts"), leaf = resolve(directory, file), shared = resolve(directory, "shared.ts");
      await writeFile(entry, `import { operation } from './${file.replace(/\.ts$/, ".js")}'; export const compiler = operation;`);
      await writeFile(shared, "export const guard = 1;");
      const implementation = (n: number) => `import {guard} from './shared.js'; export function operation() {return guard + ${n};}`;
      await writeFile(leaf, implementation(1));
      const hash = async (documents: Record<string, any>[]) => (await generateRuntimeSourceClosure({ rootDirectory: root,
        entryFile: entry, inactiveRuntimeModules: inactiveDeclarativeModules(documents) })).closureHash;
      const absent = [{ modules: {} }], empty = [{ modules: { [modules[0]]: {} } }];
      const rootUser = [{ modules: { [modules[0]]: { version: 1 } } }];
      const standardUser = [{ standard: { modules: { [modules[0]]: { version: 1 } } } }];
      const childUser = [{}, { modules: { [modules[0]]: { version: 1 } } }];
      const rootOverridden = [...rootUser, ...empty];
      const scenarios = [absent, empty, rootUser, standardUser, childUser, rootOverridden];
      const before = await Promise.all(scenarios.map(hash));
      await writeFile(leaf, implementation(2));
      const after = await Promise.all(scenarios.map(hash));
      for (let i = 0; i < scenarios.length; i++) assert.equal(before[i] !== after[i], i >= 2);
      for (const name of modules) assert(!inactiveDeclarativeModules([{ modules: { [name]: { version: 1 } } }]).includes(file));
      await writeFile(shared, "export const guard = 2;");
      assert.notEqual(await hash(absent), after[0], "shared safety imports remain dependencies even for dormant modules");
      const safe = await hash(absent);
      await writeFile(leaf, implementation(2) + "\n(globalThis as any).moduleSideEffect = true;");
      assert.notEqual(await hash(absent), safe, "unknown top-level execution falls back to the full hash");
      assert.equal(dormantDeclarativeModuleSource({ rootDirectory: root, file: leaf, source: await readFile(leaf, "utf8"),
        inactive: inactiveDeclarativeModules(absent) }), undefined);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
}

test("dependency selection counts blocked authored modules and rejects malformed blocks", () => {
  assert(!inactiveDeclarativeModules([{ modules: { trialState: { version: 1, missingMath: true } } }]).includes("declarative-trial-state.ts"));
  for (const modules of [null, [], { trialState: null }, { trialState: [] }])
    assert.throws(() => inactiveDeclarativeModules([{ modules }]));
  assert(!inactiveDeclarativeModules([{}]).includes("declarative-read-flow.ts"), "non-module read entry points remain in the core closure");
});


test("dormant modules with throwing Set initializers retain their complete source", () => {
  const rootDirectory = "/fixture", file = "/fixture/src/searcher/venues/declarative-trial-state.ts";
  const inactive = inactiveDeclarativeModules([{}]);
  for (const initializer of ["new Set(1 as any)", "new Set({} as any)", "new Set(null as any)"]) {
    assert.equal(dormantDeclarativeModuleSource({ rootDirectory, file, inactive,
      source: `const values = ${initializer}; export function operation() { return values; }` }), undefined);
  }
  assert(dormantDeclarativeModuleSource({ rootDirectory, file, inactive,
    source: `const values = new Set(["a", "b"]); export function operation() { return values; }` }));
});
