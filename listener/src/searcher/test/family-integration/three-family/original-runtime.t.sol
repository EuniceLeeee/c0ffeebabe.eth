// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;
import "./original-prestate.t.sol";

interface RuntimeProofVm {
    struct Log { bytes32[] topics; bytes data; address emitter; }
    function envString(string calldata) external view returns (string memory);
    function parseJsonAddress(string calldata,string calldata) external pure returns(address);
    function parseJsonAddressArray(string calldata,string calldata) external pure returns(address[] memory);
    function parseJsonBytes(string calldata,string calldata) external pure returns(bytes memory);
    function parseJsonBytes32(string calldata,string calldata) external pure returns(bytes32);
    function parseJsonUint(string calldata,string calldata) external pure returns(uint256);
    function toString(uint256) external pure returns(string memory);
    function deal(address,uint256) external;
    function etch(address,bytes calldata) external;
    function prank(address,address) external;
    function expectRevert(bytes calldata) external;
    function toString(bytes32) external pure returns(string memory);
    function recordLogs() external;
    function getRecordedLogs() external returns(Log[] memory);
}
interface RuntimeProofToken {
    function deposit() external payable;
    function transfer(address,uint256) external returns(bool);
    function balanceOf(address) external view returns(uint256);
    function allowance(address,address) external view returns(uint256);
}
contract OriginalRuntimeOutputProof is HistoricalPrestateProbe {
    RuntimeProofVm constant rvm=RuntimeProofVm(address(uint160(uint256(keccak256("hevm cheat code")))));
    bytes32 constant TRANSFER=keccak256("Transfer(address,address,uint256)");
    event log_named_bytes(string key,bytes value);
    function key(string memory path,uint256 i) internal pure returns(string memory) {
        return string.concat(path,"[",rvm.toString(i),"]");
    }
    function checkPrestatePayload(string memory fixture,string memory canonical) public pure {
        require(sha256(bytes(canonical))==rvm.parseJsonBytes32(fixture,".canonicalPayloadSha256"),"canonical prestate payload binding");
    }
    function testRejectsIncompleteCanonicalPayload() public {
        string memory fixture=string.concat(rvm.envString("FAMILY_EXECUTION_JSON_A"),rvm.envString("FAMILY_EXECUTION_JSON_B"),rvm.envString("FAMILY_EXECUTION_JSON_C"),rvm.envString("FAMILY_EXECUTION_JSON_D"));
        string memory missing=string.concat('{"tx":"',rvm.toString(rvm.parseJsonBytes32(fixture,".tx")),'","block":{"number":',rvm.toString(rvm.parseJsonUint(fixture,".block")),'},"prestate":{}}');
        require(vm.parseJsonBytes32(missing,".tx")==rvm.parseJsonBytes32(fixture,".tx"),"negative tx");
        require(vm.parseJsonUint(missing,".block.number")==rvm.parseJsonUint(fixture,".block"),"negative block");
        rvm.expectRevert(bytes("canonical prestate payload binding"));
        this.checkPrestatePayload(fixture,missing);
    }
    function testOriginalRuntimeOutputs() public {
        string memory fixture=string.concat(rvm.envString("FAMILY_EXECUTION_JSON_A"),rvm.envString("FAMILY_EXECUTION_JSON_B"),rvm.envString("FAMILY_EXECUTION_JSON_C"),rvm.envString("FAMILY_EXECUTION_JSON_D"));
        string memory canonical=string.concat(vm.envString("FAMILY_PRESTATE_JSON_A"),vm.envString("FAMILY_PRESTATE_JSON_B"),vm.envString("FAMILY_PRESTATE_JSON_C"),vm.envString("FAMILY_PRESTATE_JSON_D"));
        checkPrestatePayload(fixture,canonical);
        testCanonicalPrestate();
        require(rvm.parseJsonBytes32(fixture,".tx")==vm.parseJsonBytes32(canonical,".tx"),"fixture transaction");
        require(rvm.parseJsonUint(fixture,".block")==vm.getBlockNumber(),"fixture block");
        address owner=rvm.parseJsonAddress(fixture,".owner");address executor=rvm.parseJsonAddress(fixture,".executor");
        require(owner==address(uint160(uint256(keccak256("family-three-original-owner-20261008"))))&&executor==address(uint160(uint256(keccak256("family-three-original-executor-20261008")))),"isolated actors");
        require(owner.code.length==0&&executor.code.length==0&&owner.balance==0&&executor.balance==0,"actors already used");
        require(vm.getNonce(owner)==0&&vm.getNonce(executor)==0,"actor nonce");
        address[] memory tokens=rvm.parseJsonAddressArray(fixture,".tokens");
        for(uint256 i;i<tokens.length;i++)require(RuntimeProofToken(tokens[i]).balanceOf(owner)==0&&RuntimeProofToken(tokens[i]).balanceOf(executor)==0,"old token inventory");
        address weth=rvm.parseJsonAddress(fixture,".weth");
        uint256 amount=rvm.parseJsonUint(fixture,".rootAmount");
        bytes memory runtimeCode=rvm.parseJsonBytes(fixture,".runtimeCode");
        require(keccak256(runtimeCode)==rvm.parseJsonBytes32(fixture,".runtimeCodeHash"),"runtime hash");
        rvm.etch(executor,runtimeCode);
        rvm.deal(owner,amount);
        rvm.prank(owner,owner);RuntimeProofToken(weth).deposit{value:amount}();
        rvm.prank(owner,owner);require(RuntimeProofToken(weth).transfer(executor,amount),"funding transfer");
        require(RuntimeProofToken(weth).balanceOf(executor)==amount,"funding amount");
        rvm.recordLogs();
        rvm.prank(owner,owner);(bool ok,bytes memory result)=executor.call(rvm.parseJsonBytes(fixture,".calldata"));
        if(!ok){emit log_named_bytes("runtime revert",result);revert("production runtime execution");}
        RuntimeProofVm.Log[] memory observed=rvm.getRecordedLogs();
        uint256 count=rvm.parseJsonUint(fixture,".eventCount");uint256 previous;
        require(count>0&&count<=3,"fixed sample leg count");
        for(uint256 i;i<count;i++){
            string memory k=key(".events",i);
            address emitter=rvm.parseJsonAddress(fixture,string.concat(k,".emitter"));
            bytes memory data=rvm.parseJsonBytes(fixture,string.concat(k,".data"));
            uint256 topicCount=rvm.parseJsonUint(fixture,string.concat(k,".topicCount"));uint256 matches;
            require(topicCount>0&&topicCount<=4,"topic count");
            for(uint256 j;j<observed.length;j++){
                RuntimeProofVm.Log memory item=observed[j];
                if(item.emitter!=emitter||item.topics.length!=topicCount||keccak256(item.data)!=keccak256(data))continue;
                bool equal=true;
                for(uint256 t;t<topicCount;t++)if(item.topics[t]!=rvm.parseJsonBytes32(fixture,key(string.concat(k,".topics"),t)))equal=false;
                if(equal){require(i==0||j>previous,"leg order");previous=j;matches++;}
            }
            require(matches==1,"canonical protocol event mismatch");
            address tokenOut=rvm.parseJsonAddress(fixture,string.concat(k,".tokenOut"));address payer=rvm.parseJsonAddress(fixture,string.concat(k,".payer"));
            uint256 output=rvm.parseJsonUint(fixture,string.concat(k,".amountOut"));uint256 transfers;
            for(uint256 j;j<observed.length;j++){
                RuntimeProofVm.Log memory item=observed[j];
                if(item.emitter==tokenOut&&item.topics.length==3&&item.topics[0]==TRANSFER&&
                   item.topics[1]==bytes32(uint256(uint160(payer)))&&item.topics[2]==bytes32(uint256(uint160(executor)))&&
                   item.data.length==32&&abi.decode(item.data,(uint256))==output)transfers++;
            }
            require(transfers==1,"independent output transfer mismatch");
            emit log_named_uint(string.concat("original output leg ",rvm.toString(i)),output);
        }
        address finalToken=rvm.parseJsonAddress(fixture,".finalToken");
        uint256 finalAmount=rvm.parseJsonUint(fixture,".finalAmount");
        for(uint256 i;i<tokens.length;i++){
            require(RuntimeProofToken(tokens[i]).balanceOf(executor)==(tokens[i]==finalToken?finalAmount:0),"terminal token balance");
            require(RuntimeProofToken(tokens[i]).balanceOf(owner)==0,"owner token residual");
        }
        uint256 approvals=rvm.parseJsonUint(fixture,".approvalCount");
        for(uint256 i;i<approvals;i++){
            string memory k=key(".approvals",i);
            require(RuntimeProofToken(rvm.parseJsonAddress(fixture,string.concat(k,".token"))).allowance(executor,rvm.parseJsonAddress(fixture,string.concat(k,".spender")))==0,"standing approval");
        }
        require(owner.balance==0&&executor.balance==0,"native residual");
        emit log_named_uint("original legs matched",count);
        emit log_named_uint("terminal output",finalAmount);
    }
}
