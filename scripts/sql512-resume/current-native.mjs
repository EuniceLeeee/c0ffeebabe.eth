// Code review is revision-scoped. An explicit resume binds the checked native
// bytes of the selected terminal; neither the code review nor copy starts a run.
import fs from 'node:fs';import {createHash} from 'node:crypto';import assert from 'node:assert/strict';
import {join,dirname,basename,isAbsolute} from 'node:path';import {pathToFileURL} from 'node:url';
import {deserialize} from 'node:v8';import {isDeepStrictEqual} from 'node:util';
const sha=b=>createHash('sha256').update(b).digest('hex'),hex=s=>typeof s==='string'&&/^[a-f0-9]{64}$/.test(s);
const checkout='/opt/mev-cloud/work/impl-aligned-84e18ec3',input='a4c58be9aa587a7d209038e188dee15d981560c3ff3962b9b4dc0c6d6c5c240d';
const cmpSource=(a,b)=>a&&b&&a.number===b.number&&a.hash===b.hash&&a.generation===b.generation;
const checkedPath=(p,d)=>{assert(isAbsolute(p)&&fs.realpathSync(p)===p,'indirect native path');const s=fs.lstatSync(p);assert(s.uid===process.getuid()&&(s.mode&0o077)===0&&(d?s.isDirectory():s.isFile()&&s.nlink===1),'not an owned private native object');};
const bytes=p=>{checkedPath(p,false);const fd=fs.openSync(p,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);try{const s=fs.fstatSync(fd);assert(s.isFile()&&s.uid===process.getuid()&&(s.mode&0o077)===0&&s.nlink===1);return fs.readFileSync(fd);}finally{fs.closeSync(fd);}};
const checked=(p,h)=>{assert(hex(h));const b=bytes(p);assert.equal(sha(b),h,'sealed bytes changed: '+basename(p));return b;};
const decode=b=>{const body=b.subarray(65);assert(b.length>65&&b[64]===10&&sha(body)===b.subarray(0,64).toString(),'bad native checksum');return deserialize(body);};
function put(p,b){const fd=fs.openSync(p,'wx',0o600);try{fs.writeFileSync(fd,b);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}}
function inventoryStat(r){assert(isAbsolute(r)&&fs.realpathSync(r)===r&&fs.lstatSync(r).isDirectory());}
const validBaseline=n=>/^baseline-[a-f0-9-]+\.bin$/.test(n);
function linkedArchive(arc,pointer,plan,target){
 checkedPath(arc,true);const current=checked(join(arc,'current.bin'),pointer),{version,pointer:p}=decode(current);
 assert(version===2&&p?.version===2&&p.head&&p.baseline&&!p.baseline.historical&&p.baseline.identity===plan.baseline.identity&&p.baseline.file===plan.baseline.file&&validBaseline(p.baseline.file)&&p.baseline.digest===plan.baseline.digest);
 const seal=new Map([['current.bin',pointer]]);const bb=checked(join(arc,p.baseline.file),plan.baseline.fileSha256);assert.equal(bb.subarray(0,64).toString(),p.baseline.digest);seal.set(p.baseline.file,plan.baseline.fileSha256);
 const records=[];let seq=p.head.sequence;assert(Number.isSafeInteger(seq)&&seq>=plan.seedSequence);
 for(let r=p.head;r;){
  assert(seq>0&&r.sequence===seq&&hex(r.digest)&&r.file==='delta-'+seq+'-'+r.digest+'.bin');
  const b=bytes(join(arc,r.file)),digest=sha(b);assert.equal(b.subarray(0,64).toString(),r.digest);const v=decode(b);assert(v.version===2&&v.sequence===seq&&hex(v.identity));
  if(seq===plan.seedSequence)assert.equal(digest,plan.seedHeadDigest,'archive is not descended from the original verified head');
  seal.set(r.file,digest);records.push([seq--,v.identity]);r=v.previous;
 }
 assert.equal(seq,0);const segments=[];for(const [sequence,identity] of records.reverse()){const prev=segments.at(-1);if(prev?.identity===identity)prev.last=sequence;else segments.push({identity,first:sequence,last:sequence});}
 const legacy=plan.seedWriterSegments;assert.deepEqual(segments.slice(0,legacy.length),legacy,'unreviewed historical writer chronology');
 assert(segments.length===legacy.length||segments.length===legacy.length+1&&segments.at(-1).identity===plan.consumerIdentityAtReviewedContext&&segments.at(-1).first===plan.seedSequence+1,'unreviewed successor writer');
 if(segments.length===legacy.length)assert.equal(pointer,plan.seedPointer,'unreviewed legacy pointer');
 assert.equal(p.identity,segments.at(-1).identity);assert.equal(p.identity,target.identity);assert.equal(p.baseline.identity,target.baselineIdentity);
 return {seal,segments};
}
function validatedReview(stage,reviewPath,reviewSha256){
 assert.equal(reviewPath,join(stage,'native-review.json'));checkedPath(stage,true);
 const review=JSON.parse(checked(reviewPath,reviewSha256));assert(review.schema==='sql512-native-revision-review/v1'&&review.verdict==='PASS'&&typeof review.author==='string'&&typeof review.reviewer==='string'&&review.author.trim()&&review.reviewer.trim()&&review.author!==review.reviewer);
 for(const k of ['ownerBinding','nonExecutionHistoricalOnly','predecessorArchive','currentTailPositiveNegative','unchangedFinalSimulation'])assert.equal(review.checks?.[k],true,k);
 assert(Array.isArray(review.evidence)&&review.evidence.length>0);const seen=new Set();
 for(const e of review.evidence){assert(typeof e.file==='string'&&/^[A-Za-z0-9_-]+[.](?:json|tap)$/.test(e.file)&&!['native-review.json','code-plan.json'].includes(e.file)&&!seen.has(e.file));seen.add(e.file);checked(join(stage,e.file),e.sha256);}
 const plan=JSON.parse(checked(join(stage,'code-plan.json'),review.planSha256));assert(plan.schema==='sql512-native-code-plan/v1'&&plan.sqlInputSha256===input&&Array.isArray(plan.producers)&&plan.producers.length===plan.seedWriterSegments.length);
 return plan;
}
/** Fixed cloud workspace; no alternate production export or CLI test mode. */
export async function prepareCurrentNative(args){
 assert.equal(args.root,checkout);assert.equal(dirname(args.priorRun),join(checkout,'logs'));assert(/^sql-official-500-[a-zA-Z0-9]{6}$/.test(basename(args.priorRun)));
 return inspect(args);
}
async function inspect({root,priorRun,terminal,pointerSha256,reviewPath,reviewSha256,ctx}){
 const stage=dirname(reviewPath),plan=validatedReview(stage,reviewPath,reviewSha256),src=join(root,'listener/src'),arc=join(priorRun,'continuation'),j=terminal.finalJournal;
 assert.deepEqual(ctx,plan.ctx);assert(terminal.run===priorRun&&terminal.dry===true&&terminal.inputSha256===input&&j?.verified===true&&terminal.nativeBinding?.verified===true&&terminal.reorgPending===false);
 assert(Number.isSafeInteger(j.sourceBlock)&&j.sourceBlock>0&&Number.isSafeInteger(j.generation)&&j.generation>0&&/^0x[a-f0-9]{64}$/.test(j.sourceBlockHash));const source=Object.freeze({number:j.sourceBlock,hash:j.sourceBlockHash,generation:j.generation});
 if(terminal.resumeCheckpoint)assert.equal(terminal.resumeCheckpoint.pointerSha256,pointerSha256);else assert.equal(pointerSha256,plan.seedPointer);
 assert.equal(terminal.nativeBinding.consumerIdentity,j.identity);inventoryStat(src);
 const lib=await import(pathToFileURL(join(src,'searcher/blockscan-live-continuation.ts')).href);
 const all=lib.sqlContinuationSourceFiles(src),cm=new Map(all),consumerAllSourceSha256=sha(JSON.stringify(all));assert.equal(consumerAllSourceSha256,plan.consumerAllSourceSha256);
 const consumerId=lib.liveContinuationIdentity(ctx,src);assert.equal(consumerId,plan.consumerIdentityAtReviewedContext);
 const perms=plan.producers.map((p,i)=>{
  assert(/^logs\/[A-Za-z0-9-]+\/listener\/src$/.test(p.relativeRoot));const dir=join(root,p.relativeRoot);inventoryStat(dir);
  const old=lib.sqlContinuationSourceFiles(dir),om=new Map(old);assert.equal(sha(JSON.stringify(old)),p.producerAllSourceSha256);
  const ds=[...new Set([...cm.keys(),...om.keys()])].sort().filter(f=>cm.get(f)!==om.get(f)).map(file=>({file,beforeSha256:om.get(file)??null,afterSha256:cm.get(file)??null}));
  assert(ds.length>0);assert.deepEqual(ds,p.changes);const id=lib.liveContinuationIdentity(ctx,dir);assert.equal(id,p.producerIdentity);assert.equal(id,plan.seedWriterSegments[i].identity);assert.notEqual(id,consumerId);
  return {producerRoot:dir,producerIdentity:id,producerAllSourceSha256:p.producerAllSourceSha256,changes:ds};
 });
 const {seal,segments}=linkedArchive(arc,pointerSha256,plan,j),producerIds=Object.freeze(segments.map(s=>s.identity)),isTail=producerIds.at(-1)===consumerId;
 // A later writer with the same code may have multiple reachable forks from
 // the migration seed. Require THIS child's chain to contain the immediately
 // preceding terminal's actual immutable head, not just a larger height.
 if(terminal.resumeCheckpoint){
  const prev=terminal.priorRun;
  assert(typeof prev==='string'&&dirname(prev)===dirname(priorRun)&&prev!==priorRun&&/^sql-official-500-[A-Za-z0-9]{6}$/.test(basename(prev)));checkedPath(prev,true);
  const pb=checked(join(prev,'terminal.json'),terminal.resumeCheckpoint.parentTerminalSha256),pt=JSON.parse(pb);
  assert(pt.run===prev&&pt.dry===true&&pt.inputSha256===input&&pt.finalJournal?.verified===true);
  const pa=join(prev,'continuation');checkedPath(pa,true);const expectedParent=pt.resumeCheckpoint?.pointerSha256??plan.seedPointer;
  const {pointer:pr}=decode(checked(join(pa,'current.bin'),expectedParent));
  const h=pr?.head;assert(pr?.version===2&&pr.baseline?.digest===plan.baseline.digest&&pr.identity===pt.finalJournal.identity&&
    Number.isSafeInteger(h?.sequence)&&h.sequence>=plan.seedSequence&&hex(h.digest)&&h.file==='delta-'+h.sequence+'-'+h.digest+'.bin'&&seal.has(h.file),'native chain breaks its immediate predecessor');
  checked(join(pa,h.file),seal.get(h.file));
 }
 assert.equal(new Set(producerIds).size,producerIds.length);assert.equal(terminal.nativeBinding.consumerAllSourceSha256,isTail?consumerAllSourceSha256:perms.at(-1).producerAllSourceSha256);
 const roles=isTail?[...perms,{producerRoot:src,producerIdentity:consumerId,producerAllSourceSha256:consumerAllSourceSha256,changes:[]}]:perms;
 const restore=async(loc)=>{
  const s=new lib.LivePricingContinuationStore(loc,consumerId,producerIds),d=await s.read();assert.equal(s.restoredNativePointerSha256(),pointerSha256);assert.deepEqual(s.restoredWriterSegments(),segments);
  assert(d?.identity===producerIds[0]&&d.pricing.pricing.effectiveMids?.complete&&d.pricing.pricing.effectiveMids.rows.size===d.pricing.pricing.graph.edges.length&&cmpSource(d.pricing.pricing.effectiveMids.source,source));assert.equal(d.pricing.pricing.sourceBlock,source.number);assert.equal(d.pricing.pricing.sourceBlockHash,source.hash);assert.equal(d.pricing.pricing.generation,source.generation);
  const raw=d.pricing.raw;return {number:raw.sourceBlock,hash:raw.sourceBlockHash,generation:raw.generation};
 };
 const rawSource=await restore(arc);assert.equal(j.baseline,rawSource.number);
 const proof={schema:isTail?'reviewed-native-sql-current-tail-v5':'reviewed-native-sql-ordered-resume-v4',verdict:'approved-for-bounded-dry-run',pointerFormat:2,scope:'native-source-bound-pricing-only',executionAuthorityUpgrade:false,sqlInputSha256:input,
  independentEvidencePath:reviewPath,independentEvidenceSha256:reviewSha256,consumerAllSourceSha256,pointerSha256,source,rawSource,producers:roles,writerSegments:segments};
 const proofBytes=Buffer.from(JSON.stringify(proof,null,2)+'\n'),proofDigest=sha(proofBytes);
 return Object.freeze({source,rawSource,pointerSha256,producerIds,consumerId,consumerAllSourceSha256,sqlInputSha256:input,proofDigest,expectedContext:structuredClone(ctx),
  async copyTo(dest){
   assert(basename(dest)==='continuation'&&isAbsolute(dest)&&!fs.lstatSync(dest,{throwIfNoEntry:false})&&dest!==arc);checkedPath(dirname(dest),true);
   checked(join(arc,'current.bin'),pointerSha256);fs.mkdirSync(dest,{mode:0o700});
   for(const [f,h] of seal)put(join(dest,f),checked(join(arc,f),h));checked(join(arc,'current.bin'),pointerSha256);assert.deepEqual(await restore(dest),rawSource);
   const proofPath=join(dirname(dest),'native-pricing-proof.json');put(proofPath,proofBytes);const val=lib.reviewedNativeSqlResume({manifest:proofPath,releasePin:proofDigest,directory:dest,dryOnly:true,sqlInputSha256:input,context:ctx,root:src});
   const s=new lib.LivePricingContinuationStore(dest,consumerId,val.producerIdentities),d=await s.read();val.checkRead(s,d);
   return Object.freeze({destination:dest,proofPath,proofDigest});
  }});
}
export function createCurrentBindingGate(prepared,proofDigest){
 assert(hex(proofDigest)&&proofDigest===prepared.proofDigest);let emitted=false,restored=false,failed=false;
 return {get identity(){return failed||!emitted?null:prepared.consumerId;},verified(){return emitted&&restored&&!failed;},read(line){assert(!failed);
  try{if(!line.startsWith('[searcher/live-continuation] {')){
   if(line.startsWith('[searcher/blockscan-family] {')&&!restored){const e=JSON.parse(line.slice(line.indexOf('{')));assert(e.type!=='block_scan_timing'||e.startup_warm!==false,'formal pass before native restore');}return;
  }const e=JSON.parse(line.slice(line.indexOf('{')));
  if(e.phase==='native-binding-verified'){
   assert(!emitted&&!restored&&e.dry===true&&e.trading===false&&e.sqlInputSha256===prepared.sqlInputSha256&&e.pointerSha256===prepared.pointerSha256&&e.proofSha256===proofDigest&&isDeepStrictEqual(e.context,prepared.expectedContext)&&isDeepStrictEqual(e.archivedProducers,prepared.producerIds)&&e.consumerIdentity===prepared.consumerId&&isDeepStrictEqual(e.source,prepared.source),'native runtime binding/ownership mismatch');emitted=true;
  }else if(e.phase==='restored'){
   assert(emitted&&!restored&&e.identity===prepared.consumerId&&e.sourceBlock===prepared.source.number&&e.sourceBlockHash===prepared.source.hash&&e.trading===false,'wrong native restore');restored=true;
  }else if(['saved','caught-up','catching-up-prices','hot-prices-required','hot-prices-advanced','hot-prices-ready'].includes(e.phase))assert(restored,'pricing progress before verified restore');
  }catch(e){failed=true;throw e;}
 }};
}
