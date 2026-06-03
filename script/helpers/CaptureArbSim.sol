// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Constants} from "../../src/Constants.sol";
import {IERC20} from "../../src/interfaces/IERC20.sol";
import {IFluidVault} from "../../src/interfaces/IFluidVault.sol";
import {IMorpho, IMorphoFlashLoanCallback} from "../../src/interfaces/IMorpho.sol";
import {
    ICurvePool,
    ICurvePoolNoReceiver,
    IPoolManager,
    ISkyPSMLite,
    IUniswapV3Pool,
    PoolKey,
    SwapParams
} from "../../src/interfaces/ISwap.sol";

// Minimal FlashArb clone that executes the arb and stores intermediate values.
// Used to pre-compute values needed by the VM script builder.
contract CaptureArbSim is IMorphoFlashLoanCallback { // # codex修改
    uint160 private constant MIN_SQRT_PRICE = 4295128740;
    uint160 private constant MAX_SQRT_PRICE = 1461446703485210103287273052203988822378723970341;

    uint256 public daiAmount;
    uint256 public usdtReceivedPhase2;
    uint256 public wethOwed;
    uint256 public susdsOut;
    uint256 public dolaAmount;
    uint256 public wstUsrProfit;
    uint256 public wethProfit;

    uint256 private _debtAmount1;
    uint256 private _debtAmount2;
    uint256 private _v4TakeAmount;
    uint256 private _v3ExactOutput;

    function capture(
        uint256 flashAmount,
        uint256 debtAmount1,
        uint256 debtAmount2,
        uint256 v4TakeAmount,
        uint256 v3ExactOutput
    ) external {
        _debtAmount1 = debtAmount1;
        _debtAmount2 = debtAmount2;
        _v4TakeAmount = v4TakeAmount;
        _v3ExactOutput = v3ExactOutput;
        IMorpho(Constants.MORPHO).flashLoan(Constants.WSTUSER, flashAmount, "");
    }

    function onMorphoFlashLoan(uint256 assets, bytes calldata) external override {
        require(msg.sender == Constants.MORPHO, "not morpho");

        uint256 half = assets / 2;
        uint256 otherHalf = assets - half;

        IERC20(Constants.WSTUSER).approve(Constants.FLUID_VAULT_WSTUSER_USDC, assets);
        IERC20(Constants.USDC).approve(Constants.SKY_PSM_LITE, type(uint256).max);

        IFluidVault(Constants.FLUID_VAULT_WSTUSER_USDC).operate(0, int256(half), int256(_debtAmount1), address(this));
        IFluidVault(Constants.FLUID_VAULT_WSTUSER_USDC).operate(
            0, int256(otherHalf), int256(_debtAmount2), address(this)
        );

        uint256 totalUsdc = _debtAmount1 + _debtAmount2;
        ISkyPSMLite(Constants.SKY_PSM_LITE).sellGem(address(this), totalUsdc);
        daiAmount = IERC20(Constants.DAI).balanceOf(address(this));

        IPoolManager(Constants.UNISWAP_V4_POOL_MANAGER).unlock(abi.encode(daiAmount, _v4TakeAmount));

        IUniswapV3Pool(Constants.UNISWAP_V3_USDT_WETH).swap(
            address(this), true, -int256(_v3ExactOutput), MIN_SQRT_PRICE, abi.encode(uint8(2))
        );

        IERC20(Constants.WSTUSER).approve(Constants.MORPHO, assets);

        wstUsrProfit = IERC20(Constants.WSTUSER).balanceOf(address(this)) - assets;
        wethProfit = IERC20(Constants.WETH).balanceOf(address(this));
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        require(msg.sender == Constants.UNISWAP_V4_POOL_MANAGER, "not v4");
        (uint256 dai, uint256 v4Take) = abi.decode(data, (uint256, uint256));
        IPoolManager pm = IPoolManager(Constants.UNISWAP_V4_POOL_MANAGER);

        PoolKey memory key = PoolKey({
            currency0: Constants.DAI,
            currency1: Constants.USDT,
            fee: 68,
            tickSpacing: 1,
            hooks: address(0)
        });
        pm.swap(key, SwapParams({zeroForOne: true, amountSpecified: -int256(dai), sqrtPriceLimitX96: MIN_SQRT_PRICE}), "");
        pm.take(Constants.USDT, address(this), v4Take);

        IUniswapV3Pool(Constants.UNISWAP_V3_USDT_WETH).swap(
            address(this), false, int256(v4Take), MAX_SQRT_PRICE, abi.encode(uint8(1))
        );

        pm.sync(Constants.DAI);
        _safeTransfer(Constants.DAI, Constants.UNISWAP_V4_POOL_MANAGER, dai);
        pm.settle();
        return "";
    }

    function uniswapV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata data) external {
        require(msg.sender == Constants.UNISWAP_V3_USDT_WETH, "not v3");
        uint8 phase = abi.decode(data, (uint8));

        if (phase == 1) {
            _safeTransfer(Constants.USDT, msg.sender, uint256(amount1Delta));
        } else {
            usdtReceivedPhase2 = IERC20(Constants.USDT).balanceOf(address(this));
            wethOwed = uint256(amount0Delta);

            _safeTransfer(Constants.USDT, Constants.CURVE_SUSDS_USDT, usdtReceivedPhase2);
            susdsOut =
                ICurvePool(Constants.CURVE_SUSDS_USDT).exchange_received(1, 0, usdtReceivedPhase2, 0, Constants.CURVE_DOLA_SUSDS);

            ICurvePool(Constants.CURVE_DOLA_SUSDS).exchange_received(1, 0, susdsOut, 0, address(this));
            dolaAmount = IERC20(Constants.DOLA).balanceOf(address(this));

            _safeTransfer(Constants.DOLA, Constants.CURVE_DOLA_WSTUSR, dolaAmount);
            ICurvePoolNoReceiver(Constants.CURVE_DOLA_WSTUSR).exchange_received(0, 1, dolaAmount, 0);

            _safeTransfer(Constants.WETH, msg.sender, wethOwed);
        }
    }

    function _safeTransfer(address token, address to, uint256 amount) internal {
        (bool ok, bytes memory ret) = token.call(abi.encodeWithSelector(IERC20.transfer.selector, to, amount));
        require(ok && (ret.length == 0 || abi.decode(ret, (bool))), "transfer failed");
    }
}
