import { ethers } from "ethers";
import type {
  AdapterRequest,
  CanonicalSource,
} from "../../adapter-request-program.js";
import { canonicalAddress, codeRequest } from "../standard-family/common.js";

export const MAX_UINT256 = (1n << 256n) - 1n;

/**
 * DefaultCollateral share vaults (mainnet) are 45-byte EIP-1167 minimal
 * proxies whose implementation is fixed inside the clone runtime code.
 *
 * Verified at N=26244778 with block-pinned eth_getCode / eth_call and the
 * same-state effect-delta proof in identity.ts:
 *   vault / share  0x38B86004842D3FA4596f0b7A0b53DE90745Ab654
 *   clone code     `0x363d3d373d3d3d363d73` ++ impl ++
 *                  `5af43d82803e903d91602b57fd5bf3` (45 bytes)
 *   clone hash     0xcfc9ad23342291d06388db77b16a3f705c6f1bbefa8a5d45bcc74809c5092468
 *   impl           0xa301ea1E3CAB036AbE8fa70e5526A51Cb41799B6
 *   impl hash      0x9d653c832fd3da8d30d3a6b558924a39d0bbb0c08859ee9594f648b0159c9986
 *                  (8372 bytes; totalAssets/convertToAssets/pricePerShare
 *                  selectors are absent, only asset/decimals/totalSupply/
 *                  balanceOf and withdraw(address,uint256) 0xf3fef3a3)
 *   asset          0xf951E335afb289353dc249e82926178EaC7DEd78 (swETH, 18dp)
 *   asset hash     0x6bec2bf64f7e824109f6ed55f77dd7665801d6195e461666ad6a5342a9f6daf5
 *
 * The verified ABI is NOT ERC4626: totalAssets(), convertToAssets(),
 * pricePerShare() and vault() revert. `withdraw(address receiver, uint256
 * shares)` burns `shares` from msg.sender, emits ERC20 Transfer(executor,0)
 * plus Withdraw(address indexed receiver,address indexed owner,uint256
 * amount) and transfers the SAME asset amount to `receiver` (no fee, 1:1 at
 * the verified state). Observed tx 0xad88c7f6...9833 at N burns
 * 9538714839966700 shares and delivers 9538714839966700 swETH.
 *
 * Pricing derivation: the share-to-asset rate is read from the vault itself at
 * the quote block (totalSupply() and the vault balance of asset). The
 * verified implementation redeems 1:1 while the vault is fully backed, so a
 * quote exists only when backing === totalSupply; any other state is refused
 * as an unproven rate instead of inventing a pro-rata formula the
 * implementation does not implement.
 */
export const DEFAULT_COLLATERAL_SHARE_VAULT =
  "0x38B86004842D3FA4596f0b7A0b53DE90745Ab654";
export const DEFAULT_COLLATERAL_IMPLEMENTATION =
  "0xa301ea1E3CAB036AbE8fa70e5526A51Cb41799B6";
export const DEFAULT_COLLATERAL_SHARE_CODE_HASH =
  "0xcfc9ad23342291d06388db77b16a3f705c6f1bbefa8a5d45bcc74809c5092468";
export const DEFAULT_COLLATERAL_IMPLEMENTATION_CODE_HASH =
  "0x9d653c832fd3da8d30d3a6b558924a39d0bbb0c08859ee9594f648b0159c9986";
export const DEFAULT_COLLATERAL_ASSET =
  "0xf951E335afb289353dc249e82926178EaC7DEd78";
export const DEFAULT_COLLATERAL_ASSET_CODE_HASH =
  "0x6bec2bf64f7e824109f6ed55f77dd7665801d6195e461666ad6a5342a9f6daf5";
export const DEFAULT_COLLATERAL_DECIMALS = 18n;
export const DEFAULT_COLLATERAL_FEE_BPS = 0n;
/** Both sides are 18-decimal, so the verified conversion is exactly 1:1. */
export const DEFAULT_COLLATERAL_PRICE_SCALE = 10n ** 18n;
export const DEFAULT_COLLATERAL_PRICE_SAMPLE = 10n ** 18n;
/** Fixed behavior-proof sample. It is dealt to the executor inside one
 * isolated simulation frame and never reads a quote result. */
export const DEFAULT_COLLATERAL_BEHAVIOR_SAMPLE = 10n ** 18n;
/** Literal payout recipient of the identity probe, independent of msg.sender. */
export const DEFAULT_COLLATERAL_PROBE_RECEIVER =
  "0x0000000000000000000000000000000000000001";
/** Observed original transaction vault leg (shares burned -> asset received). */
export const DEFAULT_COLLATERAL_OBSERVED_WITHDRAW = 9538714839966700n;

export const DEFAULT_COLLATERAL_INTERFACE = new ethers.Interface([
  "function asset() view returns (address)",
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address account) view returns (uint256)",
  "function symbol() view returns (string)",
  "function name() view returns (string)",
  "function withdraw(address receiver, uint256 shares)",
  "event Withdraw(address indexed receiver, address indexed owner, uint256 amount)",
  "event Transfer(address indexed from, address indexed to, uint256 value)",
]);

