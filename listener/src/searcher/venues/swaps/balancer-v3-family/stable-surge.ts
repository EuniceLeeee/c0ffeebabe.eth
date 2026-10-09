import { createHash } from "node:crypto";
import { STABLE_SURGE_TEMPLATES } from "./stable-surge-templates.js";
import { STABLE_SURGE_POOL_TEMPLATES } from "./stable-surge-pool-template.js";

export type StableSurgeModel = typeof STABLE_SURGE_TEMPLATES[number]["model"];
export type StableSurgePoolModel = typeof STABLE_SURGE_POOL_TEMPLATES[number]["model"];
const MAX_ADDRESS = (1n << 160n) - 1n;
const WAD = 10n ** 18n;
// Canonical infrastructure, not an instance allowlist. Authenticated Router-v2
// build 845b6950...9bba622; test fixture reconstructs all constructor immutables.
export const STABLE_SURGE_ROUTER_CODE_HASH = "0x76d58a2f13ee78e52e3f414f0181bc77ff0fcc65ae35b0d215a26b6fd2980a18";

/** Match the complete verified non-proxy runtime, masking only compiler-owned
 * immutables. No pool/factory/hook address allowlist. Swap fees read the pool's
 * mutable surge settings, not these constructor defaults. Both inherited Vault
 * references must be this same Vault; SingletonAuthentication's disambiguator
 * must be the actual Hook address, not an arbitrary masked word.
 */
export function classifyStableSurgeCode(code: string, vault: string, hook: string): StableSurgeModel | null {
  if (!/^0x(?:[0-9a-fA-F]{2})+$/.test(code) || !/^0x[0-9a-fA-F]{40}$/.test(vault) ||
      !/^0x[0-9a-fA-F]{40}$/.test(hook) || BigInt(hook) === 0n) return null;
  const bytes = Buffer.from(code.slice(2), "hex");
  for (const template of STABLE_SURGE_TEMPLATES) {
    if (bytes.length !== template.byteLength) continue;
    const normalized = Buffer.from(bytes);
    let valid = true;
    for (const immutable of template.immutableReferences) {
      const first = immutable.offsets[0];
      const word = bytes.subarray(first, first + 32).toString("hex");
      const value = BigInt(`0x${word}`), name: string = immutable.name;
      if (name === "_vault") valid = value === BigInt(vault);
      else if (name === "_actionIdDisambiguator") valid = value === BigInt(hook);
      else if (name === "_allowedPoolFactory") valid = value > 0n && value <= MAX_ADDRESS;
      else if (name === "_defaultMaxSurgeFeePercentage" || name === "_defaultSurgeThresholdPercentage") valid = value <= WAD;
      else valid = false;
      if (!valid) break;
      for (const offset of immutable.offsets) {
        if (bytes.subarray(offset, offset + 32).toString("hex") !== word) { valid = false; break; }
        normalized.fill(0, offset, offset + 32);
      }
      if (!valid) break;
    }
    if (valid && createHash("sha256").update(normalized).digest("hex") === template.normalizedCodeSha256) return template.model;
  }
  return null;
}

export function stableSurgeFlags(flags: readonly boolean[]): boolean {
  return flags.length === 10 && flags.every((flag, i) => flag === (i === 3 || i === 7 || i === 9));
}

/** These factory releases have distinct StablePool runtimes. Prove their public
 * onSwap behavior without granting an unverified local-math implementation.
 * The EIP712 words affect only LP-token metadata/permit, never onSwap. Keep all
 * repeated words equal; every independent Vault reference must be canonical.
 */
export function classifyStableSurgePoolCode(code: string, vault: string, pool: string): StableSurgePoolModel | null {
  if (!/^0x(?:[0-9a-fA-F]{2})+$/.test(code) || !/^0x[0-9a-fA-F]{40}$/.test(vault) ||
      !/^0x[0-9a-fA-F]{40}$/.test(pool) || BigInt(pool) === 0n) return null;
  const bytes = Buffer.from(code.slice(2), "hex");
  for (const template of STABLE_SURGE_POOL_TEMPLATES) {
    if (bytes.length !== template.byteLength) continue;
    const normalized = Buffer.from(bytes);
    for (const immutable of template.immutableReferences) {
      const first = immutable.offsets[0], word = bytes.subarray(first, first + 32).toString("hex");
      const value = BigInt(`0x${word}`), name: string = immutable.name;
      if (name === "_vault" && value !== BigInt(vault)) return null;
      if (name === "_actionIdDisambiguator" && (value === 0n || value > MAX_ADDRESS)) return null;
      if (name === "_cachedThis" && value !== BigInt(pool)) return null;
      if (name === "_cachedChainId" && value !== 1n) return null;
      for (const offset of immutable.offsets) {
        if (bytes.subarray(offset, offset + 32).toString("hex") !== word) return null;
        normalized.fill(0, offset, offset + 32);
      }
    }
    return createHash("sha256").update(normalized).digest("hex") === template.normalizedCodeSha256 ? template.model : null;
  }
  return null;
}

/** The Hook calls pool.onSwap itself. An arbitrary pool could branch on that
 * caller or query mode, so only the already proven immutable StablePool models
 * may use this compatibility proof. Their prices still go through the Router;
 * the ordinary local static-fee formula MUST NOT price a dynamic swap Hook.
 */
export function supportsStableSurgeBinding(hooks: {
  readonly flags: readonly boolean[]; readonly stableSurgeModel?: StableSurgeModel;
}, poolModel: string | null | undefined): boolean {
  return (hooks.stableSurgeModel === "stable-surge-v1" || hooks.stableSurgeModel === "stable-surge-v2") &&
    (poolModel === "stable-v1" || poolModel === "stable-v2" || poolModel === "stable-v3" ||
      STABLE_SURGE_POOL_TEMPLATES.some(template => template.model === poolModel)) && stableSurgeFlags(hooks.flags);
}
