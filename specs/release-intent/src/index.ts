import {
  assertHash,
  assertNonEmptyString,
  decodeExactObject,
  deepFreeze,
  fieldArray,
  hashDomain,
  type Hash,
} from "../../../packages/canonical-codec/src/index.ts";

export interface PublicEntryBindingV1 {
  readonly modulePath: string;
  readonly exportName: string;
}

export interface FamilyReleaseIntentEntryV1 extends PublicEntryBindingV1 {
  readonly familyId: string;
  readonly manifestRoot: Hash;
}

export interface StrategyReleaseIntentEntryV1 extends PublicEntryBindingV1 {
  readonly strategyId: string;
  readonly manifestRoot: Hash;
}

export interface ReleaseIntentV1 {
  readonly schemaVersion: 1;
  readonly families: readonly FamilyReleaseIntentEntryV1[];
  readonly strategies: readonly StrategyReleaseIntentEntryV1[];
  readonly releaseIntentRoot: Hash;
}

const ID_RE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

function path(value: unknown, field: string): string {
  const result = assertNonEmptyString(value, field);
  if (result.startsWith(".") || result.startsWith("/") || result.startsWith("@") || result.includes("..") || result.includes("\\") || result.includes("?") || result.includes("#")) throw new TypeError(`non-static module path at ${field}`);
  return result;
}

function exportName(value: unknown, field: string): string {
  const result = assertNonEmptyString(value, field);
  if (!/^[$A-Z_a-z][$\w]*$/.test(result)) throw new TypeError(`non-static export name at ${field}`);
  return result;
}

function familyEntry(value: unknown, pathName: string): FamilyReleaseIntentEntryV1 {
  const decoded = decodeExactObject(value, {
    familyId: (item, field) => {
      const result = assertNonEmptyString(item, field);
      if (!ID_RE.test(result)) throw new TypeError(`invalid family id at ${field}`);
      return result;
    },
    manifestRoot: (item, field) => assertHash(item, field),
    modulePath: (item, field) => path(item, field),
    exportName: (item, field) => exportName(item, field),
  }, pathName);
  return Object.freeze(decoded);
}

function strategyEntry(value: unknown, pathName: string): StrategyReleaseIntentEntryV1 {
  const decoded = decodeExactObject(value, {
    strategyId: (item, field) => {
      const result = assertNonEmptyString(item, field);
      if (!ID_RE.test(result)) throw new TypeError(`invalid strategy id at ${field}`);
      return result;
    },
    manifestRoot: (item, field) => assertHash(item, field),
    modulePath: (item, field) => path(item, field),
    exportName: (item, field) => exportName(item, field),
  }, pathName);
  return Object.freeze(decoded);
}

function exactIds(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) throw new TypeError(`duplicate ${label}`);
}

export function sealReleaseIntent(
  families: readonly FamilyReleaseIntentEntryV1[],
  strategies: readonly StrategyReleaseIntentEntryV1[],
): ReleaseIntentV1 {
  const normalizedFamilies = families.map((entry, index) => familyEntry(entry, `releaseIntent.families[${index}]`));
  const normalizedStrategies = strategies.map((entry, index) => strategyEntry(entry, `releaseIntent.strategies[${index}]`));
  exactIds(normalizedFamilies.map(entry => entry.familyId), "family release intent");
  exactIds(normalizedStrategies.map(entry => entry.strategyId), "strategy release intent");
  const sortedFamilies = [...normalizedFamilies].sort((left, right) => left.familyId.localeCompare(right.familyId));
  const sortedStrategies = [...normalizedStrategies].sort((left, right) => left.strategyId.localeCompare(right.strategyId));
  return deepFreeze({
    schemaVersion: 1 as const,
    families: Object.freeze(sortedFamilies),
    strategies: Object.freeze(sortedStrategies),
    releaseIntentRoot: hashDomain("aloha/release-intent/v1", { families: sortedFamilies, strategies: sortedStrategies }),
  });
}

export function decodeReleaseIntent(value: unknown, pathName = "releaseIntent"): ReleaseIntentV1 {
  const decoded = decodeExactObject(value, {
    schemaVersion: (item, field) => {
      if (item !== 1) throw new TypeError(`unsupported release intent schema at ${field}`);
      return 1 as const;
    },
    families: (item, field) => fieldArray(item, (entry, entryPath) => familyEntry(entry, entryPath), field),
    strategies: (item, field) => fieldArray(item, (entry, entryPath) => strategyEntry(entry, entryPath), field),
    releaseIntentRoot: (item, field) => assertHash(item, field),
  }, pathName);
  const sealed = sealReleaseIntent(decoded.families, decoded.strategies);
  if (sealed.releaseIntentRoot !== decoded.releaseIntentRoot) throw new TypeError("release intent root mismatch");
  return sealed;
}
