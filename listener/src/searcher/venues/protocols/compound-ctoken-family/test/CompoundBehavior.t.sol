// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import {BotVM} from "src/BotVM.sol";

interface CompoundTestVm {
    function ffi(string[] calldata) external returns (bytes memory);
    function toString(address) external pure returns (string memory);
    function toString(uint256) external pure returns (string memory);
}
// Synthetic protocol only; execution below always uses the real repository BotVM.
contract CompoundTestToken {
    mapping(address => uint256) public balanceOf;
    uint256 public totalSupply;
    function mint(address to, uint256 value) external { balanceOf[to] += value; totalSupply += value; }
    function burn(address from, uint256 value) external { balanceOf[from] -= value; totalSupply -= value; }
    function transfer(address to, uint256 value) external returns (bool) {
        balanceOf[msg.sender] -= value; balanceOf[to] += value; return true;
    }
}
contract CompoundTestMarket is CompoundTestToken {
    CompoundTestToken public immutable underlying;
    uint256 public mode;
    uint256 public calls;
    uint256 public rate = 2e18;
    event Redeem(address redeemer, uint256 redeemAmount, uint256 redeemTokens);
    constructor(CompoundTestToken token) { underlying = token; }
    function configure(uint256 value) external { mode = value; }
    function exchangeRateCurrent() external view returns (uint256) { return rate; }
    function getCash() external view returns (uint256) { return underlying.balanceOf(address(this)); }
    function redeem(uint256 shares) external returns (uint256) {
        calls++;
        if (mode == 1) return 14; // genuine non-revert failure with no effects
        if (mode == 3) return 0;  // false success: no effects
        if (mode == 8) revert("native redemption failed");
        uint256 burn = shares + (mode == 5 ? 1 : 0);
        balanceOf[msg.sender] -= burn; totalSupply -= burn;
        uint256 amount = shares * rate / 1e18;
        uint256 paid = mode == 7 ? 0 : amount - (mode == 4 ? 1 : 0);
        underlying.transfer(msg.sender, paid);
        emit Redeem(msg.sender, amount, shares);
        if (mode == 6) assembly { return(0, 0) }
        return mode == 2 ? 14 : 0; // effects do not make a nonzero code successful
    }
}
contract CompoundTestReturn {
    uint256 public received;
    function swap(CompoundTestToken underlying, CompoundTestToken share, uint256 amount) external {
        received = amount;
        underlying.burn(msg.sender, amount);
        share.mint(msg.sender, amount);
    }
}
contract CompoundBehaviorTest {
    CompoundTestVm constant vm = CompoundTestVm(address(uint160(uint256(keccak256("hevm cheat code")))));
    BotVM bot;
    CompoundTestToken token;
    CompoundTestMarket market;
    CompoundTestReturn returnPool;
    uint256 constant STOCK = 1e12;
    function setUp() public {
        bot = new BotVM(); token = new CompoundTestToken(); market = new CompoundTestMarket(token);
        returnPool = new CompoundTestReturn();
        market.mint(address(bot), STOCK); token.mint(address(bot), STOCK);
        token.mint(address(market), STOCK);
    }
    function script(string memory mode, uint256 amount, uint256 minimum) internal returns (bytes memory) {
        string[] memory args = new string[](12);
        args[0] = "node"; args[1] = "listener/node_modules/tsx/dist/cli.mjs";
        args[2] = "listener/src/searcher/venues/protocols/compound-ctoken-family/test/evm-program.ts";
        args[3] = mode; args[4] = vm.toString(address(market)); args[5] = vm.toString(address(token));
        args[6] = vm.toString(address(bot)); args[7] = vm.toString(address(returnPool));
        args[8] = vm.toString(amount); args[9] = vm.toString(minimum);
        args[10] = vm.toString(market.exchangeRateCurrent()); args[11] = vm.toString(market.getCash());
        return vm.ffi(args);
    }
    function testQuotedTwoAmountsMatchActualDelta() public {
        for (uint256 amount = 11; amount <= 110; amount *= 10) {
            uint256 shares = market.balanceOf(address(bot)); uint256 cash = token.balanceOf(address(bot));
            uint256 supply = market.totalSupply();
            bot.execute(script("quoted", amount, 2 * amount));
            require(market.balanceOf(address(bot)) == shares - amount, "exact shares burned");
            require(market.totalSupply() == supply - amount, "exact supply burned");
            require(token.balanceOf(address(bot)) == cash + 2 * amount, "actual quoted receipt");
        }
    }
    function testRuntimePassesActualReceiptToNextHopWithoutSpendingOldInventory() public {
        for (uint256 amount = 11; amount <= 110; amount *= 10) {
            uint256 shares = market.balanceOf(address(bot));
            // Deliberate 1-unit short native transfer: runtime passes actual
            // receipt, never a quoted amount or the executor's old token stock.
            market.configure(4);
            bot.execute(script("flow", amount, 1));
            require(returnPool.received() == 2 * amount - 1, "next hop actual amount");
            require(token.balanceOf(address(bot)) == STOCK, "old underlying retained");
            require(market.balanceOf(address(bot)) == shares - amount + 2 * amount - 1, "closed flow balance");
        }
    }
    function assertAtomicFailure(bytes memory code) internal {
        (bool ok,) = address(bot).call(abi.encodeCall(BotVM.execute, (code)));
        require(!ok, "invalid redemption accepted");
        require(market.calls() == 0, "call state not rolled back");
        require(market.balanceOf(address(bot)) == STOCK && market.totalSupply() == STOCK, "share rollback");
        require(token.balanceOf(address(bot)) == STOCK && token.balanceOf(address(market)) == STOCK, "cash rollback");
    }
    function testNonzeroCodeFalseSuccessEmptyResultAndOverburnAreAtomic() public {
        bytes memory quoted = script("quoted", 11, 22);
        bytes memory runtime = script("runtime", 11, 1);
        for (uint256 mode = 1; mode <= 8; mode++) {
            if (mode == 4) continue; // positive runtime receipts need not equal a quote
            market.configure(mode);
            assertAtomicFailure(quoted);
            assertAtomicFailure(runtime);
        }
    }
    function testQuotedMinimumCannotBePaidFromExistingInventory() public {
        market.configure(4);
        assertAtomicFailure(script("quoted", 11, 22));
        bot.execute(script("quoted", 11, 21));
        require(token.balanceOf(address(bot)) == STOCK + 21, "minimum must check delta");
    }
    function testProductionRuntimeFlowAlsoRejectsNoOutputNonrevertFailure() public {
        market.configure(1);
        assertAtomicFailure(script("flow", 11, 1));
    }
}
