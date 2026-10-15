// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import "forge-std/Test.sol";
import {BotVM} from "../src/BotVM.sol";
import {CurveRecipientToken, CurveRecipientPool, CurveRecipientWrapped, CurveNativeRecipientPool} from "./CurvePlainRecipient.t.sol";
contract UnderlyingRecipientPool is CurveRecipientPool {
    function exchange_underlying(uint256 i,uint256 j,uint256 dx,uint256 minDy) external returns(uint256) { return swap(i,j,dx,minDy,msg.sender,false); }
    function exchange_underlying(uint256 i,uint256 j,uint256 dx,uint256 minDy,address receiver) external returns(uint256) { return swap(i,j,dx,minDy,receiver,false); }
}
contract UnderlyingNativeRecipientPool is CurveNativeRecipientPool {
    function exchange_underlying(uint256 i,uint256 j,uint256 dx,uint256 minDy) external payable returns(uint256) { return swap(i,j,dx,minDy,msg.sender); }
    function exchange_underlying(uint256 i,uint256 j,uint256 dx,uint256 minDy,address receiver) external payable returns(uint256) { return swap(i,j,dx,minDy,receiver); }
}
contract CurveUnderlyingRecipientTest is Test {
    address constant ACTOR = address(71);
    address constant TARGET = address(81);
    address constant RECEIVER = address(91);
    uint256 constant STOCK = 777;
    string[1] modes = ["uint"];
    function setUp() public {
        vm.etch(ACTOR, address(new BotVM()).code);
        bytes memory code = address(new CurveRecipientToken()).code;
        vm.etch(address(83), code); vm.etch(address(84), code);
        vm.etch(TARGET, address(new UnderlyingRecipientPool()).code);
    }
    function token(uint256 i) internal pure returns (CurveRecipientToken) { return CurveRecipientToken(address(uint160(83 + i))); }
    function setBalance(uint256 i, address actor, uint256 amount) internal { vm.store(address(token(i)), keccak256(abi.encode(actor, uint256(0))), bytes32(amount)); }
    function prepare(uint256 i, uint256 amount, uint256 fault) internal {
        for (uint256 k; k < 2; ++k) {
            setBalance(k, ACTOR, STOCK + (k == i ? amount : 0)); setBalance(k, RECEIVER, 109);
            setBalance(k, TARGET, 10000); setBalance(k, address(92), 0);
            token(k).configure(false);
            vm.prank(ACTOR); token(k).approve(TARGET, 0);
        }
        vm.deal(ACTOR, 17); vm.deal(TARGET, 100); vm.deal(RECEIVER, 23);
        CurveRecipientPool(payable(TARGET)).configure(fault);
    }
    function script(uint256 mode, uint256 i, string memory kind, uint256 amount) internal view returns (bytes memory) {
        return vm.envBytes(string.concat("CURVE_RECIPIENT_", modes[mode], "_", vm.toString(i), "_", kind, "_", vm.toString(amount)));
    }
    function run(uint256 mode, uint256 i, string memory kind, uint256 amount) internal { BotVM(payable(ACTOR)).execute(script(mode, i, kind, amount)); }
    function assertBalances(uint256 i, uint256 amount, bool externalRecipient) internal view {
        assertEq(token(i).balanceOf(ACTOR), STOCK);
        assertEq(token(1 - i).balanceOf(ACTOR), STOCK + (externalRecipient ? 0 : amount * 2));
        assertEq(token(i).balanceOf(RECEIVER), 109);
        assertEq(token(1 - i).balanceOf(RECEIVER), 109 + (externalRecipient ? amount * 2 : 0));
        assertEq(token(i).balanceOf(TARGET), 10000 + amount);
        assertEq(token(1 - i).balanceOf(TARGET), 10000 - amount * 2);
        assertEq(ACTOR.balance, 17); assertEq(RECEIVER.balance, 23);
    }
    function testBothDirectionsAllModesDefaultSelfAndExternal() public {
        for (uint256 m; m < 1; ++m) for (uint256 i; i < 2; ++i) for (uint256 k; k < 3; ++k) {
            for (uint256 a; a < 2; ++a) {
                uint256 amount = a == 0 ? 1 : 100;
                prepare(i, amount, 0); run(m, i, k == 0 ? "default" : k == 1 ? "self" : "external", amount);
                assertBalances(i, amount, k == 2);
                assertEq(token(i).allowance(ACTOR, TARGET), 0);
            }
        }
    }
    function testDirectRejectsDebitReceiptInventoryAndNativeFaultsAtomically() public {
        for (uint256 m; m < 1; ++m) for (uint256 i; i < 2; ++i) for (uint256 f = 1; f <= 9; ++f) {
            if (m >= 2 && f == 9) continue; // received mode makes no approval
            prepare(i, 100, f); bytes memory program = script(m, i, "external", 100);
            vm.expectRevert(); BotVM(payable(ACTOR)).execute(program);
            assertEq(token(i).balanceOf(ACTOR), STOCK + 100); assertEq(token(1 - i).balanceOf(ACTOR), STOCK);
            assertEq(token(i).balanceOf(RECEIVER), 109); assertEq(token(1 - i).balanceOf(RECEIVER), 109);
            assertEq(token(i).balanceOf(TARGET), 10000); assertEq(token(1 - i).balanceOf(TARGET), 10000);
            assertEq(token(i).allowance(ACTOR, TARGET), 0); assertEq(ACTOR.balance, 17);
            assertEq(TARGET.balance, 100); assertEq(CurveRecipientPool(payable(TARGET)).calls(), 0);
        }
    }
    function testDirectZeroInputCannotUseOldInventory() public {
        for (uint256 m; m < 1; ++m) for (uint256 i; i < 2; ++i) {
            prepare(i, 0, 0); bytes memory program = script(m, i, "external", 0);
            vm.expectRevert(); BotVM(payable(ACTOR)).execute(program);
            assertEq(token(i).balanceOf(ACTOR), STOCK); assertEq(CurveRecipientPool(payable(TARGET)).calls(), 0);
        }
    }
    function testReturnDataCannotReplaceActualReceipt() public {
        for (uint256 m; m < 1; ++m) for (uint256 i; i < 2; ++i) for (uint256 f = 10; f <= 11; ++f) {
            prepare(i, 100, f); run(m, i, "external", 100); assertBalances(i, 100, true);
            assertEq(token(i).allowance(ACTOR, TARGET), 0);
        }
    }
}
contract CurveUnderlyingNativeRecipientTest is Test {
    address constant ACTOR = address(71);
    address constant TARGET = address(81);
    address constant RECEIVER = address(91);
    address constant WETH = 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2;
    uint256 constant STOCK = 777;
    string[2] modes = ["nativeUint", "nativeLegacy"];
    function setUp() public {
        vm.etch(ACTOR, address(new BotVM()).code);
        vm.etch(WETH, address(new CurveRecipientWrapped()).code);
        vm.etch(address(84), address(new CurveRecipientToken()).code);
        vm.etch(TARGET, address(new UnderlyingNativeRecipientPool()).code);
    }
    function token(uint256 i) internal pure returns (CurveRecipientToken) { return CurveRecipientToken(i == 0 ? WETH : address(84)); }
    function setBalance(uint256 i, address actor, uint256 amount) internal { vm.store(address(token(i)), keccak256(abi.encode(actor, uint256(0))), bytes32(amount)); }
    function prepare(uint256 i, uint256 amount, uint256 fault) internal {
        for (uint256 k; k < 2; ++k) {
            setBalance(k, ACTOR, STOCK + (k == i ? amount : 0)); setBalance(k, RECEIVER, 109);
            setBalance(k, TARGET, 10000); setBalance(k, address(92), 0); token(k).configure(false);
            vm.prank(ACTOR); token(k).approve(TARGET, 0);
        }
        vm.deal(ACTOR, 17); vm.deal(TARGET, 10000); vm.deal(RECEIVER, 23); vm.deal(address(92), 0); vm.deal(WETH, 10000);
        UnderlyingNativeRecipientPool(payable(TARGET)).configure(fault);
    }
    function script(uint256 m, uint256 i, string memory kind, uint256 amount) internal view returns (bytes memory) {
        return vm.envBytes(string.concat("CURVE_RECIPIENT_", modes[m], "_", vm.toString(i), "_", kind, "_", vm.toString(amount)));
    }
    function testNativeDefaultSelfExternalAndLegacyOutputUseCommonBoundary() public {
        for (uint256 m; m < 2; ++m) for (uint256 i; i < 2; ++i) for (uint256 k; k < 3; ++k) {
            if (m == 1 && i == 0 && k != 0) continue;
            for (uint256 a; a < 2; ++a) {
                uint256 amount = a == 0 ? 1 : 100; prepare(i, amount, 0);
                BotVM(payable(ACTOR)).execute(script(m, i, k == 0 ? "default" : k == 1 ? "self" : "external", amount));
                assertEq(token(i).balanceOf(ACTOR), STOCK);
                assertEq(token(1 - i).balanceOf(ACTOR), STOCK + (k == 2 ? 0 : amount * 2));
                assertEq(token(i).balanceOf(RECEIVER), 109);
                assertEq(token(1 - i).balanceOf(RECEIVER), 109 + (k == 2 ? amount * 2 : 0));
                assertEq(token(1).allowance(ACTOR, TARGET), 0); assertEq(ACTOR.balance, 17); assertEq(RECEIVER.balance, 23);
                assertEq(TARGET.balance, i == 0 ? 10000 + amount : 10000 - amount * 2);
            }
        }
    }
    function testNativeDirectRejectsFaultsAndRollsBack() public {
        for (uint256 m; m < 2; ++m) for (uint256 i; i < 2; ++i) for (uint256 f = 1; f <= 9; ++f) {
            if (m == 1 && i == 0 || i == 0 && f == 9 || i == 1 && f == 8) continue;
            // Extra native output is real measured receipt, not a debit/refund error.
            prepare(i, 100, f); bytes memory program = script(m, i, "external", 100);
            vm.expectRevert(); BotVM(payable(ACTOR)).execute(program);
            assertEq(token(i).balanceOf(ACTOR), STOCK + 100); assertEq(token(1 - i).balanceOf(ACTOR), STOCK);
            assertEq(token(i).balanceOf(RECEIVER), 109); assertEq(token(1 - i).balanceOf(RECEIVER), 109);
            assertEq(token(1).allowance(ACTOR, TARGET), 0); assertEq(ACTOR.balance, 17); assertEq(RECEIVER.balance, 23);
            assertEq(TARGET.balance, 10000); assertEq(UnderlyingNativeRecipientPool(payable(TARGET)).calls(), 0);
        }
    }
    function testNativeDirectZeroAndIgnoredReturnData() public {
        for (uint256 m; m < 2; ++m) for (uint256 i; i < 2; ++i) {
            if (m == 1 && i == 0) continue;
            prepare(i, 0, 0); bytes memory program = script(m, i, "external", 0);
            vm.expectRevert(); BotVM(payable(ACTOR)).execute(program);
            assertEq(UnderlyingNativeRecipientPool(payable(TARGET)).calls(), 0);
            prepare(i, 100, 10); BotVM(payable(ACTOR)).execute(script(m, i, "external", 100));
            assertEq(token(i).balanceOf(ACTOR), STOCK); assertEq(token(1 - i).balanceOf(RECEIVER), 309);
        }
    }
}
