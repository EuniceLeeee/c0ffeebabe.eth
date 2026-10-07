// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import "forge-std/Test.sol";
import {BotVM} from "src/BotVM.sol";
import {SetRuntimeToken, SetRuntimeBasket, SetRuntimeModule, SetRuntimeReturn} from "./RuntimeAmount.t.sol";

// Synthetic contracts and balances. The emitter and inherited BotVM are real;
// this is not deployed Set bytecode, historical state, Ready or production EV.
contract SetRuntimeInspectableBot is BotVM {
    function runtimeState() external view returns (uint256 target, bytes32 hash, uint256 state) {
        uint256 targetSlot = uint256(keccak256("BotVM.runtime.callback.target"));
        uint256 hashSlot = uint256(keccak256("BotVM.runtime.callback.hash"));
        assembly { target := tload(targetSlot) hash := tload(hashSlot) state := tload(0x1337) }
    }
}
contract SetRuntimeOuterCallback {
    uint256 public mode;
    uint256 public callbacks;
    function configure(uint256 value) external { mode = value; }
    function run(bytes calldata script) external {
        if (mode == 1) return;
        bytes memory delivered = script;
        if (mode == 2) delivered = bytes.concat(script, hex"00");
        (bool ok,) = msg.sender.call(abi.encodeWithSignature("setRuntimeCallback(bytes)", delivered));
        require(ok, "callback failed");
        (uint256 target, bytes32 hash, uint256 state) = SetRuntimeInspectableBot(payable(msg.sender)).runtimeState();
        require(target == 1 && hash == keccak256(script) && state == uint256(68) << 224, "callback state changed");
        callbacks++;
        if (mode == 3) {
            (ok,) = msg.sender.call(abi.encodeWithSignature("setRuntimeCallback(bytes)", script));
            require(ok, "repeated callback refused");
        }
    }
}
contract SetRedemptionNestedRuntimeTest is Test {
    SetRuntimeInspectableBot bot;
    SetRuntimeBasket basket;
    SetRuntimeModule module;
    SetRuntimeReturn returnPool;
    SetRuntimeToken[] tokens;
    bytes program;
    uint256 constant NONE = type(uint256).max;

    function prepare(uint256 count) internal {
        bot = new SetRuntimeInspectableBot(); module = new SetRuntimeModule(); returnPool = new SetRuntimeReturn();
        delete tokens;
        address[] memory addresses = new address[](count);
        for (uint256 i; i < count; ++i) {
            SetRuntimeToken token = new SetRuntimeToken(); tokens.push(token); addresses[i] = address(token);
            token.mint(address(bot), 1_000_000e18 + i);
            token.seedAllowance(address(bot), address(module), 123 + i);
        }
        basket = new SetRuntimeBasket(addresses); basket.mint(address(bot), 1_000_000e18);
        basket.seedAllowance(address(bot), address(module), 991); vm.deal(address(bot), 777);
        string[] memory args = new string[](7 + count);
        args[0] = "node"; args[1] = "listener/node_modules/tsx/dist/cli.mjs";
        args[2] = "listener/src/searcher/venues/protocols/set-redemption-family/test/runtime-evm-program.ts";
        args[3] = vm.toString(address(basket)); args[4] = vm.toString(address(module));
        args[5] = vm.toString(address(this)); args[6] = vm.toString(address(bot));
        for (uint256 i; i < count; ++i) args[7 + i] = vm.toString(address(tokens[i]));
        program = vm.ffi(args);
        assertLe(program.length, 65536);
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
    function callbackScript(SetRuntimeOuterCallback callback_, uint256 selected, uint256 amount) internal view returns (bytes memory) {
        bytes memory payload = abi.encodeCall(SetRuntimeOuterCallback.run, (flow(selected, amount)));
        bytes memory outer = abi.encodePacked(uint8(1), uint8(1), address(callback_), uint8(0), uint8(255),
            uint24(68), uint24(68), uint8(0), uint24(payload.length), payload,
            uint8(0), uint8(1), uint256(7), uint8(3), uint8(0), uint8(1)); // parent r0 remains 7
        return abi.encodePacked(uint8(14), uint256(7), uint24(outer.length), outer);
    }
    function assertNoCallbackState() internal view {
        (uint256 target, bytes32 hash, uint256 state) = bot.runtimeState();
        assertEq(target, 0); assertEq(hash, bytes32(0)); assertEq(state, 0);
    }
    function inventoryDigest() internal view returns (bytes32) {
        uint256[] memory balances = new uint256[](tokens.length);
        uint256[] memory allowances = new uint256[](tokens.length);
        for (uint256 i; i < tokens.length; ++i) {
            balances[i] = tokens[i].balanceOf(address(bot));
            allowances[i] = tokens[i].allowance(address(bot), address(module));
        }
        return keccak256(abi.encode(balances, allowances, basket.balanceOf(address(bot)),
            basket.allowance(address(bot), address(module)), address(bot).balance, module.calls(), returnPool.received()));
    }
    function executeAndCheck(uint256 selected, uint256 amount) internal {
        uint256 beforeSet = basket.balanceOf(address(bot));
        uint256 beforeCalls = module.calls();
        uint256[] memory beforeTokens = new uint256[](tokens.length);
        uint256[] memory expected = new uint256[](tokens.length);
        for (uint256 i; i < tokens.length; ++i) {
            beforeTokens[i] = tokens[i].balanceOf(address(bot));
            expected[i] = amount * uint256(basket.getDefaultPositionRealUnit(address(tokens[i]))) / 1e18;
        }
        module.configure(NONE, selected, 0, true);
        bot.execute(flow(selected, amount));
        uint256 receipt = expected[selected] + 7;
        assertEq(returnPool.received(), receipt, "next leg gets receipt, never expected output or old inventory");
        assertEq(module.calls(), beforeCalls + 1, "exactly one whole-basket redemption");
        assertEq(basket.balanceOf(address(bot)), beforeSet - amount + receipt * 10);
        for (uint256 i; i < tokens.length; ++i) {
            assertEq(tokens[i].balanceOf(address(bot)), beforeTokens[i] + (i == selected ? 0 : expected[i]));
            assertEq(tokens[i].allowance(address(bot), address(module)), 123 + i);
        }
        assertEq(basket.allowance(address(bot), address(module)), 991);
        assertEq(address(bot).balance, 777); assertNoCallbackState();
    }
    function testNineAllDirectionsTwoAmountsNoInventoryOrSideOutputLoss() public {
        prepare(9);
        for (uint256 selected; selected < 9; ++selected) {
            executeAndCheck(selected, 1e18 + 1);
            executeAndCheck(selected, 10 * (1e18 + 1));
        }
        assertEq(module.calls(), 18);
    }
    function testMaximumEncodable187ComponentsAllReceiptsAndExtremeDirections() public {
        prepare(187);
        assertEq(program.length, 65313);
        executeAndCheck(0, 1e18 + 1); executeAndCheck(0, 10 * (1e18 + 1));
        executeAndCheck(186, 1e18 + 1); executeAndCheck(186, 10 * (1e18 + 1));
        assertEq(module.calls(), 4);
    }
    function testCrossGroupShortfallsAndExtraSetDebitRollBackAtomically() public {
        prepare(17);
        uint256[5] memory indices = [uint256(0), 7, 8, 15, 16];
        bytes32 before = inventoryDigest();
        for (uint256 i; i < indices.length; ++i) {
            module.configure(indices[i], NONE, 0, true);
            vm.expectRevert(); bot.execute(flow(8, 1e18));
            assertEq(inventoryDigest(), before); assertNoCallbackState();
        }
        module.configure(NONE, NONE, 1, true);
        vm.expectRevert(); bot.execute(flow(8, 1e18));
        assertEq(inventoryDigest(), before); assertNoCallbackState();
        module.configure(NONE, NONE, 0, false);
        vm.expectRevert(); bot.execute(flow(8, 1e18));
        assertEq(inventoryDigest(), before); assertNoCallbackState();
    }
    function testCrossGroupWrongMembersAndNegativeUnitsRejectBeforeRedeem() public {
        prepare(17);
        bytes32 before = inventoryDigest();
        basket.reverseComponents();
        vm.expectRevert(); bot.execute(flow(8, 1e18));
        assertEq(inventoryDigest(), before);
        basket.reverseComponents();
        for (uint256 index = 8; index <= 16; index += 8) {
            basket.changeUnit(address(tokens[index]), -1);
            vm.expectRevert(); bot.execute(flow(8, 1e18));
            assertEq(inventoryDigest(), before); assertNoCallbackState();
            basket.changeUnit(address(tokens[index]), int256((index + 1) * 1e18));
        }
    }
    function testCrossGroupZeroAndFractionalUnitsReadAtExecution() public {
        prepare(9);
        basket.changeUnit(address(tokens[0]), 0);
        basket.changeUnit(address(tokens[8]), int256(uint256(1e18) / 3));
        executeAndCheck(8, 1e18 + 1); executeAndCheck(8, 10 * (1e18 + 1));
    }
    function testNestedSelfCallPreservesAuthenticatedOuterCallbackScopeAndParentAmount() public {
        prepare(9);
        SetRuntimeOuterCallback callback_ = new SetRuntimeOuterCallback();
        bytes memory script = callbackScript(callback_, 8, 1e18);
        bot.execute(script); assertEq(callback_.callbacks(), 1); assertNoCallbackState();
        bot.execute(script); assertEq(callback_.callbacks(), 2); assertNoCallbackState();
        assertEq(module.calls(), 2);
        vm.expectRevert("not self"); bot.execSubscript(hex"00");
    }
    function testCallbackMissingChangedRepeatedAndNestedFailureCannotEscapeRollback() public {
        prepare(9);
        SetRuntimeOuterCallback callback_ = new SetRuntimeOuterCallback();
        bytes memory script = callbackScript(callback_, 8, 1e18);
        bytes32 before = inventoryDigest();
        for (uint256 mode = 1; mode <= 3; ++mode) {
            callback_.configure(mode);
            vm.expectRevert(); bot.execute(script);
            assertEq(inventoryDigest(), before); assertEq(callback_.callbacks(), 0); assertNoCallbackState();
        }
        callback_.configure(0); module.configure(0, NONE, 0, true); // failure after child redemption returned
        vm.expectRevert(); bot.execute(script);
        assertEq(inventoryDigest(), before); assertEq(callback_.callbacks(), 0); assertNoCallbackState();
    }
}
