import { ethers } from "ethers";

// Infrastructure behavior fingerprints, NOT pool or extension-address admission
// lists. Solidity 0.8.33 / optimizer 9999999 / viaIR / Osaka. These full runtime
// hashes include the immutable Core (and Router accountant) binding. The
// extension must ALSO reverse-prove registration in that Core at the source.
// Public sources: Etherscan verified TWAMM, MEVCaptureRouter and Core, observed
// at Ethereum block 26029876. Compiler proof is a separate acceptance artifact.
export const EKUBO_SUPPORTED_CORE_HASH = "0xc5f90c9d0dbc5037f8f9e248f4bb292e7c1824f584eb6550cb4cad525b38c71a";
export const EKUBO_SUPPORTED_ROUTER_HASH = "0xaa0ea1ad3d9ee38ce2a892211aa7fc0022cf7707779b92ef59ff2d4023481026";
export const EKUBO_SUPPORTED_TWAMM_HASH = "0x1582a2a511cd250e0e334319fac6543dda3f8fcef2ae3cc455ce4c85afe75084";
export function extensionRegistrationSlot(extension: string): string {
  return ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["address", "uint256"], [extension, 0n]));
}
export function validateExtensionProof(coreCodeHash: string, routerCodeHash: string, extensionCode: string, registration: string): string {
  if (!ethers.isHexString(extensionCode) || !ethers.isHexString(registration, 32)) throw new Error("ekubo malformed extension proof");
  const hash = ethers.keccak256(extensionCode);
  if (coreCodeHash !== EKUBO_SUPPORTED_CORE_HASH || routerCodeHash !== EKUBO_SUPPORTED_ROUTER_HASH || hash !== EKUBO_SUPPORTED_TWAMM_HASH) {
    throw new Error("ekubo unsupported extension/Core/router behavior");
  }
  if (BigInt(registration) !== 1n) throw new Error("ekubo extension not registered in Core");
  return hash;
}
