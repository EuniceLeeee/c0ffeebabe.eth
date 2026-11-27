import type { SelectorPaidRankRole } from "../paid-ranking-contract.js";
import { selectorNativeProgramKey, type SelectorNativeProgram } from "../../selector-native-definition.js";

// Full normalized recipe identity for the single 30bps constant-product V2 template.
const programSeal = "parameters:c028dc7ccc373b0813de55828817f989c392fb2fade4afcb978dd2dc0d036a14";
const knownKeys = new WeakMap<SelectorNativeProgram, string>();
function immutable(x: unknown): boolean {
  return !x || typeof x !== "object" || Object.isFrozen(x) && Object.values(x).every(immutable);
}
function keyOf(p: SelectorNativeProgram): string {
  const old = knownKeys.get(p);
  if (old) return old;
  const key = selectorNativeProgramKey(p);
  if (immutable(p)) knownKeys.set(p, key);
  return key;
}

const standardPair: SelectorPaidRankRole = ({ program, instance, routes, physical, dependencies }) => {
  const key = keyOf(program);
  if (key !== programSeal || key !== instance.programKey) return;
  const d = instance.bound?.descriptor, pool = instance.target;
  if (!d || program.refreshPolicy !== "on-touch" || physical.logical || physical.holders.size !== 1 || !physical.holders.has(pool) ||
    pool !== d.pool || d.feeRule?.kind !== "constant-bps" || String(d.feeRule.feeBps) !== "30" ||
    d.quoteModel?.kind !== "constant-product" || d.tokenTransfers !== undefined || !routes.length) return;
  const assets = [d.token0, d.token1];
  if (!assets.every(t => typeof t === "string" && /^0x[0-9a-f]{40}$/.test(t) && !/^0x0+$/.test(t) && t !== pool) || assets[0] === assets[1] ||
    !routes.every(r => r.programKey === key && r.target === pool && r.observationTarget === pool && !r.observationPoolId && !r.resources &&
      r.resource?.target === pool && !r.resource.poolId && r.tokenIn.toLowerCase() !== r.tokenOut.toLowerCase() &&
      assets.includes(r.tokenIn.toLowerCase()) && assets.includes(r.tokenOut.toLowerCase()))) return;
  const expected = new Set([pool, ...assets]), declared = new Set(dependencies.map(a => a.toLowerCase()));
  if (declared.size !== 3 || [...expected].some(a => !declared.has(a)) ||
    !Array.isArray(instance.bound.dependencies) || instance.bound.dependencies.some((a: string) => !expected.has(a.toLowerCase()))) return;
  function hasAsset(x: unknown): boolean {
    if (typeof x === "string") return assets.includes(x.toLowerCase());
    return !!x && typeof x === "object" && Object.values(x).some(hasAsset);
  }
  if (Object.entries(d).some(([name, value]) => {
    if (name === "token0" || name === "token1") return false;
    if ((name === "tokenIn" || name === "tokenOut") && instance.candidate?.scope?.[name] === value) return false;
    return hasAsset(value);
  })) return;
  return { economic: [pool], assets };
};

export const paidRankRoles: readonly (readonly [string, SelectorPaidRankRole])[] = Object.freeze([[programSeal, standardPair] as const]);
