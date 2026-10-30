import { readFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { ethers } from "ethers";
import { UniverseRebuildCheckpointStore } from "./src/searcher/universe-rebuild-checkpoint.js";
import { createRebuildWiring } from "./src/searcher/universe-rebuild-production.js";
import { rebuildUniverse } from "./src/searcher/universe-rebuild-runner.js";
const args=new Map<string,string>();
for(let i=2;i<process.argv.length;i+=2) args.set(process.argv[i]!,process.argv[i+1]!);
const family=args.get("--family")!, block=Number(args.get("--block")!), out=resolve(args.get("--out")!);
const rpcUrl=JSON.parse(readFileSync(args.get("--rpc-file")!,"utf8")).MAINNET_RPC_URL;
const executor=ethers.getAddress(args.get("--executor")!).toLowerCase(), owner=ethers.getAddress(args.get("--owner")!).toLowerCase();
process.env.SEARCHER_DRY_RUN="1"; process.env.SEARCHER_BLOCKSCAN_SUBMIT="0";
process.env.MAINNET_RPC_URL=rpcUrl; process.env.SEARCHER_REVM_SIM_BIN=args.get("--revm-bin")!;
process.env.BOTVM_ADDRESS=executor; process.env.BOTVM_OWNER=owner;
mkdirSync(out,{recursive:true,mode:0o700});
const wiring=createRebuildWiring({ rpcUrl, familyIds:[family], executionIdentity:{ executor, transactionOrigin: owner } });
const ready=await rebuildUniverse({ ...wiring, store:new UniverseRebuildCheckpointStore({ path: resolve(out,"ready.json") }),
  runId:`accept-${family}-${block}`, observationRange:{fromBlock:block,toBlock:block}, attestationConcurrency:1,
  log:(m:string)=>console.log(m) });
console.log(JSON.stringify({cutoff:ready.cutoff,instances:ready.activeInstanceKeys}));
