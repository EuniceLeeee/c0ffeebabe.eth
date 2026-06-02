// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import {FlashArb, ArbParams} from "../src/FlashArb.sol";
import {Constants} from "../src/Constants.sol";
import {IERC20} from "../src/interfaces/IERC20.sol";

contract WstUSRArbTest is Test {
    FlashArb arb;

    uint256 constant FLASH_AMOUNT = 3_533_486761808775726594; // 3,533.49 wstUSR
    uint256 constant ORIGINAL_TX_WSTUSR_DELTA = 273_027_995_949_757_443_717; // # codex修改
    uint256 constant CUSTOM_REPLAY_WSTUSR_TOLERANCE = 300_000_000_000; // # codex修改
    uint256 constant END_BLOCK_WSTUSR_DELTA = 270_096_803_239_981_276_728; // # codex修改
    uint256 constant FORK_BLOCK_MAX_WSTUSR_PROFIT = 1e15; // # codex修改

    // Reference tx: each half borrows 1,839,929,197 USDC (6 decimals = 1,839.93 USDC)
    uint256 constant DEBT_AMOUNT_1 = 1_839_929_197;
    uint256 constant DEBT_AMOUNT_2 = 1_839_929_197;
    uint256 constant V4_TAKE_AMOUNT = 3679935364;
    uint256 constant V3_EXACT_OUTPUT = 3513427987;

    function _defaultParams() internal pure returns (ArbParams memory) {
        return ArbParams({
            debtAmount1: DEBT_AMOUNT_1,
            debtAmount2: DEBT_AMOUNT_2,
            v4TakeAmount: V4_TAKE_AMOUNT,
            v3ExactOutput: V3_EXACT_OUTPUT,
            curveMinWstUsr: 0,
            minProfitWstUsr: 0
        });
    }

    function setUp() public {
        vm.createSelectFork(vm.envString("MAINNET_RPC_URL"), Constants.FORK_BLOCK);
        arb = new FlashArb();
    }

    function testForkState() public view {
        uint8 wstUsrDecimals = IERC20(Constants.WSTUSER).decimals();
        uint8 usdcDecimals = IERC20(Constants.USDC).decimals();

        assertEq(wstUsrDecimals, 18, "wstUSR should be 18 decimals");
        assertEq(usdcDecimals, 6, "USDC should be 6 decimals");

        uint256 morphoBalance = IERC20(Constants.WSTUSER).balanceOf(Constants.MORPHO);
        assertGt(morphoBalance, FLASH_AMOUNT, "Morpho should have enough wstUSR");
    }

    function testTraceOriginalBotEndBlockBalance() public {
        address bot = Constants.ORIGINAL_MEV_BOT;

        uint256 wstUsrBefore = IERC20(Constants.WSTUSER).balanceOf(bot);
        uint256 usdcBefore = IERC20(Constants.USDC).balanceOf(bot);

        emit log_named_uint("Bot wstUSR before", wstUsrBefore);
        emit log_named_uint("Bot USDC before", usdcBefore);

        vm.rollFork(Constants.TARGET_BLOCK);

        uint256 wstUsrAfter = IERC20(Constants.WSTUSER).balanceOf(bot);
        uint256 usdcAfter = IERC20(Constants.USDC).balanceOf(bot);
        uint256 wstUsrDelta = wstUsrAfter - wstUsrBefore; // # codex修改

        emit log_named_uint("Bot wstUSR after", wstUsrAfter);
        emit log_named_uint("Bot USDC after", usdcAfter);
        emit log_named_uint("End-block wstUSR delta", wstUsrDelta); // # codex修改

        assertEq(wstUsrDelta, END_BLOCK_WSTUSR_DELTA, "end-block balance delta changed"); // # codex修改
    }

    function testReplayAtForkBlockIsNotOriginalTxState() public { // # codex修改
        uint256 wstUsrBefore = IERC20(Constants.WSTUSER).balanceOf(address(arb));

        arb.execute(FLASH_AMOUNT, _defaultParams());

        uint256 wstUsrAfter = IERC20(Constants.WSTUSER).balanceOf(address(arb));
        uint256 wethProfit = IERC20(Constants.WETH).balanceOf(address(arb));
        uint256 wstUsrProfit = wstUsrAfter - wstUsrBefore;

        emit log_named_decimal_uint("Profit wstUSR", wstUsrProfit, 18);
        emit log_named_decimal_uint("Profit WETH", wethProfit, 18);

        assertLt(wstUsrProfit, FORK_BLOCK_MAX_WSTUSR_PROFIT, "fork block should not look like original tx"); // # codex修改
    }

    function testReplayWithOriginalPreState() public { // # codex修改
        vm.rollFork(Constants.ORIGINAL_TX_HASH); // # codex修改

        // Redeploy after rollFork so the local arb starts from the same pre-tx chain state. // # codex修改
        FlashArb arbPostDepeg = new FlashArb(); // # codex修改

        arbPostDepeg.execute(FLASH_AMOUNT, _defaultParams());

        uint256 wstUsrProfit = IERC20(Constants.WSTUSER).balanceOf(address(arbPostDepeg));
        uint256 wethProfit = IERC20(Constants.WETH).balanceOf(address(arbPostDepeg));

        emit log_named_decimal_uint("Profit wstUSR", wstUsrProfit, 18);
        emit log_named_decimal_uint("Profit WETH", wethProfit, 18);

        assertApproxEqAbs(wstUsrProfit, ORIGINAL_TX_WSTUSR_DELTA, CUSTOM_REPLAY_WSTUSR_TOLERANCE, "custom replay should match tx WSTUSR delta"); // # codex修改
    }

    function testMinProfitRevert() public {
        vm.rollFork(Constants.ORIGINAL_TX_HASH);
        FlashArb arbMinProfit = new FlashArb();

        ArbParams memory params = _defaultParams();
        params.minProfitWstUsr = 1_000_000e18; // 1M wstUSR — impossibly high

        vm.expectRevert("below min profit");
        arbMinProfit.execute(FLASH_AMOUNT, params);
    }

    function testMinProfitIgnoresExistingBalance() public { // # codex修改
        vm.rollFork(Constants.ORIGINAL_TX_HASH); // # codex修改
        FlashArb arbSeeded = new FlashArb(); // # codex修改
        deal(Constants.WSTUSER, address(arbSeeded), 1_000e18); // # codex修改

        ArbParams memory params = _defaultParams(); // # codex修改
        params.minProfitWstUsr = 500e18; // # codex修改

        vm.expectRevert("below min profit"); // # codex修改
        arbSeeded.execute(FLASH_AMOUNT, params); // # codex修改
    }

    function testCurveMinUsesCurrentRunOutput() public { // # codex修改
        vm.rollFork(Constants.ORIGINAL_TX_HASH); // # codex修改
        FlashArb arbSeeded = new FlashArb(); // # codex修改
        deal(Constants.WSTUSER, address(arbSeeded), 1_000e18); // # codex修改

        ArbParams memory params = _defaultParams(); // # codex修改
        params.curveMinWstUsr = 3_900e18; // # codex修改

        vm.expectRevert("curve slippage"); // # codex修改
        arbSeeded.execute(FLASH_AMOUNT, params); // # codex修改
    }

    function testExactReplay() public {
        vm.rollFork(Constants.ORIGINAL_TX_HASH); // # codex修改

        address bot = Constants.ORIGINAL_MEV_BOT;

        uint256 wstUsrBefore = IERC20(Constants.WSTUSER).balanceOf(bot);

        vm.transact(Constants.ORIGINAL_TX_HASH); // # codex修改

        uint256 wstUsrAfter = IERC20(Constants.WSTUSER).balanceOf(bot);
        uint256 wethAfter = IERC20(Constants.WETH).balanceOf(bot);
        uint256 wstUsrProfit = wstUsrAfter - wstUsrBefore;

        emit log_named_decimal_uint("Exact tx wstUSR delta", wstUsrProfit, 18); // # codex修改
        emit log_named_decimal_uint("Exact tx WETH balance", wethAfter, 18); // # codex修改

        assertEq(wstUsrProfit, ORIGINAL_TX_WSTUSR_DELTA, "Should match Tenderly tx WSTUSR delta"); // # codex修改
    }
}
