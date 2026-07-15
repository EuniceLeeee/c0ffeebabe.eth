import { ethers } from "ethers";

export const ADDR = {
  WETH: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
  USDC: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  DAI: "0x6B175474E89094C44Da98b954EedeAC495271d0F",
  USDT: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
  GOLDX: "0x355C665e101B9DA58704A8fDDb5FeeF210eF20c0",
  WSTUSR: "0x1202F5C7b4B9E47a1A484E8B270be34dbbC75055",
  DOLA: "0x865377367054516e17014CcdED1e7d814EDC9ce4",
  SUSDS: "0xa3931d71877C0E7a3148CB7Eb4463524FEc27fbD",
  MORPHO: "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb",
  FLUID_LIQUIDITY: "0x52Aa899454998Be5b000Ad077a46Bbe360F4e497",
  FLUID_VAULT_WSTUSR_USDC: "0xee327311D8640156E87eC33ea55FcbF2309e0ce6",
  FLUID_DEX_USDC_USDT: "0x667701e51B4D1Ca244F17C78F7aB8744B4C99F9B",
  SKY_PSM_LITE: "0xf6e72Db5454dd049d0788e411b06CfAF16853042",
  UNIV4_POOL_MANAGER: "0x000000000004444c5dc75cB358380D2e3dE08A90",
  CURVE_SUSDS_USDT: "0x00836Fe54625BE242BcFA286207795405ca4fD10",
  CURVE_DOLA_SUSDS: "0x8b83c4aA949254895507D09365229BC3a8c7f710",
  CURVE_DOLA_WSTUSR: "0x64273624eb57c5cA961d366CBF3968e760Bf0452",
  UNIV3_USDT_WETH: "0xc7bBeC68d12a0d1830360F8Ec58fA599bA1b0e9b",
};

export const TOKEN_META: Record<string, { symbol: string; decimals: number; stable?: boolean; roughUsd?: number }> = indexByAddress({
  [ADDR.WETH]: { symbol: "WETH", decimals: 18 },
  [ADDR.USDC]: { symbol: "USDC", decimals: 6, stable: true, roughUsd: 1 },
  [ADDR.DAI]: { symbol: "DAI", decimals: 18, stable: true, roughUsd: 1 },
  [ADDR.USDT]: { symbol: "USDT", decimals: 6, stable: true, roughUsd: 1 },
  [ADDR.WSTUSR]: { symbol: "wstUSR", decimals: 18 },
  [ADDR.DOLA]: { symbol: "DOLA", decimals: 18, stable: true, roughUsd: 1 },
  [ADDR.SUSDS]: { symbol: "sUSDS", decimals: 18, stable: true, roughUsd: 1 },
  // FRAX: listed in bundle-postmortem INVENTORY_PRICED_TOKENS but absent here, so a FRAX delta landed
  // in unpriced and the one_leg_inventory spent-check could never see it (Fable-found dead entry).
  // Price it (~$1 stable) so that inventory signal works.
  ["0x853d955acef822db058eb8505911ed77f175b99e"]: { symbol: "FRAX", decimals: 18, stable: true, roughUsd: 1 },
  // WBTC: absent from TOKEN_META, so a WBTC delta fell into unpriced with the wrong fallback
  // decimals (18, not 8) — a comparable WBTC atomic loop (R21 winner 0xa00003b2 on the
  // USDC->WBTC->USDT->USDC leg) classified as winner_style=unknown/unpriceable. roughUsd is a
  // rough BTC mark (classification only needs it defined; the USD figure is approximate by contract).
  ["0x2260fac5e5542a773aa44fbcfedf7c193bc2c599"]: { symbol: "WBTC", decimals: 8, roughUsd: 100000 },
});

export const PROTOCOLS: Record<string, { name: string; kind: string }> = indexByAddress({
  [ADDR.MORPHO]: { name: "Morpho", kind: "flash/credit" },
  [ADDR.FLUID_LIQUIDITY]: { name: "Fluid", kind: "credit" },
  [ADDR.FLUID_VAULT_WSTUSR_USDC]: { name: "Fluid Vault", kind: "credit" },
  [ADDR.FLUID_DEX_USDC_USDT]: { name: "Fluid DEX USDC/USDT", kind: "swap" },
  [ADDR.SKY_PSM_LITE]: { name: "Sky PSM", kind: "peg" },
  [ADDR.UNIV4_POOL_MANAGER]: { name: "Uniswap v4", kind: "swap" },
  [ADDR.CURVE_SUSDS_USDT]: { name: "Curve sUSDS/USDT", kind: "swap" },
  [ADDR.CURVE_DOLA_SUSDS]: { name: "Curve DOLA/sUSDS", kind: "swap" },
  [ADDR.CURVE_DOLA_WSTUSR]: { name: "Curve DOLA/wstUSR", kind: "swap" },
  [ADDR.UNIV3_USDT_WETH]: { name: "Uniswap v3 USDT/WETH", kind: "swap" },
  [ADDR.GOLDX]: { name: "GOLDx", kind: "protocol-convert" },
});

