// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {BotVMEncoder} from "./BotVMEncoder.sol";
import {Constants} from "./Constants.sol";
import {IERC20} from "./interfaces/IERC20.sol";
import {IMorpho} from "./interfaces/IMorpho.sol";
import {IFluidVault} from "./interfaces/IFluidVault.sol";
import {ISkyPSMLite, IUniswapV3Pool, ICurvePool, ICurvePoolNoReceiver, IPoolManager, PoolKey, SwapParams} from "./interfaces/ISwap.sol";

/// @notice All parameters needed to build a wstUSR arb VM script.
///         First 5 fields are user-specified (from optimizer/monitor).
///         Last 5 fields are pre-computed via CaptureArb or off-chain simulation.
struct WstUsrArbParams {
    // User-specified
    uint256 flashAmount;
    uint256 debtAmount1;
    uint256 debtAmount2;
    uint256 v4TakeAmount;
    uint256 v3ExactOutput;
    // Pre-computed intermediate values
    uint256 daiAmount;
    uint256 usdtReceived;
    uint256 wethOwed;
    uint256 susdsOut;
    uint256 dolaAmount;
}

/// @title BotVMScriptBuilder — Builds packed VM scripts for the wstUSR arb route
/// @notice Encodes the full nested callback tree:
///   top → Morpho flash loan → V4 unlock → V3 swap #1 (USDT→WETH)
///                            → V3 swap #2 (WETH→USDT) → Curve chain
library BotVMScriptBuilder {
    using BotVMEncoder for bytes;

    uint160 private constant MIN_SQRT_PRICE = 4295128740;
    uint160 private constant MAX_SQRT_PRICE = 1461446703485210103287273052203988822378723970341;

    /// @notice Build the complete top-level VM script for the wstUSR arb.
    /// @param p All arb parameters (user-specified + pre-computed intermediate values)
    /// @param executor Address of the BotVM instance (needed as recipient in callbacks)
    /// @return The packed opcode stream ready for BotVM.execute()
    function buildWstUsrArbScript(WstUsrArbParams memory p, address executor)
        internal
        pure
        returns (bytes memory)
    {
        // Build from leaves up: v3Phase1Sub → v4Sub, v3Phase2Sub → morphoSub → top

        // V3 phase 1 sub-script: pay USDT to V3 pool
        bytes memory v3Phase1Sub = BotVMEncoder.encodeCall(
            Constants.USDT,
            abi.encodeWithSelector(IERC20.transfer.selector, Constants.UNISWAP_V3_USDT_WETH, p.v4TakeAmount)
        );

        // V3 phase 2 sub-script: Curve chain + pay WETH
        bytes memory v3Phase2Sub = _buildCurveChainScript(p, executor);

        // V4 sub-script (inside unlockCallback)
        bytes memory v4Sub = _buildV4SubScript(p, executor, v3Phase1Sub);

        // Morpho sub-script (inside onMorphoFlashLoan)
        bytes memory morphoSub = _buildMorphoSubScript(p, executor, v4Sub, v3Phase2Sub);

        // Top-level: SET_FIELD2(100) → CALL Morpho.flashLoan → CLEAR_STATE
        bytes memory top = BotVMEncoder.encodeSetField2(100);
        top = top.concat(BotVMEncoder.encodeCall(
            Constants.MORPHO,
            abi.encodeWithSelector(IMorpho.flashLoan.selector, Constants.WSTUSER, p.flashAmount, morphoSub)
        ));
        top = top.concat(BotVMEncoder.encodeClearState());

        return top;
    }

    // ── Internal Builders ──────────────────────────────────────────

    function _buildMorphoSubScript(
        WstUsrArbParams memory p,
        address executor,
        bytes memory v4Sub,
        bytes memory v3Phase2Sub
    ) private pure returns (bytes memory) {
        uint256 half = p.flashAmount / 2;
        uint256 otherHalf = p.flashAmount - half;
        uint256 totalUsdc = p.debtAmount1 + p.debtAmount2;

        bytes memory s;

        // 1. Approve wstUSR for Fluid vault
        s = BotVMEncoder.encodeCall(
            Constants.WSTUSER,
            abi.encodeWithSelector(IERC20.approve.selector, Constants.FLUID_VAULT_WSTUSER_USDC, p.flashAmount)
        );

        // 2. Approve USDC for Sky PSM
        s = s.concat(BotVMEncoder.encodeCall(
            Constants.USDC,
            abi.encodeWithSelector(IERC20.approve.selector, Constants.SKY_PSM_LITE, type(uint256).max)
        ));

        // 3. Fluid position #1
        s = s.concat(BotVMEncoder.encodeCall(
            Constants.FLUID_VAULT_WSTUSER_USDC,
            abi.encodeWithSelector(IFluidVault.operate.selector, uint256(0), int256(half), int256(p.debtAmount1), executor)
        ));

        // 4. Fluid position #2
        s = s.concat(BotVMEncoder.encodeCall(
            Constants.FLUID_VAULT_WSTUSER_USDC,
            abi.encodeWithSelector(IFluidVault.operate.selector, uint256(0), int256(otherHalf), int256(p.debtAmount2), executor)
        ));

        // 5. USDC → DAI via PSM
        s = s.concat(BotVMEncoder.encodeCall(
            Constants.SKY_PSM_LITE,
            abi.encodeWithSelector(ISkyPSMLite.sellGem.selector, executor, totalUsdc)
        ));

        // 6. SET_FIELD2(68) for V4 unlockCallback
        s = s.concat(BotVMEncoder.encodeSetField2(68));

        // 7. CALL V4 PM unlock — carries v4Sub script
        s = s.concat(BotVMEncoder.encodeCall(
            Constants.UNISWAP_V4_POOL_MANAGER,
            abi.encodeWithSelector(IPoolManager.unlock.selector, v4Sub)
        ));

        // 8. CLEAR_STATE after V4 callback
        s = s.concat(BotVMEncoder.encodeClearState());

        // 9. SET_FIELD2(132) for V3 phase 2 callback
        s = s.concat(BotVMEncoder.encodeSetField2(132));

        // 10. CALL V3 swap #2: WETH→USDT (exactOutput)
        s = s.concat(BotVMEncoder.encodeCall(
            Constants.UNISWAP_V3_USDT_WETH,
            abi.encodeWithSelector(
                IUniswapV3Pool.swap.selector,
                executor,
                true,                         // zeroForOne (WETH→USDT)
                -int256(p.v3ExactOutput),      // exactOutput
                MIN_SQRT_PRICE,
                v3Phase2Sub
            )
        ));

        // 11. CLEAR_STATE after V3 callback
        s = s.concat(BotVMEncoder.encodeClearState());

        // 12. Approve Morpho for flash loan repayment
        s = s.concat(BotVMEncoder.encodeCall(
            Constants.WSTUSER,
            abi.encodeWithSelector(IERC20.approve.selector, Constants.MORPHO, p.flashAmount)
        ));

        return s;
    }

    function _buildV4SubScript(
        WstUsrArbParams memory p,
        address executor,
        bytes memory v3Phase1Sub
    ) private pure returns (bytes memory) {
        bytes memory s;

        // 1. V4 swap: DAI→USDT
        PoolKey memory key = PoolKey({
            currency0: Constants.DAI,
            currency1: Constants.USDT,
            fee: 68,
            tickSpacing: 1,
            hooks: address(0)
        });
        SwapParams memory params = SwapParams({
            zeroForOne: true,
            amountSpecified: -int256(p.daiAmount),
            sqrtPriceLimitX96: MIN_SQRT_PRICE
        });
        s = BotVMEncoder.encodeCall(
            Constants.UNISWAP_V4_POOL_MANAGER,
            abi.encodeWithSelector(IPoolManager.swap.selector, key, params, "")
        );

        // 2. Take USDT from V4
        s = s.concat(BotVMEncoder.encodeCall(
            Constants.UNISWAP_V4_POOL_MANAGER,
            abi.encodeWithSelector(IPoolManager.take.selector, Constants.USDT, executor, p.v4TakeAmount)
        ));

        // 3. SET_FIELD2(132) for V3 phase 1 callback
        s = s.concat(BotVMEncoder.encodeSetField2(132));

        // 4. V3 swap #1: USDT→WETH (exactInput)
        s = s.concat(BotVMEncoder.encodeCall(
            Constants.UNISWAP_V3_USDT_WETH,
            abi.encodeWithSelector(
                IUniswapV3Pool.swap.selector,
                executor,
                false,                        // not zeroForOne (USDT→WETH)
                int256(p.v4TakeAmount),        // exactInput
                MAX_SQRT_PRICE,
                v3Phase1Sub
            )
        ));

        // 5. CLEAR_STATE after V3 callback
        s = s.concat(BotVMEncoder.encodeClearState());

        // 6. Sync DAI with V4
        s = s.concat(BotVMEncoder.encodeCall(
            Constants.UNISWAP_V4_POOL_MANAGER,
            abi.encodeWithSelector(IPoolManager.sync.selector, Constants.DAI)
        ));

        // 7. Transfer DAI to V4 PM for settlement
        s = s.concat(BotVMEncoder.encodeCall(
            Constants.DAI,
            abi.encodeWithSelector(IERC20.transfer.selector, Constants.UNISWAP_V4_POOL_MANAGER, p.daiAmount)
        ));

        // 8. V4 settle
        s = s.concat(BotVMEncoder.encodeCall(
            Constants.UNISWAP_V4_POOL_MANAGER,
            abi.encodeWithSelector(IPoolManager.settle.selector)
        ));

        // 9. RETURN("") — V4 unlock must return bytes
        s = s.concat(BotVMEncoder.encodeReturn(abi.encode("")));

        return s;
    }

    function _buildCurveChainScript(WstUsrArbParams memory p, address executor)
        private
        pure
        returns (bytes memory)
    {
        bytes memory s;

        // 1. Transfer USDT to Curve sUSDS/USDT pool
        s = BotVMEncoder.encodeCall(
            Constants.USDT,
            abi.encodeWithSelector(IERC20.transfer.selector, Constants.CURVE_SUSDS_USDT, p.usdtReceived)
        );

        // 2. USDT → sUSDS (coin[1]→coin[0]), output to DOLA/sUSDS pool
        s = s.concat(BotVMEncoder.encodeCall(
            Constants.CURVE_SUSDS_USDT,
            abi.encodeWithSelector(
                ICurvePool.exchange_received.selector,
                int128(1), int128(0), p.usdtReceived, uint256(0), Constants.CURVE_DOLA_SUSDS
            )
        ));

        // 3. sUSDS → DOLA (coin[1]→coin[0]), output to executor
        s = s.concat(BotVMEncoder.encodeCall(
            Constants.CURVE_DOLA_SUSDS,
            abi.encodeWithSelector(
                ICurvePool.exchange_received.selector,
                int128(1), int128(0), p.susdsOut, uint256(0), executor
            )
        ));

        // 4. Transfer DOLA to Curve DOLA/wstUSR pool
        s = s.concat(BotVMEncoder.encodeCall(
            Constants.DOLA,
            abi.encodeWithSelector(IERC20.transfer.selector, Constants.CURVE_DOLA_WSTUSR, p.dolaAmount)
        ));

        // 5. DOLA → wstUSR (coin[0]→coin[1]), no receiver param
        s = s.concat(BotVMEncoder.encodeCall(
            Constants.CURVE_DOLA_WSTUSR,
            abi.encodeWithSelector(
                ICurvePoolNoReceiver.exchange_received.selector,
                int128(0), int128(1), p.dolaAmount, uint256(0)
            )
        ));

        // 6. Pay WETH to V3 pool
        s = s.concat(BotVMEncoder.encodeCall(
            Constants.WETH,
            abi.encodeWithSelector(IERC20.transfer.selector, Constants.UNISWAP_V3_USDT_WETH, p.wethOwed)
        ));

        return s;
    }
}
