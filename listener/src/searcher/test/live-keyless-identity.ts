import assert from "node:assert/strict";
import { test } from "node:test";
import { ethers } from "ethers";
import { keylessDryRunEnabled, loadLiveEnvironment, buildLiveExecutionWallet } from "../live-runtime-identity.js";
import { createBundleRouter, DryRunBundleRouter, ProductionBundleRouter } from "../execution/bundle-router.js";
const owner = "0x1000000000000000000000000000000000000001";
const botvm = "0x1000000000000000000000000000000000000002";
const provider = new ethers.JsonRpcProvider("http://127.0.0.1:1");
const enabled = { SEARCHER_DRY_RUN_KEYLESS:"1", SEARCHER_DRY_RUN:"1", SEARCHER_BLOCKSCAN_SUBMIT:"0", BOTVM_OWNER:owner };

test("explicit keyless mode reads no key or environment file and binds public execution identity", async () => {
  const env = new Proxy({...enabled}, { get(target, property) {
    if (property === "PRIVATE_KEY" || property === "OWNER_PRIVATE_KEY") throw new Error("key was read");
    return Reflect.get(target,property);
  }});
  let fileReads=0;loadLiveEnvironment(env, () => { fileReads++; return ""; });assert.equal(fileReads,0);
  const wallet = buildLiveExecutionWallet(provider,env);
  assert(wallet instanceof ethers.VoidSigner);
  assert.equal(wallet.address,ethers.getAddress(owner));
  assert.equal(wallet.provider,provider);
  let signed = 0;
  wallet.signTransaction = async () => { signed++; throw new Error("must not sign"); };
  const router=createBundleRouter({dryRun:true,wallet,provider,botvmAddress:botvm,defaultGasUsed:100000});
  assert(router instanceof DryRunBundleRouter);
  const result=await router.submit({victimTxHash:"0x"+"00".repeat(32),mode:"standalone",backrunCalldata:"0x1234",targetBlock:1,expectedProfit:1n});
  assert.equal(result[0]!.error,"dry-run-unsigned");assert.equal(result[0]!.accepted,false);assert.equal(signed,0);
  assert.throws(()=>createBundleRouter({dryRun:false,wallet,provider,botvmAddress:botvm,defaultGasUsed:100000}),/requires a signing Wallet/);
});

test("keyless flag fails closed on live/submit/malformed mode or invalid public owner", () => {
  for(const env of [{...enabled,SEARCHER_DRY_RUN:"0"},{...enabled,SEARCHER_BLOCKSCAN_SUBMIT:"1"},
    {...enabled,SEARCHER_BLOCKSCAN_SUBMIT:undefined},{...enabled,SEARCHER_DRY_RUN_KEYLESS:"true"}]) {
    let reads=0;assert.throws(()=>loadLiveEnvironment(env,()=>{reads++;return "";}));assert.equal(reads,0);
    assert.throws(()=>buildLiveExecutionWallet(provider,env));
  }
  for(const BOTVM_OWNER of [undefined,"bad",ethers.ZeroAddress]) assert.throws(()=>buildLiveExecutionWallet(provider,{...enabled,BOTVM_OWNER}));
});

test("keyless cannot be enabled by dotenv; ordinary loading semantics and disabled-file mode remain", () => {
  const env:NodeJS.ProcessEnv={};loadLiveEnvironment(env,()=>"# comment\nexport ORDINARY_VALUE='ok'\n");assert.equal(env.ORDINARY_VALUE,"ok");
  assert.throws(()=>loadLiveEnvironment({},()=>"SEARCHER_DRY_RUN_KEYLESS=1"),/process environment/);
  let reads=0;loadLiveEnvironment({SEARCHER_TEST_DISABLE_DOTENV:"1"},()=>{reads++;return "";});assert.equal(reads,0);
  assert.equal(keylessDryRunEnabled({}),false);assert.equal(keylessDryRunEnabled({SEARCHER_DRY_RUN_KEYLESS:"0"}),false);
});

test("default production path still requires a real Wallet and owner binding", () => {
  assert.throws(()=>buildLiveExecutionWallet(provider,{}),/PRIVATE_KEY or OWNER_PRIVATE_KEY required/);
  const key="0x"+"01".repeat(32); // public synthetic test-only input; never signs
  const wallet=buildLiveExecutionWallet(provider,{PRIVATE_KEY:key});assert(wallet instanceof ethers.Wallet);
  assert.throws(()=>buildLiveExecutionWallet(provider,{PRIVATE_KEY:key,BOTVM_OWNER:owner}),/does not match/);
  const router=createBundleRouter({dryRun:false,wallet,provider,botvmAddress:botvm,defaultGasUsed:100000});assert(router instanceof ProductionBundleRouter);
});
