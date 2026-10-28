// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import "../../../../../../../src/BotVM.sol";
interface RecipientVm {
    function deal(address, uint256) external;
    function etch(address, bytes calldata) external;
    function envBytes(string calldata) external view returns (bytes memory);
}
// Fault injection only: never used as deployed identity/historical evidence.
contract RecipientToken {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    uint256 public debitMode;
    bool public shortCredit;
    bool public badApprove;
    bool public keepAllowance;
    bool public refuseClear;
    function configure(uint256 d, bool s, bool a, bool k, bool c) external { debitMode=d; shortCredit=s; badApprove=a; keepAllowance=k; refuseClear=c; }
    function mint(address a, uint256 n) external { balanceOf[a]+=n; }
    function approve(address a, uint256 n) external returns(bool) { if (!(refuseClear && n == 0)) allowance[msg.sender][a] = badApprove && n > 0 ? n-1 : n; return true; }
    function transfer(address to, uint256 n) external returns(bool) { move(msg.sender,to,n); return true; }
    function transferFrom(address from, address to, uint256 n) external returns(bool) {
        require(allowance[from][msg.sender]>=n,"allowance");
        if (!keepAllowance) allowance[from][msg.sender]-=n;
        move(from,to,n); return true;
    }
    function move(address from,address to,uint256 n) internal {
        uint256 debit=debitMode==1?n-1:debitMode==2?n+1:debitMode==3?0:n;
        balanceOf[from]-=debit; balanceOf[to]+=shortCredit && n>0?n-1:n;
    }
}
contract RecipientWeth is RecipientToken {
    bool public shortDeposit;
    bool public shortWithdraw;
    function nativeFaults(bool d, bool w) external { shortDeposit=d; shortWithdraw=w; }
    function deposit() external payable { balanceOf[msg.sender]+=shortDeposit?msg.value-1:msg.value; }
    function withdraw(uint256 n) external { balanceOf[msg.sender]-=n; payable(msg.sender).transfer(shortWithdraw?n-1:n); }
    receive() external payable { balanceOf[msg.sender]+=msg.value; }
}
contract RecipientExchange {
    RecipientToken immutable token;
    uint256 public mode;
    constructor(RecipientToken t) { token=t; }
    function setMode(uint256 n) external { mode=n; }
    function ethToTokenTransferInput(uint256 min,uint256 deadline,address to) external payable returns(uint256) {
        require(min>0 && deadline>=block.timestamp && msg.value>0);
        if(mode!=3) token.transfer(mode==4?msg.sender:to,2000);
        if(mode==5) payable(msg.sender).transfer(1);
        if(mode==6) payable(msg.sender).transfer(msg.value);
        return mode==1?2001:2000;
    }
    function tokenToEthTransferInput(uint256 n,uint256 min,uint256 deadline,address to) external returns(uint256) {
        require(min>0 && deadline>=block.timestamp && n>0);
        token.transferFrom(msg.sender,address(this),n);
        if(mode!=3) payable(mode==4?address(0x1234):to).transfer(mode==2?1999:2000);
        return mode==1?2001:2000;
    }
    receive() external payable {}
}
contract UniV1RecipientRuntimeTest {
    RecipientVm private constant vm=RecipientVm(address(uint160(uint256(keccak256("hevm cheat code")))));
    address private constant POOL=0x1000000000000000000000000000000000000001;
    address private constant TOKEN=0x1000000000000000000000000000000000000002;
    address private constant EXECUTOR=0x1000000000000000000000000000000000000005;
    address private constant RECEIVER=0x1000000000000000000000000000000000000006;
    address private constant WETH=0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2;
    uint256 private constant OLD=100_000;
    uint256 private constant INPUT=1000;
    RecipientToken private token;
    RecipientWeth private weth;
    RecipientExchange private pool;
    BotVM private bot;
    function setUp() public {
        vm.etch(TOKEN,type(RecipientToken).runtimeCode); token=RecipientToken(TOKEN);
        vm.etch(WETH,type(RecipientWeth).runtimeCode); weth=RecipientWeth(payable(WETH));
        RecipientExchange deployed=new RecipientExchange(token);vm.etch(POOL,address(deployed).code); pool=RecipientExchange(payable(POOL));
        BotVM b=new BotVM(); vm.etch(EXECUTOR,address(b).code); bot=BotVM(payable(EXECUTOR));
        vm.deal(POOL,10 ether);vm.deal(WETH,10 ether);vm.deal(EXECUTOR,7 ether);vm.deal(RECEIVER,9 ether);
        token.mint(POOL,OLD);token.mint(EXECUTOR,OLD);token.mint(RECEIVER,OLD);
        weth.mint(EXECUTOR,OLD);weth.mint(RECEIVER,OLD);
    }
    function script(bool buy,bool externalReceiver,bool zero) private view returns(bytes memory) {
        if(zero) return vm.envBytes(buy?"V1_DIRECT_BUY_ZERO":"V1_DIRECT_SELL_ZERO");
        return vm.envBytes(buy?(externalReceiver?"V1_DIRECT_BUY_EXTERNAL":"V1_DIRECT_BUY_SELF"):(externalReceiver?"V1_DIRECT_SELL_EXTERNAL":"V1_DIRECT_SELL_SELF"));
    }
    function checkSuccess(bool buy,bool externalReceiver) private {
        bot.execute(script(buy,externalReceiver,false));
        address to=externalReceiver?RECEIVER:EXECUTOR;
        require(token.balanceOf(EXECUTOR)==OLD+(buy?(externalReceiver?0:2000):0)-(buy?0:INPUT),"actor token");
        require(weth.balanceOf(EXECUTOR)==OLD+(buy?0:(externalReceiver?0:2000))-(buy?INPUT:0),"actor WETH");
        require(token.balanceOf(RECEIVER)==OLD+(buy && externalReceiver?2000:0),"receiver token");
        require(weth.balanceOf(RECEIVER)==OLD+(!buy && externalReceiver?2000:0),"receiver WETH");
        require(to!=address(0) && EXECUTOR.balance==7 ether && RECEIVER.balance==9 ether,"native stock");
        require(token.allowance(EXECUTOR,POOL)==0,"allowance cleanup");
    }
    function reject(bool buy,bool zero) private {
        uint256 poolNative=POOL.balance; uint256 wrappedNative=WETH.balance;
        (bool ok,)=address(bot).call(abi.encodeCall(BotVM.execute,(script(buy,true,zero))));
        require(!ok,"fault accepted");
        require(token.balanceOf(EXECUTOR)==OLD && token.balanceOf(RECEIVER)==OLD && token.balanceOf(POOL)==OLD,"token rollback");
        require(weth.balanceOf(EXECUTOR)==OLD && weth.balanceOf(RECEIVER)==OLD,"WETH rollback");
        require(EXECUTOR.balance==7 ether && RECEIVER.balance==9 ether && POOL.balance==poolNative && WETH.balance==wrappedNative,"native rollback");
        require(token.allowance(EXECUTOR,POOL)==0,"allowance rollback");
    }
    function testBuyExternal() public { checkSuccess(true,true); }
    function testBuySelf() public { checkSuccess(true,false); }
    function testSellExternal() public { checkSuccess(false,true); }
    function testSellSelf() public { checkSuccess(false,false); }
    function testBuyShortCredit() public { token.configure(0,true,false,false,false);reject(true,false); }
    function testBuyLyingReturn() public { pool.setMode(1);reject(true,false); }
    function testBuyMissingOutput() public { pool.setMode(3);reject(true,false); }
    function testBuyWrongReceiver() public { pool.setMode(4);reject(true,false); }
    function testBuyInputUnderdebit() public { pool.setMode(5);reject(true,false); }
    function testBuyZeroDebit() public { pool.setMode(6);reject(true,false); }
    function testBuyShortUnwrapOldNativeProtected() public { weth.nativeFaults(false,true);reject(true,false); }
    function testSellInputUnderdebit() public { token.configure(1,false,false,false,false);reject(false,false); }
    function testSellInputOverdebitOldTokenProtected() public { token.configure(2,false,false,false,false);reject(false,false); }
    function testSellZeroDebit() public { token.configure(3,false,false,false,false);reject(false,false); }
    function testSellBadApprovalReadback() public { token.configure(0,false,true,false,false);reject(false,false); }
    function testSellAllowanceCleanupFailure() public { token.configure(0,false,false,true,true);reject(false,false); }
    function testSellLyingReturn() public { pool.setMode(1);reject(false,false); }
    function testSellShortNativeReceipt() public { pool.setMode(2);reject(false,false); }
    function testSellMissingOutput() public { pool.setMode(3);reject(false,false); }
    function testSellWrongReceiver() public { pool.setMode(4);reject(false,false); }
    function testSellShortWrappingReceipt() public { weth.nativeFaults(true,false);reject(false,false); }
    function testSellShortWethDelivery() public { weth.configure(0,true,false,false,false);reject(false,false); }
    function testSellWethDeliveryOverdebitOldWethProtected() public { weth.configure(2,false,false,false,false);reject(false,false); }
    function testBuyZeroInput() public { reject(true,true); }
    function testSellZeroInput() public { reject(false,true); }
}
