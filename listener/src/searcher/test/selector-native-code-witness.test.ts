import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {ZeroAddress,keccak256} from "ethers";
import {compileSelectorNativeDiscovery,selectorNativeStateCandidate,selectorObservedTargetCode} from "../venues/selector-native-discovery.js";
import {normalizeSelectorNativeExecutionDefinition,selectorNativeProgramKey} from "../venues/selector-native-definition.js";
const mgr="0x000000000004444c5dc75cb358380d2e3de08a90",usdt="0xdac17f958d2ee523a2206206994597c13d831ec7",
 poolId="0x72331fcb696b0151904c03584b66dc8365bc63f8a144d89a773384e3a579ca73",hash="0x"+"1".repeat(64),source={number:50,hash,generation:51};
test("only an original, matching reverse-read packet can accompany an unchanged nomination with code evidence",async()=>{
 const def=normalizeSelectorNativeExecutionDefinition(JSON.parse(readFileSync(new URL("../venues/selector-native/selector-48c89491-family/selector-48c89491.json",import.meta.url),"utf8")));
 const key=selectorNativeProgramKey(def.programs[0]!),coords={chainId:1,poolNamespace:"contract-pool-id",poolId,target:mgr,tokenIn:ZeroAddress,tokenOut:usdt};
 const original=selectorNativeStateCandidate(def,coords,key);assert(original);
 const {discovery}=compileSelectorNativeDiscovery(def),get=(c:any,s=source,m=mgr)=>selectorObservedTargetCode(c,s,m);
 assert.equal(get(original),undefined);
 const capture=discovery.reverseBinding;assert.equal(capture?.kind,"implementation");
 let reads=0;const [self]=await (capture as any).reverseBinding({source,nominations:[{address:mgr,opaque:original}],
   provider:{getCode:async(a:string,n:number)=>{assert.equal(a,mgr);assert.equal(n,source.number);reads++;return "0x6000";}}});
 assert.equal(reads,1);const obs=self.observation,pattern=discovery.addressSurfaces!.find(s=>s.fingerprint===obs.interfaceFingerprints[0])!;
 const decode=(o:any)=>discovery.decodeCandidate({observation:o,matchedPatternId:pattern.id})!;
 const candidate=decode(obs);assert(candidate);assert.deepEqual(candidate,original);
 assert.equal(get(candidate),keccak256("0x6000"));assert.equal(discovery.candidateKey(candidate),discovery.candidateKey(original));
 for(const c of [structuredClone(candidate),{...candidate,codeHash:keccak256("0x6000")},decode(structuredClone(obs))])assert.equal(get(c),undefined);
 for(const s of [{...source,hash:"0x"+"2".repeat(64)},{...source,number:source.number+1},{...source,generation:54}]){assert.equal(get(candidate,s),undefined);assert.equal(get(decode({...obs,source:s}),s),undefined);}
 assert.equal(get(candidate,source,usdt),undefined);
 assert.equal(get(decode({...obs,codeHash:"0x"+"a".repeat(64)})),undefined);
 assert.equal(get(decode({...obs,opaque:{...obs.opaque}})),undefined);
});
