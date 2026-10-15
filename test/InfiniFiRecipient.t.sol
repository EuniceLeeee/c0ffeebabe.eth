// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import {Test} from "forge-std/Test.sol";
import {BotVM} from "../src/BotVM.sol";
import {CurveRecipientToken} from "./CurvePlainRecipient.t.sol";

// Synthetic ABI/state only. These fixtures never claim Gateway historical identity.
contract InfiniRecipientToken is CurveRecipientToken {
    uint256 public totalSupply;
    function setSupply(uint256 value) external { totalSupply = value; }
    function changeSupply(int256 delta) external { totalSupply = uint256(int256(totalSupply) + delta); }
    function asset() external pure returns (address) { return address(102); }
    function core() external pure returns (address) { return address(103); }
    function yieldSharing() external pure returns (address) { return address(104); }
}
contract InfiniRecipientCore {
    function hasRole(bytes32, address) external pure returns (bool) { return true; }
    function core() external pure returns (address) { return address(103); }
}
contract InfiniRecipientGateway {
    uint256 public fault;
    uint256 public calls;
    function configure(uint256 value) external { fault = value; calls = 0; }
    function core() external pure returns (address) { return address(103); }
    function getAddress(string calldata name) external pure returns (address) {
        if (keccak256(bytes(name)) == keccak256("stakedToken")) return address(101);
        if (keccak256(bytes(name)) == keccak256("receiptToken")) return address(102);
        require(keccak256(bytes(name)) == keccak256("yieldSharing")); return address(104);
    }
    function stake(address recipient, uint256 amount) external returns (uint256) { return swap(true, recipient, amount); }
    function unstake(address recipient, uint256 amount) external returns (uint256) { return swap(false, recipient, amount); }
    function swap(bool deposit, address recipient, uint256 amount) internal returns (uint256) {
        require(amount > 0); calls++;
        InfiniRecipientToken shares = InfiniRecipientToken(address(101));
        InfiniRecipientToken input = InfiniRecipientToken(deposit ? address(102) : address(101));
        InfiniRecipientToken output = InfiniRecipientToken(deposit ? address(101) : address(102));
        uint256 received = amount * 2;
        input.transferFrom(msg.sender, address(this), amount); input.change(address(this), -int256(amount));
        shares.changeSupply(deposit ? int256(received) : -int256(amount));
        if (fault == 1) input.change(msg.sender, int256(amount));
        if (fault == 2) input.change(msg.sender, 1);
        if (fault == 3) input.change(msg.sender, -1);
        if (fault != 4) output.change(fault == 5 ? address(92) : recipient, int256(received));
        if (fault == 6) output.change(msg.sender, -1);
        if (fault == 7) input.change(recipient, -1);
        if (fault == 8) { (bool ok,) = msg.sender.call{value: 1}(""); require(ok); }
        if (fault == 9) input.configure(true);
        if (fault == 11) shares.changeSupply(1);
        if (fault == 12) input.change(address(this), 1);
        return fault == 10 ? 0 : fault == 13 ? received + 1 : received;
    }
    receive() external payable {}
}
contract InfiniFiRecipientTest is Test {
    address constant ACTOR = address(107);
    address constant RECEIVER = address(91);
    address constant GATEWAY = address(bytes20(hex"3f04b65ddbd87f9ce0a2e7eb24d80e7fb87625b5"));
    uint256 constant STOCK = 777;
    function setUp() public {
        vm.etch(ACTOR, address(new BotVM()).code);
        bytes memory tokenCode = address(new InfiniRecipientToken()).code;
        vm.etch(address(101), tokenCode); vm.etch(address(102), tokenCode);
        bytes memory links = address(new InfiniRecipientCore()).code;
        vm.etch(address(103), links); vm.etch(address(104), links);
        vm.etch(GATEWAY, address(new InfiniRecipientGateway()).code);
    }
    function token(uint256 i) internal pure returns (InfiniRecipientToken) { return InfiniRecipientToken(i == 0 ? address(102) : address(101)); }
    function setBalance(uint256 i, address actor, uint256 amount) internal { vm.store(address(token(i)), keccak256(abi.encode(actor, uint256(0))), bytes32(amount)); }
    function prepare(uint256 i, uint256 amount, uint256 fault) internal {
        for (uint256 k; k < 2; ++k) {
            setBalance(k, ACTOR, STOCK + (k == i ? amount : 0)); setBalance(k, RECEIVER, 109);
            setBalance(k, GATEWAY, 10000); setBalance(k, address(92), 0);
            token(k).setSupply(100000); token(k).configure(false);
            vm.prank(ACTOR); token(k).approve(GATEWAY, 0);
        }
        vm.deal(ACTOR, 17); vm.deal(RECEIVER, 23); vm.deal(GATEWAY, 100);
        InfiniRecipientGateway(payable(GATEWAY)).configure(fault);
    }
    function script(uint256 i, string memory kind, uint256 amount) internal view returns (bytes memory) {
        return vm.envBytes(string.concat("INFINIFI_RECIPIENT_", vm.toString(i), "_", kind, "_", vm.toString(amount)));
    }
    function unchanged(uint256 i, uint256 amount) internal view {
        assertEq(token(i).balanceOf(ACTOR), STOCK + amount); assertEq(token(1 - i).balanceOf(ACTOR), STOCK);
        for (uint256 k; k < 2; ++k) {
            assertEq(token(k).balanceOf(RECEIVER), 109); assertEq(token(k).balanceOf(GATEWAY), 10000);
            assertEq(token(k).balanceOf(address(92)), 0); assertEq(token(k).allowance(ACTOR, GATEWAY), 0);
            assertEq(token(k).totalSupply(), 100000); assertFalse(token(k).badClear());
        }
        assertEq(ACTOR.balance, 17); assertEq(RECEIVER.balance, 23); assertEq(GATEWAY.balance, 100);
        assertEq(InfiniRecipientGateway(payable(GATEWAY)).calls(), 0);
    }
    function testDefaultSelfExternalBothDirectionsAndAmounts() public {
        for (uint256 i; i < 2; ++i) for (uint256 k; k < 3; ++k) for (uint256 n; n < 2; ++n) {
            uint256 amount = n == 0 ? 1 : 100; prepare(i, amount, 0);
            BotVM(payable(ACTOR)).execute(script(i, k == 0 ? "default" : k == 1 ? "self" : "external", amount));
            assertEq(token(i).balanceOf(ACTOR), STOCK);
            assertEq(token(1 - i).balanceOf(ACTOR), STOCK + (k == 2 ? 0 : amount * 2));
            assertEq(token(i).balanceOf(RECEIVER), 109);
            assertEq(token(1 - i).balanceOf(RECEIVER), 109 + (k == 2 ? amount * 2 : 0));
            assertEq(token(i).balanceOf(GATEWAY), 10000); assertEq(token(1 - i).balanceOf(GATEWAY), 10000);
            assertEq(token(1).totalSupply(), i == 0 ? 100000 + amount * 2 : 100000 - amount);
            assertEq(token(i).allowance(ACTOR, GATEWAY), 0); assertEq(ACTOR.balance, 17); assertEq(RECEIVER.balance, 23);
        }
    }
    function testDirectFaultsRollBackBalancesSupplyAllowanceNativeAndGatewayState() public {
        for (uint256 i; i < 2; ++i) for (uint256 k; k < 2; ++k) for (uint256 f = 1; f <= 13; ++f) {
            prepare(i, 100, f); bytes memory program = script(i, k == 0 ? "self" : "external", 100);
            vm.expectRevert(); BotVM(payable(ACTOR)).execute(program); unchanged(i, 100);
        }
    }
    function testZeroInputCannotConsumeOldInventory() public {
        for (uint256 i; i < 2; ++i) for (uint256 k; k < 2; ++k) {
            prepare(i, 0, 0); bytes memory program = script(i, k == 0 ? "self" : "external", 0);
            vm.expectRevert(); BotVM(payable(ACTOR)).execute(program); unchanged(i, 0);
        }
    }
    function testNoInputSameProgramRevertsWithoutChangingStock() public {
        for (uint256 i; i < 2; ++i) for (uint256 k; k < 2; ++k) {
            prepare(i, 100, 0); setBalance(i, ACTOR, 0); bytes memory program = script(i, k == 0 ? "self" : "external", 100);
            vm.expectRevert(); BotVM(payable(ACTOR)).execute(program);
            assertEq(token(i).balanceOf(ACTOR), 0); setBalance(i, ACTOR, STOCK + 100); unchanged(i, 100);
        }
    }
}
