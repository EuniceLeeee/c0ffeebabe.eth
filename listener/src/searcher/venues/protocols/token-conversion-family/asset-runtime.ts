import { id, keccak256, TypedDataEncoder, zeroPadValue } from "ethers";
import { nonzero, proveLocalAssetRuntime } from "./variants.js";

// Dependency closure for the ERC20 selectors used by this Family, not a claim
// that every public method of the asset is local. Verified BTBFinance source:
// ERC20 (OZ 5.5), ERC1363 (5.4), ERC20Permit (5.5); solc 0.8.30, optimizer 200,
// viaIR=false, evmVersion=prague. Recompilation matches all 5938 runtime bytes
// including metadata after validating/normalizing the seven compiler-reported
// EIP712 immutable operands below.
// transfer/transferFrom/approve/balanceOf/totalSupply use unoverridden ERC20
// storage operations. ERC1363 callbacks require separate *AndCall selectors;
// permit's timestamp/ecrecover branch is not called by those ERC20 methods.
// Constructor _mint is not callable at runtime. No proxy/delegatecall/upgrade
// surface exists in this exact template. Other code still uses the conservative
// instruction-level proof, never a blanket CALL/CHAINID exception.
const TEMPLATE_HASH = "0x581d62bab0a23c4cd262927b8fb4e6985f11192c7c357017d60d951b674f2215";
const SHORT_NAME = "0x4254422046696e616e636500000000000000000000000000000000000000000b";
const SHORT_VERSION = "0x3100000000000000000000000000000000000000000000000000000000000001";

export function proveConversionAssetRuntime(code: string, asset: string): string {
  asset = nonzero(asset);
  try { return proveLocalAssetRuntime(code); } catch { /* exact audited template below */ }
  if (!/^0x[0-9a-fA-F]{11876}$/.test(code)) throw new Error("asset dependency closure unproven: unsupported runtime");
  let normalized = code.toLowerCase();
  const operands: readonly (readonly [number, string])[] = [
    [2457, zeroPadValue(asset, 32)],
    [2499, zeroPadValue("0x01", 32)],
    [2541, TypedDataEncoder.hashDomain({ name: "BTB Finance", version: "1", chainId: 1, verifyingContract: asset })],
    [2622, id("BTB Finance")], [2662, id("1")],
    [3082, SHORT_NAME], [3127, SHORT_VERSION],
  ];
  for (const [offset, expected] of operands) {
    const at = 2 + offset * 2;
    if (normalized.slice(at - 2, at) !== "7f" || normalized.slice(at, at + 64) !== expected.slice(2).toLowerCase()) {
      throw new Error("asset dependency closure unproven: immutable binding mismatch");
    }
    normalized = normalized.slice(0, at) + "0".repeat(64) + normalized.slice(at + 64);
  }
  if (keccak256(normalized) !== TEMPLATE_HASH) throw new Error("asset dependency closure unproven: runtime template mismatch");
  return keccak256(code);
}
