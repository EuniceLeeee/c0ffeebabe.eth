// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import {Test} from "forge-std/Test.sol";
import {BotVM} from "../src/BotVM.sol";
import {CurveRecipientToken, CurveRecipientPool} from "./CurvePlainRecipient.t.sol";
contract EkuboErc20RecipientRouter is CurveRecipientPool {
    struct PoolKey { address token0; address token1; bytes32 config; }
    function swap(PoolKey calldata key, bool isToken1, int128 amount, uint96 limit, uint256 skip, int256 minimum, address recipient)
        external returns (bytes32) {
        require(key.token0 == address(83) && key.token1 == address(84) && amount > 0 && minimum > 0 && limit == 0 && skip == 0);
        uint256 i = isToken1 ? 1 : 0;
        uint256 dy = super.swap(i, 1 - i, uint256(uint128(amount)), uint256(minimum), recipient, false);
        if (fault == 11) dy = uint256(uint128(amount)) * 2 + 1;
        int128 debit = fault == 12 ? amount - 1 : amount;
        int128 output = fault == 13 ? int128(uint128(dy)) : -int128(uint128(dy));
        int128 delta0 = isToken1 ? output : debit;
        int128 delta1 = isToken1 ? debit : output;
        return bytes32((uint256(uint128(delta0)) << 128) | uint128(delta1));
    }
}
contract EkuboErc20RecipientTest is Test {
    address constant ACTOR = address(71);
    address constant TARGET = address(bytes20(hex"d26f20001a72a18c002b00e6710000d68700ce00"));
    address constant RECEIVER = address(91);
    uint256 constant STOCK = 777;
    function setUp() public {
        vm.etch(ACTOR, address(new BotVM()).code);
        vm.etch(address(83), address(new CurveRecipientToken()).code);
        vm.etch(address(84), address(new CurveRecipientToken()).code);
        vm.etch(TARGET, address(new EkuboErc20RecipientRouter()).code);
    }
    function token(uint256 i) internal pure returns (CurveRecipientToken) { return CurveRecipientToken(address(uint160(83 + i))); }
    function setBalance(uint256 i, address account, uint256 amount) internal { vm.store(address(token(i)), keccak256(abi.encode(account, uint256(0))), bytes32(amount)); }
    function prepare(uint256 i, uint256 amount, uint256 fault) internal {
        for (uint256 k; k < 2; ++k) {
            setBalance(k, ACTOR, STOCK + (k == i ? amount : 0)); setBalance(k, RECEIVER, 109);
            setBalance(k, TARGET, 10000); setBalance(k, address(92), 0); token(k).configure(false);
            vm.prank(ACTOR); token(k).approve(TARGET, 0);
        }
        vm.deal(ACTOR, 17); vm.deal(TARGET, 100); vm.deal(RECEIVER, 23); vm.deal(address(92), 0);
        CurveRecipientPool(payable(TARGET)).configure(fault);
    }
    function script(uint256 i, string memory kind, uint256 amount) internal view returns (bytes memory) {
        return vm.envBytes(string.concat("EKUBO_ERC20_RECIPIENT_", vm.toString(i), "_", kind, "_", vm.toString(amount)));
    }
    function unchanged(uint256 i, uint256 amount) internal view {
        for (uint256 k; k < 2; ++k) {
            assertEq(token(k).balanceOf(ACTOR), STOCK + (k == i ? amount : 0));
            assertEq(token(k).balanceOf(RECEIVER), 109); assertEq(token(k).balanceOf(TARGET), 10000);
            assertEq(token(k).balanceOf(address(92)), 0); assertEq(token(k).allowance(ACTOR,TARGET), 0); assertFalse(token(k).badClear());
        }
        assertEq(ACTOR.balance,17); assertEq(RECEIVER.balance,23); assertEq(TARGET.balance,100); assertEq(address(92).balance,0);
        assertEq(CurveRecipientPool(payable(TARGET)).calls(), 0);
    }
    function testDefaultSelfExternalBothDirectionsAndAmounts() public {
        for (uint256 i; i < 2; ++i) for (uint256 k; k < 3; ++k) for (uint256 a; a < 2; ++a) {
            uint256 amount = a == 0 ? 1 : 100; prepare(i, amount, 0);
            BotVM(payable(ACTOR)).execute(script(i, k == 0 ? "default" : k == 1 ? "self" : "external", amount));
            assertEq(token(i).balanceOf(ACTOR), STOCK); assertEq(token(1-i).balanceOf(ACTOR), STOCK + (k == 2 ? 0 : amount*2));
            assertEq(token(i).balanceOf(RECEIVER),109); assertEq(token(1-i).balanceOf(RECEIVER),109 + (k == 2 ? amount*2 : 0));
            assertEq(token(i).balanceOf(TARGET),10000+amount); assertEq(token(1-i).balanceOf(TARGET),10000-amount*2);
            assertEq(token(i).allowance(ACTOR,TARGET),k == 0 ? type(uint256).max-amount : 0);
            assertEq(ACTOR.balance,17); assertEq(RECEIVER.balance,23);
        }
    }
    function testDirectFaultsRejectAndRollBackAllState() public {
        for(uint256 i; i<2; ++i) for(uint256 k; k<2; ++k) for(uint256 f=1; f<=13; ++f) {
            prepare(i,100,f); bytes memory program = script(i,k==0?"self":"external",100);
            vm.expectRevert(); BotVM(payable(ACTOR)).execute(program); unchanged(i,100);
        }
    }
    function testZeroInputCannotUseOldStock() public {
        for(uint256 i; i<2; ++i) for(uint256 k; k<2; ++k) {
            prepare(i,0,0); bytes memory program=script(i,k==0?"self":"external",0);
            vm.expectRevert(); BotVM(payable(ACTOR)).execute(program); unchanged(i,0);
        }
    }
    function testNoInputSameProgramReverts() public {
        for(uint256 i; i<2; ++i) for(uint256 k; k<2; ++k) {
            prepare(i,100,0);setBalance(i,ACTOR,0);bytes memory program=script(i,k==0?"self":"external",100);
            vm.expectRevert();BotVM(payable(ACTOR)).execute(program);assertEq(token(i).balanceOf(ACTOR),0);
            setBalance(i,ACTOR,STOCK+100);unchanged(i,100);
        }
    }
}
