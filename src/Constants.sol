// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

library Constants {
    // Core tokens (from tx 0xf88b498b...970)
    address constant WSTUSER = 0x1202F5C7b4B9E47a1A484E8B270be34dbbC75055;
    address constant USDC = 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48;
    address constant DAI = 0x6B175474E89094C44Da98b954EedeAC495271d0F;
    address constant USDT = 0xdAC17F958D2ee523a2206206994597C13D831ec7;
    address constant WETH = 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2;
    address constant DOLA = 0x865377367054516e17014CcdED1e7d814EDC9ce4;
    address constant SUSDS = 0xa3931d71877C0E7a3148CB7Eb4463524FEc27fbD;

    // Morpho Blue
    address constant MORPHO = 0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb;

    // Fluid
    address constant FLUID_VAULT_WSTUSER_USDC = 0xee327311D8640156E87eC33ea55FcbF2309e0ce6;
    address constant FLUID_LIQUIDITY = 0x52Aa899454998Be5b000Ad077a46Bbe360F4e497;

    // DEX routing (USDC → DAI → USDT → sUSDS → DOLA → wstUSR)
    address constant SKY_PSM_LITE = 0xf6e72Db5454dd049d0788e411b06CfAF16853042;
    address constant UNISWAP_V4_POOL_MANAGER = 0x000000000004444c5dc75cB358380D2e3dE08A90;
    address constant UNISWAP_V3_USDT_WETH = 0xc7bBeC68d12a0d1830360F8Ec58fA599bA1b0e9b;
    address constant CURVE_SUSDS_USDT = 0x00836Fe54625BE242BcFA286207795405ca4fD10;
    address constant CURVE_DOLA_SUSDS = 0x8b83c4aA949254895507D09365229BC3a8c7f710;
    address constant CURVE_DOLA_WSTUSR = 0x64273624eb57c5cA961d366CBF3968e760Bf0452;

    // Oracles
    address constant CHAINLINK_ETH_USD = 0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419;

    // Reference
    address constant ORIGINAL_MEV_BOT = 0xE08D97e151473A848C3d9CA3f323Cb720472D015;
    bytes32 constant ORIGINAL_TX_HASH = 0xf88b498b835279ec9de597c7360ca21b7e8803053b442a04c5fc664e04e39970; // # codex修改
    uint256 constant TARGET_BLOCK = 24710788;
    uint256 constant FORK_BLOCK = 24710787;
}
