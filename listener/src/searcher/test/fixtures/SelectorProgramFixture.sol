// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

contract SelectorProgramToken {
    uint8 public immutable decimals;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    event Transfer(address indexed from, address indexed to, uint256 amount);
    constructor(uint8 decimals_) { decimals = decimals_; }
    function issue(address receiver, uint256 amount) public {
        balanceOf[receiver] += amount; totalSupply += amount; emit Transfer(address(0), receiver, amount);
    }
    function approve(address spender, uint256 amount) external returns (bool) { allowance[msg.sender][spender] = amount; return true; }
    function transfer(address receiver, uint256 amount) external returns (bool) { _transfer(msg.sender, receiver, amount); return true; }
    function transferFrom(address sender, address receiver, uint256 amount) external returns (bool) {
        allowance[sender][msg.sender] -= amount; _transfer(sender, receiver, amount); return true;
    }
    function _transfer(address sender, address receiver, uint256 amount) internal {
        balanceOf[sender] -= amount; balanceOf[receiver] += amount; emit Transfer(sender, receiver, amount);
    }
    function _burn(address sender, uint256 amount) internal {
        balanceOf[sender] -= amount; totalSupply -= amount; emit Transfer(sender, address(0), amount);
    }
}

/// An unregistered local contract implementing four existing execution shapes.
/// It deliberately exposes no factory, protocol label, or identity registry.
contract SelectorProgramVault is SelectorProgramToken {
    SelectorProgramToken public immutable asset;
    constructor(SelectorProgramToken asset_) SelectorProgramToken(18) { asset = asset_; }
    function previewDeposit(uint256 assets) public pure returns (uint256) { return assets * 3 / 2; }
    function previewRedeem(uint256 shares) public pure returns (uint256) { return shares * 2 / 3; }
    function deposit(uint256 assets, address receiver) external returns (uint256 shares) {
        shares = previewDeposit(assets); asset.transferFrom(msg.sender, address(this), assets); issue(receiver, shares);
    }
    function mint(uint256 shares, address receiver) external returns (uint256 assets) {
        assets = (shares * 2 + 2) / 3; asset.transferFrom(msg.sender, address(this), assets); issue(receiver, shares);
    }
    function redeem(uint256 shares, address receiver, address owner) external returns (uint256 assets) {
        require(msg.sender == owner); assets = previewRedeem(shares); _burn(owner, shares); asset.transfer(receiver, assets);
    }
    function withdraw(uint256 assets, address receiver, address owner) external returns (uint256 shares) {
        require(msg.sender == owner); shares = (assets * 3 + 1) / 2; _burn(owner, shares); asset.transfer(receiver, assets);
    }
}

/// ABI amount is output-sized; the old JSON computes the input budget, exact
/// approval and actual spend. A nonmultiple of scale must leave input dust.
contract SelectorProgramPsm {
    SelectorProgramToken public immutable gem;
    SelectorProgramToken public immutable dai;
    uint256 public constant to18ConversionFactor = 1e12;
    uint256 public constant tin = 0;
    uint256 public constant tout = 0;
    constructor(SelectorProgramToken gem_, SelectorProgramToken dai_) { gem = gem_; dai = dai_; }
    function buyGem(address receiver, uint256 amount) external returns (uint256 cost) {
        cost = amount * to18ConversionFactor; dai.transferFrom(msg.sender, address(this), cost); gem.transfer(receiver, amount);
    }
    function sellGem(address receiver, uint256 amount) external returns (uint256 output) {
        output = amount * to18ConversionFactor; gem.transferFrom(msg.sender, address(this), amount); dai.transfer(receiver, output);
    }
}
