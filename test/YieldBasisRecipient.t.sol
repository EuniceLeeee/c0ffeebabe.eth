// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import {Test} from "forge-std/Test.sol";
import {BotVM} from "../src/BotVM.sol";

// Synthetic ABI/fault fixture. It does not represent deployed LT identity.
contract YbRecipientToken {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    bool public badClear;
    function set(address who, uint256 amount) external { balanceOf[who] = amount; }
    function change(address who, int256 delta) external { balanceOf[who] = uint256(int256(balanceOf[who]) + delta); }
    function configure(bool bad) external { badClear = bad; }
    function approve(address who, uint256 amount) external returns (bool) {
        allowance[msg.sender][who] = badClear && amount == 0 ? 1 : amount; return true;
    }
    function transfer(address to, uint256 amount) external returns (bool) {
        balanceOf[msg.sender] -= amount; balanceOf[to] += amount; return true;
    }
    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        allowance[from][msg.sender] -= amount; balanceOf[from] -= amount; balanceOf[to] += amount; return true;
    }
}
contract YbRecipientPool {
    function balances(uint256 i) external pure returns (uint256) { return i == 0 ? 2000 : 100; }
}
contract YbRecipientLt is YbRecipientToken {
    uint256 public calls;
    uint256 public debt;
    uint256 public fault;
    uint256 public totalSupply;
    function setup(uint256 n) external { fault = n; calls = 0; debt = 0; totalSupply = 100000; }
    function deposit(uint256 amount, uint256 d, uint256) external returns (uint256) { return depositTo(amount, d, msg.sender); }
    function deposit(uint256 amount, uint256 d, uint256, address to) external returns (uint256) { return depositTo(amount, d, to); }
    function withdraw(uint256 amount, uint256) external returns (uint256) { return withdrawTo(amount, msg.sender); }
    function withdraw(uint256 amount, uint256, address to) external returns (uint256) { return withdrawTo(amount, to); }
    function depositTo(uint256 amount, uint256 d, address to) internal returns (uint256) {
        require(to != address(108)); calls++; debt = d;
        YbRecipientToken(address(103)).transferFrom(address(105), address(this), d);
        YbRecipientToken(address(102)).transferFrom(msg.sender, address(this), amount);
        uint256 out = amount * 2;
        if (fault != 4) { uint256 mint = out - (fault == 14 ? 1 : 0); balanceOf[fault == 5 ? address(92) : to] += mint; totalSupply += mint; }
        effects(address(102), address(this), amount, to);
        return fault == 11 ? 0 : fault == 12 ? out + 1 : out;
    }
    function withdrawTo(uint256 amount, address to) internal returns (uint256) {
        require(to != address(108) && msg.sender != address(108)); calls++; balanceOf[msg.sender] -= amount; totalSupply -= amount;
        uint256 out = amount * 2;
        if (fault != 4) YbRecipientToken(address(102)).transfer(fault == 5 ? address(92) : to, out - (fault == 14 ? 1 : 0));
        effects(address(this), address(102), amount, to);
        return fault == 11 ? 0 : fault == 12 ? out + 1 : out;
    }
    function effects(address input, address output, uint256 amount, address to) internal {
        if (fault == 1) YbRecipientToken(input).change(msg.sender, int256(amount));
        if (fault == 2) YbRecipientToken(input).change(msg.sender, 1);
        if (fault == 3) YbRecipientToken(input).change(msg.sender, -1);
        if (fault == 6) YbRecipientToken(output).change(msg.sender, -1);
        if (fault == 7) YbRecipientToken(input).change(to, -1);
        if (fault == 8) YbRecipientToken(address(103)).change(msg.sender, -1);
        if (fault == 9) YbRecipientToken(address(103)).change(to, -1);
        if (fault == 10) { (bool ok,) = msg.sender.call{value: 1}(""); require(ok); }
    }
    receive() external payable {}
}
contract YieldBasisRecipientTest is Test {
    address constant ACTOR = address(107);
    address constant RECEIVER = address(91);
    address constant LT = address(101);
    address constant ASSET = address(102);
    address constant STABLE = address(103);
    address constant AMM = address(105);
    uint256 constant STOCK = 777;
    function setUp() public {
        vm.etch(ACTOR, address(new BotVM()).code); vm.etch(LT, address(new YbRecipientLt()).code);
        vm.etch(ASSET, address(new YbRecipientToken()).code); vm.etch(STABLE, address(new YbRecipientToken()).code);
        vm.etch(address(104), address(new YbRecipientPool()).code);
    }
    function token(address a) internal pure returns (YbRecipientToken) { return YbRecipientToken(a); }
    function prepare(bool deposit, uint256 amount, uint256 fault) internal {
        for (uint256 i; i < 3; i++) {
            address t = i == 0 ? LT : i == 1 ? ASSET : STABLE;
            token(t).set(ACTOR, STOCK + (t == (deposit ? ASSET : LT) ? amount : 0)); token(t).set(RECEIVER, 109);
            token(t).set(LT, 100000); token(t).set(AMM, 1000000); token(t).set(address(92), 0); token(t).configure(false);
            vm.prank(ACTOR); token(t).approve(LT, 13); vm.prank(AMM); token(t).approve(LT, 1000000);
        }
        token(ASSET).configure(fault == 13); vm.deal(ACTOR, 17); vm.deal(RECEIVER, 23); vm.deal(LT, 100);
        YbRecipientLt(payable(LT)).setup(fault);
    }
    function script(bool deposit, string memory kind, uint256 amount) internal view returns (bytes memory) {
        return vm.envBytes(string.concat("YB_RECIPIENT_", deposit ? "deposit" : "withdraw", "_", kind, "_", vm.toString(amount)));
    }
    function unchanged(bool deposit, uint256 amount) internal view {
        for (uint256 i; i < 3; i++) {
            address t = i == 0 ? LT : i == 1 ? ASSET : STABLE;
            assertEq(token(t).balanceOf(ACTOR), STOCK + (t == (deposit ? ASSET : LT) ? amount : 0));
            assertEq(token(t).balanceOf(RECEIVER), 109); assertEq(token(t).balanceOf(LT), 100000);
            assertEq(token(t).balanceOf(AMM), 1000000); assertEq(token(t).balanceOf(address(92)), 0);
            assertEq(token(t).allowance(ACTOR, LT), 13); assertEq(token(t).allowance(AMM, LT), 1000000);
        }
        assertEq(YbRecipientLt(payable(LT)).calls(), 0); assertEq(YbRecipientLt(payable(LT)).debt(), 0);
        assertEq(YbRecipientLt(payable(LT)).totalSupply(), 100000);
        assertEq(ACTOR.balance, 17); assertEq(RECEIVER.balance, 23); assertEq(LT.balance, 100);
    }
    function testDirectSelfExternalBothDirectionsAmountsAndOldInventory() public {
        for (uint256 d; d < 2; d++) for (uint256 k; k < 2; k++) for (uint256 n; n < 2; n++) {
            bool deposit = d == 0; uint256 amount = n == 0 ? 1 : 100; prepare(deposit, amount, 0);
            BotVM(payable(ACTOR)).execute(script(deposit, k == 0 ? "self" : "external", amount));
            address input = deposit ? ASSET : LT; address output = deposit ? LT : ASSET;
            assertEq(token(input).balanceOf(ACTOR), STOCK); assertEq(token(output).balanceOf(ACTOR), STOCK + (k == 0 ? amount * 2 : 0));
            assertEq(token(input).balanceOf(RECEIVER), 109); assertEq(token(output).balanceOf(RECEIVER), 109 + (k == 1 ? amount * 2 : 0));
            assertEq(token(STABLE).balanceOf(ACTOR), STOCK); assertEq(token(STABLE).balanceOf(RECEIVER), 109);
            assertEq(token(ASSET).allowance(ACTOR, LT), deposit ? 0 : 13);
            assertEq(YbRecipientLt(payable(LT)).debt(), deposit ? amount * 20 : 0);
            assertEq(ACTOR.balance, 17); assertEq(RECEIVER.balance, 23);
        }
    }
    function testDirectFaultsIndependentlyRollBackAllStockAllowanceNativeAndProtocolState() public {
        for (uint256 d; d < 2; d++) for (uint256 k; k < 2; k++) for (uint256 f = 1; f <= 14; f++) {
            if (d == 1 && f == 13) continue;
            prepare(d == 0, 100, f); bytes memory p = script(d == 0, k == 0 ? "self" : "external", 100);
            vm.expectRevert(); BotVM(payable(ACTOR)).execute(p); unchanged(d == 0, 100);
        }
    }
    function testFaultsAreAcceptedByTheUnguardedSyntheticProtocol() public {
        for (uint256 d; d < 2; d++) for (uint256 f = 1; f <= 14; f++) {
            if (d == 1 && f == 13) continue;
            prepare(d == 0, 100, f);
            if (d == 0) { vm.prank(ACTOR); token(ASSET).approve(LT, 100); vm.prank(ACTOR); YbRecipientLt(payable(LT)).deposit(100, 2000, 1, RECEIVER); vm.prank(ACTOR); token(ASSET).approve(LT, 0); }
            else { vm.prank(ACTOR); YbRecipientLt(payable(LT)).withdraw(100, 1, RECEIVER); }
            assertEq(YbRecipientLt(payable(LT)).calls(), 1);
        }
    }
    function testZeroInputCannotConsumeOldInventory() public {
        for (uint256 d; d < 2; d++) for (uint256 k; k < 2; k++) {
            prepare(d == 0, 0, 0); bytes memory p = script(d == 0, k == 0 ? "self" : "external", 0);
            vm.expectRevert(); BotVM(payable(ACTOR)).execute(p); unchanged(d == 0, 0);
        }
    }
    function testUnfundedIdenticalScriptCannotSpendOrChangeStock() public {
        for (uint256 d; d < 2; d++) for (uint256 k; k < 2; k++) {
            bool deposit = d == 0; prepare(deposit, 100, 0); address input = deposit ? ASSET : LT; token(input).set(ACTOR, 0);
            bytes memory p = script(deposit, k == 0 ? "self" : "external", 100);
            vm.expectRevert(); BotVM(payable(ACTOR)).execute(p); assertEq(token(input).balanceOf(ACTOR), 0);
            token(input).set(ACTOR, STOCK + 100); unchanged(deposit, 100);
        }
    }
}
