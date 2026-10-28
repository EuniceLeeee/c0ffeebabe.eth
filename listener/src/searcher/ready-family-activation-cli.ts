/** Bounded launcher preflight: activation only, never discovery or attestation. */
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {createReadStream} from "node:fs";
import {writeFile} from "node:fs/promises";
import {UniverseRebuildCheckpointStore,activeReadyMemos} from "./universe-rebuild-checkpoint.js";
import {assertReadyFamilyActivation,refreshReadyInstances,restrictReadyFamilies,updateReadyFamilies} from "./universe-rebuild-runner.js";
import {createRebuildWiring} from "./universe-rebuild-production.js";
import {resolveStrictReadyRuntime} from "./strict-ready-runtime.js";

async function main():Promise<void>{
  assert.equal(process.env.SEARCHER_DRY_RUN,"1");assert.equal(process.env.SEARCHER_BLOCKSCAN_SUBMIT,"0");
  assert(!process.env.OWNER_PRIVATE_KEY&&!process.env.PRIVATE_KEY);
  const path=process.env.SEARCHER_UNIVERSE_REBUILD_CHECKPOINT_PATH!,output=process.env.SEARCHER_READY_ACTIVATION_RECEIPT!;
  assert(path&&output&&path!==output);
  const sourceSha256=process.env.SEARCHER_READY_SOURCE_SHA256!,cacheKey=process.env.SEARCHER_READY_ACTIVATION_KEY!;
  assert(/^[0-9a-f]{64}$/.test(sourceSha256)&&/^[0-9a-f]{64}$/.test(cacheKey));
  const sourceHash=createHash("sha256");for await(const chunk of createReadStream(path))sourceHash.update(chunk);
  assert.equal(sourceHash.digest("hex"),sourceSha256,"Ready source changed before activation");
  const store=new UniverseRebuildCheckpointStore({path});
  const wiring=createRebuildWiring({rpcUrl:process.env.MAINNET_RPC_URL,
    executionIdentity:{executor:process.env.BOTVM_ADDRESS!,transactionOrigin:process.env.BOTVM_OWNER!}});
  const noWork=async():Promise<never>=>{throw new Error("activation requires new or stale evidence; run scoped Ready explicitly");};
  const pure={...wiring,store,scanSwapWindow:noWork,freezeCanonicalHead:noWork,attestFamilyInstanceOnce:noWork,findReusableMemo:noWork,
    log:(message:string)=>{if(!message.includes("ready instance refresh"))console.log("[ready-activation] "+message);}};
  console.log("[ready-activation] loading source Ready");
  const base=await store.load();assert(base?.readyGeneration&&base.inProgressRun===null);
  const sourceGeneration=Number(process.env.SEARCHER_READY_SOURCE_GENERATION);assert.equal(base.readyGeneration.generation,sourceGeneration);
  const coverage=new Set(base.readyGeneration.sourceCoverage.map(row=>row.familyId+"|"+row.sourceId));
  assert(wiring.requiredSourceCoverageKeys().every(key=>coverage.has(key)),"new Family lacks Ready coverage; scoped Ready required");
  const disabled=base.readyGeneration.activationRestriction?.disabledFamilyIds??[];
  const restore=disabled.some(id=>wiring.isFamilyEnabled!(id));
  const restrict=activeReadyMemos(base).some(memo=>!wiring.isFamilyEnabled!(memo.familyId));
  if(restore)await updateReadyFamilies(pure);
  else if(restrict)await restrictReadyFamilies(pure);
  const ready=await refreshReadyInstances(pure),next=await store.load();assert(next);
  const memos=activeReadyMemos(next);assertReadyFamilyActivation(memos,wiring.isFamilyEnabled);
  const runtime=resolveStrictReadyRuntime(ready);
  const instances=memos.map(memo=>wiring.rehydrateVerifiedInstance({memo,cutoff:ready.cutoff}));
  const publications=wiring.aggregateOnceByFamily(instances);
  wiring.assertReadyGraphSnapshot!({publications,graphSnapshot:ready.graphSnapshot,cutoff:ready.cutoff});
  const hash=createHash("sha256");for await(const chunk of createReadStream(path))hash.update(chunk);
  const receipt={schemaVersion:1,cacheKey,sourceSha256,sourceGeneration,generation:ready.generation,readySha256:hash.digest("hex"),
    activeInstances:memos.length,graphEdges:runtime.graph.length,disabledFamilyIds:ready.activationRestriction?.disabledFamilyIds??[],
    scans:0,attestations:0,signing:false,broadcast:false};
  await writeFile(output,JSON.stringify(receipt)+"\n",{flag:"wx",mode:0o600});
  console.log("[ready-activation] complete "+JSON.stringify(receipt));
}
main().then(()=>process.exit(0)).catch(error=>{
  let message=String(error?.message??error);const rpc=process.env.MAINNET_RPC_URL;if(rpc)message=message.replaceAll(rpc,"[RPC_REDACTED]");
  console.error("[ready-activation] "+message.replace(/https?:\/\/[^\s"<>]+/g,"[URL_REDACTED]"));process.exit(1);
});
