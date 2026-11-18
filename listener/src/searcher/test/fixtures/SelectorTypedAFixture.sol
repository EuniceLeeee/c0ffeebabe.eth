// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

contract TypedToken {
    mapping(address=>uint256) public balanceOf;
    mapping(address=>mapping(address=>uint256)) public allowance;
    uint256 public totalSupply;
    event Transfer(address indexed sender,address indexed receiver,uint256 value);
    function issue(address to,uint256 amount) public { balanceOf[to]+=amount;totalSupply+=amount;emit Transfer(address(0),to,amount); }
    function burn(address from,uint256 amount) public { balanceOf[from]-=amount;totalSupply-=amount;emit Transfer(from,address(0),amount); }
    function approve(address to,uint256 amount) external returns(bool) { allowance[msg.sender][to]=amount;return true; }
    function transfer(address to,uint256 amount) external returns(bool) { move(msg.sender,to,amount);return true; }
    function transferFrom(address from,address to,uint256 amount) external returns(bool) {
        if(allowance[from][msg.sender]!=type(uint256).max)allowance[from][msg.sender]-=amount;
        move(from,to,amount);return true;
    }
    function move(address from,address to,uint256 amount) internal { balanceOf[from]-=amount;balanceOf[to]+=amount;emit Transfer(from,to,amount); }
}
contract TypedReserves {
    uint256[2] public balances;
    constructor(){balances[0]=300;balances[1]=200;}
    function set(uint256 stable,uint256 asset) external {balances[0]=stable;balances[1]=asset;}
}
contract TypedYield is TypedToken {
    address public immutable ASSET_TOKEN;address public immutable STABLECOIN;
    address public immutable CRYPTOPOOL;address public immutable amm;address public immutable staker;
    event Deposit(address indexed sender,address indexed owner,uint256 assets,uint256 shares);
    constructor(address asset,address stable,address pool,address liquidity,address staking){ASSET_TOKEN=asset;STABLECOIN=stable;CRYPTOPOOL=pool;amm=liquidity;staker=staking;}
    function deposit(uint256 amount,uint256 debt,uint256 minimum) external returns(uint256){return _deposit(amount,debt,minimum,msg.sender);}
    function deposit(uint256 amount,uint256 debt,uint256 minimum,address to) external returns(uint256){return _deposit(amount,debt,minimum,to);}
    function _deposit(uint256 amount,uint256 debt,uint256 minimum,address to) internal returns(uint256 out){
        require(debt==amount*TypedReserves(CRYPTOPOOL).balances(0)/TypedReserves(CRYPTOPOOL).balances(1),"stale debt");
        require(debt>0);TypedToken(ASSET_TOKEN).transferFrom(msg.sender,address(this),amount);out=amount*2;require(out>=minimum);
        issue(to,out);issue(staker,1);emit Deposit(msg.sender,to,amount,out);
    }
    function withdraw(uint256 shares,uint256 minimum) external returns(uint256){return _withdraw(shares,minimum,msg.sender);}
    function withdraw(uint256 shares,uint256 minimum,address to) external returns(uint256){return _withdraw(shares,minimum,to);}
    function _withdraw(uint256 shares,uint256 minimum,address to) internal returns(uint256 out){burn(msg.sender,shares);out=shares*2;require(out>=minimum);TypedToken(ASSET_TOKEN).transfer(to,out);}
}
contract TypedCurve is TypedToken {
    address[2] private _coins;address public immutable fee_receiver;address public immutable factory;
    uint256 public dust;uint256 public returnError;
    event ClaimAdminFee(address indexed admin,uint256[2] tokens);
    constructor(address c0,address c1,address fee,address factory_){_coins=[c0,c1];fee_receiver=fee;factory=factory_;}
    function coins(uint256 i) external view returns(address){return _coins[i];}
    function coins(int128 i) external view returns(address){return _coins[uint256(uint128(i))];}
    function lp_token() external view returns(address){return address(this);}
    function setRounding(uint256 dust_,uint256 error_) external {dust=dust_;returnError=error_;}
    function add_liquidity(uint256[2] calldata amounts,uint256 minimum) external returns(uint256){return _add(amounts,minimum,msg.sender);}
    function add_liquidity(uint256[2] calldata amounts,uint256 minimum,address to) external returns(uint256){return _add(amounts,minimum,to);}
    function _add(uint256[2] calldata amounts,uint256 minimum,address to) internal returns(uint256){
        uint256 i=amounts[0]>0?0:1;uint256 paid=amounts[i]-dust;require(paid>0);TypedToken(_coins[i]).transferFrom(msg.sender,address(this),paid);
        uint256 out=paid*2;require(out>=minimum);issue(to,out);return out+returnError;
    }
    function remove_liquidity_one_coin(uint256 amount,uint256 i,uint256 minimum) external returns(uint256){return _remove(amount,i,minimum,msg.sender);}
    function remove_liquidity_one_coin(uint256 amount,uint256 i,uint256 minimum,address to) external returns(uint256){return _remove(amount,i,minimum,to);}
    function _remove(uint256 amount,uint256 i,uint256 minimum,address to) internal returns(uint256 out){
        burn(msg.sender,amount);TypedToken(_coins[0]).transfer(fee_receiver,3);TypedToken(_coins[1]).transfer(fee_receiver,5);
        emit ClaimAdminFee(fee_receiver,[uint256(3),uint256(5)]);out=amount*2;require(out>=minimum);TypedToken(_coins[i]).transfer(to,out);
    }
}
contract TypedPermit {
    mapping(address=>mapping(address=>mapping(address=>uint256))) public permitted;
    function approve(address token,address spender,uint160 amount,uint48) external {permitted[msg.sender][token][spender]=amount;}
    function take(address from,address token,address to,uint256 amount) external {
        permitted[from][token][msg.sender]-=amount;TypedToken(token).transferFrom(from,to,amount);
    }
}
contract TypedVault {
    event Swap(address indexed pool,address indexed tokenIn,address indexed tokenOut,uint256 amountIn,uint256 amountOut,uint256 swapFeePercentage,uint256 swapFeeAmount);
    function send(address pool,address input,address output,uint256 amount,address to) external returns(uint256 out){
        out=amount*2;TypedToken(output).transfer(to,out);emit Swap(pool,input,output,amount,out,0,0);
    }
}
contract TypedPool {
    address public immutable getVault;
    constructor(address vault){getVault=vault;}
}
contract TypedRouter {
    address public immutable getPermit2;
    constructor(address permit){getPermit2=permit;}
    function swapSingleTokenExactIn(address pool,address input,address output,uint256 amount,uint256 minimum,uint256 deadline,bool native,bytes calldata data) external payable returns(uint256 out){
        require(!native&&data.length==0&&deadline>=block.timestamp&&msg.value==0);address vault=TypedPool(pool).getVault();
        TypedPermit(getPermit2).take(msg.sender,input,vault,amount);out=TypedVault(vault).send(pool,input,output,amount,msg.sender);require(out>=minimum);
    }
}
contract TypedZap {
    address public immutable pool;address public immutable base_pool;address public immutable token;address public immutable baseLp;
    address[4] private _coins;
    constructor(address meta,address base,address lp,address baseToken,address[4] memory tokens){pool=meta;base_pool=base;token=lp;baseLp=baseToken;_coins=tokens;}
    function coins(uint256 i) external view returns(address){return i==0?_coins[0]:baseLp;}
    function base_coins(uint256 i) external view returns(address){return _coins[i+1];}
    function add_liquidity(uint256[4] calldata amounts,uint256 minimum) external returns(uint256 out){
        for(uint256 i=0;i<4;i++)if(amounts[i]>0){TypedToken(_coins[i]).transferFrom(msg.sender,pool,amounts[i]);out=amounts[i]*2;if(i>0)TypedToken(baseLp).issue(base_pool,amounts[i]);}
        require(out>=minimum);TypedToken(token).issue(msg.sender,out);
    }
}
