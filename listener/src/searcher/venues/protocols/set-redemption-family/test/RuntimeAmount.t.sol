// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import "forge-std/Test.sol";
import {BotVM} from "src/BotVM.sol";

// Isolated synthetic contracts. They test the real Family-emitted program and
// BotVM, NOT deployed Set bytecode, historical state, admission or full-route EV.
contract SetRuntimeToken {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    function mint(address who, uint256 amount) external { balanceOf[who] += amount; }
    function burn(address who, uint256 amount) external { balanceOf[who] -= amount; }
    function seedAllowance(address who, address spender, uint256 value) external { allowance[who][spender] = value; }
}
contract SetRuntimeBasket is SetRuntimeToken {
    address[] private components;
    mapping(address => int256) private units;
    constructor(address[] memory tokens) {
        components = tokens;
        for (uint256 i; i < tokens.length; ++i) units[tokens[i]] = int256((i + 1) * 1e18);
    }
    function getComponents() external view returns (address[] memory) { return components; }
    function getDefaultPositionRealUnit(address token) external view returns (int256) { return units[token]; }
    function changeUnit(address token, int256 value) external { units[token] = value; }
    function reverseComponents() external {
        (components[0], components[components.length - 1]) = (components[components.length - 1], components[0]);
    }
}
contract SetRuntimeModule {
    uint256 public calls;
    uint256 public shortIndex = type(uint256).max;
    uint256 public bonusIndex = type(uint256).max;
    uint256 public extraBurn;
    bool public enabled = true;
    function configure(uint256 short_, uint256 bonus_, uint256 burn_, bool enabled_) external {
        shortIndex = short_; bonusIndex = bonus_; extraBurn = burn_; enabled = enabled_;
    }
    function redeem(SetRuntimeBasket basket, uint256 amount, address receiver) external {
        require(enabled && amount > 0, "mock native eligibility");
        calls++;
        basket.burn(msg.sender, amount + extraBurn);
        address[] memory tokens = basket.getComponents();
        for (uint256 i; i < tokens.length; ++i) {
            int256 signedUnit = basket.getDefaultPositionRealUnit(tokens[i]);
            require(signedUnit >= 0, "negative unit");
            uint256 output = amount * uint256(signedUnit) / 1e18;
            SetRuntimeToken(tokens[i]).mint(receiver, output + (i == bonusIndex ? 7 : 0) - (i == shortIndex ? 1 : 0));
        }
    }
}
contract SetRuntimeReturn {
    uint256 public received;
    function swap(SetRuntimeToken token, SetRuntimeToken output, uint256 amount) external {
        received = amount;
        token.burn(msg.sender, amount);
        output.mint(msg.sender, amount * 10);
    }
}
contract SetRedemptionRuntimeTest is Test {
    BotVM bot;
    SetRuntimeBasket basket;
    SetRuntimeModule module;
    SetRuntimeReturn returnPool;
    SetRuntimeToken[4] tokens;
    bytes program;
    uint256 constant NONE = type(uint256).max;
    function setUp() public {
        bot = new BotVM(); module = new SetRuntimeModule(); returnPool = new SetRuntimeReturn();
        address[] memory addresses = new address[](4);
        for (uint256 i; i < 4; ++i) {
            tokens[i] = new SetRuntimeToken(); addresses[i] = address(tokens[i]);
            tokens[i].mint(address(bot), 1_000_000e18 + i);
            tokens[i].seedAllowance(address(bot), address(module), 123 + i);
        }
        basket = new SetRuntimeBasket(addresses); basket.mint(address(bot), 1_000_000e18);
        basket.seedAllowance(address(bot), address(module), 991);
        string[] memory args = new string[](11);
        args[0] = "node"; args[1] = "listener/node_modules/tsx/dist/cli.mjs";
        args[2] = "listener/src/searcher/venues/protocols/set-redemption-family/test/runtime-evm-program.ts";
        args[3] = vm.toString(address(basket)); args[4] = vm.toString(address(module));
        args[5] = vm.toString(address(this)); args[6] = vm.toString(address(bot));
        for (uint256 i; i < 4; ++i) args[7 + i] = vm.toString(address(tokens[i]));
        program = vm.ffi(args);
    }
    function flow(uint256 selected, uint256 amount) internal view returns (bytes memory) {
        bytes memory payload = abi.encodeCall(SetRuntimeReturn.swap, (tokens[selected], basket, 0));
        bytes memory next = abi.encodePacked(uint8(1), uint8(1), address(returnPool), uint8(0), uint8(255),
            uint24(0), uint24(0), uint8(1), uint24(68), uint8(0), uint24(payload.length), payload);
        bytes memory data = abi.encodePacked(amount, uint8(2),
            address(basket), address(tokens[selected]), uint256(1), uint24(program.length), program,
            address(tokens[selected]), address(basket), amount + 1, uint24(next.length), next);
        return abi.encodePacked(uint8(12), uint24(data.length), data);
    }
    function testAllFourDirectionsAndTwoAmountsUseReceiptAndPreserveBasketInventory() public {
        for (uint256 selected; selected < 4; ++selected) for (uint256 scale = 1; scale <= 10; scale += 9) {
            uint256 amount = scale * 1e18;
            uint256 beforeSet = basket.balanceOf(address(bot));
            uint256[4] memory beforeTokens;
            for (uint256 i; i < 4; ++i) beforeTokens[i] = tokens[i].balanceOf(address(bot));
            module.configure(NONE, selected, 0, true);
            bot.execute(flow(selected, amount));
            uint256 actual = amount * (selected + 1) + 7;
            assertEq(returnPool.received(), actual, "next hop uses receipt, not threshold or inventory");
            assertEq(basket.balanceOf(address(bot)), beforeSet - amount + actual * 10);
            for (uint256 i; i < 4; ++i) {
                assertEq(tokens[i].balanceOf(address(bot)), beforeTokens[i] + (i == selected ? 0 : amount * (i + 1)));
                assertEq(tokens[i].allowance(address(bot), address(module)), 123 + i);
            }
            assertEq(basket.allowance(address(bot), address(module)), 991);
        }
        assertEq(module.calls(), 8);
    }
    function testEveryComponentShortfallRevertsDespiteExistingInventory() public {
        for (uint256 i; i < 4; ++i) {
            module.configure(i, NONE, 0, true);
            vm.expectRevert(); bot.execute(flow(0, 1e18));
            assertEq(module.calls(), 0); assertEq(basket.balanceOf(address(bot)), 1_000_000e18);
            for (uint256 j; j < 4; ++j) assertEq(tokens[j].balanceOf(address(bot)), 1_000_000e18 + j);
        }
    }
    function testExtraInputDebitAndNativeRejectionRevert() public {
        module.configure(NONE, NONE, 1, true);
        vm.expectRevert("runtime amount mismatch"); bot.execute(flow(0, 1e18));
        module.configure(NONE, NONE, 0, false);
        vm.expectRevert("runtime external call"); bot.execute(flow(0, 1e18));
        assertEq(module.calls(), 0);
    }
    function testMembershipChangeAndNegativeUnitRejectBeforeRedeem() public {
        basket.reverseComponents();
        vm.expectRevert("runtime amount mismatch"); bot.execute(flow(0, 1e18));
        basket.reverseComponents(); basket.changeUnit(address(tokens[3]), -1);
        vm.expectRevert(stdError.arithmeticError); bot.execute(flow(0, 1e18));
        assertEq(module.calls(), 0);
    }
    function testZeroExtraOutputAndUpdatedFractionalUnitsAreReadAtExecution() public {
        uint256 fractionalUnit = uint256(1e18) / 3;
        basket.changeUnit(address(tokens[1]), int256(fractionalUnit));
        basket.changeUnit(address(tokens[2]), 0);
        uint256 beforeExtra = tokens[2].balanceOf(address(bot));
        bot.execute(flow(1, 1e18 + 1));
        assertEq(returnPool.received(), (1e18 + 1) * fractionalUnit / 1e18);
        assertEq(tokens[2].balanceOf(address(bot)), beforeExtra);
    }
}
