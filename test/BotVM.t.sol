// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import {BotVM} from "../src/BotVM.sol";
import {BotVMEncoder} from "../src/BotVMEncoder.sol";
import {BotVMScriptBuilder, WstUsrArbParams} from "../src/BotVMScriptBuilder.sol";
import {Constants} from "../src/Constants.sol";
import {IERC20} from "../src/interfaces/IERC20.sol";
import {IMorpho, IMorphoFlashLoanCallback} from "../src/interfaces/IMorpho.sol";
import {IFluidVault} from "../src/interfaces/IFluidVault.sol";
import {ISkyPSMLite, IUniswapV3Pool, ICurvePool, ICurvePoolNoReceiver, IPoolManager, PoolKey, SwapParams} from "../src/interfaces/ISwap.sol";

// ── CaptureArb ─────────────────────────────────────────────────────
// Minimal FlashArb clone that stores intermediate values for VM script construction.

contract CaptureArb is IMorphoFlashLoanCallback {
    address public immutable owner;

    uint160 private constant MIN_SQRT_PRICE = 4295128740;
    uint160 private constant MAX_SQRT_PRICE = 1461446703485210103287273052203988822378723970341;

    // Captured intermediate values
    uint256 public daiAmount;
    uint256 public usdtReceivedPhase2;
    uint256 public wethOwed;
    uint256 public susdsOut;
    uint256 public dolaAmount;
    uint256 public wstUsrProfit;
    uint256 public wethProfit;

    // Params
    uint256 private _debtAmount1;
    uint256 private _debtAmount2;
    uint256 private _v4TakeAmount;
    uint256 private _v3ExactOutput;

    constructor() { owner = msg.sender; }

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
        IFluidVault(Constants.FLUID_VAULT_WSTUSER_USDC).operate(0, int256(otherHalf), int256(_debtAmount2), address(this));

        uint256 totalUsdc = _debtAmount1 + _debtAmount2;
        ISkyPSMLite(Constants.SKY_PSM_LITE).sellGem(address(this), totalUsdc);
        daiAmount = IERC20(Constants.DAI).balanceOf(address(this));

        // V4 unlock → DAI→USDT + V3 swap #1 (USDT→WETH)
        IPoolManager(Constants.UNISWAP_V4_POOL_MANAGER).unlock(abi.encode(daiAmount, _v4TakeAmount));

        // V3 swap #2: WETH→USDT (exactOutput)
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
            currency0: Constants.DAI, currency1: Constants.USDT,
            fee: 68, tickSpacing: 1, hooks: address(0)
        });
        pm.swap(key, SwapParams({zeroForOne: true, amountSpecified: -int256(dai), sqrtPriceLimitX96: MIN_SQRT_PRICE}), "");
        pm.take(Constants.USDT, address(this), v4Take);

        // V3 swap #1: USDT→WETH
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
            uint256 usdtOwed = uint256(amount1Delta);
            _safeTransfer(Constants.USDT, msg.sender, usdtOwed);
        } else {
            // Phase 2: capture all intermediate values
            usdtReceivedPhase2 = IERC20(Constants.USDT).balanceOf(address(this));
            wethOwed = uint256(amount0Delta);

            // USDT → sUSDS
            _safeTransfer(Constants.USDT, Constants.CURVE_SUSDS_USDT, usdtReceivedPhase2);
            susdsOut = ICurvePool(Constants.CURVE_SUSDS_USDT).exchange_received(
                1, 0, usdtReceivedPhase2, 0, Constants.CURVE_DOLA_SUSDS
            );

            // sUSDS → DOLA
            ICurvePool(Constants.CURVE_DOLA_SUSDS).exchange_received(1, 0, susdsOut, 0, address(this));
            dolaAmount = IERC20(Constants.DOLA).balanceOf(address(this));

            // DOLA → wstUSR
            _safeTransfer(Constants.DOLA, Constants.CURVE_DOLA_WSTUSR, dolaAmount);
            ICurvePoolNoReceiver(Constants.CURVE_DOLA_WSTUSR).exchange_received(0, 1, dolaAmount, 0);

            // Pay WETH
            _safeTransfer(Constants.WETH, msg.sender, wethOwed);
        }
    }

    function _safeTransfer(address token, address to, uint256 amount) internal {
        (bool ok, bytes memory ret) = token.call(abi.encodeWithSelector(IERC20.transfer.selector, to, amount));
        require(ok && (ret.length == 0 || abi.decode(ret, (bool))), "transfer failed");
    }
}

