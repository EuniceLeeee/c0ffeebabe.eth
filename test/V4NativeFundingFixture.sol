// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
interface IV4FundingToken {
    function balanceOf(address) external view returns (uint256);
    function transfer(address,uint256) external returns (bool);
}
/// Fork-only isolated funding actor. No target protocol code/state is modified.
/// It exchanges the output actually released by PoolManager for pre-seeded test
/// debt tokens. This is not a production return route or profitability evidence.
contract V4NativeFundingFixture {
    function fund(address input, address output, uint256 received, uint256 debt, address recipient) external returns (uint256) {
        require(input != output && recipient != address(this) && received > 0 && debt > 0, "fixture arguments");
        require(IV4FundingToken(output).balanceOf(address(this)) == received, "fresh output");
        require(IV4FundingToken(input).balanceOf(address(this)) == debt, "isolated debt budget");
        require(input.code.length > 0, "token code");
        uint256 beforeRecipient = IV4FundingToken(input).balanceOf(recipient);
        (bool ok, bytes memory returned) = input.call(abi.encodeCall(IV4FundingToken.transfer, (recipient, debt)));
        require(ok && (returned.length == 0 || (returned.length == 32 && abi.decode(returned, (bool)))), "fund");
        require(IV4FundingToken(input).balanceOf(recipient) == beforeRecipient + debt, "actual funding");
        require(IV4FundingToken(input).balanceOf(address(this)) == 0, "debt consumed");
        return debt;
    }
}
