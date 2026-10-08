// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

interface PrestateVm {
    function envString(string calldata) external view returns (string memory);
    function readFile(string calldata) external view returns (string memory);
    function parseJsonKeys(string calldata, string calldata) external pure returns (string[] memory);
    function parseJsonBytes32(string calldata, string calldata) external pure returns (bytes32);
    function parseJsonBytes(string calldata, string calldata) external pure returns (bytes memory);
    function parseJsonUint(string calldata, string calldata) external pure returns (uint256);
    function parseJsonAddress(string calldata, string calldata) external pure returns (address);
    function parseAddress(string calldata) external pure returns (address);
    function parseBytes32(string calldata) external pure returns (bytes32);
    function keyExistsJson(string calldata, string calldata) external view returns (bool);
    function createSelectFork(string calldata, bytes32) external returns (uint256);
    function getNonce(address) external view returns (uint64);
    function getBlockNumber() external view returns (uint256);
    function getBlockTimestamp() external view returns (uint256);
    function getChainId() external view returns (uint256);
    function load(address, bytes32) external view returns (bytes32);
}

// Diagnostic only: use Foundry's native transaction-prefix primitive and compare
// independently captured canonical prestate. No deal/store/etch/nonce rewriting.
contract HistoricalPrestateProbe {
    PrestateVm constant vm = PrestateVm(address(uint160(uint256(keccak256("hevm cheat code")))));
    event log_named_uint(string key, uint256 value);

    function testCanonicalPrestate() public {
        string memory data = string.concat(vm.envString("FAMILY_PRESTATE_JSON_A"), vm.envString("FAMILY_PRESTATE_JSON_B"), vm.envString("FAMILY_PRESTATE_JSON_C"), vm.envString("FAMILY_PRESTATE_JSON_D"));
        bytes32 txHash = vm.parseJsonBytes32(data, ".tx");
        vm.createSelectFork(vm.envString("MAINNET_RPC_URL"), txHash);
        require(vm.getChainId() == 1, "chain");
        require(vm.getBlockNumber() == vm.parseJsonUint(data, ".block.number"), "number");
        require(vm.getBlockTimestamp() == vm.parseJsonUint(data, ".block.timestamp"), "timestamp");
        require(block.basefee == vm.parseJsonUint(data, ".block.baseFeePerGas"), "basefee");
        require(block.gaslimit == vm.parseJsonUint(data, ".block.gasLimit"), "gaslimit");
        require(block.coinbase == vm.parseJsonAddress(data, ".block.miner"), "coinbase");
        require(block.prevrandao == vm.parseJsonUint(data, ".block.mixHash"), "prevrandao");
        string[] memory accounts = vm.parseJsonKeys(data, ".prestate");
        uint256 checkedSlots;
        for (uint256 i; i < accounts.length; ++i) {
            address account = vm.parseAddress(accounts[i]);
            string memory key = string.concat(".prestate[\"", accounts[i], "\"]");
            if (vm.keyExistsJson(data, string.concat(key, ".balance"))) {
                require(account.balance == vm.parseJsonUint(data, string.concat(key, ".balance")), string.concat(accounts[i], ": balance"));
            }
            if (vm.keyExistsJson(data, string.concat(key, ".nonce"))) {
                require(vm.getNonce(account) == vm.parseJsonUint(data, string.concat(key, ".nonce")), string.concat(accounts[i], ": nonce"));
            }
            bytes memory code = vm.keyExistsJson(data, string.concat(key, ".code")) ? vm.parseJsonBytes(data, string.concat(key, ".code")) : bytes("");
            require(keccak256(account.code) == keccak256(code), string.concat(accounts[i], ": code"));
            if (vm.keyExistsJson(data, string.concat(key, ".storage"))) {
                string[] memory slots = vm.parseJsonKeys(data, string.concat(key, ".storage"));
                for (uint256 j; j < slots.length; ++j) {
                    require(vm.load(account, vm.parseBytes32(slots[j])) == vm.parseJsonBytes32(data, string.concat(key, ".storage[\"", slots[j], "\"]")), string.concat(accounts[i], ": storage"));
                    ++checkedSlots;
                }
            }
        }
        emit log_named_uint("canonical accounts verified", accounts.length);
        emit log_named_uint("canonical slots verified", checkedSlots);
    }
}
