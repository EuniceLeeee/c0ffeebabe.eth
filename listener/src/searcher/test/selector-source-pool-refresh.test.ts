import assert from 'node:assert/strict';
import test from 'node:test';
import {Interface} from 'ethers';
import {PoolLegRefreshIndex,observePoolLegRefresh,type PoolActivityRule} from '../pool-leg-refresh.js';
const a=(n:number)=>'0x'+n.toString(16).padStart(40,'0');
const pool=a(1),otherPool=a(2),token=a(3),otherToken=a(4),user=a(5);
const erc20=new Interface(['event Transfer(address indexed from,address indexed to,uint256 value)','event Approval(address indexed owner,address indexed spender,uint256 value)']);
test('declared pool events select every pool leg, never every token consumer',()=>{
 const activity:PoolActivityRule={on:['call-target','log-emitter','asset-transfer-endpoint'],assets:[token]};
 const index=new PoolLegRefreshIndex([0,1,2,3,4].map(n=>({poolAddress:n===4?otherPool:pool,legId:'leg'+n,stateKey:'state'+n,activity})));
 const select=(address:string,name:string,args:unknown[])=>observePoolLegRefresh(index,{kind:'log',address,...erc20.encodeEventLog(name,args)}).legIds;
 assert.deepEqual(select(token,'Transfer',[user,pool,7n]),['leg0','leg1','leg2','leg3']);
 assert.deepEqual(select(token,'Transfer',[user,a(6),7n]),[]);
 assert.deepEqual(select(otherToken,'Transfer',[user,pool,7n]),[]);
 assert.deepEqual(select(token,'Approval',[user,pool,7n]),[]);
 const nft=new Interface(['event Transfer(address indexed from,address indexed to,uint256 indexed tokenId)']);
 assert.deepEqual(observePoolLegRefresh(index,{kind:'log',address:token,...nft.encodeEventLog('Transfer',[user,pool,7n])}).legIds,[]);
});
test('logical source watches only full pool IDs, not manager calls or shared custody transfers',()=>{
 const id='0x'+'11'.repeat(32),other='0x'+'22'.repeat(32);
 const activity:PoolActivityRule={on:['pool-id-event'],assets:[token,'0x'+'00'.repeat(20)]};
 const index=new PoolLegRefreshIndex([{poolAddress:pool,poolId:id,legId:'forward',stateKey:'same',activity},
  {poolAddress:pool,poolId:id,legId:'reverse',stateKey:'same',activity},
  {poolAddress:pool,poolId:other,legId:'other',stateKey:'other',activity}],true);
 const scopes=()=>[id];
 assert.deepEqual(observePoolLegRefresh(index,{kind:'call',target:pool,data:'0x'},scopes).legIds,[]);
 assert.deepEqual(observePoolLegRefresh(index,{kind:'log',address:token,...erc20.encodeEventLog('Transfer',[user,pool,7n])},scopes).legIds,[]);
 assert.deepEqual(observePoolLegRefresh(index,{kind:'log',address:pool,topics:[],data:'0x'},()=>null).legIds,[]);
 const picked=observePoolLegRefresh(index,{kind:'log',address:pool,topics:[],data:'0x'},scopes);
 assert.deepEqual(picked.legIds,['forward','reverse']);assert.deepEqual(picked.touchedPoolKeys,[JSON.stringify([pool,id])]);
 assert.throws(()=>new PoolLegRefreshIndex([{poolAddress:pool,poolId:id,legId:'bad',stateKey:'bad',activity:{on:['call-target'],assets:[token]}}]));
});
test('activity modes are consumed and copied rather than hardcoded or externally mutable',()=>{
 const on:PoolActivityRule['on'][number][]=['call-target'],assets=[token];
 const index=new PoolLegRefreshIndex([{poolAddress:pool,legId:'leg',stateKey:'state',activity:{on,assets}}]);
 on.push('log-emitter','asset-transfer-endpoint');assets.push(otherToken);
 assert.deepEqual(observePoolLegRefresh(index,{kind:'call',target:pool,data:'0x'}).legIds,['leg']);
 assert.deepEqual(observePoolLegRefresh(index,{kind:'log',address:pool,topics:[],data:'0x'}).legIds,[]);
 assert.deepEqual(observePoolLegRefresh(index,{kind:'log',address:token,...erc20.encodeEventLog('Transfer',[user,pool,1n])}).legIds,[]);
});