export const TOPICS = {
  transfer: ethers.id("Transfer(address,address,uint256)"),
  wethDeposit: ethers.id("Deposit(address,uint256)"),
  wethWithdrawal: ethers.id("Withdrawal(address,uint256)"),
  univ2Swap: ethers.id("Swap(address,uint256,uint256,uint256,uint256,address)"),
  univ3Swap: ethers.id("Swap(address,address,int256,int256,uint160,uint128,int24)"),
  univ4Swap: ethers.id("Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)"),
  univ4Initialize: ethers.id("Initialize(bytes32,address,address,uint24,int24,address,uint160,int24)"),
  curveTokenExchange: ethers.id("TokenExchange(address,int128,uint256,int128,uint256)"),
  curveCryptoTokenExchange: ethers.id("TokenExchange(address,uint256,uint256,uint256,uint256,uint256,uint256)"),
  curveTokenExchangeUnderlying: ethers.id("TokenExchangeUnderlying(address,int128,uint256,int128,uint256)"),
  balancerV2Swap: ethers.id("Swap(bytes32,address,address,uint256,uint256)"),
  balancerV2PoolBalanceChanged: ethers.id("PoolBalanceChanged(bytes32,address,address[],int256[],uint256[])"),
  univ2Mint: ethers.id("Mint(address,uint256,uint256)"),
  univ2Burn: ethers.id("Burn(address,uint256,uint256,address)"),
  univ3Mint: ethers.id("Mint(address,address,int24,int24,uint128,uint256,uint256)"),
  univ3Burn: ethers.id("Burn(address,int24,int24,uint128,uint256,uint256)"),
  balancerV2FlashLoan: ethers.id("FlashLoan(address,address,uint256,uint256)"),
  morphoFlashLoan: ethers.id("FlashLoan(address,address,uint256)"),
  univ3Flash: ethers.id("Flash(address,address,uint256,uint256,uint256,uint256)"),
  aaveV3FlashLoan: ethers.id("FlashLoan(address,address,address,uint256,uint8,uint256,uint16)"),
  univ4ModifyLiquidity: ethers.id("ModifyLiquidity(bytes32,address,int24,int24,int256,bytes32)"),
  morphoBorrow: ethers.id("Borrow(bytes32,address,address,address,uint256,uint256)"),
  morphoRepay: ethers.id("Repay(bytes32,address,address,uint256,uint256)"),
  morphoSupply: ethers.id("Supply(bytes32,address,address,uint256,uint256)"),
  morphoWithdraw: ethers.id("Withdraw(bytes32,address,address,address,uint256,uint256)"),
  morphoSupplyCollateral: ethers.id("SupplyCollateral(bytes32,address,address,uint256)"),
  morphoWithdrawCollateral: ethers.id("WithdrawCollateral(bytes32,address,address,address,uint256)"),
  aaveV3Borrow: ethers.id("Borrow(address,address,address,uint256,uint8,uint256,uint16)"),
  aaveV3Repay: ethers.id("Repay(address,address,address,uint256,bool)"),
  // Liquity v2 — fixture-verified: all three topic0s match the emitter 0xa2895d6a… in
  // test/fixtures/coffee-20260704/tx-2.json (0x962110f2… / 0x0fba2673… / 0xecf6daab…).
  liquityTroveOperation: ethers.id("TroveOperation(uint256,uint8,uint256,uint256,uint256,int256,uint256,int256)"),
  liquityTroveUpdated: ethers.id("TroveUpdated(uint256,uint256,uint256,uint256,uint256,uint256,uint256)"),
  liquityBatchUpdated: ethers.id("BatchUpdated(address,uint8,uint256,uint256,uint256,uint256,uint256,uint256)"),
  // ERC4626 — canonical EIP-4626 event signatures (spec-defined; not present in the coffee fixtures).
  erc4626Deposit: ethers.id("Deposit(address,address,uint256,uint256)"),
  erc4626Withdraw: ethers.id("Withdraw(address,address,address,uint256,uint256)"),
  // Pancake v3 + DODO — fixture-verified: match coffee-20260704/tx-4.json (0x19b47279… / 0xc2c0245e…).
  pancakeV3Swap: ethers.id("Swap(address,address,int256,int256,uint160,uint128,int24,uint128,uint128)"),
  dodoSwap: ethers.id("DODOSwap(address,address,uint256,uint256,address,address)"),
  // Fluid DEX T1 swap — receipt-verified on coffee tx 0x9be73297 at the registered
  // USDC/USDT pool 0x667701e5. The public event signature is not available in the
  // interface we use, so keep the full observed topic instead of inventing an ABI.
  fluidDexSwap: "0xdc004dbca4ef9c966218431ee5d9133d337ad018dd5b5c5493722803f75c64f7",
  // Sky LitePSM (0xf6e72Db5…) — NODE-VERIFIED 2026-07-05: read the contract's real emitted topic0s over
  // 20k blocks on local reth (SellGem 0xef75f5a4… ×2822, BuyGem 0x085d06ec… ×2522) then ethers.id-matched
  // the signature (chain topic0 == ethers.id — two-way lock). SellGem = USDC→DAI, BuyGem = DAI→USDC.
  psmSellGem: ethers.id("SellGem(address,uint256,uint256)"),
  psmBuyGem: ethers.id("BuyGem(address,uint256,uint256)"),
  // TODO(credit): Fluid Liquidity LogOperate — the Fluid VAULT (0xee327311…) emits 0 logs (inactive);
  // LogOperate is emitted by Fluid's central Liquidity contract (address not yet resolved). Same
  // node-verify method as PSM once that address is found; do NOT invent a hash.
};

export const CALL_SELECTORS = {
  morphoFlashLoan: ethers.id("flashLoan(address,uint256,bytes)").slice(0, 10),
};

export function lower(addr: string | null | undefined): string {
  return (addr ?? "").toLowerCase();
}

export function tokenMeta(addr: string): { symbol: string; decimals: number; stable?: boolean; roughUsd?: number } {
  return TOKEN_META[lower(addr)] ?? { symbol: short(addr), decimals: 18 };
}

export function protocolName(addr: string): string | undefined {
  return PROTOCOLS[lower(addr)]?.name;
}

export function short(addr: string): string {
  return addr ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : "unknown";
}

function indexByAddress<T>(obj: Record<string, T>): Record<string, T> {
  const out: Record<string, T> = {};
  for (const [k, v] of Object.entries(obj)) out[k.toLowerCase()] = v;
  return out;
}
