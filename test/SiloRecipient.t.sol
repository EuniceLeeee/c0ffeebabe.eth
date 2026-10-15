// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import {Test} from "forge-std/Test.sol";
import {BotVM} from "../src/BotVM.sol";
import {CurveRecipientToken} from "./CurvePlainRecipient.t.sol";

// Synthetic Tranche ABI and faults, never a claim of historical Strata identity.
contract SiloRecipientTranche is CurveRecipientToken {
    uint256 public totalSupply;
    uint256 public fault;
    uint256 public calls;
    function setup(uint256 value) external { totalSupply = 100000; fault = value; calls = 0; }
    function redeem(address token, uint256 amount, address recipient, address owner) external returns (uint256) {
        require(token == address(102) && owner == msg.sender && amount > 0); calls++;
        balanceOf[owner] -= amount; totalSupply -= amount;
        CurveRecipientToken output = CurveRecipientToken(token);
        uint256 received = amount * 2;
        if (fault == 1) balanceOf[owner] += amount;
        if (fault == 2) balanceOf[owner] += 1;
        if (fault == 3) balanceOf[owner] -= 1;
        if (fault != 4) output.transfer(fault == 5 ? address(92) : recipient, received - (fault == 12 ? 1 : 0));
        if (fault == 6) output.change(owner, -1);
        if (fault == 7) balanceOf[recipient] -= 1;
        if (fault == 8) { (bool ok,) = owner.call{value: 1}(""); require(ok); }
        if (fault == 9) totalSupply += 1;
        return fault == 10 ? 0 : fault == 11 ? received + 1 : received;
    }
    receive() external payable {}
}

contract SiloRecipientTest is Test {
    address constant ACTOR = address(107);
    address constant RECEIVER = address(91);
    address constant VAULT = address(101);
    address constant PAYOUT = address(102);
    uint256 constant STOCK = 777;
    function setUp() public {
        vm.etch(ACTOR, address(new BotVM()).code);
        vm.etch(VAULT, address(new SiloRecipientTranche()).code);
        vm.etch(PAYOUT, address(new CurveRecipientToken()).code);
    }
    function token(address a) internal pure returns (CurveRecipientToken) { return CurveRecipientToken(a); }
    function setBalance(address t, address a, uint256 value) internal { vm.store(t, keccak256(abi.encode(a, uint256(0))), bytes32(value)); }
    function prepare(uint256 amount, uint256 fault) internal {
        for (uint256 i; i < 2; ++i) {
            address t = i == 0 ? VAULT : PAYOUT;
            setBalance(t, ACTOR, STOCK + (i == 0 ? amount : 0));
            setBalance(t, RECEIVER, 109); setBalance(t, VAULT, 10000); setBalance(t, address(92), 0);
            vm.prank(ACTOR); token(t).approve(VAULT, 13);
        }
        vm.deal(ACTOR, 17); vm.deal(RECEIVER, 23); vm.deal(VAULT, 100);
        SiloRecipientTranche(payable(VAULT)).setup(fault);
    }
    function script(string memory kind, uint256 amount) internal view returns (bytes memory) {
        return vm.envBytes(string.concat("SILO_RECIPIENT_", kind, "_", vm.toString(amount)));
    }
    function unchanged(uint256 amount) internal view {
        assertEq(token(VAULT).balanceOf(ACTOR), STOCK + amount); assertEq(token(PAYOUT).balanceOf(ACTOR), STOCK);
        for (uint256 i; i < 2; ++i) {
            address t = i == 0 ? VAULT : PAYOUT;
            assertEq(token(t).balanceOf(RECEIVER), 109); assertEq(token(t).balanceOf(VAULT), 10000);
            assertEq(token(t).balanceOf(address(92)), 0); assertEq(token(t).allowance(ACTOR, VAULT), 13);
        }
        assertEq(SiloRecipientTranche(payable(VAULT)).totalSupply(), 100000);
        assertEq(SiloRecipientTranche(payable(VAULT)).calls(), 0);
        assertEq(ACTOR.balance, 17); assertEq(RECEIVER.balance, 23); assertEq(VAULT.balance, 100);
    }
    function testDefaultSelfExternalAmountsAndOldInventory() public {
        for (uint256 k; k < 3; ++k) for (uint256 n; n < 2; ++n) {
            uint256 amount = n == 0 ? 1 : 100; prepare(amount, 0);
            BotVM(payable(ACTOR)).execute(script(k == 0 ? "default" : k == 1 ? "self" : "external", amount));
            assertEq(token(VAULT).balanceOf(ACTOR), STOCK);
            assertEq(token(PAYOUT).balanceOf(ACTOR), STOCK + (k == 2 ? 0 : amount * 2));
            assertEq(token(VAULT).balanceOf(RECEIVER), 109);
            assertEq(token(PAYOUT).balanceOf(RECEIVER), 109 + (k == 2 ? amount * 2 : 0));
            assertEq(token(PAYOUT).balanceOf(VAULT), 10000 - amount * 2);
            assertEq(SiloRecipientTranche(payable(VAULT)).totalSupply(), 100000 - amount);
            assertEq(token(VAULT).allowance(ACTOR, VAULT), 13); assertEq(token(PAYOUT).allowance(ACTOR, VAULT), 13);
            assertEq(ACTOR.balance, 17); assertEq(RECEIVER.balance, 23);
        }
    }
    function testDirectFaultsRollBackBalancesSupplyAllowanceNativeAndTrancheState() public {
        for (uint256 k; k < 2; ++k) for (uint256 f = 1; f <= 12; ++f) {
            prepare(100, f); bytes memory program = script(k == 0 ? "self" : "external", 100);
            vm.expectRevert(); BotVM(payable(ACTOR)).execute(program); unchanged(100);
        }
    }
    function testGuardMutationSentinelUnguardedDefaultAcceptsEveryFault() public {
        for (uint256 f = 1; f <= 12; ++f) {
            prepare(100, f); BotVM(payable(ACTOR)).execute(script("default", 100));
            assertEq(SiloRecipientTranche(payable(VAULT)).calls(), 1);
        }
    }
    function testZeroInputCannotConsumeOldInventory() public {
        for (uint256 k; k < 2; ++k) {
            prepare(0, 0); bytes memory program = script(k == 0 ? "self" : "external", 0);
            vm.expectRevert(); BotVM(payable(ACTOR)).execute(program); unchanged(0);
        }
    }
    function testNoInputSameProgramRevertsWithoutChangingStock() public {
        for (uint256 k; k < 2; ++k) {
            prepare(100, 0); setBalance(VAULT, ACTOR, 0); bytes memory program = script(k == 0 ? "self" : "external", 100);
            vm.expectRevert(); BotVM(payable(ACTOR)).execute(program);
            assertEq(token(VAULT).balanceOf(ACTOR), 0); setBalance(VAULT, ACTOR, STOCK + 100); unchanged(100);
        }
    }
}
