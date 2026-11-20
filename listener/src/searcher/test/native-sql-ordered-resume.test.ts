import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { LivePricingContinuationStore as Store, liveContinuationFiles, liveContinuationIdentity,
  reviewedNativeSqlResume, sqlContinuationSourceFiles } from "../blockscan-live-continuation.js";
import { buildEffectiveMids, exportEffectiveMidReplayState } from "../blockscan-effective-mid.js";
import { BlockScanAmountReference } from "../blockscan-amount-reference.js";
import { ADDR } from "../../shared/constants/addresses.js";

test("ordered SQL resume verifies every writer against this consumer and the actual native read in order",async()=>{
  const tmp=await mkdtemp(join(tmpdir(),"sql-ordered-resume-"));
  const sha=(b:string|Buffer)=>createHash("sha256").update(b).digest("hex");
  try{
    const ctx={topology:"sql-edges:unit",sqlInputFingerprint:sha("unit SQL")},inputHash=sha("unit manifest");
    const roots=["a","b","c","d","e"].map(n=>join(tmp,n));
    for(const [i,root] of roots.entries()){
      for(const dir of ["adapters","shared","searcher/venues","searcher/simulator"])await mkdir(join(root,dir),{recursive:true});
      // Use just the mandatory individual files; the production inventory walker
      // still owns which of them authenticate semantic vs all-source identity.
      for(const [f] of liveContinuationFiles().filter(([name])=>/^(?:[^/]+|searcher\/[^/]+)\.ts$/.test(name))){
        await mkdir(dirname(join(root,f)),{recursive:true});await writeFile(join(root,f),f==="compiler.ts"?String(i):"// fixture");
      }
    }
    const ids=roots.map(r=>liveContinuationIdentity(ctx,r)),E=roots[4],out=join(tmp,"journal"),hash="0x"+sha("source");
    const source={number:10,hash,generation:1};
    const raw={sourceBlock:10,sourceBlockHash:hash,generation:1,graph:{edges:[]},mids:new Map(),coverage:{resolvedEdgeKeys:[]},pricingStateKeyByEdgeKey:new Map()};
    const effective=await buildEffectiveMids({pricing:raw,weth:ADDR.WETH,fixedWethInput:100n,gasCostWei:null,enumerationSpreadBps:0,concurrency:1,control:{},
      quote:async()=>{throw Error("no edges");}});
    const baseline:any={version:1,identity:ids[0],pricing:{version:1,raw,pricing:{...raw,effectiveMids:effective},lineage:exportEffectiveMidReplayState(effective),disabledInstances:[]},
      startup:{version:1,rows:[]},simRejects:{version:1,routes:[],pools:[]},amounts:new BlockScanAmountReference().exportHistoricalBaseline()};
    for(let i=0;i<4;i++){
      const writer=new Store(out,ids[i],ids.slice(0,i));if(!i)await writer.write(baseline);else await writer.read();
      await writer.append({version:2,source,previous:source,effective:null,disabled:[],amounts:new BlockScanAmountReference().takeContinuationDelta(),
        startup:{reset:false,rows:[]},simRejects:{reset:false,routes:[],pools:[]}});
    }
    const pointer=sha(await readFile(join(out,"current.bin"))), full=(r:string)=>sha(JSON.stringify(sqlContinuationSourceFiles(r)));
    const producers=roots.slice(0,4).map((r,i)=>({producerRoot:r,producerIdentity:ids[i],producerAllSourceSha256:full(r),
      changes:[{file:"compiler.ts",beforeSha256:sha(String(i)),afterSha256:sha("4")}]}));
    const evidence=join(tmp,"review");await writeFile(evidence,"unit evidence, not an approval");
    const base={schema:"reviewed-native-sql-ordered-resume-v4",verdict:"approved-for-bounded-dry-run",scope:"native-source-bound-pricing-only",executionAuthorityUpgrade:false,
      pointerFormat:2,pointerSha256:pointer,source,rawSource:source,sqlInputSha256:inputHash,consumerAllSourceSha256:full(E),
      independentEvidencePath:evidence,independentEvidenceSha256:sha(await readFile(evidence)),
      producers,writerSegments:producers.map((p,i)=>({identity:p.producerIdentity,first:i+1,last:i+1}))};
    const manifest=join(tmp,"manifest"),verify=async (v:unknown,overrides={})=>{const bytes=JSON.stringify(v);await writeFile(manifest,bytes);
      return reviewedNativeSqlResume({manifest,releasePin:sha(bytes),directory:out,dryOnly:true,sqlInputSha256:inputHash,context:ctx,root:E,...overrides});};
    const real=await verify(base),loader=new Store(out,ids[4],real.producerIdentities),data=await loader.read();
    assert.deepEqual(real.producerIdentities,ids.slice(0,4));real.checkRead(loader,data);
    await assert.rejects(verify(base,{dryOnly:false}));await assert.rejects(verify(base,{releasePin:sha("other")}));
    await assert.rejects(verify(base,{sqlInputSha256:sha("other SQL")}));await assert.rejects(verify({...base,baselineProducer:producers[0]}));
    await assert.rejects(verify({...base,producers:[producers[0],producers[1],producers[1],producers[3]]}));
    await assert.rejects(verify({...base,producers:[producers[1],producers[0],producers[2],producers[3]]}));
    await assert.rejects(verify({...base,producers:producers.map((p,i)=>i===2?{...p,changes:[]}:p)}));
    await assert.rejects(verify({...base,pointerSha256:sha("different pointer")}));
    // A self-consistent but false chronology / last boundary is vetoed only by
    // comparing the store's actual linked deltas, not by trusting the manifest.
    const switched=[1,0,2,3].map(i=>producers[i]);
    for(const wrong of [{...base,producers:switched,writerSegments:switched.map((p,i)=>({identity:p.producerIdentity,first:i+1,last:i+1}))},
      {...base,writerSegments:base.writerSegments.map((s,i)=>i===3?{...s,last:7}:s)}, {...base,source:{...source,generation:2}}]){
      const narrowed=await verify(wrong);assert.throws(()=>narrowed.checkRead(loader,data));
    }
    assert.throws(()=>real.checkRead(new Store(out,ids[4],ids.slice(0,4)),data));
    const own={producerRoot:E,producerIdentity:ids[4],producerAllSourceSha256:full(E),changes:[]};
    const currentWriter=new Store(out,ids[4],ids.slice(0,4));await currentWriter.read();
    await currentWriter.append({version:2,source,previous:source,effective:null,disabled:[],amounts:new BlockScanAmountReference().takeContinuationDelta(),
      startup:{reset:false,rows:[]},simRejects:{reset:false,routes:[],pools:[]}});
    const self={...base,schema:"reviewed-native-sql-current-tail-v5",pointerSha256:sha(await readFile(join(out,"current.bin"))),
      producers:[...producers,own],writerSegments:[...base.writerSegments,{identity:ids[4],first:5,last:5}]};
    const approved=await verify(self),currentStore=new Store(out,ids[4],approved.producerIdentities);
    assert.equal(approved.currentWriterTailVerified,true);assert.equal(real.currentWriterTailVerified,false);
    approved.checkRead(currentStore,await currentStore.read());
    await assert.rejects(verify({...self,schema:base.schema}));
    for(const bad of [{...own,producerIdentity:ids[2]},{...own,producerRoot:roots[1]},{...own,changes:[{}]}])
      await assert.rejects(verify({...self,producers:[...producers,bad]}));
    await assert.rejects(verify({...self,producers:[...producers.slice(0,-1),own,own]}));
    await assert.rejects(verify({...self,writerSegments:self.writerSegments.slice(0,-1)}));
  }finally{await rm(tmp,{recursive:true,force:true});}
});
