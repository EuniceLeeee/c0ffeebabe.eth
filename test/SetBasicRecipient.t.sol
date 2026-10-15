// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import {Test} from "forge-std/Test.sol";
import {BotVM} from "../src/BotVM.sol";

// Synthetic BasicIssuance ABI and fault tokens. Production emitter + actual
// BotVM execute; this is not deployed protocol bytecode or historical rollback.
contract BasicRecipientToken {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    uint256 public totalSupply;
    uint256 public fault;
    uint256 public returnMode;
    address public side;
    function set(address who, uint256 value) external { balanceOf[who] = value; }
    function setSupply(uint256 value) external { totalSupply = value; }
    function change(address who, int256 delta) external { balanceOf[who] = uint256(int256(balanceOf[who]) + delta); }
    function burn(address who, uint256 value) external { balanceOf[who] -= value; totalSupply -= value; }
    function configure(uint256 f, uint256 mode, address other) external { fault = f; returnMode = mode; side = other; }
    function approve(address to, uint256 amount) external returns (bool) { allowance[msg.sender][to] = amount; return true; }
    function transfer(address to, uint256 amount) external returns (bool) {
        if (fault != 10) balanceOf[msg.sender] -= amount + (fault == 14 ? 1 : 0);
        if (fault != 11) balanceOf[fault == 15 ? address(999) : to] += amount + (fault == 13 ? 1 : 0) - (fault == 12 ? 1 : 0);
        if (fault == 16) BasicRecipientToken(payable(side)).change(msg.sender, -1);
        if (fault == 17) BasicRecipientToken(payable(side)).change(to, -1);
        if (fault == 18) BasicRecipientToken(payable(address(301))).change(msg.sender, -1);
        if (fault == 19) { (bool ok,) = msg.sender.call{value: 1}(""); require(ok); }
        if (returnMode == 1) assembly { return(0, 0) }
        return returnMode != 2;
    }
    receive() external payable {}
}
contract BasicRecipientBasket is BasicRecipientToken {
    uint256 public count;
    function configureCount(uint256 n) external { count = n; }
    function getComponents() external view returns (address[] memory values) {
        values = new address[](count); for (uint256 i; i < count; i++) values[i] = address(uint160(1000 + i));
    }
    function getDefaultPositionRealUnit(address token) external pure returns (int256) { return int256(uint256(uint160(token) - 999) * 1e18); }
}
contract BasicRecipientModule {
    uint256 public calls;
    uint256 public fault;
    uint256 public selected;
    uint256 public bonus;
    function configure(uint256 f, uint256 i, uint256 b) external { fault = f; selected = i; bonus = b; calls = 0; }
    function redeem(BasicRecipientBasket basket, uint256 amount, address to) external {
        calls++;
        uint256 debit = fault == 1 ? 0 : fault == 2 ? amount - 1 : fault == 3 ? amount + 1 : amount;
        basket.burn(msg.sender, debit);
        address[] memory tokens = basket.getComponents();
        for (uint256 i; i < tokens.length; i++) {
            uint256 out = amount * (i + 1) + (i == selected ? bonus : 0) - ((fault == 4 && i == selected || fault == 5 && i == (selected + 1) % tokens.length) ? 1 : 0);
            BasicRecipientToken(payable(tokens[i])).change(address(basket), -int256(out));
            BasicRecipientToken(payable(tokens[i])).change(fault == 6 ? address(202) : to, int256(out));
        }
        if (fault == 7) basket.change(address(202), -1);
        if (fault == 8) BasicRecipientToken(payable(tokens[(selected + 1) % tokens.length])).change(address(202), -1);
        if (fault == 9) { (bool ok,) = msg.sender.call{value: 1}(""); require(ok); }
    }
    receive() external payable {}
}
contract SetBasicRecipientTest is Test {
    address constant ACTOR = address(201);
    address constant RECEIVER = address(202);
    address constant BASKET = address(301);
    address constant MODULE = address(302);
    uint256 count;
    function token(uint256 index) internal pure returns (BasicRecipientToken) { return BasicRecipientToken(payable(address(uint160(1000 + index)))); }
    function setUp() public {
        vm.etch(ACTOR, address(new BotVM()).code);
        vm.etch(BASKET, address(new BasicRecipientBasket()).code);
        vm.etch(MODULE, address(new BasicRecipientModule()).code);
        for (uint256 i; i < 33; i++) vm.etch(address(token(i)), address(new BasicRecipientToken()).code);
    }
    function prepare(uint256 n, uint256 selected, uint256 fault, uint256 mode, uint256 bonus) internal {
        count = n; BasicRecipientBasket(payable(BASKET)).configureCount(n);
        BasicRecipientToken(payable(BASKET)).set(ACTOR, 10000); BasicRecipientToken(payable(BASKET)).set(RECEIVER, 7000);
        BasicRecipientToken(payable(BASKET)).setSupply(100000);
        vm.prank(ACTOR); BasicRecipientToken(payable(BASKET)).approve(MODULE, 991);
        for (uint256 i; i < n; i++) {
            token(i).set(ACTOR, 1000 + i); token(i).set(RECEIVER, 2000 + i); token(i).set(BASKET, 100000); token(i).set(address(999), 0);
            token(i).configure(i == selected ? fault : 0, i == selected ? mode : 0, address(token((selected + 1) % n)));
            vm.prank(ACTOR); token(i).approve(MODULE, 123 + i); vm.deal(address(token(i)), 100);
        }
        BasicRecipientModule(payable(MODULE)).configure(fault, selected, bonus);
        vm.deal(ACTOR, 17); vm.deal(RECEIVER, 23); vm.deal(MODULE, 100);
    }
    function script(uint256 n, uint256 selected, string memory kind, uint256 amount) internal view returns (bytes memory) {
        return vm.envBytes(string.concat("SET_BASIC_RECIPIENT_", vm.toString(n), "_", vm.toString(selected), "_", kind, "_", vm.toString(amount)));
    }
    function digest() internal view returns (bytes32 result) {
        for (uint256 i; i < count; i++) result = keccak256(abi.encode(result, token(i).balanceOf(ACTOR), token(i).balanceOf(RECEIVER),
            token(i).balanceOf(BASKET), token(i).balanceOf(address(999)), token(i).allowance(ACTOR, MODULE), address(token(i)).balance));
        result = keccak256(abi.encode(result, BasicRecipientToken(payable(BASKET)).balanceOf(ACTOR), BasicRecipientToken(payable(BASKET)).balanceOf(RECEIVER),
            BasicRecipientToken(payable(BASKET)).totalSupply(), BasicRecipientToken(payable(BASKET)).allowance(ACTOR, MODULE), BasicRecipientModule(payable(MODULE)).calls(),
            ACTOR.balance, RECEIVER.balance, MODULE.balance));
    }
    function checkPositive(uint256 selected, bool external_, uint256 amount, uint256 bonus) internal view {
        assertEq(BasicRecipientModule(payable(MODULE)).calls(), 1);
        assertEq(BasicRecipientToken(payable(BASKET)).balanceOf(ACTOR), 10000 - amount);
        assertEq(BasicRecipientToken(payable(BASKET)).balanceOf(RECEIVER), 7000);
        assertEq(BasicRecipientToken(payable(BASKET)).totalSupply(), 100000 - amount);
        assertEq(BasicRecipientToken(payable(BASKET)).allowance(ACTOR, MODULE), 991);
        for (uint256 i; i < count; i++) {
            uint256 out = amount * (i + 1) + (i == selected ? bonus : 0);
            assertEq(token(i).balanceOf(ACTOR), 1000 + i + (external_ && i == selected ? 0 : out));
            assertEq(token(i).balanceOf(RECEIVER), 2000 + i + (external_ && i == selected ? out : 0));
            assertEq(token(i).balanceOf(BASKET), 100000 - out); assertEq(token(i).balanceOf(address(999)), 0);
            assertEq(token(i).allowance(ACTOR, MODULE), 123 + i); assertEq(address(token(i)).balance, 100);
        }
        assertEq(ACTOR.balance, 17); assertEq(RECEIVER.balance, 23); assertEq(MODULE.balance, 100);
    }
    function testAllFourRoutesTwoAmountsSelfExternalAndActualBonusReceipt() public {
        for (uint256 selected; selected < 4; selected++) for (uint256 k; k < 2; k++) for (uint256 a; a < 2; a++) for (uint256 b; b < 2; b++) {
            uint256 amount = a == 0 ? 1 : 100; uint256 bonus = b == 0 ? 0 : 7; prepare(4, selected, 0, 0, bonus);
            BotVM(payable(ACTOR)).execute(script(4, selected, k == 0 ? "self" : "external", amount)); checkPositive(selected, k == 1, amount, bonus);
        }
    }
    function testTransferFalseAndEmptyUseActualBalances() public {
        for (uint256 selected; selected < 4; selected++) for (uint256 mode = 1; mode <= 2; mode++) {
            prepare(4, selected, 0, mode, 0); BotVM(payable(ACTOR)).execute(script(4, selected, "external", 100)); checkPositive(selected, true, 100, 0);
        }
    }
    function testAllNineteenFaultsRejectAndRollBackFullBasketSupplyAllowancesAndNative() public {
        for (uint256 selected; selected < 4; selected++) for (uint256 f = 1; f <= 19; f++) {
            prepare(4, selected, f, 0, 0); bytes32 before = digest(); bytes memory code = script(4, selected, "external", 100);
            vm.expectRevert(); BotVM(payable(ACTOR)).execute(code); assertEq(digest(), before);
        }
    }
    function testUnguardedSentinelsAdmitSameFaults() public {
        for (uint256 selected; selected < 4; selected++) for (uint256 f = 1; f <= 19; f++) {
            prepare(4, selected, f, 0, 0); BotVM(payable(ACTOR)).execute(script(4, selected, "unguarded", 100));
            assertEq(BasicRecipientModule(payable(MODULE)).calls(), 1);
        }
    }
    function testZeroAndUnfundedIdenticalProgramsRejectWithoutMutation() public {
        for (uint256 selected; selected < 4; selected++) for (uint256 k; k < 2; k++) {
            prepare(4, selected, 0, 0, 0); bytes32 before = digest(); bytes memory code = script(4, selected, k == 0 ? "self" : "external", 0);
            vm.expectRevert(); BotVM(payable(ACTOR)).execute(code); assertEq(digest(), before);
            BasicRecipientToken(payable(BASKET)).set(ACTOR, 0); before = digest(); code = script(4, selected, k == 0 ? "self" : "external", 100);
            vm.expectRevert(); BotVM(payable(ACTOR)).execute(code); assertEq(digest(), before);
        }
    }
    function testThirtyThreeComponentsRemainEncodableWithoutSubprogramDepthOverflow() public {
        for (uint256 k; k < 2; k++) {
            uint256 selected = k == 0 ? 0 : 32; prepare(33, selected, 0, 0, 7);
            BotVM(payable(ACTOR)).execute(script(33, selected, "external", 100)); checkPositive(selected, true, 100, 7);
        }
    }
}