export const DEFAULT_COLLATERAL_ERC20_INTERFACE = new ethers.Interface([
  "function balanceOf(address account) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)",
]);

export const DEFAULT_COLLATERAL_WITHDRAW_SELECTOR =
  DEFAULT_COLLATERAL_INTERFACE.getFunction("withdraw")!.selector;
export const DEFAULT_COLLATERAL_WITHDRAW_SIGNATURE =
  "withdraw(address,uint256)";
/** keccak256("Withdraw(address,address,uint256)") emitted by the verified
 * implementation after the asset transfer. Not an ERC4626 event. */
export const DEFAULT_COLLATERAL_WITHDRAW_TOPIC =
  DEFAULT_COLLATERAL_INTERFACE.getEvent("Withdraw")!.topicHash.toLowerCase();
export const DEFAULT_COLLATERAL_TRANSFER_TOPIC =
  DEFAULT_COLLATERAL_INTERFACE.getEvent("Transfer")!.topicHash.toLowerCase();

const EIP1167_PREFIX = "0x363d3d373d3d3d363d73";
const EIP1167_SUFFIX = "5af43d82803e903d91602b57fd5bf3";

export function defaultCollateralAddress(value: string): string {
  const address = ethers.getAddress(value).toLowerCase();
  if (address === ethers.ZeroAddress) {
    throw new Error("default-collateral zero address");
  }
  return address;
}

export function defaultCollateralUint(value: bigint): bigint {
  if (typeof value !== "bigint" || value < 0n || value > MAX_UINT256) {
    throw new Error("default-collateral uint256 overflow");
  }
  return value;
}

export function defaultCollateralSourceValid(source: CanonicalSource): void {
  if (
    !Number.isSafeInteger(source.number) || source.number < 0 ||
    !/^0x[0-9a-f]{64}$/i.test(source.hash) ||
    !Number.isSafeInteger(source.generation) || source.generation < 0
  ) {
    throw new Error("default-collateral invalid source");
  }
}

/** Decode a 45-byte EIP-1167 minimal proxy runtime and return its embedded
 * implementation address. Any other runtime is not this Family clone shape. */
export function eip1167Implementation(code: string): string {
  const normalized = code.trim().toLowerCase();
  if (normalized.length !== 2 + 45 * 2) {
    throw new Error(
      "default-collateral runtime is not a 45-byte EIP-1167 clone",
    );
  }
  if (
    !normalized.startsWith(EIP1167_PREFIX) ||
    !normalized.slice(62).startsWith(EIP1167_SUFFIX)
  ) {
    throw new Error(
      "default-collateral runtime is not an EIP-1167 minimal proxy",
    );
  }
  return canonicalAddress(`0x${normalized.slice(22, 62)}`);
}

export function defaultCollateralCloneCode(implementation: string): string {
  return `${EIP1167_PREFIX}${defaultCollateralAddress(implementation).slice(2)}${EIP1167_SUFFIX}`;
}

/** Verified share -> asset conversion. The read totalSupply/backing pair must
 * prove the 1:1 invariant of the verified implementation; otherwise the rate
 * is unknown and the caller must not quote. */
export function defaultCollateralQuote(input: {
  readonly amountIn: bigint;
  readonly totalSupply: bigint;
  readonly backing: bigint;
}): bigint {
  defaultCollateralUint(input.amountIn);
  if (input.amountIn === 0n) return 0n;
  if (input.totalSupply <= 0n || input.backing <= 0n) {
    throw new Error(
      "default-collateral supply/backing is empty: rate not proven",
    );
  }
  if (input.backing !== input.totalSupply) {
    throw new Error(
      "default-collateral backing differs from totalSupply: 1:1 rate not proven",
    );
  }
  if (input.amountIn > input.totalSupply) {
    throw new Error(
      "default-collateral amount exceeds the proven share supply",
    );
  }
  const amountOut = input.amountIn * input.backing / input.totalSupply;
  if (amountOut !== input.amountIn) {
    throw new Error("default-collateral conversion is not 1:1 at this state");
  }
  return amountOut;
}

/** Family-declared negative-evidence call: a revert is an observation, not a
 * transport failure, so decode can terminally reject a non-vault candidate. */
export function declaredCallRequest(
  id: string,
  to: string,
  data: string,
): AdapterRequest {
  return Object.freeze({
    id,
    kind: "eth-call" as const,
    to: canonicalAddress(to),
    data,
    completion: "return-or-revert-data" as const,
  });
}

export function defaultCollateralCodeRequest(
  id: string,
  address: string,
): AdapterRequest {
  return codeRequest(id, canonicalAddress(address));
}

export function defaultCollateralDependencies(input: {
  readonly vault: string;
  readonly asset: string;
  readonly implementation: string;
}): readonly string[] {
  return Object.freeze([...new Set([
    defaultCollateralAddress(input.vault),
    defaultCollateralAddress(input.asset),
    defaultCollateralAddress(input.implementation),
  ])]);
}
