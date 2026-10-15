// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import {Test} from "forge-std/Test.sol";
import {BotVM} from "../src/BotVM.sol";
import {CurveRecipientToken, CurveRecipientWrapped, CurveNativeRecipientPool} from "./CurvePlainRecipient.t.sol";
contract EkuboRecipientRouter is CurveNativeRecipientPool {
    struct PoolKey { address token0; address token1; bytes32 config; }
    function swap(PoolKey calldata key, bool isToken1, int128 amount, uint96 limit, uint256 skip, int256 minimum, address recipient)
        external payable returns (bytes32) {
        require(key.token0 == address(0) && key.token1 == address(84) && amount > 0 && minimum > 0 && limit == 0 && skip == 0);
        uint256 i = isToken1 ? 1 : 0;
        return bytes32(super.swap(i, 1 - i, uint256(uint128(amount)), uint256(minimum), recipient));
    }
}
contract EkuboNativeRecipientTest is Test {
    address constant ACTOR = address(71);
    address constant TARGET = address(bytes20(hex"d26f20001a72a18c002b00e6710000d68700ce00"));
    address constant RECEIVER = address(91);
    address constant WETH = 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2;
    uint256 constant STOCK = 777;
    string[2] modes = ["vanilla", "twamm"];
    function setUp() public {
        vm.etch(ACTOR, address(new BotVM()).code);
        vm.etch(WETH, address(new CurveRecipientWrapped()).code);
        vm.etch(address(84), address(new CurveRecipientToken()).code);
        vm.etch(TARGET, address(new EkuboRecipientRouter()).code);
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
        CurveNativeRecipientPool(payable(TARGET)).configure(fault);
    }
    function script(uint256 m, uint256 i, string memory kind, uint256 amount) internal view returns (bytes memory) {
        return vm.envBytes(string.concat("EKUBO_RECIPIENT_", modes[m], "_", vm.toString(i), "_", kind, "_", vm.toString(amount)));
    }
    function testNativeDefaultSelfExternalUseCommonBoundary() public {
        for (uint256 m; m < 2; ++m) for (uint256 i; i < 2; ++i) for (uint256 k; k < 3; ++k) {

            for (uint256 a; a < 2; ++a) {
                uint256 amount = a == 0 ? 1 : 100; prepare(i, amount, 0);
                BotVM(payable(ACTOR)).execute(script(m, i, k == 0 ? "default" : k == 1 ? "self" : "external", amount));
                assertEq(token(i).balanceOf(ACTOR), STOCK);
                assertEq(token(1 - i).balanceOf(ACTOR), STOCK + (k == 2 ? 0 : amount * 2));
                assertEq(token(i).balanceOf(RECEIVER), 109);
                assertEq(token(1 - i).balanceOf(RECEIVER), 109 + (k == 2 ? amount * 2 : 0));
                assertEq(token(1).allowance(ACTOR, TARGET), i == 1 && k == 0 ? type(uint256).max - amount : 0); assertEq(ACTOR.balance, 17); assertEq(RECEIVER.balance, 23);
                assertEq(TARGET.balance, i == 0 ? 10000 + amount : 10000 - amount * 2);
            }
        }
    }
    function testNativeDirectRejectsFaultsAndRollsBack() public {
        for (uint256 m; m < 2; ++m) for (uint256 i; i < 2; ++i) for (uint256 f = 1; f <= 9; ++f) {
            if (i == 0 && f == 9 || i == 1 && f == 8) continue;
            // Extra native output is real measured receipt, not a debit/refund error.
            prepare(i, 100, f); bytes memory program = script(m, i, "external", 100);
            vm.expectRevert(); BotVM(payable(ACTOR)).execute(program);
            assertEq(token(i).balanceOf(ACTOR), STOCK + 100); assertEq(token(1 - i).balanceOf(ACTOR), STOCK);
            assertEq(token(i).balanceOf(RECEIVER), 109); assertEq(token(1 - i).balanceOf(RECEIVER), 109);
            assertEq(token(1).allowance(ACTOR, TARGET), 0); assertEq(ACTOR.balance, 17); assertEq(RECEIVER.balance, 23);
            assertEq(TARGET.balance, 10000); assertEq(CurveNativeRecipientPool(payable(TARGET)).calls(), 0);
        }
    }
    function testNativeDirectZeroAndIgnoredReturnData() public {
        for (uint256 m; m < 2; ++m) for (uint256 i; i < 2; ++i) {

            prepare(i, 0, 0); bytes memory program = script(m, i, "external", 0);
            vm.expectRevert(); BotVM(payable(ACTOR)).execute(program);
            assertEq(CurveNativeRecipientPool(payable(TARGET)).calls(), 0);
            prepare(i, 100, 10); BotVM(payable(ACTOR)).execute(script(m, i, "external", 100));
            assertEq(token(i).balanceOf(ACTOR), STOCK); assertEq(token(1 - i).balanceOf(RECEIVER), 309);
        }
    }
}
