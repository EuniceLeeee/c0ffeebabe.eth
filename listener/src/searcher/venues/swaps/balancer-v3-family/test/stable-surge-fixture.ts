import { ethers } from "ethers";
import { VAULT } from "../codec.js";
import { STABLE_SURGE_TEMPLATES } from "../stable-surge-templates.js";
import type { StableSurgeModel, StableSurgePoolModel } from "../stable-surge.js";
import { STABLE_SURGE_POOL_TEMPLATES } from "../stable-surge-pool-template.js";

// Compiler-template constructor instances; synthetic, not historical EVM proof.
export function syntheticStableSurgeCode(model: StableSurgeModel, hook: string,
  overrides: Readonly<Record<string, bigint>> = {}): string {
  const template = STABLE_SURGE_TEMPLATES.find(t => t.model === model)!;
  const bytes = Buffer.from(template.runtimeTemplate.slice(2), "hex");
  const values: Record<string, bigint> = { _vault: BigInt(VAULT), _actionIdDisambiguator: BigInt(hook),
    _allowedPoolFactory: 0x42n, _defaultMaxSurgeFeePercentage: 950_000_000_000_000_000n,
    _defaultSurgeThresholdPercentage: 300_000_000_000_000_000n, ...overrides };
  for (const immutable of template.immutableReferences) {
    const word = Buffer.from(ethers.toBeHex(values[immutable.name], 32).slice(2), "hex");
    for (const offset of immutable.offsets) bytes.set(word, offset);
  }
  return `0x${bytes.toString("hex")}`;
}

export function syntheticStableSurgePoolCode(pool: string, overrides: Readonly<Record<string, bigint>> = {},
  model: StableSurgePoolModel = "stable-surge-pool-v1"): string {
  const template = STABLE_SURGE_POOL_TEMPLATES.find(t => t.model === model)!;
  const bytes = Buffer.from(template.runtimeTemplate.slice(2), "hex");
  const values: Record<string, bigint> = { _vault: BigInt(VAULT), _actionIdDisambiguator: 0x42n,
    _cachedThis: BigInt(pool), _cachedChainId: 1n, ...overrides };
  for (const immutable of template.immutableReferences) {
    const word = Buffer.from(ethers.toBeHex(values[immutable.name] ?? 0n, 32).slice(2), "hex");
    for (const offset of immutable.offsets) bytes.set(word, offset);
  }
  return `0x${bytes.toString("hex")}`;
}
