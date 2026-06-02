// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IMorpho, IMorphoFlashLoanCallback} from "./interfaces/IMorpho.sol";
import {IFluidVault} from "./interfaces/IFluidVault.sol";
import {IERC20} from "./interfaces/IERC20.sol";
import {ISkyPSMLite, IUniswapV3Pool, ICurvePool, ICurvePoolNoReceiver, IPoolManager, PoolKey, SwapParams} from "./interfaces/ISwap.sol";
import {Constants} from "./Constants.sol";

struct ArbParams {
    uint256 debtAmount1;      // USDC to borrow for Fluid position 1 (computed off-chain)
    uint256 debtAmount2;      // USDC to borrow for Fluid position 2 (computed off-chain)
    uint256 v4TakeAmount;     // USDT to take from V4 pool after DAI→USDT swap
    uint256 v3ExactOutput;    // USDT exact output for V3 swap #2 (WETH→USDT)
    uint256 curveMinWstUsr;   // min wstUSR output from Curve chain (slippage guard)
    uint256 minProfitWstUsr;  // min wstUSR profit after repay (revert if below)
}

contract FlashArb is IMorphoFlashLoanCallback {
    address public immutable owner;
    uint256 private activeStartWstUsrBalance; // # codex修改

    uint160 private constant MIN_SQRT_PRICE = 4295128740;
    uint160 private constant MAX_SQRT_PRICE = 1461446703485210103287273052203988822378723970341;

    modifier onlyOwner() {
        require(msg.sender == owner, "not owner");
        _;
    }

    constructor() {
        owner = msg.sender;
    }

    function execute(uint256 flashAmount, ArbParams calldata params) external onlyOwner {
        activeStartWstUsrBalance = IERC20(Constants.WSTUSER).balanceOf(address(this)); // # codex修改
        IMorpho(Constants.MORPHO).flashLoan(Constants.WSTUSER, flashAmount, abi.encode(params));
        delete activeStartWstUsrBalance; // # codex修改
    }

    function onMorphoFlashLoan(uint256 assets, bytes calldata data) external override {
        require(msg.sender == Constants.MORPHO, "not morpho");
        ArbParams memory params = abi.decode(data, (ArbParams));

        uint256 half = assets / 2;
        uint256 otherHalf = assets - half;

        // Approve Fluid vault + Sky PSM before operations
        IERC20(Constants.WSTUSER).approve(Constants.FLUID_VAULT_WSTUSER_USDC, assets);
        IERC20(Constants.USDC).approve(Constants.SKY_PSM_LITE, type(uint256).max);

        // Fluid position #1
        uint256 borrowed1 = _depositAndBorrow(half, params.debtAmount1);
        // Fluid position #2
        uint256 borrowed2 = _depositAndBorrow(otherHalf, params.debtAmount2);
        uint256 totalUsdc = borrowed1 + borrowed2;

        // USDC → DAI via Sky PSM (1:1)
        ISkyPSMLite(Constants.SKY_PSM_LITE).sellGem(address(this), totalUsdc);
        uint256 daiAmount = IERC20(Constants.DAI).balanceOf(address(this));

        // DAI → USDT via Uniswap V4, then USDT → WETH via V3 (inside unlockCallback)
        IPoolManager(Constants.UNISWAP_V4_POOL_MANAGER).unlock(abi.encode(daiAmount, params.v4TakeAmount));

        // WETH → USDT via V3 swap #2
        // In v3SwapCallback phase 2: route USDT→sUSDS→DOLA→wstUSR, then pay WETH
        IUniswapV3Pool(Constants.UNISWAP_V3_USDT_WETH).swap(
            address(this),
            true, // zeroForOne (WETH→USDT, WETH is token0)
            -int256(params.v3ExactOutput), // exactOutput USDT
            MIN_SQRT_PRICE,
            abi.encode(uint8(2), params.curveMinWstUsr)
        );

        // Min profit check: wstUSR balance must cover flash loan repay + minimum profit
        uint256 wstUsrBal = IERC20(Constants.WSTUSER).balanceOf(address(this));
        uint256 requiredWstUsr = activeStartWstUsrBalance + assets + params.minProfitWstUsr; // # codex修改
        require(wstUsrBal >= requiredWstUsr, "below min profit"); // # codex修改

        // Approve Morpho to pull wstUSR for repayment
        IERC20(Constants.WSTUSER).approve(Constants.MORPHO, assets);
    }

    // --- Uniswap V4 unlock callback ---

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        require(msg.sender == Constants.UNISWAP_V4_POOL_MANAGER, "not v4");

        (uint256 daiAmount, uint256 v4TakeAmount) = abi.decode(data, (uint256, uint256));
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

        // Take USDT out of V4
        pm.take(Constants.USDT, address(this), v4TakeAmount);

        // V3 swap #1: USDT → WETH (inside V4 unlock context)
        IUniswapV3Pool(Constants.UNISWAP_V3_USDT_WETH).swap(
            address(this),
            false, // not zeroForOne (USDT→WETH, USDT is token1)
            int256(v4TakeAmount), // exactInput USDT
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
            (, uint256 curveMinWstUsr) = abi.decode(data, (uint8, uint256));
            uint256 usdtReceived = IERC20(Constants.USDT).balanceOf(address(this));
            uint256 wstUsrBeforeCurve = IERC20(Constants.WSTUSER).balanceOf(address(this)); // # codex修改

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

            // Curve slippage guard
            if (curveMinWstUsr > 0) {
                uint256 wstUsrOut = IERC20(Constants.WSTUSER).balanceOf(address(this)) - wstUsrBeforeCurve; // # codex修改
                require(wstUsrOut >= curveMinWstUsr, "curve slippage"); // # codex修改
            }

            // Pay WETH owed to V3 pool
            uint256 wethOwed = uint256(amount0Delta);
            _safeTransfer(Constants.WETH, msg.sender, wethOwed);
        }
    }

    // --- Fluid vault ---

    function _depositAndBorrow(uint256 colAmount, uint256 debtAmount) internal returns (uint256 usdcBorrowed) {
        IFluidVault(Constants.FLUID_VAULT_WSTUSER_USDC).operate(
            0,
            int256(colAmount),
            int256(debtAmount),
            address(this)
        );

        usdcBorrowed = debtAmount;
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
