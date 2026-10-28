// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import "forge-std/Test.sol";
import {BotVM} from "src/BotVM.sol";

// Actual saved PSV proxy/implementation runtime; fresh synthetic storage and
// tokens. This is local EVM correctness, not historical fee/cap state evidence.
interface IPsvFixture {
    function initialize(address,address,address,address,address,address) external;
    function setFees(uint256,uint256) external;
    function setRateLimits(uint256,uint256) external;
    function setTreasury(address) external;
    function setWhitelist(address,bool) external;
    function pause() external;
    function getRemainingBlockCapacity() external view returns(uint256);
    function previewSellGem(uint256,address) external view returns(uint256,uint256);
    function previewBuyGem(uint256,address) external view returns(uint256,uint256);
}
contract PsvFixtureToken {
    uint8 public immutable decimals;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    int256 public debitOffset;
    int256 public creditOffset;
    bool public wrongReceiver;
    bool public falseApproval;
    constructor(uint8 n) { decimals = n; }
    function mint(address who, uint256 n) external { balanceOf[who] += n; }
    function burn(address who, uint256 n) external { balanceOf[who] -= n; }
    function seedAllowance(address who,address spender,uint256 n) external { allowance[who][spender] = n; }
    function configure(int256 debit,int256 credit,bool wrong,bool failApproval) external {
        debitOffset = debit; creditOffset = credit; wrongReceiver = wrong; falseApproval = failApproval;
    }
    function approve(address spender,uint256 n) external returns(bool) { allowance[msg.sender][spender] = n; return !falseApproval; }
    function transferFrom(address from,address to,uint256 n) external returns(bool) {
        allowance[from][msg.sender] -= n;
        uint256 spent = uint256(int256(n) + debitOffset); balanceOf[from] -= spent; balanceOf[to] += spent; return true;
    }
    function transfer(address to,uint256 n) external returns(bool) {
        balanceOf[msg.sender] -= n;
        balanceOf[wrongReceiver ? address(0xBAD) : to] += uint256(int256(n) + creditOffset); return true;
    }
}
contract PsvFixtureShell {}
contract PsvRuntimeRecipientTest is Test {
    BotVM bot;
    IPsvFixture psv;
    PsvFixtureToken gem;
    PsvFixtureToken stable;
    address constant IMPLEMENTATION = address(0x1053);
    address constant RECEIVER = address(0x1057);
    address treasury;
    bytes[2] direct;
    bytes[2] quote;
    function setUp() public { install(6,6); }
    function install(uint8 gd,uint8 sd) internal {
        bot = new BotVM(); gem = new PsvFixtureToken(gd); stable = new PsvFixtureToken(sd);
        string memory saved = vm.readFile("listener/src/searcher/venues/protocols/psv-family/test/source-runtime.json");
        bytes memory proxy = vm.parseJsonBytes(saved,".proxy");
        assertEq(keccak256(proxy), 0x46a010df31eb642b47284650e80051e8f6239a0c995003d230b437810bc4b9b4);
        bytes memory implementation = vm.parseJsonBytes(saved,".implementation");
        bytes32 self = bytes32(uint256(uint160(IMPLEMENTATION)));
        for (uint256 j; j < 32; ++j) { implementation[4253+j] = self[j]; implementation[4473+j] = self[j]; }
        vm.etch(IMPLEMENTATION,implementation);
        address target = address(new PsvFixtureShell()); vm.etch(target,proxy);
        vm.store(target,0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc,self);
        treasury = address(0x1056); psv = IPsvFixture(target);
        psv.initialize(address(stable),address(gem),treasury,address(this),address(this),address(this));
        psv.setFees(1e15,5e14);
        gem.mint(target, 1_000_000e18); stable.mint(target,1_000_000e18);
        gem.mint(address(bot),100_000e18); stable.mint(address(bot),100_000e18);
        gem.mint(RECEIVER,107); stable.mint(RECEIVER,109); vm.deal(address(bot),17); vm.deal(RECEIVER,19);
        for (uint256 i; i < 2; ++i) { direct[i] = emitted(i,"direct-output"); quote[i] = emitted(i,"quote-output"); }
    }
    function emitted(uint256 direction,string memory mode) internal returns(bytes memory) {
        string[] memory args = new string[](13);
        args[0] = "node"; args[1] = "listener/node_modules/tsx/dist/cli.mjs";
        args[2] = "listener/src/searcher/venues/protocols/psv-family/test/runtime-evm-program.ts";
        args[3] = vm.toString(address(psv)); args[4] = vm.toString(IMPLEMENTATION);
        args[5] = vm.toString(address(gem)); args[6] = vm.toString(address(stable)); args[7] = vm.toString(address(bot));
        args[8] = vm.toString(RECEIVER); args[9] = vm.toString(direction);
        args[10] = vm.toString(gem.decimals()); args[11] = vm.toString(stable.decimals()); args[12] = mode;
        return vm.ffi(args);
    }
    function script(bytes memory program,uint256 amount) internal pure returns(bytes memory) {
        return abi.encodePacked(uint8(14),amount,uint24(program.length),program);
    }
    function successful(uint256 direction,uint256 amount) internal {
        PsvFixtureToken input = direction == 0 ? gem : stable;
        PsvFixtureToken output = direction == 0 ? stable : gem;
        (uint256 net,uint256 fee) = direction == 0 ? psv.previewSellGem(amount,RECEIVER) : psv.previewBuyGem(amount,RECEIVER);
        uint256 credit = net + (treasury == RECEIVER ? fee : 0);
        uint256[6] memory beforeBalance = [input.balanceOf(address(bot)), output.balanceOf(address(bot)),
            input.balanceOf(RECEIVER), output.balanceOf(RECEIVER), output.balanceOf(address(psv)), output.balanceOf(treasury)];
        // Run the actual quote-output emitter read-only, then assert its return.
        bytes memory check = abi.encodePacked(hex"0108000101",uint24(quote[direction].length),quote[direction],hex"0002",credit,hex"030102");
        bot.execute(script(check,amount)); bot.execute(script(direct[direction],amount));
        assertEq(input.balanceOf(address(bot)),beforeBalance[0]-amount); assertEq(output.balanceOf(address(bot)),beforeBalance[1]);
        assertEq(input.balanceOf(RECEIVER),beforeBalance[2]); assertEq(output.balanceOf(RECEIVER),beforeBalance[3]+credit);
        assertEq(output.balanceOf(address(psv)),beforeBalance[4]-net-fee); assertEq(input.allowance(address(bot),address(psv)),0);
        if (treasury != RECEIVER) assertEq(output.balanceOf(treasury),beforeBalance[5]+fee);
        assertEq(address(bot).balance,17); assertEq(RECEIVER.balance,19);
    }
    function rejected(uint256 direction,uint256 amount) internal {
        PsvFixtureToken input = direction == 0 ? gem : stable; PsvFixtureToken output = direction == 0 ? stable : gem;
        uint256[7] memory beforeBalance = [input.balanceOf(address(bot)),output.balanceOf(address(bot)),input.balanceOf(RECEIVER),
            output.balanceOf(RECEIVER), input.balanceOf(address(psv)),output.balanceOf(address(psv)),output.balanceOf(treasury)];
        uint256 allowance = input.allowance(address(bot),address(psv)); uint256 capacity = psv.getRemainingBlockCapacity();
        vm.expectRevert(); bot.execute(script(direct[direction],amount));
        assertEq(input.balanceOf(address(bot)),beforeBalance[0]); assertEq(output.balanceOf(address(bot)),beforeBalance[1]);
        assertEq(input.balanceOf(RECEIVER),beforeBalance[2]); assertEq(output.balanceOf(RECEIVER),beforeBalance[3]);
        assertEq(input.balanceOf(address(psv)),beforeBalance[4]); assertEq(output.balanceOf(address(psv)),beforeBalance[5]);
        assertEq(output.balanceOf(treasury),beforeBalance[6]); assertEq(input.allowance(address(bot),address(psv)),allowance);
        assertEq(psv.getRemainingBlockCapacity(),capacity); assertEq(address(bot).balance,17); assertEq(RECEIVER.balance,19);
    }
    function testActualRuntimeBothDirectionsFeeAndWhitelistReceiver() public {
        for (uint256 i; i < 2; ++i) { successful(i,1); successful(i,1_234_567); successful(i,7_361_655_916); }
        psv.setWhitelist(address(bot),true); successful(0,1_234_567); successful(1,1_234_567);
        psv.setWhitelist(RECEIVER,true); successful(0,1_234_567); successful(1,1_234_567);
    }
    function testActualTreasuryReceiverGetsGrossIncludingFee() public {
        treasury = RECEIVER; psv.setTreasury(treasury); successful(0,1_234_567); successful(1,1_234_567);
    }
    function testPayerTreasurySplitOutputRollsBackAndZeroFeeWorks() public {
        treasury = address(bot); psv.setTreasury(treasury); rejected(0,1_000_000); rejected(1,1_000_000);
        psv.setFees(0,0); successful(0,1_000_000); successful(1,1_000_000);
    }
    function testLimitsInclusiveSequentialCapacityAndNextBlockReset() public {
        psv.setRateLimits(1e18,2e18); rejected(0,1_000_001); successful(0,1_000_000); successful(1,1_000_000);
        assertEq(psv.getRemainingBlockCapacity(),0); rejected(0,1);
        vm.roll(block.number+1); successful(0,1_000_000);
    }
    function testGrossReserveBoundaryPauseAndZeroOutput() public {
        stable.burn(address(psv),stable.balanceOf(address(psv))-999_999); rejected(0,1_000_000);
        stable.mint(address(psv),1); successful(0,1_000_000); rejected(1,0);
        psv.pause(); rejected(1,1_000_000);
    }
    function testExactDebitReceiptAndApprovalFailuresRollbackAllState() public {
        gem.seedAllowance(address(bot),address(psv),123);
        gem.configure(-1_000_000,0,false,false); rejected(0,1_000_000);
        gem.configure(-1,0,false,false); rejected(0,1_000_000);
        gem.configure(1,0,false,false); rejected(0,1_000_000);
        gem.configure(0,0,false,true); rejected(0,1_000_000);
        gem.configure(0,0,false,false); stable.configure(0,-1,false,false); rejected(0,1_000_000);
        stable.configure(0,0,true,false); rejected(0,1_000_000);
        stable.configure(0,0,false,false); successful(0,1_000_000);
    }
    function testAsymmetricDecimalsAndTwoFeeFloors() public {
        install(18,6); psv.setFees(1e17,1e17);
        successful(0,1_999_999_999_999); rejected(0,999_999_999_999); successful(1,1);
        install(6,18); psv.setFees(1e17,1e17); successful(0,1); successful(1,1_999_999_999_999);
    }
}
