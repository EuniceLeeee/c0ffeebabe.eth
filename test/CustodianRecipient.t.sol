// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import {Test} from "forge-std/Test.sol";
import {BotVM} from "../src/BotVM.sol";
// Synthetic synchronous custody semantics; historical deployed identity is
// verified separately. Faults are accepted by the mock, then rejected by VM.
contract CustodianRecipientToken {
    mapping(address=>uint256) public balanceOf;
    mapping(address=>mapping(address=>uint256)) public allowance;
    uint256 public totalSupply;
    bool public badClear;
    function set(address a,uint256 n) external {balanceOf[a]=n;}
    function setup() external {totalSupply=10**20;badClear=false;}
    function setBadClear() external {badClear=true;}
    function change(address a,int256 n) external {balanceOf[a]=uint256(int256(balanceOf[a])+n);}
    function supply(int256 n) external {totalSupply=uint256(int256(totalSupply)+n);}
    function minters(address) external pure returns(bool){return true;}
    function isPaused() external pure returns(bool){return false;}
    function isFrozen(address) external pure returns(bool){return false;}
    function approve(address a,uint256 n) external returns(bool){allowance[msg.sender][a]=badClear&&n==0?1:n;return true;}
    function transferFrom(address a,address b,uint256 n) external {allowance[a][msg.sender]-=n;balanceOf[a]-=n;balanceOf[b]+=n;}
}
contract CustodianRecipientVault {
    address public constant asset=address(102);
    address public constant frxUSD=address(103);
    address public constant custodianTkn=asset;
    uint256 public fault;
    uint256 public calls;
    function configure(uint256 n) external {fault=n;calls=0;}
    function mdwrComboView() external pure returns(uint256,uint256,uint256,uint256){return(10**25,10**25,10**25,10**25);}
    function previewDeposit(uint256 a) external pure returns(uint256){return a*1000;}
    function previewRedeem(uint256 a) external pure returns(uint256){return a/1000;}
    function deposit(uint256 a,address to) external returns(uint256){return convert(a,to,true);}
    function redeem(uint256 a,address to,address owner) external returns(uint256){require(owner==msg.sender);return convert(a,to,false);}
    function convert(uint256 a,address to,bool dep) internal returns(uint256){
        calls++;address input=dep?asset:frxUSD;address output=dep?frxUSD:asset;uint256 out=dep?a*1000:a/1000;
        uint256 debit=fault==1?0:fault==2?a-1:fault==3?a+1:a;
        uint256 credit=fault==4?out-1:fault==5?out+1:out;
        CustodianRecipientToken(input).change(msg.sender,-int256(debit));
        CustodianRecipientToken(output).change(to,int256(credit));
        CustodianRecipientToken(asset).change(address(this),dep?int256(a):-int256(out));
        CustodianRecipientToken(frxUSD).supply(dep?int256(out):-int256(a));
        if(fault==7)CustodianRecipientToken(frxUSD).supply(1);
        if(fault==8)CustodianRecipientToken(output).change(msg.sender,-1);
        if(fault==9)CustodianRecipientToken(input).change(to,-1);
        if(fault==10){(bool ok,)=msg.sender.call{value:1}("");require(ok);}
        if(fault==11)CustodianRecipientToken(input).setBadClear();
        return fault==6?out+1:out;
    }
    receive() external payable {}
}
contract CustodianRecipientTest is Test {
    address constant ACTOR=address(107);address constant RECEIVER=address(109);address constant VAULT=address(101);
    address constant ASSET=address(102);address constant SHARE=address(103);uint256 constant STOCK=10**9;
    function setUp() public {vm.etch(ACTOR,address(new BotVM()).code);vm.etch(VAULT,address(new CustodianRecipientVault()).code);vm.etch(ASSET,address(new CustodianRecipientToken()).code);vm.etch(SHARE,address(new CustodianRecipientToken()).code);}
    function token(address a) internal pure returns(CustodianRecipientToken){return CustodianRecipientToken(a);}
    function prepare(bool dep,uint256 amount,uint256 fault) internal {
        for(uint256 i;i<2;i++){address t=i==0?ASSET:SHARE;token(t).setup();token(t).set(ACTOR,STOCK+(t==(dep?ASSET:SHARE)?amount:0));token(t).set(RECEIVER,333);token(t).set(VAULT,10**12);vm.prank(ACTOR);token(t).approve(VAULT,13);}
        CustodianRecipientVault(payable(VAULT)).configure(fault);vm.deal(ACTOR,17);vm.deal(RECEIVER,23);vm.deal(VAULT,29);
    }
    function script(bool dep,bool externalReceiver,uint256 amount) internal view returns(bytes memory){return vm.envBytes(string.concat("CUSTODIAN_",dep?"deposit":"redeem","_",externalReceiver?"external":"self","_",vm.toString(amount)));}
    function unchanged(bool dep,uint256 amount) internal view {
        for(uint256 i;i<2;i++){address t=i==0?ASSET:SHARE;assertEq(token(t).balanceOf(ACTOR),STOCK+(t==(dep?ASSET:SHARE)?amount:0));assertEq(token(t).balanceOf(RECEIVER),333);assertEq(token(t).balanceOf(VAULT),10**12);assertEq(token(t).totalSupply(),10**20);assertEq(token(t).allowance(ACTOR,VAULT),13);assertFalse(token(t).badClear());}
        assertEq(CustodianRecipientVault(payable(VAULT)).calls(),0);assertEq(ACTOR.balance,17);assertEq(RECEIVER.balance,23);assertEq(VAULT.balance,29);
    }
    function testBothDirectionsSelfExternalProtectBalances() public {
        for(uint256 d;d<2;d++)for(uint256 k;k<2;k++){bool dep=d==0;uint256 a=dep?100:100000;uint256 out=dep?a*1000:a/1000;prepare(dep,a,0);BotVM(payable(ACTOR)).execute(script(dep,k==1,a));
            address input=dep?ASSET:SHARE;address output=dep?SHARE:ASSET;assertEq(token(input).balanceOf(ACTOR),STOCK);assertEq(token(output).balanceOf(ACTOR),STOCK+(k==0?out:0));assertEq(token(input).balanceOf(RECEIVER),333);assertEq(token(output).balanceOf(RECEIVER),uint256(333)+(k==1?out:0));assertEq(token(input).allowance(ACTOR,VAULT),0);assertEq(ACTOR.balance,17);}
    }
    function testFaultsRevertAllBalancesSupplyAllowanceAndProtocolState() public {
        for(uint256 d;d<2;d++)for(uint256 k;k<2;k++)for(uint256 f=1;f<=11;f++){bool dep=d==0;uint256 a=dep?100:100000;prepare(dep,a,f);bytes memory p=script(dep,k==1,a);vm.expectRevert();BotVM(payable(ACTOR)).execute(p);unchanged(dep,a);}
    }
    function testFaultsAreAcceptedBySyntheticProtocolWithoutProgram() public {
        for(uint256 d;d<2;d++)for(uint256 f=1;f<=11;f++){bool dep=d==0;uint256 a=dep?100:100000;prepare(dep,a,f);vm.prank(ACTOR);if(dep)CustodianRecipientVault(payable(VAULT)).deposit(a,RECEIVER);else CustodianRecipientVault(payable(VAULT)).redeem(a,RECEIVER,ACTOR);assertEq(CustodianRecipientVault(payable(VAULT)).calls(),1);}
    }
    function testZeroAndDustCannotConsumeOldInventory() public {
        for(uint256 d;d<2;d++)for(uint256 k;k<2;k++){bool dep=d==0;prepare(dep,0,0);bytes memory p=script(dep,k==1,0);vm.expectRevert();BotVM(payable(ACTOR)).execute(p);unchanged(dep,0);if(!dep){prepare(false,1,0);p=script(false,k==1,1);vm.expectRevert();BotVM(payable(ACTOR)).execute(p);unchanged(false,1);}}
    }
}
