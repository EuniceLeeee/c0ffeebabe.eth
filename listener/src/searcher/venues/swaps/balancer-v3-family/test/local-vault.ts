import assert from "node:assert/strict";
import test from "node:test";
import { supportsBalancerLocalVault } from "../vault-model.js";
import { BALANCER_VAULT_TEMPLATES } from "../local-math/vault-templates.js";
import { syntheticBalancerVaultCodes } from "./local-vault-fixture.js";

test("local Vault support requires the complete official non-upgradeable runtime chain", () => {
  const codes = syntheticBalancerVaultCodes();
  assert.equal(supportsBalancerLocalVault(...codes), true);
  for (let i = 0; i < codes.length; i++) {
    const changed: [string, string, string] = [...codes];
    changed[i] = "0x6000";
    assert.equal(supportsBalancerLocalVault(...changed), false);
    changed[i] = `0xff${codes[i].slice(4)}`;
    assert.equal(supportsBalancerLocalVault(...changed), false, "code changes are not masked");
    changed[i] = codes[i].slice(0, -2);
    assert.equal(supportsBalancerLocalVault(...changed), false, "metadata and length are retained");
  }
});

test("every immutable group is semantic, not an arbitrary hole in runtime matching", () => {
  const codes = syntheticBalancerVaultCodes();
  for (let i = 0; i < codes.length; i++) {
    for (const immutable of BALANCER_VAULT_TEMPLATES[i].immutableReferences) {
      const changed: [string, string, string] = [...codes], bytes = Buffer.from(changed[i].slice(2), "hex");
      for (const offset of immutable.offsets) bytes[offset + 31] ^= 1;
      changed[i] = `0x${bytes.toString("hex")}`;
      assert.equal(supportsBalancerLocalVault(...changed), false, `${i}/${immutable.name}`);
      if (immutable.offsets.length > 1) {
        const inconsistent = Buffer.from(codes[i].slice(2), "hex"); inconsistent[immutable.offsets[0] + 31] ^= 1;
        changed[i] = `0x${inconsistent.toString("hex")}`;
        assert.equal(supportsBalancerLocalVault(...changed), false, `repeated ${i}/${immutable.name}`);
      }
    }
  }
});

test("cross-contract collusion cannot change fixed slots or minimums", () => {
  for (const name of ["_IS_UNLOCKED_SLOT", "_MINIMUM_TRADE_AMOUNT", "_vaultBufferPeriodDuration"]) {
    const changed = syntheticBalancerVaultCodes();
    for (let i = 0; i < changed.length; i++) {
      const bytes = Buffer.from(changed[i].slice(2), "hex");
      for (const immutable of BALANCER_VAULT_TEMPLATES[i].immutableReferences) {
        if (immutable.name === name) for (const offset of immutable.offsets) bytes[offset + 31] ^= 1;
      }
      changed[i] = `0x${bytes.toString("hex")}`;
    }
    assert.equal(supportsBalancerLocalVault(...changed), false, name);
  }
});

test("only a consistent uint32 deployment timestamp varies across equivalent Vault builds", () => {
  const changed = syntheticBalancerVaultCodes();
  for (let i = 0; i < changed.length; i++) {
    const bytes = Buffer.from(changed[i].slice(2), "hex");
    for (const immutable of BALANCER_VAULT_TEMPLATES[i].immutableReferences) {
      if (immutable.name === "_vaultPauseWindowEndTime" || immutable.name === "_vaultBufferPeriodEndTime") {
        for (const offset of immutable.offsets) {
          const value = BigInt(`0x${bytes.subarray(offset, offset + 32).toString("hex")}`) + 1n;
          bytes.set(Buffer.from(value.toString(16).padStart(64, "0"), "hex"), offset);
        }
      }
    }
    changed[i] = `0x${bytes.toString("hex")}`;
  }
  assert.equal(supportsBalancerLocalVault(...changed), true);
  const overflowed = syntheticBalancerVaultCodes();
  for (let i = 0; i < overflowed.length; i++) {
    const bytes = Buffer.from(overflowed[i].slice(2), "hex");
    for (const immutable of BALANCER_VAULT_TEMPLATES[i].immutableReferences) {
      if (immutable.name === "_vaultPauseWindowEndTime" || immutable.name === "_vaultBufferPeriodEndTime") {
        for (const offset of immutable.offsets) bytes[offset + 20] = 1;
      }
    }
    overflowed[i] = `0x${bytes.toString("hex")}`;
  }
  assert.equal(supportsBalancerLocalVault(...overflowed), false);
});
