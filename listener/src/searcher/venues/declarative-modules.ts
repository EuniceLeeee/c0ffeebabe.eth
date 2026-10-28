/** A module is defined by common TS once. Documents contain data only. This
 * catalogue reports definition coverage, never protocol acceptance. */
export type ModuleBlock = Readonly<Record<string, unknown>>;
export interface DeclarativeModuleVersion<T = unknown> {
  readonly required: readonly string[];
  readonly optional?: readonly string[];
  validate(block: ModuleBlock): void;
  compile(block: ModuleBlock): T;
  dependencies?(block: ModuleBlock): readonly string[];
}
export interface DeclarativeModule<T = unknown> {
  readonly key: string;
  readonly versions: Readonly<Record<number, DeclarativeModuleVersion<T>>>;
}
export interface ModuleCoverage {
  readonly key: string;
  readonly state: "undefined" | "blocked" | "compiled";
  readonly version?: number;
  readonly missingDependencies: readonly string[];
}
const forbidden = new Set(["__proto__", "constructor", "prototype"]);
export function assertModuleData(value: unknown): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number" && Number.isSafeInteger(value)) return;
  if (Array.isArray(value)) { value.forEach(assertModuleData); return; }
  if (!value || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype)
    throw new Error("module definitions must be lossless JSON data");
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
    if (forbidden.has(key) || !("value" in descriptor)) throw new Error("invalid module data property");
    assertModuleData(descriptor.value);
  }
}
function record(value: unknown): asserts value is Record<string, unknown> {
  if (!value || Array.isArray(value) || typeof value !== "object") throw new Error("module block must be an object");
}
const freeze = <T>(value: T): T => {
  if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
};
export function createDeclarativeModuleCatalog(entries: readonly DeclarativeModule[]) {
  const catalog = new Map<string, DeclarativeModule>();
  for (const entry of entries) {
    if (!/^[a-zA-Z][a-zA-Z0-9]*$/.test(entry.key) || forbidden.has(entry.key) || catalog.has(entry.key))
      throw new Error("invalid or duplicate declarative module key");
    if (!Object.keys(entry.versions).length) throw new Error("module requires a version");
    for (const [version, contract] of Object.entries(entry.versions)) {
      if (!/^[1-9][0-9]*$/.test(version) || !Number.isSafeInteger(Number(version))) throw new Error("invalid module version");
      const fields = [...contract.required, ...(contract.optional ?? [])];
      if (fields.some(k => forbidden.has(k) || k === "version") || new Set(fields).size !== fields.length)
        throw new Error("invalid module field contract");
    }
    catalog.set(entry.key, freeze({ ...entry, versions: { ...entry.versions } }));
  }
  function read(raw: unknown = {}) {
    assertModuleData(raw); record(raw);
    for (const key of Object.keys(raw)) if (!catalog.has(key)) throw new Error(`unknown declarative module: ${key}`);
    const blocks: Record<string, ModuleBlock> = {}, contracts = new Map<string, DeclarativeModuleVersion>();
    const dependencies = new Map<string, readonly string[]>();
    for (const [key, entry] of catalog) {
      const block = Object.hasOwn(raw, key) ? raw[key] : {};
      record(block);
      blocks[key] = freeze(JSON.parse(JSON.stringify(block)));
      if (!Object.keys(block).length) continue;
      const version = block.version;
      const contract = typeof version === "number" && Number.isSafeInteger(version) && Object.hasOwn(entry.versions, version)
        ? entry.versions[version] : undefined;
      if (!contract) throw new Error(`unknown declarative module version: ${key}`);
      const allowed = new Set(["version", ...contract.required, ...(contract.optional ?? [])]);
      if (contract.required.some(field => !Object.hasOwn(block, field)) || Object.keys(block).some(field => !allowed.has(field)))
        throw new Error(`missing or unknown module fields: ${key}`);
      if (contract.validate(blocks[key]!) !== undefined) throw new Error(`module validation must be synchronous and return void: ${key}`);
      const deps = [...(contract.dependencies?.(blocks[key]!) ?? [])];
      if (deps.some(dep => !catalog.has(dep)) || new Set(deps).size !== deps.length) throw new Error(`invalid module dependencies: ${key}`);
      contracts.set(key, contract); dependencies.set(key, deps);
    }
    const visiting = new Set<string>(), rows = new Map<string, ModuleCoverage>(), compiled = new Map<string, unknown>();
    function visit(key: string): ModuleCoverage {
      if (visiting.has(key)) throw new Error(`cyclic module dependency: ${key}`);
      const prior = rows.get(key); if (prior) return prior;
      const contract = contracts.get(key);
      visiting.add(key);
      const missing = (dependencies.get(key) ?? []).filter(dep => visit(dep).state !== "compiled");
      const state = !contract ? "undefined" : missing.length ? "blocked" : "compiled";
      if (state === "compiled") {
        const value = contract!.compile(blocks[key]!);
        if (value === undefined) throw new Error(`module compiler returned no value: ${key}`);
        if (value && typeof (value as { then?: unknown }).then === "function") throw new Error(`module compilation must be synchronous: ${key}`);
        compiled.set(key, value);
      }
      const row = freeze({ key, state, ...(contract ? { version: blocks[key]!.version as number } : {}), missingDependencies: missing }) as ModuleCoverage;
      visiting.delete(key); rows.set(key, row); return row;
    }
    catalog.forEach((_entry, key) => visit(key));
    return Object.freeze({
      // A new-format view only. No mutation or inferred business definitions.
      blocks: freeze(blocks), coverage: freeze([...catalog.keys()].map(key => rows.get(key)!)),
      get<T = unknown>(key: string): T | undefined {
        if (!catalog.has(key)) throw new Error(`unknown declarative module: ${key}`);
        return compiled.get(key) as T | undefined;
      },
      require<T = unknown>(key: string): T {
        if (!compiled.has(key)) throw new Error(`declarative module unavailable: ${key}`);
        return compiled.get(key) as T;
      },
    });
  }
  return Object.freeze({
    read,
    schema: freeze(entries.map(entry => ({ key: entry.key, versions: Object.entries(entry.versions).map(([version, c]) =>
      ({ version: Number(version), required: [...c.required], optional: [...(c.optional ?? [])] })) }))),
  });
}
