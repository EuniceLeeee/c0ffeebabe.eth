// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;
import "./original-runtime.t.sol";

interface OriginalReadVm {
    function envString(string calldata) external view returns(string memory);
    function parseJsonBytes(string calldata,string calldata) external pure returns(bytes memory);
    function parseJsonBytes32(string calldata,string calldata) external pure returns(bytes32);
    function parseJsonUint(string calldata,string calldata) external pure returns(uint256);
    function parseJsonAddress(string calldata,string calldata) external pure returns(address);
    function parseJsonAddressArray(string calldata,string calldata) external pure returns(address[] memory);
    function toString(bytes calldata) external pure returns(string memory);
    function toString(uint256) external pure returns(string memory);
    function snapshotState() external returns(uint256);
    function revertToStateAndDelete(uint256) external returns(bool);
    function exists(string calldata) external view returns(bool);
    function writeFile(string calldata,string calldata) external;
}

// Test-only provider transport for the five fixed original-amount legs.
// Each request has eth_call isolation; no production scheduler or formulas here.
contract OriginalStateReadProof is OriginalRuntimeOutputProof {
    OriginalReadVm constant qvm=OriginalReadVm(address(uint160(uint256(keccak256("hevm cheat code")))));
    function checkReadBinding(string memory fixture,string memory request) public pure {
        require(sha256(bytes(fixture))==qvm.parseJsonBytes32(request,".fixtureSha256"),"read fixture bytes");
        require(qvm.parseJsonBytes32(request,".tx")==rvm.parseJsonBytes32(fixture,".tx"),"read tx");
        require(qvm.parseJsonUint(request,".block")==rvm.parseJsonUint(fixture,".block"),"read block");
        uint256 leg=qvm.parseJsonUint(request,".leg");
        require(leg<rvm.parseJsonUint(fixture,".eventCount")&&leg<=2,"fixed leg");
        require(qvm.parseJsonUint(request,".prefixCount")==leg,"complete leg prefix");
    }
    function testRejectsForeignReadTransaction() public {
        string memory fixture=string.concat(rvm.envString("FAMILY_EXECUTION_JSON_A"),rvm.envString("FAMILY_EXECUTION_JSON_B"),rvm.envString("FAMILY_EXECUTION_JSON_C"),rvm.envString("FAMILY_EXECUTION_JSON_D"));
        string memory bad=string.concat('{"fixtureSha256":"',qvm.toString(abi.encodePacked(sha256(bytes(fixture)))),'","tx":"0x0000000000000000000000000000000000000000000000000000000000000000"}');
        rvm.expectRevert(bytes("read tx"));this.checkReadBinding(fixture,bad);
    }
    function testRejectsMissingLegPrefix() public {
        string memory fixture=string.concat(rvm.envString("FAMILY_EXECUTION_JSON_A"),rvm.envString("FAMILY_EXECUTION_JSON_B"),rvm.envString("FAMILY_EXECUTION_JSON_C"),rvm.envString("FAMILY_EXECUTION_JSON_D"));
        require(rvm.parseJsonUint(fixture,".eventCount")==3,"Aura negative fixture");
        string memory bad=string.concat('{"fixtureSha256":"',qvm.toString(abi.encodePacked(sha256(bytes(fixture)))),'","tx":"',rvm.toString(rvm.parseJsonBytes32(fixture,".tx")),'","block":',qvm.toString(rvm.parseJsonUint(fixture,".block")),',"leg":2,"prefixCount":1}');
        rvm.expectRevert(bytes("complete leg prefix"));this.checkReadBinding(fixture,bad);
    }
    function testOriginalStateReads() public {
        string memory fixture=string.concat(rvm.envString("FAMILY_EXECUTION_JSON_A"),rvm.envString("FAMILY_EXECUTION_JSON_B"),rvm.envString("FAMILY_EXECUTION_JSON_C"),rvm.envString("FAMILY_EXECUTION_JSON_D"));
        string memory canonical=string.concat(vm.envString("FAMILY_PRESTATE_JSON_A"),vm.envString("FAMILY_PRESTATE_JSON_B"),vm.envString("FAMILY_PRESTATE_JSON_C"),vm.envString("FAMILY_PRESTATE_JSON_D"));
        string memory request=qvm.envString("FAMILY_READ_JSON");
        emit log_named_bytes("fixture payload sha256",abi.encodePacked(sha256(bytes(fixture))));
        checkReadBinding(fixture,request);
        checkPrestatePayload(fixture,canonical);
        testCanonicalPrestate();
        require(rvm.parseJsonBytes32(fixture,".tx")==vm.parseJsonBytes32(canonical,".tx"),"canonical fixture tx");
        require(rvm.parseJsonUint(fixture,".block")==vm.getBlockNumber(),"canonical fixture block");
        address owner=rvm.parseJsonAddress(fixture,".owner");address executor=rvm.parseJsonAddress(fixture,".executor");
        require(owner==address(uint160(uint256(keccak256("family-three-original-owner-20261008"))))&&executor==address(uint160(uint256(keccak256("family-three-original-executor-20261008")))),"isolated actors");
        require(owner.code.length==0&&executor.code.length==0&&owner.balance==0&&executor.balance==0,"actors already used");
        require(vm.getNonce(owner)==0&&vm.getNonce(executor)==0,"actor nonce");
        address[] memory tokens=rvm.parseJsonAddressArray(fixture,".tokens");
        for(uint256 i;i<tokens.length;i++)require(RuntimeProofToken(tokens[i]).balanceOf(owner)==0&&RuntimeProofToken(tokens[i]).balanceOf(executor)==0,"old inventory");
        bytes memory code=rvm.parseJsonBytes(fixture,".runtimeCode");
        require(keccak256(code)==rvm.parseJsonBytes32(fixture,".runtimeCodeHash"),"runtime hash");
        rvm.etch(executor,code);
        address weth=rvm.parseJsonAddress(fixture,".weth");uint256 root=rvm.parseJsonUint(fixture,".rootAmount");
        rvm.deal(owner,root);
        rvm.prank(owner,owner);RuntimeProofToken(weth).deposit{value:root}();
        rvm.prank(owner,owner);require(RuntimeProofToken(weth).transfer(executor,root),"input transfer");
        uint256 leg=qvm.parseJsonUint(request,".leg");
        require(leg<rvm.parseJsonUint(fixture,".eventCount")&&leg<=2,"fixed leg");
        require(qvm.parseJsonUint(request,".prefixCount")==leg,"complete leg prefix");
        for(uint256 i;i<leg;i++){
            bytes memory data=qvm.parseJsonBytes(request,key(".prefixCalls",i));
            rvm.prank(owner,owner);(bool ok,bytes memory result)=executor.call(data);
            if(!ok){emit log_named_bytes("prefix revert",result);revert("prefix execution");}
            string memory k=key(".programs",i);
            address output=rvm.parseJsonAddress(fixture,string.concat(k,".tokenOut"));
            uint256 amount=rvm.parseJsonUint(fixture,string.concat(k,".amountOut"));
            for(uint256 j;j<tokens.length;j++)require(RuntimeProofToken(tokens[j]).balanceOf(executor)==(tokens[j]==output?amount:0),"prefix actual receipts");
        }
        uint256 approvals=rvm.parseJsonUint(fixture,".approvalCount");
        for(uint256 i;i<approvals;i++){
            string memory k=key(".approvals",i);
            require(RuntimeProofToken(rvm.parseJsonAddress(fixture,string.concat(k,".token"))).allowance(executor,rvm.parseJsonAddress(fixture,string.concat(k,".spender")))==0,"prefix standing approval");
        }
        require(owner.balance==0&&executor.balance==0,"prefix native residual");
        uint256 count=qvm.parseJsonUint(request,".count");require(count>0&&count<=64,"read count");
        string memory rows="[";
        for(uint256 i;i<count;i++){
            string memory k=key(".requests",i);
            uint256 kind=qvm.parseJsonUint(request,string.concat(k,".kind"));
            address target=qvm.parseJsonAddress(request,string.concat(k,".to"));
            bool ok=true;bytes memory data;
            if(kind==0){
                address sender=qvm.parseJsonAddress(request,string.concat(k,".from"));
                bytes memory input=qvm.parseJsonBytes(request,string.concat(k,".data"));
                uint256 snapshot=qvm.snapshotState();
                rvm.prank(sender,sender);(ok,data)=target.call(input);
                require(qvm.revertToStateAndDelete(snapshot),"read rollback");
            }else if(kind==1){data=target.code;}
            else if(kind==2){data=abi.encode(vm.load(target,qvm.parseJsonBytes32(request,string.concat(k,".slot"))));}
            else{revert("unsupported native read");}
            rows=string.concat(rows,i==0?"":",",'{"ok":',ok?"true":"false",',"data":"',qvm.toString(data),'"}');
        }
        string memory body=string.concat('{"requestSha256":"',qvm.toString(abi.encodePacked(sha256(bytes(request)))),'","count":',qvm.toString(count),',"results":',rows,"]}");
        string memory outputPath=qvm.envString("FAMILY_READ_OUTPUT");
        require(!qvm.exists(outputPath),"read output exists");
        qvm.writeFile(outputPath,body);
        emit log_named_uint("native reads returned",count);
        emit log_named_uint("preceding legs executed",leg);
    }
}
