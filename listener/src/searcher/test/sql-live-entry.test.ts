import { test } from "node:test";
import assert from "node:assert/strict";
import { ethers } from "ethers";
import { liveDryRunEnabled, liveExecutionSigner } from "../live-signer.js";
import { createBundleRouter, DryRunBundleRouter } from "../execution/bundle-router.js";
import { buildSqlStrategyIntakeView } from "../strategy-views.js";
import type { TokenEdge } from "../planner/token-graph.js";

test("production dry-run keeps only an authenticated public origin and cannot sign", async () => {
  const provider = new ethers.JsonRpcProvider();
  try {
    const testKey = ethers.Wallet.createRandom();
    const env = { SEARCHER_DRY_RUN: "1", BOTVM_OWNER: testKey.address };
    assert.equal(liveDryRunEnabled({}),true);
    assert.equal(liveDryRunEnabled({SEARCHER_DRY_RUN:"0"}),false);
    for(const v of ["", "true", "false","2"]) assert.throws(()=>liveDryRunEnabled({SEARCHER_DRY_RUN:v}),/0 or 1/);
    for (const settings of [env, {...env,PRIVATE_KEY:testKey.privateKey}, {BOTVM_OWNER:testKey.address},
      {BOTVM_OWNER:testKey.address,PRIVATE_KEY:testKey.privateKey}]) {
      const wallet = liveExecutionSigner(settings,provider);
      assert(wallet instanceof ethers.VoidSigner);
      assert.equal(wallet.address,testKey.address);
      await assert.rejects(wallet.signMessage("unsigned dry-run"), /cannot sign/);
      const wiring = {wallet,provider,botvmAddress:testKey.address,defaultGasUsed:100000};
      assert(createBundleRouter({...wiring,dryRun:true}) instanceof DryRunBundleRouter);
      assert.throws(()=>createBundleRouter({...wiring,dryRun:false}),/requires a signing wallet/);
    }
    assert.throws(()=>liveExecutionSigner({...env,SEARCHER_DRY_RUN:"0"},provider),/required for live/);
    assert(liveExecutionSigner({...env,SEARCHER_DRY_RUN:"0",PRIVATE_KEY:testKey.privateKey},provider) instanceof ethers.Wallet);
    assert.throws(()=>liveExecutionSigner({SEARCHER_DRY_RUN:"1"},provider),/requires BOTVM_OWNER/);
    assert.throws(()=>liveExecutionSigner({...env,PRIVATE_KEY:ethers.Wallet.createRandom().privateKey},provider),/does not match/);
  } finally {provider.destroy();}
});

test("graph intake deduplicates addresses, not distinct logical pools or authenticated input versions", () => {
  const addr=(n:number)=>ethers.getAddress(ethers.zeroPadValue(ethers.toBeHex(n),20));
  const target=addr(2), emitter=addr(3);
  const edge:TokenEdge={target,observationTarget:emitter,observationPoolId:"poolA",tokenIn:addr(7),tokenOut:addr(8),
    adapterId:"generic",edgeKind:"swap",leavesStandingPosition:false,slotKind:"swap"};
  const rows=[edge,{...edge,tokenIn:edge.tokenOut,tokenOut:edge.tokenIn},{...edge,observationPoolId:"poolB"}];
  const a=buildSqlStrategyIntakeView(rows,"input-a");
  assert.deepEqual(a.targets,[{address:target},{address:emitter}]);
  assert.deepEqual(a.pools,[{address:emitter,poolId:"poolA"},{address:emitter,poolId:"poolB"}]);
  assert.deepEqual(a,buildSqlStrategyIntakeView([...rows].reverse(),"input-a"));
  assert.notEqual(a.version,buildSqlStrategyIntakeView(rows,"input-b").version);
});
