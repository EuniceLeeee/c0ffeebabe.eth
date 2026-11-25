import test from 'node:test';
import assert from 'node:assert/strict';
import {Interface} from 'ethers';
import {decodeDeclaredGetter,rememberMatchedGetter,withVerifiedGetterDecodes,VerifiedGetterDecodes} from '../venues/declarative-verified-getter-decode.js';

test('only repeated decoding of exactly confirmed bytes and a full output ABI is reusable',async()=>{
  const abi='function read() view returns (int256 signed, address asset)',fn='read()';
  const iface=new Interface([abi]),asset='0x'+'11'.repeat(20),raw=iface.encodeFunctionResult(fn,[-1n,asset]);
  const scope=new VerifiedGetterDecodes();
  await withVerifiedGetterDecodes(scope,async()=>{
    assert.equal(decodeDeclaredGetter(iface,fn,raw).signed,-1n);
    assert.equal(scope.hits,0);
    rememberMatchedGetter(abi,raw);
    const a=decodeDeclaredGetter(iface,fn,raw),b=decodeDeclaredGetter(iface,fn,raw);
    assert.equal(b.signed,-1n);assert.equal(b.asset,asset);assert.deepEqual(b.toObject(),a.toObject());
    assert.notEqual(a,b);assert.equal(scope.hits,1);
    const diffName=new Interface(['function read() view returns (uint256 unsigned,address who)']);
    const c=decodeDeclaredGetter(diffName,fn,raw);
    assert.equal(c.unsigned,(1n<<256n)-1n);assert.equal(c.signed,undefined);assert.equal(scope.hits,1);
    assert.equal(decodeDeclaredGetter(iface,fn,iface.encodeFunctionResult(fn,[0n,asset])).signed,0n);
    assert.equal(scope.hits,1);
    assert.throws(()=>decodeDeclaredGetter(iface,fn,'0x'));
    const other=new VerifiedGetterDecodes();
    await withVerifiedGetterDecodes(other,async()=>{
      decodeDeclaredGetter(iface,fn,raw);decodeDeclaredGetter(iface,fn,raw);assert.equal(other.hits,0);
    });
  });
  decodeDeclaredGetter(iface,fn,raw);assert.equal(scope.hits,1);
});
test('non-scalar results and deferred ABI errors are never memoized as success',async()=>{
  const s=new VerifiedGetterDecodes();
  await withVerifiedGetterDecodes(s,async()=>{
    const abi='function f() view returns (uint256[])',iface=new Interface([abi]),raw=iface.encodeFunctionResult('f',[[2n]]);
    rememberMatchedGetter(abi,raw);
    for(let i=0;i<2;i++)assert.deepEqual(Array.from(decodeDeclaredGetter(iface,'f',raw)[0]),[2n]);
    const addr='function g() view returns (address)',bad='0x'+'ff'.repeat(32),face=new Interface([addr]);
    rememberMatchedGetter(addr,bad);
    for(let i=0;i<2;i++)assert.throws(()=>decodeDeclaredGetter(face,'g',bad)[0]);
    assert.equal(s.hits,0);
  });
});
