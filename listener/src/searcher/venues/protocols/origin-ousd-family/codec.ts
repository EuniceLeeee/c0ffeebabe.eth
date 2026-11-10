import { ethers } from "ethers";
import { ADDR } from "../../../../shared/constants/addresses.js";

const MAX_UINT256 = (1n << 256n) - 1n;

/**
 * Origin Dollar (OUSD) Vault, mainnet.
 *
 * On-chain identity at N=26185253 (verified with eth_getCode/getStorageAt/
 * eth_call against MAINNET_RPC_URL):
 *   proxy code hash  0x42459e351d7ee0ec70d78ff7a8fab408810e97ca87324ba416acfe7708ce456e
 *   EIP-1967 slot    0x360894a1…bbc -> 0x82948060c4B72684bEdEdec342350AB344975145
 *   impl code hash   0xedf6048420eebf78f63106d125288365723ca61843ce3df62c35e5106766cc40
 *                    (20934 bytes)
 *   vault.asset()    0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48 (USDC, 6 decimals)
 *   mint(uint256)    selector 0xa0712d68; pulls `amount` USDC from msg.sender
 *                    and mints `amount * 1e12` OUSD to msg.sender, 1:1, no fee.
 *                    Sample tx 0xab27e700…13a: 394088756 USDC -> 394088756e12 OUSD.
 */
export const ORIGIN_OUSD_VAULT = "0xE75D77B1865Ae93c7eaa3040B038D7aA7BC02F70";
/**
 * OUSD token address is pinned by on-chain evidence, not by symbol lookup.
 * The well-known `0x2A8e1E676Ec238d8A992307B4957b3EBa7ED3a2e` spelling has NO
 * runtime code at the Ready block or at head; the mint log in the sample tx is
 * emitted by this address (symbol "OUSD", name "Origin Dollar", 18 decimals,
 * code hash 0xd39af98f18b3c72b2e30db499f1b8cab8dc7deffe9db5a7db6f5a260af34e7a6).
 */
export const ORIGIN_OUSD_TOKEN = "0x2A8e1E676Ec238d8A992307B495b45B3fEAa5e86";
export const ORIGIN_OUSD_ASSET = ADDR.USDC;
export const ORIGIN_OUSD_DECIMAL_SCALE = 10n ** 12n;
export const ORIGIN_OUSD_PRICE_SAMPLE = 10n ** 6n;
/** Behavior proof sizes: 1 and 10 USDC. Two sizes prevent an amount-independent
 * getter response from granting a conversion edge. */
export const ORIGIN_OUSD_BEHAVIOR_SAMPLES = Object.freeze([10n ** 6n, 10n * 10n ** 6n]);

export const ORIGIN_OUSD_EIP1967_IMPLEMENTATION_SLOT =
  "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
export const ORIGIN_OUSD_PROXY_CODE_HASH =
  "0x42459e351d7ee0ec70d78ff7a8fab408810e97ca87324ba416acfe7708ce456e";
export const ORIGIN_OUSD_IMPLEMENTATION =
  "0x82948060c4B72684bEdEdec342350AB344975145";
export const ORIGIN_OUSD_IMPLEMENTATION_CODE_HASH =
  "0xedf6048420eebf78f63106d125288365723ca61843ce3df62c35e5106766cc40";
export const ORIGIN_OUSD_TOKEN_CODE_HASH =
  "0xd39af98f18b3c72b2e30db499f1b8cab8dc7deffe9db5a7db6f5a260af34e7a6";

/** Vault surface used by discovery, identity and execution. `redeem(uint256)`
 * is declared for the observed implementation but NOT routed: the redemption
 * direction carries a fee and is a documented variant gap. */
export const ORIGIN_OUSD_VAULT_INTERFACE = new ethers.Interface([
  "function mint(uint256 amount)",
  "function redeem(uint256 amount)",
  "function asset() view returns (address)",
  "function totalValue() view returns (uint256)",
]);

/** OUSD token surface. The vault exposes no `ousd()` getter (it reverts on this
 * implementation), so the token is bound by the fixed constant above plus its
 * pinned runtime code hash. */
export const ORIGIN_OUSD_TOKEN_INTERFACE = new ethers.Interface([
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address owner) view returns (uint256)",
  "function approve(address spender,uint256 amount) returns (bool)",
  "function allowance(address owner,address spender) view returns (uint256)",
]);

/** Deterministic 1:1 mint: the vault mints `amount * 1e12` OUSD (18 decimals)
 * for `amount` USDC (6 decimals). No fee, no preview function. */
export function originOusdMintQuote(amountIn: bigint): bigint {
  if (amountIn < 0n) {
    throw new Error("Origin OUSD mint amountIn cannot be negative");
  }
  if (amountIn > MAX_UINT256 / ORIGIN_OUSD_DECIMAL_SCALE) {
    throw new Error("Origin OUSD mint scaling overflow");
  }
  return amountIn * ORIGIN_OUSD_DECIMAL_SCALE;
}
