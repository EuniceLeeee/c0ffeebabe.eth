// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IMorpho, IMorphoFlashLoanCallback} from "./interfaces/IMorpho.sol";
import {IFluidVault} from "./interfaces/IFluidVault.sol";
import {IERC20} from "./interfaces/IERC20.sol";
import {ISkyPSMLite, IUniswapV3Pool, ICurvePool, ICurvePoolNoReceiver, IPoolManager, PoolKey, SwapParams} from "./interfaces/ISwap.sol";
import {Constants} from "./Constants.sol";

contract FlashArb is IMorphoFlashLoanCallback {
    address public immutable owner;

    uint160 private constant MIN_SQRT_PRICE = 4295128740;
    uint160 private constant MAX_SQRT_PRICE = 1461446703485210103287273052203988822378723970341;

    modifier onlyOwner() {
        require(msg.sender == owner, "not owner");
        _;
    }

    constructor() {
        owner = msg.sender;
    }

    function execute(uint256 flashAmount) external onlyOwner {
        IMorpho(Constants.MORPHO).flashLoan(Constants.WSTUSER, flashAmount, "");
    }

    function onMorphoFlashLoan(uint256 assets, bytes calldata) external override {
        require(msg.sender == Constants.MORPHO, "not morpho");

        uint256 half = assets / 2;
        uint256 otherHalf = assets - half;

        // Approve Fluid vault + Sky PSM before operations
        IERC20(Constants.WSTUSER).approve(Constants.FLUID_VAULT_WSTUSER_USDC, assets);
        IERC20(Constants.USDC).approve(Constants.SKY_PSM_LITE, type(uint256).max);

        // Fluid position #1
        uint256 borrowed1 = _depositAndBorrow(half);
        // Fluid position #2
        uint256 borrowed2 = _depositAndBorrow(otherHalf);
        uint256 totalUsdc = borrowed1 + borrowed2;

        // USDC → DAI via Sky PSM (1:1)
        ISkyPSMLite(Constants.SKY_PSM_LITE).sellGem(address(this), totalUsdc);
        uint256 daiAmount = IERC20(Constants.DAI).balanceOf(address(this));

        // DAI → USDT via Uniswap V4, then USDT → WETH via V3 (inside unlockCallback)
        IPoolManager(Constants.UNISWAP_V4_POOL_MANAGER).unlock(abi.encode(daiAmount));

        // WETH → USDT via V3 swap #2 (exactOutput 3,513.43 USDT from trace)
        // In v3SwapCallback phase 2: route USDT→sUSDS→DOLA→wstUSR, then pay WETH
        IUniswapV3Pool(Constants.UNISWAP_V3_USDT_WETH).swap(
            address(this),
            true, // zeroForOne (WETH→USDT, WETH is token0)
            -int256(uint256(3513427987)), // exactOutput USDT
            MIN_SQRT_PRICE,
            abi.encode(uint8(2))
        );

        // Approve Morpho to pull wstUSR for repayment
        IERC20(Constants.WSTUSER).approve(Constants.MORPHO, assets);
    }

    // --- Uniswap V4 unlock callback ---

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        require(msg.sender == Constants.UNISWAP_V4_POOL_MANAGER, "not v4");

        uint256 daiAmount = abi.decode(data, (uint256));
        IPoolManager pm = IPoolManager(Constants.UNISWAP_V4_POOL_MANAGER);

        // V4 swap: DAI → USDT
        PoolKey memory key = PoolKey({
            currency0: Constants.DAI,
            currency1: Constants.USDT,
            fee: 68,
            tickSpacing: 1,
            hooks: address(0)
        });

        pm.swap(
            key,
            SwapParams({
                zeroForOne: true,
                amountSpecified: -int256(daiAmount),
                sqrtPriceLimitX96: MIN_SQRT_PRICE
            }),
            ""
        );

        // Take USDT out of V4 (amount from trace)
        pm.take(Constants.USDT, address(this), 3679935364);

        // V3 swap #1: USDT → WETH (inside V4 unlock context)
        IUniswapV3Pool(Constants.UNISWAP_V3_USDT_WETH).swap(
            address(this),
            false, // not zeroForOne (USDT→WETH, USDT is token1)
            int256(uint256(3679935364)), // exactInput USDT
            MAX_SQRT_PRICE,
            abi.encode(uint8(1)) // phase 1: pay USDT
        );

        // Settle DAI with V4
        pm.sync(Constants.DAI);
        _safeTransfer(Constants.DAI, Constants.UNISWAP_V4_POOL_MANAGER, daiAmount);
        pm.settle();

        return "";
    }

    // --- Uniswap V3 swap callback ---

    function uniswapV3SwapCallback(
        int256 amount0Delta,
        int256 amount1Delta,
        bytes calldata data
    ) external {
        require(msg.sender == Constants.UNISWAP_V3_USDT_WETH, "not v3");

        uint8 phase = abi.decode(data, (uint8));

        if (phase == 1) {
            // Phase 1 (inside V4 unlock): USDT→WETH swap, pay USDT to V3 pool
            uint256 usdtOwed = uint256(amount1Delta);
            _safeTransfer(Constants.USDT, msg.sender, usdtOwed);
        } else {
            // Phase 2: WETH→USDT swap
            // We already received USDT. Now route it through Curve to wstUSR, then pay WETH.
            uint256 usdtReceived = IERC20(Constants.USDT).balanceOf(address(this));

            // USDT → sUSDS (Curve: coin[1]→coin[0]), send output to DOLA/sUSDS pool
            _safeTransfer(Constants.USDT, Constants.CURVE_SUSDS_USDT, usdtReceived);
            uint256 susdsOut = ICurvePool(Constants.CURVE_SUSDS_USDT).exchange_received(
                1, 0, usdtReceived, 0, Constants.CURVE_DOLA_SUSDS
            );

            // sUSDS → DOLA (Curve: coin[1]→coin[0])
            ICurvePool(Constants.CURVE_DOLA_SUSDS).exchange_received(
                1, 0, susdsOut, 0, address(this)
            );

            // DOLA → wstUSR (Curve: coin[0]→coin[1])
            uint256 dolaAmount = IERC20(Constants.DOLA).balanceOf(address(this));
            _safeTransfer(Constants.DOLA, Constants.CURVE_DOLA_WSTUSR, dolaAmount);
            ICurvePoolNoReceiver(Constants.CURVE_DOLA_WSTUSR).exchange_received(
                0, 1, dolaAmount, 0
            );

            // Pay WETH owed to V3 pool
            uint256 wethOwed = uint256(amount0Delta);
            _safeTransfer(Constants.WETH, msg.sender, wethOwed);
        }
    }

    // --- Fluid vault ---

    function _depositAndBorrow(uint256 colAmount) internal returns (uint256 usdcBorrowed) {
        int256 debtAmount = int256(_calcDebtForCollateral(colAmount));

        IFluidVault(Constants.FLUID_VAULT_WSTUSER_USDC).operate(
            0,
            int256(colAmount),
            debtAmount,
            address(this)
        );

        usdcBorrowed = uint256(debtAmount);
    }

    function _calcDebtForCollateral(uint256 colAmount) internal pure returns (uint256) {
        // Reference tx: 1,766,743,380,904,387,863,297 wstUSR → 1,839,929,197 USDC
        return (colAmount * 1839929197) / 1766743380904387863297;
    }

    // --- Helpers ---

    function _safeTransfer(address token, address to, uint256 amount) internal {
        (bool success, bytes memory ret) = token.call(
            abi.encodeWithSelector(IERC20.transfer.selector, to, amount)
        );
        require(success && (ret.length == 0 || abi.decode(ret, (bool))), "transfer failed");
    }

    function sweep(address token) external onlyOwner {
        uint256 bal = IERC20(token).balanceOf(address(this));
        if (bal > 0) _safeTransfer(token, owner, bal);
    }

    receive() external payable {}
}
