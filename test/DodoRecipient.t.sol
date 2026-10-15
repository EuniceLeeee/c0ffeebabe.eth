// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import {Test} from "forge-std/Test.sol";
import {BotVM} from "../src/BotVM.sol";

// Synthetic balance/ABI fault fixture; no deployed GSP identity claim.
contract DodoRecipientToken {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    uint256 public returnMode;
    function set(address who, uint256 value) external { balanceOf[who] = value; }
    function change(address who, int256 delta) external { balanceOf[who] = uint256(int256(balanceOf[who]) + delta); }
    function configure(uint256 mode) external { returnMode = mode; }
    function approve(address to, uint256 amount) external returns (bool) { allowance[msg.sender][to] = amount; return true; }
    function transfer(address to, uint256 amount) external returns (bool) {
        balanceOf[msg.sender] -= amount; balanceOf[to] += amount;
        if (returnMode == 1) assembly { return(0, 0) }
        return returnMode != 2;
    }
}
contract DodoRecipientPool {
    uint256 public fault;
    uint256 public calls;
    function configure(uint256 f) external { fault = f; calls = 0; }
    function sellBase(address to) external returns (uint256) { return sell(address(102), address(103), to); }
    function sellQuote(address to) external returns (uint256) { return sell(address(103), address(102), to); }
    function sell(address input, address output, address to) internal returns (uint256) {
        calls++; uint256 amount = DodoRecipientToken(input).balanceOf(address(this)) - 100000; uint256 out = amount * 2;
        if (fault != 4) DodoRecipientToken(output).transfer(fault == 5 ? address(92) : to, out - (fault == 11 ? 1 : 0));
        if (fault == 1) DodoRecipientToken(input).change(msg.sender, int256(amount));
        if (fault == 2) DodoRecipientToken(input).change(msg.sender, 1);
        if (fault == 3) DodoRecipientToken(input).change(msg.sender, -1);
        if (fault == 6) DodoRecipientToken(output).change(msg.sender, -1);
        if (fault == 7) DodoRecipientToken(input).change(to, -1);
        if (fault == 8) { (bool ok,) = msg.sender.call{value: 1}(""); require(ok); }
        return fault == 9 ? 0 : fault == 10 ? out + 1 : out;
    }
    receive() external payable {}
}
contract DodoRecipientTest is Test {
    address constant ACTOR = address(107);
    address constant RECEIVER = address(91);
    address constant POOL = address(101);
    address constant BASE = address(102);
    address constant QUOTE = address(103);
    uint256 constant STOCK = 777;
    function setUp() public {
        vm.etch(ACTOR, address(new BotVM()).code); vm.etch(POOL, address(new DodoRecipientPool()).code);
        vm.etch(BASE, address(new DodoRecipientToken()).code); vm.etch(QUOTE, address(new DodoRecipientToken()).code);
    }
    function token(address a) internal pure returns (DodoRecipientToken) { return DodoRecipientToken(a); }
    function prepare(bool base, uint256 amount, uint256 fault, uint256 mode) internal {
        address input = base ? BASE : QUOTE;
        for (uint256 i; i < 2; i++) {
            address t = i == 0 ? BASE : QUOTE;
            token(t).set(ACTOR, STOCK + (t == input ? amount : 0)); token(t).set(RECEIVER, 109);
            token(t).set(POOL, 100000); token(t).set(address(92), 0); token(t).configure(t == input ? mode : 0);
            vm.prank(ACTOR); token(t).approve(POOL, 13);
        }
        vm.deal(ACTOR, 17); vm.deal(RECEIVER, 23); vm.deal(POOL, 100); DodoRecipientPool(payable(POOL)).configure(fault);
    }
    function script(bool base, string memory kind, uint256 amount) internal view returns (bytes memory) {
        return vm.envBytes(string.concat("DODO_RECIPIENT_", base ? "sell-base" : "sell-quote", "_", kind, "_", vm.toString(amount)));
    }
    function unchanged(bool base, uint256 amount) internal view {
        for (uint256 i; i < 2; i++) {
            address t = i == 0 ? BASE : QUOTE;
            assertEq(token(t).balanceOf(ACTOR), STOCK + (t == (base ? BASE : QUOTE) ? amount : 0));
            assertEq(token(t).balanceOf(RECEIVER), 109); assertEq(token(t).balanceOf(POOL), 100000);
            assertEq(token(t).balanceOf(address(92)), 0); assertEq(token(t).allowance(ACTOR, POOL), 13);
        }
        assertEq(DodoRecipientPool(payable(POOL)).calls(), 0); assertEq(ACTOR.balance, 17); assertEq(RECEIVER.balance, 23); assertEq(POOL.balance, 100);
    }
    function testSelfExternalBothDirectionsAndTransferReturnModesUseActualBalances() public {
        for (uint256 d; d < 2; d++) for (uint256 k; k < 2; k++) for (uint256 n; n < 2; n++) for (uint256 m; m < 3; m++) {
            bool base = d == 0; uint256 amount = n == 0 ? 1 : 100; prepare(base, amount, 0, m);
            BotVM(payable(ACTOR)).execute(script(base, k == 0 ? "self" : "external", amount));
            address input = base ? BASE : QUOTE; address output = base ? QUOTE : BASE;
            assertEq(token(input).balanceOf(ACTOR), STOCK); assertEq(token(output).balanceOf(ACTOR), STOCK + (k == 0 ? amount * 2 : 0));
            assertEq(token(input).balanceOf(RECEIVER), 109); assertEq(token(output).balanceOf(RECEIVER), 109 + (k == 1 ? amount * 2 : 0));
            assertEq(token(input).balanceOf(POOL), 100000 + amount); assertEq(token(output).balanceOf(POOL), 100000 - amount * 2);
            assertEq(token(input).allowance(ACTOR, POOL), 13); assertEq(token(output).allowance(ACTOR, POOL), 13);
            assertEq(ACTOR.balance, 17); assertEq(RECEIVER.balance, 23); assertEq(POOL.balance, 100);
        }
    }
    function testFaultsRejectAndIndependentlyRollBackEveryObservedAccount() public {
        for (uint256 d; d < 2; d++) for (uint256 k; k < 2; k++) for (uint256 f = 1; f <= 11; f++) {
            prepare(d == 0, 100, f, 0); bytes memory p = script(d == 0, k == 0 ? "self" : "external", 100);
            vm.expectRevert(); BotVM(payable(ACTOR)).execute(p); unchanged(d == 0, 100);
        }
    }
    function testDefaultUnguardedProgramsAcceptFaultsAsSentinels() public {
        for (uint256 d; d < 2; d++) for (uint256 f = 1; f <= 11; f++) {
            prepare(d == 0, 100, f, 0); BotVM(payable(ACTOR)).execute(script(d == 0, "default", 100));
            assertEq(DodoRecipientPool(payable(POOL)).calls(), 1);
        }
    }
    function testZeroInputCannotUseInventoryOrPoolSurplus() public {
        for (uint256 d; d < 2; d++) for (uint256 k; k < 2; k++) {
            prepare(d == 0, 0, 0, 0); address input = d == 0 ? BASE : QUOTE;
            token(input).set(POOL, 100123); bytes memory p = script(d == 0, k == 0 ? "self" : "external", 0);
            vm.expectRevert(); BotVM(payable(ACTOR)).execute(p); assertEq(token(input).balanceOf(POOL), 100123);
            token(input).set(POOL, 100000); unchanged(d == 0, 0);
        }
    }
    function testUnfundedIdenticalScriptCannotSpendOrChangeStock() public {
        for (uint256 d; d < 2; d++) for (uint256 k; k < 2; k++) {
            bool base = d == 0; prepare(base, 100, 0, 0); address input = base ? BASE : QUOTE; token(input).set(ACTOR, 0);
            bytes memory p = script(base, k == 0 ? "self" : "external", 100);
            vm.expectRevert(); BotVM(payable(ACTOR)).execute(p); assertEq(token(input).balanceOf(ACTOR), 0);
            token(input).set(ACTOR, STOCK + 100); unchanged(base, 100);
        }
    }
}
