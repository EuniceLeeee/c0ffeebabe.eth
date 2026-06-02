// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import {BotVM} from "../src/BotVM.sol";
import {Constants} from "../src/Constants.sol";
import {IERC20} from "../src/interfaces/IERC20.sol";
import {IMorpho, IMorphoFlashLoanCallback} from "../src/interfaces/IMorpho.sol";
import {IFluidVault} from "../src/interfaces/IFluidVault.sol";
import {ISkyPSMLite, IUniswapV3Pool, ICurvePool, ICurvePoolNoReceiver, IPoolManager, PoolKey, SwapParams} from "../src/interfaces/ISwap.sol";

// ── ScriptEncoder ──────────────────────────────────────────────────
// Test helper: constructs packed opcode streams for BotVM.
// Each function returns raw bytes for one instruction; concat to build scripts.

library ScriptEncoder {
    /// @dev Opcode 0x00: CALL (no value)
    ///      Layout: [0x00][addr:20][payload_len:3][payload:N]
    function encodeCall(address target, bytes memory payload) internal pure returns (bytes memory) {
        return abi.encodePacked(
            uint8(0x00),
            target,
            uint24(payload.length),
            payload
        );
    }

    /// @dev Opcode 0x01: CALL (with value)
    ///      Layout: [0x01][addr:20][value:12][payload_len:3][payload:N]
    function encodeCallValue(address target, uint96 value, bytes memory payload) internal pure returns (bytes memory) {
        return abi.encodePacked(
            uint8(0x01),
            target,
            value,
            uint24(payload.length),
            payload
        );
    }

    /// @dev Opcode 0x02: SET_FIELD2
    ///      Layout: [0x02][field2:3]
    function encodeSetField2(uint24 offset) internal pure returns (bytes memory) {
        return abi.encodePacked(uint8(0x02), offset);
    }

    /// @dev Opcode 0x03: RETURN
    ///      Layout: [0x03][data_len:3][data:N]
    function encodeReturn(bytes memory data) internal pure returns (bytes memory) {
        return abi.encodePacked(uint8(0x03), uint24(data.length), data);
    }

    /// @dev Opcode 0x04: WETH_UNWRAP
    function encodeWethUnwrap() internal pure returns (bytes memory) {
        return abi.encodePacked(uint8(0x04));
    }

    /// @dev Opcode 0x05: CLEAR_STATE
    function encodeClearState() internal pure returns (bytes memory) {
        return abi.encodePacked(uint8(0x05));
    }

    /// @dev Opcode 0x06: SET_FIELD3
    ///      Layout: [0x06][field3:3]
    function encodeSetField3(uint24 offset) internal pure returns (bytes memory) {
        return abi.encodePacked(uint8(0x06), offset);
    }

    /// @dev Opcode 0x07: CLEAR_FIELD1
    function encodeClearField1() internal pure returns (bytes memory) {
        return abi.encodePacked(uint8(0x07));
    }

    /// @dev Opcode 0x0d: REVERT
    ///      Layout: [0x0d][data_len:3][data:N]
    function encodeRevert(bytes memory data) internal pure returns (bytes memory) {
        return abi.encodePacked(uint8(0x0d), uint24(data.length), data);
    }

    /// @dev Concatenate two byte arrays.
    function concat(bytes memory a, bytes memory b) internal pure returns (bytes memory) {
        return abi.encodePacked(a, b);
    }
}

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
    using ScriptEncoder for bytes;

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
        // Single CALL: balanceOf (read-only, return value discarded but call succeeds)
        bytes memory script = ScriptEncoder.encodeCall(
            Constants.WSTUSER,
            abi.encodeWithSelector(IERC20.balanceOf.selector, Constants.MORPHO)
        );

        // Just verify it doesn't revert
        // We can't check return value (opcode 0x00 discards it), but success = no revert
        // Use staticcall via vm to verify
        (bool ok,) = address(vm_).staticcall(abi.encodeWithSelector(BotVM.execute.selector, script));
        assertTrue(ok, "simple call should succeed");
    }

    function testMultiCall() public {
        // Two CALL opcodes: approve + approve (both succeed, no state dependency)
        bytes memory script = ScriptEncoder.encodeCall(
            Constants.WSTUSER,
            abi.encodeWithSelector(IERC20.approve.selector, address(0xdead), 100)
        );
        script = script.concat(ScriptEncoder.encodeCall(
            Constants.USDC,
            abi.encodeWithSelector(IERC20.approve.selector, address(0xdead), 200)
        ));

        vm_.execute(script);
        // Verify the approvals actually happened
        assertEq(IERC20(Constants.WSTUSER).allowance(address(vm_), address(0xdead)), 100);
        assertEq(IERC20(Constants.USDC).allowance(address(vm_), address(0xdead)), 200);
    }

    function testRevertOpcode() public {
        bytes memory script = ScriptEncoder.encodeRevert(abi.encodePacked("boom"));

        vm.expectRevert();
        vm_.execute(script);
    }

    function testInvalidOpcode() public {
        // Opcode 0xFF — not implemented
        bytes memory script = abi.encodePacked(uint8(0xFF));

        vm.expectRevert("invalid opcode");
        vm_.execute(script);
    }

    function testCallFailureReverts() public {
        // CALL to a non-contract address with some payload — will succeed (empty call)
        // But CALL to a contract that reverts should propagate
        bytes memory script = ScriptEncoder.encodeCall(
            Constants.MORPHO,
            abi.encodeWithSignature("flashLoan(address,uint256,bytes)", address(0), 0, "")
        );

        vm.expectRevert("call failed");
        vm_.execute(script);
    }

    // ── Callback Resume Test ───────────────────────────────────────

    function testCallbackResumeMorpho() public {
        // Minimal flash loan through VM:
        //   1. SET_FIELD2(100) — Morpho callback offset
        //   2. CALL Morpho.flashLoan(wstUSR, 1e18, sub_script)
        //   3. CLEAR_STATE
        //
        // sub_script (inside Morpho callback):
        //   1. CALL wstUSR.approve(Morpho, 1e18)
        //
        // This borrows 1 wstUSR, approves repayment, and returns.

        uint256 loanAmount = 1e18;

        // Build sub-script: just approve Morpho to pull the wstUSR back
        bytes memory subScript = ScriptEncoder.encodeCall(
            Constants.WSTUSER,
            abi.encodeWithSelector(IERC20.approve.selector, Constants.MORPHO, loanAmount)
        );

        // field2 = 100 for onMorphoFlashLoan(uint256, bytes)
        // ABI: selector(4) + uint256(32) + bytes_offset(32) + bytes_length(32) = 100
        bytes memory topScript = ScriptEncoder.encodeSetField2(100);
        topScript = topScript.concat(ScriptEncoder.encodeCall(
            Constants.MORPHO,
            abi.encodeWithSelector(
                IMorpho.flashLoan.selector,
                Constants.WSTUSER,
                loanAmount,
                subScript
            )
        ));
        topScript = topScript.concat(ScriptEncoder.encodeClearState());

        // Should succeed — borrow 1 wstUSR and repay it
        vm_.execute(topScript);

        // VM should have 0 wstUSR after (loan repaid)
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
        uint256 capWstUsrProfit = capturer.wstUsrProfit();

        emit log_named_decimal_uint("Captured daiAmount", capDaiAmount, 18);
        emit log_named_uint("Captured usdtReceived", capUsdtReceived);
        emit log_named_uint("Captured wethOwed", capWethOwed);
        emit log_named_uint("Captured susdsOut", capSusdsOut);
        emit log_named_uint("Captured dolaAmount", capDolaAmount);
        emit log_named_decimal_uint("Captured wstUSR profit", capWstUsrProfit, 18);

        vm.revertTo(snap);

        // Phase 2: Construct VM script with captured values and execute
        BotVM botvm = new BotVM();
        bytes memory script = _buildFullArbScript(IntermediateValues({
            executor: address(botvm),
            daiAmount: capDaiAmount,
            usdtReceived: capUsdtReceived,
            wethOwed: capWethOwed,
            susdsOut: capSusdsOut,
            dolaAmount: capDolaAmount
        }));

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

    // ── Script Builder ─────────────────────────────────────────────

    struct IntermediateValues {
        address executor;
        uint256 daiAmount;
        uint256 usdtReceived;
        uint256 wethOwed;
        uint256 susdsOut;
        uint256 dolaAmount;
    }

    /// @dev Build the full arb script for the VM. All intermediate values pre-computed.
    function _buildFullArbScript(IntermediateValues memory iv) internal pure returns (bytes memory) {
        // ── V3 phase 1 sub-script: pay USDT to V3 pool ──
        bytes memory v3Phase1Sub = ScriptEncoder.encodeCall(
            Constants.USDT,
            abi.encodeWithSelector(IERC20.transfer.selector, Constants.UNISWAP_V3_USDT_WETH, V4_TAKE_AMOUNT)
        );

        // ── V3 phase 2 sub-script: Curve chain + pay WETH ──
        bytes memory v3Phase2Sub = _buildCurveChainScript(iv);

        // ── V4 sub-script (inside unlockCallback) ──
        bytes memory v4Sub = _buildV4SubScript(iv.executor, iv.daiAmount, v3Phase1Sub);

        // ── Morpho sub-script (inside onMorphoFlashLoan) ──
        bytes memory morphoSub = _buildMorphoSubScript(iv.executor, iv.daiAmount, v4Sub, v3Phase2Sub);

        // ── Top-level script ──
        // SET_FIELD2(100) → CALL Morpho.flashLoan → CLEAR_STATE
        bytes memory top = ScriptEncoder.encodeSetField2(100);
        top = top.concat(ScriptEncoder.encodeCall(
            Constants.MORPHO,
            abi.encodeWithSelector(
                IMorpho.flashLoan.selector,
                Constants.WSTUSER,
                FLASH_AMOUNT,
                morphoSub
            )
        ));
        top = top.concat(ScriptEncoder.encodeClearState());

        return top;
    }

    function _buildMorphoSubScript(
        address executor,
        uint256 daiAmount,
        bytes memory v4Sub,
        bytes memory v3Phase2Sub
    ) internal pure returns (bytes memory) {
        uint256 half = FLASH_AMOUNT / 2;
        uint256 otherHalf = FLASH_AMOUNT - half;
        uint256 totalUsdc = DEBT_AMOUNT_1 + DEBT_AMOUNT_2;
        bytes memory s;

        // 1. Approve wstUSR for Fluid vault
        s = ScriptEncoder.encodeCall(
            Constants.WSTUSER,
            abi.encodeWithSelector(IERC20.approve.selector, Constants.FLUID_VAULT_WSTUSER_USDC, FLASH_AMOUNT)
        );

        // 2. Approve USDC for Sky PSM
        s = s.concat(ScriptEncoder.encodeCall(
            Constants.USDC,
            abi.encodeWithSelector(IERC20.approve.selector, Constants.SKY_PSM_LITE, type(uint256).max)
        ));

        // 3. Fluid position #1
        s = s.concat(ScriptEncoder.encodeCall(
            Constants.FLUID_VAULT_WSTUSER_USDC,
            abi.encodeWithSelector(
                IFluidVault.operate.selector,
                uint256(0), int256(half), int256(DEBT_AMOUNT_1), executor
            )
        ));

        // 4. Fluid position #2
        s = s.concat(ScriptEncoder.encodeCall(
            Constants.FLUID_VAULT_WSTUSER_USDC,
            abi.encodeWithSelector(
                IFluidVault.operate.selector,
                uint256(0), int256(otherHalf), int256(DEBT_AMOUNT_2), executor
            )
        ));

        // 5. USDC → DAI via PSM
        s = s.concat(ScriptEncoder.encodeCall(
            Constants.SKY_PSM_LITE,
            abi.encodeWithSelector(ISkyPSMLite.sellGem.selector, executor, totalUsdc)
        ));

        // 6. SET_FIELD2(68) for V4 unlockCallback
        s = s.concat(ScriptEncoder.encodeSetField2(68));

        // 7. CALL V4 PM unlock — carries v4Sub script
        s = s.concat(ScriptEncoder.encodeCall(
            Constants.UNISWAP_V4_POOL_MANAGER,
            abi.encodeWithSelector(IPoolManager.unlock.selector, v4Sub)
        ));

        // 8. CLEAR_STATE after V4 callback
        s = s.concat(ScriptEncoder.encodeClearState());

        // 9. SET_FIELD2(132) for V3 phase 2 callback
        s = s.concat(ScriptEncoder.encodeSetField2(132));

        // 10. CALL V3 swap #2: WETH→USDT (exactOutput)
        s = s.concat(ScriptEncoder.encodeCall(
            Constants.UNISWAP_V3_USDT_WETH,
            abi.encodeWithSelector(
                IUniswapV3Pool.swap.selector,
                executor,               // recipient
                true,                    // zeroForOne (WETH→USDT)
                -int256(V3_EXACT_OUTPUT),// exactOutput
                uint160(4295128740),     // MIN_SQRT_PRICE
                v3Phase2Sub              // data = Curve chain script
            )
        ));

        // 11. CLEAR_STATE after V3 callback
        s = s.concat(ScriptEncoder.encodeClearState());

        // 12. Approve Morpho for flash loan repayment
        s = s.concat(ScriptEncoder.encodeCall(
            Constants.WSTUSER,
            abi.encodeWithSelector(IERC20.approve.selector, Constants.MORPHO, FLASH_AMOUNT)
        ));

        return s;
    }

    function _buildV4SubScript(
        address executor,
        uint256 daiAmount,
        bytes memory v3Phase1Sub
    ) internal pure returns (bytes memory) {
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
            amountSpecified: -int256(daiAmount),
            sqrtPriceLimitX96: 4295128740 // MIN_SQRT_PRICE
        });
        s = ScriptEncoder.encodeCall(
            Constants.UNISWAP_V4_POOL_MANAGER,
            abi.encodeWithSelector(IPoolManager.swap.selector, key, params, "")
        );

        // 2. Take USDT from V4
        s = s.concat(ScriptEncoder.encodeCall(
            Constants.UNISWAP_V4_POOL_MANAGER,
            abi.encodeWithSelector(IPoolManager.take.selector, Constants.USDT, executor, V4_TAKE_AMOUNT)
        ));

        // 3. SET_FIELD2(132) for V3 phase 1 callback
        s = s.concat(ScriptEncoder.encodeSetField2(132));

        // 4. V3 swap #1: USDT→WETH (exactInput)
        s = s.concat(ScriptEncoder.encodeCall(
            Constants.UNISWAP_V3_USDT_WETH,
            abi.encodeWithSelector(
                IUniswapV3Pool.swap.selector,
                executor,
                false,                               // not zeroForOne (USDT→WETH)
                int256(V4_TAKE_AMOUNT),               // exactInput
                uint160(1461446703485210103287273052203988822378723970341), // MAX_SQRT_PRICE
                v3Phase1Sub
            )
        ));

        // 5. CLEAR_STATE after V3 callback
        s = s.concat(ScriptEncoder.encodeClearState());

        // 6. Sync DAI with V4
        s = s.concat(ScriptEncoder.encodeCall(
            Constants.UNISWAP_V4_POOL_MANAGER,
            abi.encodeWithSelector(IPoolManager.sync.selector, Constants.DAI)
        ));

        // 7. Transfer DAI to V4 PM for settlement
        s = s.concat(ScriptEncoder.encodeCall(
            Constants.DAI,
            abi.encodeWithSelector(IERC20.transfer.selector, Constants.UNISWAP_V4_POOL_MANAGER, daiAmount)
        ));

        // 8. V4 settle
        s = s.concat(ScriptEncoder.encodeCall(
            Constants.UNISWAP_V4_POOL_MANAGER,
            abi.encodeWithSelector(IPoolManager.settle.selector)
        ));

        // 9. RETURN("") — V4 unlock must return bytes
        s = s.concat(ScriptEncoder.encodeReturn(abi.encode("")));

        return s;
    }

    function _buildCurveChainScript(IntermediateValues memory iv) internal pure returns (bytes memory) {
        bytes memory s;

        // 1. Transfer USDT to Curve sUSDS/USDT pool
        s = ScriptEncoder.encodeCall(
            Constants.USDT,
            abi.encodeWithSelector(IERC20.transfer.selector, Constants.CURVE_SUSDS_USDT, iv.usdtReceived)
        );

        // 2. USDT → sUSDS (coin[1]→coin[0]), output to DOLA/sUSDS pool
        s = s.concat(ScriptEncoder.encodeCall(
            Constants.CURVE_SUSDS_USDT,
            abi.encodeWithSelector(
                ICurvePool.exchange_received.selector,
                int128(1), int128(0), iv.usdtReceived, uint256(0), Constants.CURVE_DOLA_SUSDS
            )
        ));

        // 3. sUSDS → DOLA (coin[1]→coin[0]), output to executor
        s = s.concat(ScriptEncoder.encodeCall(
            Constants.CURVE_DOLA_SUSDS,
            abi.encodeWithSelector(
                ICurvePool.exchange_received.selector,
                int128(1), int128(0), iv.susdsOut, uint256(0), iv.executor
            )
        ));

        // 4. Transfer DOLA to Curve DOLA/wstUSR pool
        s = s.concat(ScriptEncoder.encodeCall(
            Constants.DOLA,
            abi.encodeWithSelector(IERC20.transfer.selector, Constants.CURVE_DOLA_WSTUSR, iv.dolaAmount)
        ));

        // 5. DOLA → wstUSR (coin[0]→coin[1]), no receiver param
        s = s.concat(ScriptEncoder.encodeCall(
            Constants.CURVE_DOLA_WSTUSR,
            abi.encodeWithSelector(
                ICurvePoolNoReceiver.exchange_received.selector,
                int128(0), int128(1), iv.dolaAmount, uint256(0)
            )
        ));

        // 6. Pay WETH to V3 pool
        s = s.concat(ScriptEncoder.encodeCall(
            Constants.WETH,
            abi.encodeWithSelector(IERC20.transfer.selector, Constants.UNISWAP_V3_USDT_WETH, iv.wethOwed)
        ));

        return s;
    }
}
