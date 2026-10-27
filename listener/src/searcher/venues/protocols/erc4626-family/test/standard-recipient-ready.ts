// Current-production single-block Ready discovery from real saved candidate blocks.
// Original non-partitioned Ready stays immutable and is provenance only.
import assert from "node:assert/strict";
import { constants, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ethers } from "ethers";
import { UniverseRebuildCheckpointStore, activeReadyMemos } from "../../../../universe-rebuild-checkpoint.js";
import { createRebuildWiring } from "../../../../universe-rebuild-production.js";
import { rebuildUniverse } from "../../../../universe-rebuild-runner.js";

import { sha } from "../../../../test/family-integration/kyber-yb-compound/evidence.js";
import { plugin as erc4626Plugin } from "../../../production-families/erc4626.production.js";

const FAMILY = erc4626Plugin.manifest.familyId;

async function main() {
  const names = ["--from-block", "--to-block", "--block-hash", "--rpc-file", "--out", "--executor", "--owner", "--revm-bin", "--prior-ready"];
  const args = new Map<string, string>();
  for (let i = 2; i < process.argv.length; i += 2) {
    assert(names.includes(process.argv[i]!) && !args.has(process.argv[i]!) && process.argv[i + 1]);
    args.set(process.argv[i]!, process.argv[i + 1]!);
  }
  assert(names.every(n => args.has(n)));
  const fromBlock = Number(args.get("--from-block")), toBlock = Number(args.get("--to-block"));
  assert(Number.isSafeInteger(fromBlock) && Number.isSafeInteger(toBlock) && fromBlock > 0 && toBlock === fromBlock);
  const hash = args.get("--block-hash")!; assert(ethers.isHexString(hash, 32));
  const out = resolve(args.get("--out")!); assert(!existsSync(out));
  const executor = ethers.getAddress(args.get("--executor")!), owner = ethers.getAddress(args.get("--owner")!);
  const priorPath = resolve(args.get("--prior-ready")!);
  assert(!existsSync(priorPath + ".lock") && !existsSync(priorPath + ".attestation-journal"));
  const priorBytes = readFileSync(priorPath);
  const prior = await new UniverseRebuildCheckpointStore({path: priorPath}).load();
  assert(prior?.readyGeneration && !prior.inProgressRun);
  assert(prior.readyGeneration.universeRange.fromBlock <= toBlock && prior.readyGeneration.universeRange.toBlock >= toBlock);
  const candidates = activeReadyMemos(prior).filter(m => m.familyId === FAMILY).map(m => m.candidateSnapshot as {blockNumber?:number;blockHash?:string});
  assert(candidates.some(c => c.blockNumber === toBlock && c.blockHash === hash), "block must contain a real saved nomination; candidates are not injected");
  const rpcUrl = JSON.parse(readFileSync(args.get("--rpc-file")!, "utf8")).MAINNET_RPC_URL;
  assert(typeof rpcUrl === "string" && /^https?:\/\//.test(rpcUrl));
  process.env.SEARCHER_DRY_RUN = "1"; process.env.SEARCHER_BLOCKSCAN_SUBMIT = "0";
  process.env.SEARCHER_DRY_RUN_BOTVM_CODE_OVERRIDE = "1";
  process.env.MAINNET_RPC_URL = rpcUrl; process.env.SEARCHER_REVM_SIM_BIN = args.get("--revm-bin")!;
  process.env.BOTVM_ADDRESS = executor; process.env.BOTVM_OWNER = owner;
  const provider = new ethers.JsonRpcProvider(rpcUrl, 1, {staticNetwork:true,batchMaxCount:1});
  mkdirSync(out, {recursive:true,mode:0o700});
  const save = (name:string,value:unknown) => writeFileSync(resolve(out,name),JSON.stringify(value,null,2)+"\n",{flag:"wx",mode:0o600});
  let stage = "header";
  try {
    const header = await provider.send("eth_getBlockByNumber", [ethers.toQuantity(toBlock),false]);
    assert.equal(header.hash,hash); save("header.json",header);
    save("input-provenance.json",{priorReady:priorPath,sha256:sha(priorBytes),source:prior.readyGeneration.cutoff,
      priorRange:prior.readyGeneration.universeRange,partitioned:prior.readyGeneration.familyPartitions!==undefined,
      scope:"Saved real candidate provenance for current production admission; discovery-mode records fresh discovery or valid partitioned selective revalidation. Original cutoff may differ; no old output or natural-price/opportunity claim"});
    stage = "production-scoped-ready";
    const checkpoint=resolve(out,"ready.json");
    const canReuse=prior.readyGeneration.familyPartitions!==undefined&&prior.readyGeneration.cutoff.number===toBlock&&prior.readyGeneration.cutoff.hash===hash&&prior.readyGeneration.universeRange.fromBlock===toBlock&&prior.readyGeneration.universeRange.toBlock===toBlock;
    let familyUpdateScope;
    if(canReuse){assert(prior.readyGeneration.observationScope===undefined);assert(Object.keys(prior.readyGeneration.familyPartitions!).includes(FAMILY));copyFileSync(priorPath,checkpoint,constants.COPYFILE_EXCL);assert(readFileSync(checkpoint).equals(priorBytes));familyUpdateScope={parentCheckpointFingerprint:prior.checkpointFingerprint,familyIds:[FAMILY]};}
    save("discovery-mode.json",{mode:canReuse?"production-selective-revalidation":"fresh-production-single-block-discovery",preservedOriginal:true});
    const wiring = createRebuildWiring({rpcUrl,familyIds:[FAMILY],executionIdentity:{executor,transactionOrigin:owner}});
    const ready = await rebuildUniverse({...wiring,store:new UniverseRebuildCheckpointStore({path:checkpoint}),
      runId:`erc4626-standard-${toBlock}`,observationRange:{fromBlock,toBlock},...(familyUpdateScope?{familyUpdateScope}:{}),attestationConcurrency:4,log:message=>console.log(message)});
    assert.equal(ready.cutoff.number,toBlock); assert.equal(ready.cutoff.hash,hash);
    assert(readFileSync(priorPath).equals(priorBytes));
    assert(!existsSync(priorPath+".lock")&&!existsSync(priorPath+".attestation-journal"));
    save("ready-summary.json",{source:ready.cutoff,range:ready.universeRange,instances:ready.activeInstanceKeys,graphHash:ready.graphHash,prices:"not run",broadcast:false});
  } catch(error) {
    const message=String(error instanceof Error?error.stack:error).split(rpcUrl).join("[REDACTED]").replace(/https?:\/\/[^\s"<>]+/g,"[REDACTED_URL]");
    save("failure.json",{stage,message});console.error(JSON.stringify({stage,message}));process.exitCode=1;
  } finally {provider.destroy();}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(error=>{
  console.error(String(error instanceof Error?error.stack:error).replace(/https?:\/\/[^\s"<>]+/g,"[REDACTED_URL]"));process.exitCode=1;
});