// ── BotVMTest ──────────────────────────────────────────────────────

contract BotVMTest is Test {
    using BotVMEncoder for bytes;

    BotVM vm_;

    uint256 constant FLASH_AMOUNT = 3_533_486761808775726594;
    uint256 constant DEBT_AMOUNT_1 = 1_839_929_197;
    uint256 constant DEBT_AMOUNT_2 = 1_839_929_197;
    uint256 constant V4_TAKE_AMOUNT = 3679935364;
    uint256 constant V3_EXACT_OUTPUT = 3513427987;
    uint256 constant ORIGINAL_TX_WSTUSR_DELTA = 273_027_995_949_757_443_717;
    uint256 constant REPLAY_TOLERANCE = 300_000_000_000;

    function setUp() public {
        vm.createSelectFork(vm.envString("MAINNET_RPC_URL"), Constants.FORK_BLOCK);
        vm_ = new BotVM();
    }

    // ── Basic Opcode Tests ─────────────────────────────────────────

    function testSimpleCall() public view {
        bytes memory script = BotVMEncoder.encodeCall(
            Constants.WSTUSER,
            abi.encodeWithSelector(IERC20.balanceOf.selector, Constants.MORPHO)
        );

        (bool ok,) = address(vm_).staticcall(abi.encodeWithSelector(BotVM.execute.selector, script));
        assertTrue(ok, "simple call should succeed");
    }

    function testMultiCall() public {
        bytes memory script = BotVMEncoder.encodeCall(
            Constants.WSTUSER,
            abi.encodeWithSelector(IERC20.approve.selector, address(0xdead), 100)
        );
        script = script.concat(BotVMEncoder.encodeCall(
            Constants.USDC,
            abi.encodeWithSelector(IERC20.approve.selector, address(0xdead), 200)
        ));

        vm_.execute(script);
        assertEq(IERC20(Constants.WSTUSER).allowance(address(vm_), address(0xdead)), 100);
        assertEq(IERC20(Constants.USDC).allowance(address(vm_), address(0xdead)), 200);
    }

    function testRevertOpcode() public {
        bytes memory script = BotVMEncoder.encodeRevert(abi.encodePacked("boom"));

        vm.expectRevert();
        vm_.execute(script);
    }

    function testInvalidOpcode() public {
        bytes memory script = abi.encodePacked(uint8(0xFF));

        vm.expectRevert("invalid opcode");
        vm_.execute(script);
    }

    function testCallFailureReverts() public {
        bytes memory script = BotVMEncoder.encodeCall(
            Constants.MORPHO,
            abi.encodeWithSignature("flashLoan(address,uint256,bytes)", address(0), 0, "")
        );

        vm.expectRevert("call failed");
        vm_.execute(script);
    }

    // ── Callback Resume Test ───────────────────────────────────────

    function testCallbackResumeMorpho() public {
        uint256 loanAmount = 1e18;

        bytes memory subScript = BotVMEncoder.encodeCall(
            Constants.WSTUSER,
            abi.encodeWithSelector(IERC20.approve.selector, Constants.MORPHO, loanAmount)
        );

        bytes memory topScript = BotVMEncoder.encodeSetField2(100);
        topScript = topScript.concat(BotVMEncoder.encodeCall(
            Constants.MORPHO,
            abi.encodeWithSelector(
                IMorpho.flashLoan.selector,
                Constants.WSTUSER,
                loanAmount,
                subScript
            )
        ));
        topScript = topScript.concat(BotVMEncoder.encodeClearState());

        vm_.execute(topScript);
        assertEq(IERC20(Constants.WSTUSER).balanceOf(address(vm_)), 0);
    }

    // ── Full wstUSR Arb Replay ─────────────────────────────────────

    function testReplayWstUSRArb() public {
        vm.rollFork(Constants.ORIGINAL_TX_HASH);

        // Phase 1: Simulate with CaptureArb to get intermediate values
        uint256 snap = vm.snapshot();

        CaptureArb capturer = new CaptureArb();
        capturer.capture(FLASH_AMOUNT, DEBT_AMOUNT_1, DEBT_AMOUNT_2, V4_TAKE_AMOUNT, V3_EXACT_OUTPUT);

        uint256 capDaiAmount = capturer.daiAmount();
        uint256 capUsdtReceived = capturer.usdtReceivedPhase2();
        uint256 capWethOwed = capturer.wethOwed();
        uint256 capSusdsOut = capturer.susdsOut();
        uint256 capDolaAmount = capturer.dolaAmount();

        emit log_named_decimal_uint("Captured daiAmount", capDaiAmount, 18);
        emit log_named_uint("Captured usdtReceived", capUsdtReceived);
        emit log_named_uint("Captured wethOwed", capWethOwed);
        emit log_named_uint("Captured susdsOut", capSusdsOut);
        emit log_named_uint("Captured dolaAmount", capDolaAmount);

        vm.revertTo(snap);

        // Phase 2: Build script using extracted BotVMScriptBuilder
        BotVM botvm = new BotVM();
        bytes memory script = BotVMScriptBuilder.buildWstUsrArbScript(
            WstUsrArbParams({
                flashAmount: FLASH_AMOUNT,
                debtAmount1: DEBT_AMOUNT_1,
                debtAmount2: DEBT_AMOUNT_2,
                v4TakeAmount: V4_TAKE_AMOUNT,
                v3ExactOutput: V3_EXACT_OUTPUT,
                daiAmount: capDaiAmount,
                usdtReceived: capUsdtReceived,
                wethOwed: capWethOwed,
                susdsOut: capSusdsOut,
                dolaAmount: capDolaAmount,
                minProfit: 100e18
            }),
            address(botvm)
        );

        botvm.execute(script);

        uint256 wstUsrProfit = IERC20(Constants.WSTUSER).balanceOf(address(botvm));
        uint256 wethProfit = IERC20(Constants.WETH).balanceOf(address(botvm));

        emit log_named_decimal_uint("VM wstUSR profit", wstUsrProfit, 18);
        emit log_named_decimal_uint("VM WETH profit", wethProfit, 18);

        assertApproxEqAbs(
            wstUsrProfit, ORIGINAL_TX_WSTUSR_DELTA, REPLAY_TOLERANCE,
            "VM replay should match original tx wstUSR delta"
        );
    }

    // ── ASSERT_BALANCE_GTE Tests ───────────────────────────────────

    function testAssertBalanceGtePass() public {
        // Morpho holds plenty of wstUSR; asserting against a tiny threshold passes.
        bytes memory script = BotVMEncoder.encodeAssertBalanceGte(Constants.WSTUSER, 0);
        vm_.execute(script);
    }

    function testAssertBalanceGteFail() public {
        // VM holds zero of any token; threshold = 1 wei must revert.
        bytes memory script = BotVMEncoder.encodeAssertBalanceGte(Constants.WSTUSER, 1);
        vm.expectRevert("min profit");
        vm_.execute(script);
    }

    function testReplayWstUSRArbFailsOnHighMinProfit() public {
        vm.rollFork(Constants.ORIGINAL_TX_HASH);

        // Real profit is ~273 wstUSR; demand 10_000 wstUSR to force revert.
        uint256 snap = vm.snapshot();
        CaptureArb capturer = new CaptureArb();
        capturer.capture(FLASH_AMOUNT, DEBT_AMOUNT_1, DEBT_AMOUNT_2, V4_TAKE_AMOUNT, V3_EXACT_OUTPUT);
        uint256 capDaiAmount = capturer.daiAmount();
        uint256 capUsdtReceived = capturer.usdtReceivedPhase2();
        uint256 capWethOwed = capturer.wethOwed();
        uint256 capSusdsOut = capturer.susdsOut();
        uint256 capDolaAmount = capturer.dolaAmount();
        vm.revertTo(snap);

        BotVM botvm = new BotVM();
        bytes memory script = BotVMScriptBuilder.buildWstUsrArbScript(
            WstUsrArbParams({
                flashAmount: FLASH_AMOUNT,
                debtAmount1: DEBT_AMOUNT_1,
                debtAmount2: DEBT_AMOUNT_2,
                v4TakeAmount: V4_TAKE_AMOUNT,
                v3ExactOutput: V3_EXACT_OUTPUT,
                daiAmount: capDaiAmount,
                usdtReceived: capUsdtReceived,
                wethOwed: capWethOwed,
                susdsOut: capSusdsOut,
                dolaAmount: capDolaAmount,
                minProfit: 10_000e18
            }),
            address(botvm)
        );

        vm.expectRevert();
        botvm.execute(script);

        // Flash loan must have unwound — VM still holds nothing.
        assertEq(IERC20(Constants.WSTUSER).balanceOf(address(botvm)), 0);
    }
}
