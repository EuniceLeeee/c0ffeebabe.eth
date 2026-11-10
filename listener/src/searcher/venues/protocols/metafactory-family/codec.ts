import { ethers } from "ethers";

/**
 * MetaFactoryV1Composter (mainnet 0x585Aba689bf7293fe66e9fDED9Eec9d0E732b180).
 *
 * Source (Sourcify full match, solc 0.8.26, optimizer disabled):
 *   ethRedeemed = amount * totalEthAllocated / circulatingSupply   (uint256 floor)
 *   robotToken.transferFrom(msg.sender, DEAD_ADDRESS, amount)
 *   payable(msg.sender).call{value: ethRedeemed}("")
 *
 * The payout asset is raw native ETH paid to msg.sender; passportRecipient only
 * labels the off-chain passport NFT and never receives value. The Family emits
 * the raw operation and the shared execution-asset boundary wraps the receipt.
 */
export const METAFACTORY_INTERFACE = new ethers.Interface([
  "function robotToken() view returns (address)",
  "function DEAD_ADDRESS() view returns (address)",
  "function totalEthAllocated() view returns (uint256)",
  "function circulatingSupply() view returns (uint256)",
  "function redemptionActivated() view returns (bool)",
  "function paused() view returns (bool)",
  "function redemptionEndTime() view returns (uint256)",
  "function isRedemptionPeriodOver() view returns (bool)",
  "function calculateRedemptionAmount(uint256 amount) view returns (uint256)",
  "function compostAndRedeem(uint256 amount,address passportRecipient)",
  "event Redeem(address indexed user,uint256 tokensComposted,uint256 totalComposted,uint256 ethRedeemed,address passportRecipient)",
]);

export const METAFACTORY_ERC20_INTERFACE = new ethers.Interface([
  "function decimals() view returns (uint8)",
  "function balanceOf(address owner) view returns (uint256)",
  "function totalSupply() view returns (uint256)",
  "function approve(address spender,uint256 amount) returns (bool)",
  "function transfer(address to,uint256 amount) returns (bool)",
]);

export const METAFACTORY_MAX_UINT256 = (1n << 256n) - 1n;

/** Canonical DEAD_ADDRESS baked into the verified composter runtime. */
export const METAFACTORY_DEAD_ADDRESS =
  "0x000000000000000000000000000000000000dEaD";

/**
 * keccak256(runtime code) pinned at mainnet block 26244712 (and unchanged at
 * every later block observed during this adaptation). The composter is a
 * standalone contract, so the hash is a content identity, never an allowlist.
 */
export const METAFACTORY_RUNTIME_CODE_HASH =
  "0xbecc42fd73cba67b7be22df4d95338acc52d01101a6bddd0dccb3232d07e6485";
/** ROBOT ERC20 runtime at 0xfb5453340C03db5aDe474b27E68B6a9c6b2823eB. */
export const METAFACTORY_ROBOT_CODE_HASH =
  "0xa95160f62eaa5dca87377958e157dffae85f7f0df672492b534198c3a948f13e";
/** Canonical WETH9 runtime at 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2. */
export const METAFACTORY_NATIVE_ANCHOR_CODE_HASH =
  "0xd0a06b12ac47863b5c7be4185c2deaad1c61557033f56c7d4ea74429cbb25e23";

/**
 * Exact composter arithmetic. Mirrors the verified Solidity expression: the
 * multiplication is checked first (solc 0.8 reverts on overflow), then uint256
 * floor division. circulatingSupply == 0 is not redeemable (the contract
 * divides by it), so it is rejected instead of guessed.
 */
export function metafactoryRedeemAmount(
  amount: bigint,
  totalEthAllocated: bigint,
  circulatingSupply: bigint,
): bigint {
  if (typeof amount !== "bigint" || amount < 0n || amount > METAFACTORY_MAX_UINT256) {
    throw new Error("metafactory amount is outside uint256 range");
  }
  if (
    typeof totalEthAllocated !== "bigint" ||
    totalEthAllocated < 0n ||
    totalEthAllocated > METAFACTORY_MAX_UINT256
  ) {
    throw new Error("metafactory totalEthAllocated is outside uint256 range");
  }
  if (
    typeof circulatingSupply !== "bigint" ||
    circulatingSupply <= 0n ||
    circulatingSupply > METAFACTORY_MAX_UINT256
  ) {
    throw new Error("metafactory circulatingSupply is not redeemable");
  }
  if (amount !== 0n && totalEthAllocated > METAFACTORY_MAX_UINT256 / amount) {
    throw new Error("metafactory redemption multiplication overflow");
  }
  return (amount * totalEthAllocated) / circulatingSupply;
}

/** Strict 32-byte word decode for raw eth_call return data. */
export function metafactoryWord(data: string, label: string): bigint {
  if (!/^0x[0-9a-fA-F]{64}$/.test(data)) {
    throw new Error(`${label} is not a canonical uint256 word`);
  }
  return BigInt(data);
}

export function metafactoryAddressWord(data: string, label: string): string {
  const value = metafactoryWord(data, label);
  if (value >> 160n !== 0n) {
    throw new Error(`${label} is not a canonical address word`);
  }
  const address = ethers.getAddress(`0x${data.slice(-40)}`);
  if (address === ethers.ZeroAddress) {
    throw new Error(`${label} is the zero address`);
  }
  return address;
}

export function metafactoryBooleanWord(data: string, label: string): boolean {
  const value = metafactoryWord(data, label);
  if (value > 1n) throw new Error(`${label} is not a boolean word`);
  return value === 1n;
}

export function metafactorySelector(functionName: string): `0x${string}` {
  const fragment = METAFACTORY_INTERFACE.getFunction(functionName);
  if (fragment === null) throw new Error(`metafactory unknown function ${functionName}`);
  return fragment.selector as `0x${string}`;
}

export const METAFACTORY_REDEEM_TOPIC = METAFACTORY_INTERFACE
  .getEvent("Redeem")!.topicHash.toLowerCase();
export const METAFACTORY_REDEEM_SIGNATURE =
  "Redeem(address,uint256,uint256,uint256,address)";
