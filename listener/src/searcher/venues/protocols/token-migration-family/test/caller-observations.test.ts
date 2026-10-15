import assert from "node:assert/strict";
import { test } from "node:test";
import { ethers } from "ethers";
import { SAMPLES, originalInputs } from "./caller-samples.js";
function fixture(name:"migration"|"btb",event:string,a:bigint,b:bigint){const s=SAMPLES[name],log=s.abi.encodeEventLog(s.abi.getEvent(event)!,["0x1000000000000000000000000000000000000009",a,b]);return {transactionHash:s.tx,status:"0x1",blockNumber:ethers.toQuantity(s.number),blockHash:s.hash,logs:[{address:s.target,logIndex:"0x1",...log}]};}
test("migration donor retains full original input, independently of output",()=>{assert.equal(originalInputs("migration",fixture("migration","TokensMigrated",100n,3n)).migrate!.amount,100n);});
test("Bear opposite direction borrows its actual token quantity only",()=>{const r=originalInputs("btb",fixture("btb","Redeemed",100n,300n));assert.equal(r.redeem!.amount,100n);assert.equal(r.mint!.amount,300n);});
test("source and unique positive event gates",()=>{const r=fixture("migration","TokensMigrated",100n,3n);assert.throws(()=>originalInputs("migration",{...r,blockHash:ethers.ZeroHash}));assert.throws(()=>originalInputs("migration",{...r,logs:[...r.logs,...r.logs]}));assert.throws(()=>originalInputs("migration",fixture("migration","TokensMigrated",0n,3n)));assert.throws(()=>originalInputs("migration",{...r,logs:r.logs.map(l=>({...l,removed:true}))}));});
