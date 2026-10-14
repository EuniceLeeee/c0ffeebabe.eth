// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import "forge-std/Test.sol";
import {BotVM} from "../src/BotVM.sol";

// Synthetic protocol and tokens, preserving the verified output/callback/pull
// order. All programs under test come from the current TypeScript producers.
contract YearnSettlementToken {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    function mint(address to, uint256 amount) external { balanceOf[to] += amount; }
    function burn(address from, uint256 amount) external { balanceOf[from] -= amount; }
    function transfer(address to, uint256 amount) external returns (bool) {
        balanceOf[msg.sender] -= amount; balanceOf[to] += amount; return true;
    }
    function approve(address to, uint256 amount) external returns (bool) { allowance[msg.sender][to] = amount; return true; }
    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        allowance[from][msg.sender] -= amount; balanceOf[from] -= amount; balanceOf[to] += amount; return true;
    }
}
contract YearnSettlementRelay {
    function relay(address actor, bytes memory data) external {
        (bool ok, bytes memory reason) = actor.call(data); if (!ok) assembly { revert(add(reason, 32), mload(reason)) }
    }
}
contract YearnSettlementAuction {
    YearnSettlementToken constant WANT = YearnSettlementToken(address(83));
    YearnSettlementToken constant SOLD = YearnSettlementToken(address(84));
    address public receiver;
    uint256 public price;
    uint256 public capacity;
    uint256 public fault;
    uint256 public stage;
    uint256 public paid;
    function configure(uint256 cap, uint256 p, uint256 f, address proceeds) external {
        capacity = cap; price = p; fault = f; receiver = proceeds; stage = 0; paid = 0;
    }
    function available(address from) public view returns (uint256) {
        require(from == address(SOLD)); uint256 balance = SOLD.balanceOf(address(this));
        return price == 0 ? 0 : balance < capacity ? balance : capacity;
    }
    function getAmountNeeded(address from, uint256 amount) public view returns (uint256) {
        require(from == address(SOLD)); return amount * price / 1e18;
    }
    function take(address from, uint256 maximum) external returns (uint256) { return _take(from, maximum, msg.sender, ""); }
    function take(address from, uint256 maximum, address taker) external returns (uint256) { return _take(from, maximum, taker, ""); }
    function take(address from, uint256 maximum, address taker, bytes memory data) external returns (uint256) { return _take(from, maximum, taker, data); }
    function _take(address from, uint256 maximum, address taker, bytes memory data) internal returns (uint256 output) {
        output = available(from); if (maximum < output) output = maximum;
        uint256 needed = getAmountNeeded(from, output); require(needed > 0, "zero debt");
        if (fault != 17) SOLD.transfer(fault == 8 ? address(86) : taker, fault == 7 ? 0 : fault == 6 ? output - 1 : output);
        stage = 1;
        if (data.length > 0 && fault != 9) {
            require(WANT.allowance(msg.sender, address(this)) == 0, "approval before callback");
            if (fault == 10) data[0] = bytes1(uint8(data[0]) ^ 1);
            bytes memory callback = abi.encodeWithSignature("auctionTakeCallback(address,address,uint256,uint256,bytes)",
                fault == 1 ? address(WANT) : from, fault == 2 ? address(91) : msg.sender,
                fault == 3 ? output + 1 : output, fault == 5 ? 0 : fault == 4 ? needed + 1 : needed, data);
            if (fault == 12) new YearnSettlementRelay().relay(taker, callback);
            else {
                (bool ok, bytes memory reason) = taker.call(callback); if (!ok) assembly { revert(add(reason, 32), mload(reason)) }
                if (fault == 11) { (ok, reason) = taker.call(callback); if (!ok) assembly { revert(add(reason, 32), mload(reason)) } }
            }
        }
        stage = 2;
        paid = fault == 14 ? 0 : fault == 13 ? needed - 1 : fault == 15 ? needed + 1 : needed;
        WANT.transferFrom(msg.sender, receiver, paid);
        if (fault == 18) { (bool ok,) = msg.sender.call{value: 1}(""); require(ok); }
        if (fault == 21) { (bool ok,) = taker.call{value: 1}(""); require(ok); }
        if (fault == 19) SOLD.burn(taker, 1);
        if (fault == 20) WANT.burn(msg.sender, 1);
        stage = 3;
        return fault == 16 ? output + 1 : output;
    }
    receive() external payable {}
}
contract YearnSettlementPrefix {
    YearnSettlementToken constant WANT = YearnSettlementToken(address(83));
    YearnSettlementToken constant SOLD = YearnSettlementToken(address(84));
    uint256 public bonus;
    int256 public debitDelta;
    int256 public creditDelta;
    uint256 public returnMode;
    uint256 public calls;
    function configure(uint256 b, int256 d, int256 c, uint256 r) external { bonus = b; debitDelta = d; creditDelta = c; returnMode = r; calls = 0; }
    function quote(uint256 amount) public view returns (uint256) { return amount * 3 + bonus; }
    function swap(address to, uint256 amount) external returns (uint256) {
        YearnSettlementAuction auction = YearnSettlementAuction(payable(address(81)));
        require(auction.stage() == 1 && auction.paid() == 0, "callback order");
        calls++;
        SOLD.burn(msg.sender, uint256(int256(amount) + debitDelta));
        uint256 credit = uint256(int256(quote(amount)) + creditDelta); WANT.mint(to, credit);
        return returnMode == 1 ? 0 : returnMode == 2 ? type(uint256).max : credit;
    }
}
contract YearnAuctionSettlementTest is Test {
    address constant ACTOR = address(71);
    address constant TARGET = address(81);
    address constant WANT = address(83);
    address constant SOLD = address(84);
    address constant PROCEEDS = address(85);
    address constant PREFIX = address(89);
    address constant TAKER = address(91);
    uint256 constant STOCK = 777;
    function setUp() public {
        vm.etch(ACTOR, address(new BotVM()).code);
        bytes memory code = address(new YearnSettlementToken()).code; vm.etch(WANT, code); vm.etch(SOLD, code);
        vm.etch(TARGET, address(new YearnSettlementAuction()).code);
        vm.etch(PREFIX, address(new YearnSettlementPrefix()).code);
    }
    function setBalance(address token, address account, uint256 value) internal {
        vm.store(token, keccak256(abi.encode(account, uint256(0))), bytes32(value));
    }
    function prepare(uint256 cap, uint256 bonus, uint256 fault, bool funded) internal {
        setBalance(WANT, ACTOR, STOCK + (funded ? 300 + bonus : 0)); setBalance(SOLD, ACTOR, STOCK);
        setBalance(SOLD, TARGET, 1000); setBalance(WANT, PROCEEDS, 107); setBalance(SOLD, TAKER, 109);
        vm.deal(ACTOR, 17); vm.deal(TARGET, 100); vm.deal(TAKER, 23);
        YearnSettlementAuction(payable(TARGET)).configure(cap, 3e18, fault, PROCEEDS);
        YearnSettlementPrefix(PREFIX).configure(bonus, 0, 0, 0);
    }
    function script(string memory name) internal view returns (bytes memory) { return vm.envBytes(string.concat("YEARN_SETTLEMENT_", name)); }
    function run(string memory name) internal { BotVM(payable(ACTOR)).execute(script(name)); }
    function balances(uint256 want, uint256 sold, uint256 proceeds) internal view {
        assertEq(YearnSettlementToken(WANT).balanceOf(ACTOR), want, "actual want balance");
        assertEq(YearnSettlementToken(SOLD).balanceOf(ACTOR), sold, "actual sold balance");
        assertEq(YearnSettlementToken(WANT).balanceOf(PROCEEDS), proceeds, "actual proceeds");
        assertEq(YearnSettlementToken(WANT).allowance(ACTOR, TARGET), 0, "temporary allowance cleared");
        assertEq(ACTOR.balance, 17, "old native balance");
    }
    function testDefaultQuotedAndDirectPathsRemainPayable() public {
        for (uint256 mode; mode < 3; ++mode) {
            prepare(1000, 61, 0, true); run(mode == 0 ? "default" : mode == 1 ? "quoted" : "direct");
            balances(STOCK + 1, mode == 2 ? STOCK : STOCK + 120, 107 + 360);
            assertEq(YearnSettlementToken(SOLD).balanceOf(TAKER), mode == 2 ? 229 : 109);
        }
    }
    function testAllFundedModesRejectUnderDebitAndProtectBalances() public {
        uint256[8] memory faults = [uint256(13), 14, 15, 6, 8, 16, 18, 20];
        for (uint256 mode; mode < 3; ++mode) {
            bytes memory program = script(mode == 0 ? "default" : mode == 1 ? "quoted" : "direct");
            for (uint256 i; i < faults.length; ++i) {
                prepare(1000, 61, faults[i], true);
                vm.expectRevert(); BotVM(payable(ACTOR)).execute(program);
                balances(STOCK + 361, STOCK, 107);
                assertEq(YearnSettlementToken(SOLD).balanceOf(TAKER), 109);
                assertEq(YearnSettlementToken(SOLD).balanceOf(TARGET), 1000);
            }
        }
    }
    function testExternalRecipientNativeGiftDoesNotChangeExecutorInventory() public {
        prepare(1000, 61, 21, true); run("direct");
        balances(STOCK + 1, STOCK, 107 + 360);
        assertEq(YearnSettlementToken(SOLD).balanceOf(TAKER), 229);
        assertEq(TAKER.balance, 24);
    }
    function testReadOnlyQuoteNeedsNoInputAndCapsCapacity() public {
        prepare(1000, 61, 0, false); setBalance(WANT, ACTOR, 0); run("quote120"); balances(0, STOCK, 107);
        prepare(110, 61, 0, false); setBalance(WANT, ACTOR, 0); run("quote110"); balances(0, STOCK, 107);
        assertEq(YearnSettlementAuction(payable(TARGET)).stage(), 0);
    }
    function testCallbackDebtBudgetAndCapacityRefunds() public {
        for (uint256 mode; mode < 2; ++mode) {
            prepare(1000, 61, 0, false); run(mode == 0 ? "deferred" : "root"); balances(STOCK + 1, STOCK + 20, 107 + 360);
            assertEq(YearnSettlementPrefix(PREFIX).calls(), 1); assertEq(YearnSettlementAuction(payable(TARGET)).stage(), 3);
            prepare(110, 61, 0, false); run(mode == 0 ? "deferred" : "root"); balances(STOCK + 31, STOCK + 10, 107 + 330);
        }
        prepare(1000, 60, 0, false); run("root"); balances(STOCK, STOCK + 20, 107 + 360);
    }
    function testCallbackAuthenticationDebtReceiptsAndRollback() public {
        bytes memory program = script("root");
        for (uint256 fault = 1; fault <= 20; ++fault) {
            prepare(1000, 61, fault, false);
            vm.expectRevert(); BotVM(payable(ACTOR)).execute(program);
            balances(STOCK, STOCK, 107); assertEq(YearnSettlementToken(SOLD).balanceOf(TARGET), 1000);
            assertEq(YearnSettlementPrefix(PREFIX).calls(), 0); assertEq(YearnSettlementAuction(payable(TARGET)).stage(), 0);
        }
    }
    function testPrefixInputAndReceiptCannotUseOldInventory() public {
        bytes memory program = script("root");
        int256[4] memory changes = [int256(-100), -1, 1, 2];
        for (uint256 i; i < changes.length; ++i) {
            prepare(1000, 61, 0, false); YearnSettlementPrefix(PREFIX).configure(61, changes[i], 0, 0);
            vm.expectRevert(); BotVM(payable(ACTOR)).execute(program); balances(STOCK, STOCK, 107);
            prepare(1000, 61, 0, false); YearnSettlementPrefix(PREFIX).configure(61, 0, changes[i], 0);
            vm.expectRevert(); BotVM(payable(ACTOR)).execute(program); balances(STOCK, STOCK, 107);
        }
    }
    function testReturnDataDoesNotReplaceMeasuredPrefixCredit() public {
        for (uint256 mode = 1; mode <= 2; ++mode) {
            prepare(1000, 61, 0, false); YearnSettlementPrefix(PREFIX).configure(61, 0, 0, mode);
            run("root"); balances(STOCK + 1, STOCK + 20, 107 + 360);
        }
    }
    function testOpeningFloorFinalProfitAndProceedsSeparation() public {
        bytes memory program = script("root");
        for (uint256 cap = 99; cap <= 100; ++cap) {
            prepare(cap, 61, 0, false); vm.expectRevert(); BotVM(payable(ACTOR)).execute(program); balances(STOCK, STOCK, 107);
        }
        prepare(1000, 61, 0, false);
        YearnSettlementAuction(payable(TARGET)).configure(1000, 3e18, 0, ACTOR);
        vm.expectRevert(); BotVM(payable(ACTOR)).execute(program); balances(STOCK, STOCK, 107);
        prepare(1000, 61, 0, false);
        YearnSettlementAuction(payable(TARGET)).configure(1000, 0, 0, PROCEEDS);
        vm.expectRevert(); BotVM(payable(ACTOR)).execute(program); balances(STOCK, STOCK, 107);
    }
}
