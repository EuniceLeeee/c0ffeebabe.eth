import { ethers } from "ethers";
import { VAULT } from "../codec.js";
import { BALANCER_VAULT_ADMIN, BALANCER_VAULT_EXTENSION } from "../vault-model.js";
import { BALANCER_VAULT_TEMPLATES } from "../local-math/vault-templates.js";

/** Synthetic constructor instances of the pinned compiler output, not evidence
 * that these exact runtimes were read from the historical Ethereum source. */
export function syntheticBalancerVaultCodes(): [string, string, string] {
  const slots: Record<string, string> = {
    _IS_UNLOCKED_SLOT: "isUnlocked", _NON_ZERO_DELTA_COUNT_SLOT: "nonZeroDeltaCount",
    _TOKEN_DELTAS_SLOT: "tokenDeltas", _ADD_LIQUIDITY_CALLED_SLOT: "addLiquidityCalled", _SESSION_ID_SLOT: "sessionId",
  };
  const duration = 180n * 86400n, pauseEnd = 1733356800n + 1440n * 86400n;
  const values: Record<string, bigint> = {
    _vault: BigInt(VAULT), _actionIdDisambiguator: BigInt(VAULT),
    _vaultExtension: BigInt(BALANCER_VAULT_EXTENSION), _vaultAdmin: BigInt(BALANCER_VAULT_ADMIN),
    _MINIMUM_TRADE_AMOUNT: 1000000n, _MINIMUM_WRAP_AMOUNT: 10000n,
    _vaultBufferPeriodDuration: duration, _vaultPauseWindowEndTime: pauseEnd, _vaultBufferPeriodEndTime: pauseEnd + duration,
  };
  for (const [name, key] of Object.entries(slots)) {
    const namespace = ethers.id(`balancer-labs.v3.storage.VaultStorage.${key}`);
    values[name] = BigInt(ethers.keccak256(ethers.toBeHex(BigInt(namespace) - 1n, 32))) & ~255n;
  }
  const code = (index: number) => {
    const template = BALANCER_VAULT_TEMPLATES[index], bytes = Buffer.from(template.runtimeTemplate.slice(2), "hex");
    for (const immutable of template.immutableReferences) {
      if (values[immutable.name] === undefined) throw new Error(`unhandled fixture immutable ${immutable.name}`);
      const word = Buffer.from(ethers.toBeHex(values[immutable.name], 32).slice(2), "hex");
      for (const offset of immutable.offsets) bytes.set(word, offset);
    }
    return `0x${bytes.toString("hex")}`;
  };
  return [code(0), code(1), code(2)];
}
