// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import "forge-std/Test.sol";
import {BotVM} from "src/BotVM.sol";

// Explicit synthetic protocol/token faults test the actual emitted guards and
// EVM rollback. Historical Mooniswap identity, pricing and receipts are separate.
contract MoonFixtureToken {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    uint256 public approvals;
    bool public falseApproval;
    function mint(address who,uint256 n) external { balanceOf[who] += n; }
    function burn(address who,uint256 n) external { balanceOf[who] -= n; }
    function seedAllowance(address who,address spender,uint256 n) external { allowance[who][spender] = n; }
    function failApproval(bool fail) external { falseApproval = fail; }
    function approve(address spender,uint256 n) external returns(bool) {
        allowance[msg.sender][spender] = n; approvals++; return !falseApproval;
    }
    function transferFrom(address from,address to,uint256 n) external returns(bool) {
        allowance[from][msg.sender] -= n; balanceOf[from] -= n; balanceOf[to] += n; return true;
    }
    function transfer(address to,uint256 n) external returns(bool) {
        balanceOf[msg.sender] -= n; balanceOf[to] += n; return true;
    }
}
contract MoonFixtureDonation { constructor(address payable receiver) payable { selfdestruct(receiver); } }
contract MoonFixtureGovernance {
    bool public isActive = true;
    function setActive(bool value) external { isActive = value; }
}
contract MoonFixturePool {
    MoonFixtureGovernance public mooniswapFactoryGovernance;
    uint256 public fault;
    uint256 public swaps;
    constructor(MoonFixtureGovernance governance) { mooniswapFactoryGovernance = governance; }
    receive() external payable {}
    function configure(uint256 f) external { fault = f; }
    function setGovernance(MoonFixtureGovernance governance) external { mooniswapFactoryGovernance = governance; }
    function getReturn(address,address,uint256 amount) external pure returns(uint256) { return amount * 2; }
    function swapFor(address src,address dst,uint256 amount,uint256 minReturn,address referral,address receiver) external returns(uint256 result) {
        require(mooniswapFactoryGovernance.isActive(), "inactive"); require(referral == address(0)); swaps++;
        result = amount * 2; require(result >= minReturn);
        uint256 spent = fault == 1 ? 0 : fault == 2 ? amount-1 : fault == 3 ? amount+1 : amount;
        uint256 credit = fault == 4 ? 0 : fault == 5 ? result-1 : fault == 6 ? result+1 : result;
        MoonFixtureToken(src).transferFrom(msg.sender,address(this),spent);
        MoonFixtureToken(dst).transfer(fault == 7 ? msg.sender : receiver,credit);
        if (fault == 8) MoonFixtureToken(dst).burn(msg.sender,1);
        if (fault == 9) MoonFixtureToken(src).burn(receiver,1);
        if (fault == 10) new MoonFixtureDonation{value:1}(payable(msg.sender));
    }
}
contract MooniswapRuntimeRecipientTest is Test {
    BotVM bot;
    MoonFixtureToken token0;
    MoonFixtureToken token1;
    MoonFixturePool pool;
    MoonFixtureGovernance governance;
    address constant RECEIVER = address(0x1057);
    bytes[2] direct;
    bytes[2] self;
    bytes[2] quote;
    function setUp() public {
        bot = new BotVM(); MoonFixtureToken a = new MoonFixtureToken(); MoonFixtureToken b = new MoonFixtureToken();
        (token0,token1) = address(a) < address(b) ? (a,b) : (b,a);
        governance = new MoonFixtureGovernance(); pool = new MoonFixturePool(governance);
        for (uint256 i; i < 2; ++i) {
            MoonFixtureToken token = i == 0 ? token0 : token1;
            token.mint(address(bot),100_000e18); token.mint(address(pool),1_000_000e18); token.mint(RECEIVER,109);
            direct[i] = emitted(i,RECEIVER,"direct-output"); self[i] = emitted(i,address(bot),"direct-output"); quote[i] = emitted(i,RECEIVER,"quote-output");
        }
        vm.deal(address(bot),17); vm.deal(RECEIVER,19); vm.deal(address(pool),23);
    }
    function emitted(uint256 direction,address recipient,string memory mode) internal returns(bytes memory) {
        string[] memory args = new string[](10); args[0] = "node"; args[1] = "listener/node_modules/tsx/dist/cli.mjs";
        args[2] = "listener/src/searcher/venues/swaps/mooniswap-family/test/runtime-evm-program.ts";
        args[3] = vm.toString(address(pool)); args[4] = vm.toString(address(token0)); args[5] = vm.toString(address(token1));
        args[6] = vm.toString(address(bot)); args[7] = vm.toString(recipient); args[8] = vm.toString(direction); args[9] = mode;
        return vm.ffi(args);
    }
    function script(bytes memory program,uint256 amount) internal pure returns(bytes memory) {
        return abi.encodePacked(uint8(14),amount,uint24(program.length),program);
    }
    function quoteCheck(uint256 direction,uint256 amount) internal {
        bytes memory check = abi.encodePacked(hex"0108000101",uint24(quote[direction].length),quote[direction],hex"0002",amount*2,hex"030102");
        bot.execute(script(check,amount));
    }
    function balances() internal view returns(bytes32) {
        return keccak256(abi.encode(token0.balanceOf(address(bot)),token1.balanceOf(address(bot)),token0.balanceOf(RECEIVER),token1.balanceOf(RECEIVER),
            token0.balanceOf(address(pool)),token1.balanceOf(address(pool)),token0.allowance(address(bot),address(pool)),token1.allowance(address(bot),address(pool)),
            token0.approvals(),token1.approvals(),pool.swaps(),address(bot).balance,RECEIVER.balance,address(pool).balance));
    }
    function rejected(uint256 direction,uint256 amount,bytes memory program) internal {
        bytes32 beforeState = balances(); vm.expectRevert(); bot.execute(script(program,amount)); assertEq(balances(),beforeState);
    }
    function successful(uint256 direction,uint256 amount,bool toSelf) internal {
        MoonFixtureToken input = direction == 0 ? token0 : token1; MoonFixtureToken output = direction == 0 ? token1 : token0;
        address recipient = toSelf ? address(bot) : RECEIVER;
        uint256 beforeIn = input.balanceOf(address(bot)); uint256 beforeOut = output.balanceOf(recipient);
        uint256 beforeOldOutput = output.balanceOf(address(bot)); uint256 beforeReceiverIn = input.balanceOf(RECEIVER);
        uint256 approvals = input.approvals(); uint256 allowance = input.allowance(address(bot),address(pool));
        quoteCheck(direction,amount); bot.execute(script(toSelf ? self[direction] : direct[direction],amount));
        assertEq(input.balanceOf(address(bot)),beforeIn-amount); assertEq(output.balanceOf(recipient),beforeOut+amount*2);
        if (!toSelf) assertEq(output.balanceOf(address(bot)),beforeOldOutput);
        assertEq(input.balanceOf(RECEIVER),beforeReceiverIn); assertEq(input.approvals(),approvals+(allowance < amount ? 1 : 0));
        assertEq(input.allowance(address(bot),address(pool)),(allowance < amount ? type(uint256).max : allowance)-amount);
        assertEq(address(bot).balance,17); assertEq(RECEIVER.balance,19);
    }
    function testBothDirectionsSelfExternalAndStandingAllowanceReuse() public {
        for (uint256 i; i < 2; ++i) {
            successful(i,1,false); successful(i,1234567,false); successful(i,947347012323163156825,true);
        }
    }
    function testReadonlyBeforeFundingAndMutableGovernanceExecutionGuard() public {
        token0.burn(address(bot),token0.balanceOf(address(bot))); quoteCheck(0,1000);
        rejected(0,1000,direct[0]); token0.mint(address(bot),10000);
        MoonFixtureGovernance replacement = new MoonFixtureGovernance(); replacement.setActive(false); pool.setGovernance(replacement);
        quoteCheck(0,1000); rejected(0,1000,direct[0]); rejected(1,1000,direct[1]);
        replacement.setActive(true); successful(0,1000,false); successful(1,1000,false);
    }
    function testIncorrectDebitReceiptRecipientInventoryAndNativeRollback() public {
        for (uint256 i; i < 2; ++i) for (uint256 fault=1; fault <= 10; ++fault) {
            pool.configure(fault); rejected(i,1000,direct[i]);
            if (fault != 7) rejected(i,1000,self[i]);
        }
        pool.configure(0); successful(0,1000,false); successful(1,1000,false);
    }
    function testZeroAmountReserveAndApprovalFailureRollback() public {
        rejected(0,0,direct[0]); rejected(1,0,direct[1]);
        token0.failApproval(true); rejected(0,1000,direct[0]); token0.failApproval(false);
        token1.failApproval(true); rejected(1,1000,direct[1]); token1.failApproval(false);
        token1.burn(address(pool),token1.balanceOf(address(pool))-1999); rejected(0,1000,direct[0]);
        token1.mint(address(pool),1); successful(0,1000,false);
    }
    function testLaterFailureRollsBackSuccessfulSwapAndApproval() public {
        bytes memory fail = abi.encodePacked(hex"0000",uint256(0),hex"0001",uint256(1),hex"030001");
        for (uint256 i; i < 2; ++i) {
            bytes32 beforeState = balances(); vm.expectRevert(); bot.execute(bytes.concat(script(direct[i],1000),script(fail,0)));
            assertEq(balances(),beforeState);
        }
    }
}
