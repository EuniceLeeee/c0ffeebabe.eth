import { createHash } from "node:crypto";
import { VAULT } from "./codec.js";
import { BALANCER_MODEL_TEMPLATES } from "./local-math/model-templates.js";

export type BalancerLocalModel = typeof BALANCER_MODEL_TEMPLATES[number]["model"];

/**
 * This selects a pricing implementation, never pool admission. Unknown/custom
 * runtimes retain Router pricing. Only compiler-declared immutable words are
 * normalized; instructions, metadata, linked addresses and all other bytes must
 * match the pinned official build exactly. Repeated copies of each immutable
 * must agree, including the independently inherited Vault references.
 */
export function classifyBalancerPoolCode(code: string): BalancerLocalModel | null {
  if (!/^0x(?:[0-9a-fA-F]{2})+$/.test(code)) return null;
  const bytes = Buffer.from(code.slice(2), "hex");
  const vaultWord = VAULT.slice(2).toLowerCase().padStart(64, "0");
  for (const template of BALANCER_MODEL_TEMPLATES) {
    if (bytes.length !== template.byteLength) continue;
    const normalized = Buffer.from(bytes);
    let valid = true;
    for (const immutable of template.immutableReferences) {
      const first = immutable.offsets[0];
      const value = bytes.subarray(first, first + 32).toString("hex");
      if (immutable.name === "_vault" && value !== vaultWord) { valid = false; break; }
      for (const offset of immutable.offsets) {
        if (bytes.subarray(offset, offset + 32).toString("hex") !== value) { valid = false; break; }
        normalized.fill(0, offset, offset + 32);
      }
      if (!valid) break;
    }
    if (valid && createHash("sha256").update(normalized).digest("hex") === template.normalizedCodeSha256) {
      return template.model;
    }
  }
  return null;
}
