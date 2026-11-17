import assert from "node:assert/strict";
import test from "node:test";
import { AbiCoder, keccak256, ZeroAddress, ZeroHash } from "ethers";
import { indexKnownUniV4PoolKeys, knownUniV4NominationPoolKey } from "../ready-univ4-pool-key-reuse.js";
import { PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG as catalog } from "../venues/production-family-composition.js";

const manager = "0x000000000004444c5dc75cb358380d2e3de08a90";
const source = { number: 26_222_895, hash: ZeroHash, generation: 26_222_895 };
const discovery = catalog.forStrictFamily("univ4-fee-hook" as never).plugin.discovery;
function row(hooks: string) {
  const currency0 = "0x0000000000000000000000000000000000000001";
  const currency1 = "0x0000000000000000000000000000000000000002";
  const fee = "500", tickSpacing = "10";
  const poolId = keccak256(AbiCoder.defaultAbiCoder().encode(
    ["address", "address", "uint24", "int24", "address"], [currency0, currency1, fee, tickSpacing, hooks],
  ));
  return { familyId: "univ4", candidateKind: "univ4-pool-key", address: manager, manager, poolId,
    currency0, currency1, fee, tickSpacing, hooks };
}

test("same PoolId can exclude a foreign hook before RPC, and preserves a matching hook", () => {
  const regular = row(ZeroAddress);
  const accepted = row("0xfa439315b015a4c283ded9815a4af6cef0b90880");
  const keys = indexKnownUniV4PoolKeys([regular, accepted]);
  assert.equal(knownUniV4NominationPoolKey({ keys, discovery, manager, poolId: regular.poolId, source }), null);
  assert.equal(knownUniV4NominationPoolKey({ keys, discovery, manager, poolId: accepted.poolId, source })
    ?.hooks.toLowerCase(), accepted.hooks);
});

test("unresolved, forged, or foreign-manager PoolKeys cannot exclude a nomination", () => {
  const regular = row(ZeroAddress);
  const keys = indexKnownUniV4PoolKeys([{ ...regular, fee: "501" }, { ...regular, hooks: undefined }]);
  assert.equal(knownUniV4NominationPoolKey({ keys, discovery, manager, poolId: regular.poolId, source }), undefined);
  assert.equal(knownUniV4NominationPoolKey({ keys: indexKnownUniV4PoolKeys([regular]), discovery,
    manager: ZeroAddress, poolId: regular.poolId, source }), undefined);
});
