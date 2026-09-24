import { createHash } from "node:crypto";
import { ethers } from "ethers";
import { VAULT } from "./codec.js";
import { BALANCER_VAULT_TEMPLATES } from "./local-math/vault-templates.js";

// Official 20241204-v3-vault/output/mainnet.json infrastructure identities.
export const BALANCER_VAULT_EXTENSION = ethers.getAddress("0x0E8B07657D719B86e06bF0806D6729e3D528C9A9");
export const BALANCER_VAULT_ADMIN = ethers.getAddress("0x35fFB749B273bEb20F40f35EdeB805012C539864");
const UINT32_MAX = (1n << 32n) - 1n;
const BUFFER_DURATION = 180n * 24n * 60n * 60n;
const PAUSE_DURATION = 4n * 12n * 30n * 24n * 60n * 60n;
const SLOT_KEYS: Readonly<Record<string, string>> = {
  _IS_UNLOCKED_SLOT: "isUnlocked", _NON_ZERO_DELTA_COUNT_SLOT: "nonZeroDeltaCount",
  _TOKEN_DELTAS_SLOT: "tokenDeltas", _ADD_LIQUIDITY_CALLED_SLOT: "addLiquidityCalled", _SESSION_ID_SLOT: "sessionId",
};

// Exact VaultStorage/TransientStorageHelpers constructor formula, not arbitrary
// masked slot words. Their equality is needed for query and swap semantics.
function transientSlot(key: string): bigint {
  const namespace = ethers.keccak256(ethers.toUtf8Bytes(`balancer-labs.v3.storage.VaultStorage.${key}`));
  return BigInt(ethers.keccak256(ethers.toBeHex(BigInt(namespace) - 1n, 32))) & ~255n;
}

/** Verify the whole non-upgradeable delegate chain before using Vault math.
 * Every immutable is checked; only the constructor's deployment timestamp is
 * variable, constrained to uint32 and identical pause/buffer values across all
 * contracts. Dynamic isVaultPaused/isPoolPaused guards remain the caller's job.
 */
export function supportsBalancerLocalVault(vaultCode: string, extensionCode: string, adminCode: string): boolean {
  const codes = [vaultCode, extensionCode, adminCode];
  const timing = new Map<string, bigint>();
  for (let i = 0; i < BALANCER_VAULT_TEMPLATES.length; i++) {
    const template = BALANCER_VAULT_TEMPLATES[i], code = codes[i];
    if (!/^0x(?:[0-9a-fA-F]{2})+$/.test(code)) return false;
    const bytes = Buffer.from(code.slice(2), "hex");
    if (bytes.length !== template.byteLength) return false;
    const normalized = Buffer.from(bytes);
    for (const immutable of template.immutableReferences) {
      const first = immutable.offsets[0], word = bytes.subarray(first, first + 32).toString("hex");
      const value = BigInt(`0x${word}`);
      for (const offset of immutable.offsets) {
        if (bytes.subarray(offset, offset + 32).toString("hex") !== word) return false;
        normalized.fill(0, offset, offset + 32);
      }
      const name: string = immutable.name;
      if (name === "_vault" || name === "_actionIdDisambiguator") {
        if (value !== BigInt(VAULT)) return false;
      } else if (name === "_vaultExtension") {
        if (value !== BigInt(BALANCER_VAULT_EXTENSION)) return false;
      } else if (name === "_vaultAdmin") {
        if (value !== BigInt(BALANCER_VAULT_ADMIN)) return false;
      } else if (name === "_MINIMUM_TRADE_AMOUNT") {
        if (value !== 1000000n) return false;
      } else if (name === "_MINIMUM_WRAP_AMOUNT") {
        if (value !== 10000n) return false;
      } else if (name === "_vaultBufferPeriodDuration") {
        if (value !== BUFFER_DURATION) return false;
      } else if (name === "_vaultPauseWindowEndTime" || name === "_vaultBufferPeriodEndTime") {
        if (value > UINT32_MAX || (timing.has(name) && timing.get(name) !== value)) return false;
        timing.set(name, value);
      } else if (Object.hasOwn(SLOT_KEYS, name)) {
        if (value !== transientSlot(SLOT_KEYS[name])) return false;
      } else return false;
    }
    if (createHash("sha256").update(normalized).digest("hex") !== template.normalizedCodeSha256) return false;
  }
  const pauseEnd = timing.get("_vaultPauseWindowEndTime"), bufferEnd = timing.get("_vaultBufferPeriodEndTime");
  return pauseEnd !== undefined && bufferEnd !== undefined && pauseEnd >= PAUSE_DURATION &&
    bufferEnd === pauseEnd + BUFFER_DURATION;
}
