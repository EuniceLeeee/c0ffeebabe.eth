// The bootstrap is an immutable historical event, not "next attempt = N".
// Handoff is manual: selection never starts work, allocates a slot or rewrites a pointer.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {join,dirname,basename} from 'node:path';
import {createHash} from 'node:crypto';
import {tmpdir} from 'node:os';
const logsRoot='/opt/mev-cloud/work/impl-aligned-84e18ec3/logs',input='a4c58be9aa587a7d209038e188dee15d981560c3ff3962b9b4dc0c6d6c5c240d';
const genesis=Object.freeze({attempt:13,terminal:'c8960d4ae64f3da085f09b203ed2271f83370d40afd6641810912798f7193497',
 marker:'c15a27270f0c5a78ffafe46c82fb142acd2821cec913590248358b2bfaf4a899',pointer:'f8778790e3e0005387845eb86390aef0d0dc8dbdd16c9698ed438cea06765acf',
 cap:7510528,priorCu:2706162,spent:3973406,day:'2026-11-20',bytes:43815952,dayHash:'932e9c82196d11b6e41fdeeb9392e3a4569777a442bfd8646673ecae5a0836dd',
 calls:314475,cu:11483908,input});
const sha=b=>createHash('sha256').update(b).digest('hex'),hex=s=>typeof s==='string'&&/^[a-f0-9]{64}$/.test(s),
 num=x=>Number.isSafeInteger(x)&&x>=0,runName=s=>/^sql-official-500-[A-Za-z0-9]{6}$/.test(s),
 privateDir=p=>{const st=fs.lstatSync(p);assert(fs.realpathSync(p)===p&&st.isDirectory()&&st.uid===process.getuid()&&!(st.mode&0o077),'private directory expected');};
function bytes(p,max=65536){assert(fs.realpathSync(p)===p,'redirected receipt');
 const fd=fs.openSync(p,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
 try{const st=fs.fstatSync(fd);assert(st.isFile()&&st.uid===process.getuid()&&st.nlink===1&&!(st.mode&0o077)&&st.size>0&&st.size<=max,'invalid receipt file');return fs.readFileSync(fd);}finally{fs.closeSync(fd);}}
function durableNew(p,data){const fd=fs.openSync(p,'wx',0o600);try{fs.writeFileSync(fd,data);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
 const d=fs.openSync(dirname(p),'r');try{fs.fsyncSync(d);}finally{fs.closeSync(d);}}
const present=p=>!!fs.lstatSync(p,{throwIfNoEntry:false});
function checkRun(logs,run){assert(typeof run==='string'&&runName(basename(run))&&run===join(logs,basename(run)),'foreign run');privateDir(run);}
const marker=(dir,d,n)=>join(dir,'official-500-'+d+(n===1?'':'.repair-'+n)+'.started');
const seal=(dir,d,n)=>join(dir,'official-500-'+d+'.repair-'+n+'.terminal-seal.json');
const methodsFrom=(m)=>{assert(m&&typeof m==='object'&&!Array.isArray(m),'missing method totals');let n=0;
 for(const [s,v] of Object.entries(m)){assert(/^(?:eth|debug)_[A-Za-z0-9]+$/.test(s)&&num(v)&&v>0);n+=v;}assert(num(n));return n;};
const fileDay=/^official500-daily-(\d{4}-\d{2}-\d{2})\.jsonl$/;
const utcToday=()=>new Date().toISOString().slice(0,10);
const group=(a,m)=>{for(const [k,v] of Object.entries(m))a[k]=(a[k]??0)+v;};
const rootPin=m=>({day:m.day,bytes:m.bytes,sha256:m.dayHash,calls:m.calls,cu:m.cu});
const dayPin=p=>({...p,meteredPrefix:p.calls>0});
// Older ledgers can contain independently billed jobs. Require exact prefix bytes and
// let the supervisor's existing per-method debit validator recheck its own ledger.
// No spending after the pinned close is permitted except the single actual writer
// being closed. A fresh day header written under the OS lock contains no debit.
function reconcileCalendar(dir,before,{writer=null,cloudRpc=null}={}){
 privateDir(dir);const pins=new Map(before.map(p=>[p.day,p]));assert(pins.size===before.length&&before.length);
 const files=fs.readdirSync(dir).map(n=>n.match(fileDay)?.[1]).filter(x=>x&&x>=before[0].day).sort();
 assert(before.every(p=>files.includes(p.day))&&files.every(d=>d<=utcToday()),'missing or future ledger day');
 const after=[],extraMethods={},max=128*1024*1024;let addedCu=0,addedCalls=0;
 for(const d of files){
  const p=pins.get(d),b=bytes(join(dir,'official500-daily-'+d+'.jsonl'),max);
  assert(b.at(-1)===10,'partial ledger');let at,calls=0,cu=0;
  if(p){assert(b.length>=p.bytes&&b[p.bytes-1]===10&&sha(b.subarray(0,p.bytes))===p.sha256,'ledger prefix changed');at=p.bytes;calls=p.calls;cu=p.cu;
   if(d<before.at(-1).day)assert.equal(b.length,at,'posthumous debit');}
  else {assert(d>before.at(-1).day,'unexpected inserted day');const nl=b.indexOf(10);assert(nl>0);const header=JSON.parse(b.subarray(0,nl));
   assert(header.day===d&&header.scope==='this supervisor only'&&header.dailyCuPolicy==='meter-only'&&header.localDayCu===null,'invalid new ledger header');at=nl+1;}
  if(at!==b.length){assert(writer,'unreconciled charges since predecessor');for(const text of b.subarray(at,-1).toString().split('\n')){
    const e=JSON.parse(text);assert(e.run===writer&&num(e.calls)&&e.calls>0&&num(e.cu)&&num(e.at)&&new Date(e.at).toISOString().slice(0,10)===d&&methodsFrom(e.methodCounts)===e.calls,'foreign/invalid debit');
    addedCalls+=e.calls;addedCu+=e.cu;calls+=e.calls;cu+=e.cu;group(extraMethods,e.methodCounts);
  }}
  after.push({day:d,bytes:b.length,sha256:sha(b),calls,cu});
 }
 if(cloudRpc){assert.equal(addedCu,cloudRpc.dispatchedPublishedCu,'cumulative charge mismatch');assert.equal(addedCalls,cloudRpc.calls,'cumulative method count mismatch');
  assert.deepEqual(extraMethods,cloudRpc.methodCounts,'actual per-method charges differ');const last=after.at(-1);
  assert.equal(last.day,cloudRpc.day);assert.equal(last.cu,cloudRpc.localDayCu);assert.equal(last.calls,cloudRpc.localDayCalls);}
 return after;
}
function viable(t,run,attempt,d,cap,prevCu){
 const j=t.finalJournal,b=t.nativeBinding,q=t.cloudRpc;
 assert(t.run===run&&t.attempt===attempt&&t.inputSha256===d&&t.dry===true&&t.graph===true&&t.reorgPending===false&&t.lease===null,'not a verified dry terminal');
 assert(Number.isFinite(Date.parse(t.ended))&&num(t.formalCompleted)&&t.formalCompleted<=500,'bad count or end');
 const normal=t.reason==='block_limit'&&t.formalCompleted===500&&t.code===0&&t.signal===null;
 const stopped=t.reason==='supervisor_interrupted'&&t.formalCompleted<500&&((t.code===0&&t.signal===null)||(t.code===null&&t.signal==='SIGTERM'));
 assert(normal||stopped,'terminal not eligible for ordinary resume');
 assert(j?.verified===true&&num(j.sourceBlock)&&j.sourceBlock>0&&num(j.baseline)&&j.baseline<=j.sourceBlock&&num(j.generation)&&j.generation>0&&
  /^0x[a-f0-9]{64}$/.test(j.sourceBlockHash)&&hex(j.identity)&&hex(j.baselineIdentity)&&b?.verified===true&&b.consumerIdentity===j.identity&&hex(b.consumerAllSourceSha256),'journal or binding unverified');
 assert(q&&q.runCuLimit===cap&&q.dailyCuPolicy==='meter-only'&&q.priorRunCu===prevCu&&q.repairCu===cap-prevCu&&num(q.dispatchedPublishedCu)&&q.priorRunCu+q.dispatchedPublishedCu===q.combinedRunCu&&q.combinedRunCu<=cap&&num(q.calls)&&methodsFrom(q.methodCounts)===q.calls,'run debit lineage differs');
 return {number:j.sourceBlock,hash:j.sourceBlockHash,generation:j.generation};
}
function linkedState(logs,d,m){
 assert(fs.realpathSync(logs)===logs&&d===m.input);const entries=fs.readdirSync(logs),prefix='official-500-'+d;
 const slots=entries.filter(f=>f.startsWith(prefix)&&f.endsWith('.started'));assert(slots.length>=m.attempt,'missing migration anchor');
 let j,prev=null,prevHash=null,pointer,currentMarker,spent,days,previousSource,allow;
 const runs=new Set();for(let n=1;n<=slots.length;n++){
  const mp=marker(logs,d,n);assert(slots.includes(basename(mp)),'noncontiguous or unexpected marker');const mb=bytes(mp),ms=sha(mb);let run,mark;
  if(n===1){const s=mb.toString();run=s.slice(0,-1);assert.equal(s,run+'\n');}
  else {mark=JSON.parse(mb);run=mark.run;assert(mark.attempt===n&&mark.inputSha256===d&&mark.priorRun===prev&&mark.priorTerminalSha256===prevHash,'invalid prior-terminal link');
   if(n<=m.attempt)assert.equal(mark.format,'sql-live-repair/v1');else assert(mark.format==='sql-current-resume/v1'&&mark.priorPointerSha256===pointer&&mark.priorMarkerSha256===currentMarker&&mark.priorCombinedRunCu===spent,'invalid predecessor seal');}
  assert(!runs.has(run),'duplicate run');runs.add(run);checkRun(logs,run);
  const terminalPath=join(run,'terminal.json');assert(present(terminalPath),'latest attempt active or lacks terminal');
  const tb=bytes(terminalPath),ts=sha(tb),t=JSON.parse(tb);
  if(n>=m.attempt){const source=viable(t,run,n,d,m.cap,n===m.attempt?m.priorCu:spent);
   assert(t.priorRun===prev);let ptr;
   if(n===m.attempt){assert(ms===m.marker&&ts===m.terminal&&t.cloudRpc.combinedRunCu===m.spent,'migration anchor diverged');ptr=m.pointer;days=[rootPin(m)];}
   else {const rec=JSON.parse(bytes(seal(logs,d,n)));assert(rec.schema==='sql-current-terminal/v1'&&rec.attempt===n&&rec.run===run&&rec.terminalSha256===ts&&rec.markerSha256===ms,'terminal seal mismatch');
    const c=t.resumeCheckpoint;assert(c?.schema==='sql-current-checkpoint/v1'&&c.parentTerminalSha256===prevHash&&c.markerSha256===ms&&c.pointerSha256===rec.pointerSha256&&hex(c.pointerSha256),'unverified terminal checkpoint');
    assert(source.number>=previousSource.number&&(source.number!==previousSource.number||source.hash===previousSource.hash)&&source.generation>=previousSource.generation,'price history rewind');
    assert(Array.isArray(c.dayPins)&&c.dayPins.length>=days.length&&c.dayPins.every((v,i)=>v?.day?.match(/^\d{4}-\d{2}-\d{2}$/)&&(!i||v.day>c.dayPins[i-1].day)&&num(v.bytes)&&v.bytes>0&&hex(v.sha256)&&num(v.calls)&&num(v.cu)),'invalid day chain');
    for(let i=0;i<days.length;i++){const old=days[i],neu=c.dayPins[i];assert(neu.day===old.day&&neu.bytes>=old.bytes&&neu.calls>=old.calls&&neu.cu>=old.cu&&(old.bytes!==neu.bytes||old.sha256===neu.sha256));}
    const total=(ps,f)=>ps.reduce((acc,v)=>acc+v[f],0);assert(total(c.dayPins,'cu')-total(days,'cu')===t.cloudRpc.dispatchedPublishedCu&&total(c.dayPins,'calls')-total(days,'calls')===t.cloudRpc.calls,'day sum mismatch');
    days=c.dayPins;ptr=c.pointerSha256;
   }
   privateDir(join(run,'continuation'));assert.equal(sha(bytes(join(run,'continuation/current.bin'))),ptr,'checkpoint pointer changed');
   pointer=ptr;spent=t.cloudRpc.combinedRunCu;previousSource=source;allow=t; }
  prev=run;prevHash=ts;currentMarker=ms;j=n;
 }
 const orphanSeals=entries.filter(s=>s.startsWith(prefix)&&s.endsWith('.terminal-seal.json'));
 assert(orphanSeals.length===j-m.attempt&&!orphanSeals.some(s=>!Array.from({length:j-m.attempt},(_,i)=>basename(seal(logs,d,m.attempt+i+1))).includes(s)),'orphan or missing terminal receipt');
 for(const child of entries.filter(runName)){const r=join(logs,child);if(runs.has(r))continue;checkRun(logs,r);const f=join(r,'terminal.json');if(present(f))assert.notEqual(JSON.parse(bytes(f)).inputSha256,d,'unlinked duplicate terminal');}
 assert(spent<m.cap,'aggregate CU exhausted');
 return {priorRun:prev,priorAttempt:j,attempt:j+1,terminal:allow,terminalSha256:prevHash,markerSha256:currentMarker,pointerSha256:pointer,source:previousSource,priorCu:spent,remainingCu:m.cap-spent,runCuLimit:m.cap,dayPins:days,dayPin:dayPin(days.at(-1)),claimKey:sha(JSON.stringify([d,j,prevHash,currentMarker,pointer,spent]))};
}
const freeze=o=>{if(o&&typeof o==='object'&&!Object.isFrozen(o)){for(const v of Object.values(o))freeze(v);Object.freeze(o);}return o;};
function createParentVerifier(logs,m){
 const issued=new WeakSet(),closed=new Map();
 const sel=({inputDigest})=>{const s=linkedState(logs,inputDigest,m);reconcileCalendar(join(logs,'sql512-cloud-guard'),s.dayPins);issued.add(s);return freeze(s);};
 const claim=({inputDigest,selection,run})=>{assert(issued.has(selection),'selection not issued');const now=sel({inputDigest});assert.deepEqual(now,selection,'parent changed after preview');
  checkRun(logs,run);assert(run!==now.priorRun&&!present(join(run,'terminal.json')));const record={format:'sql-current-resume/v1',inputSha256:inputDigest,attempt:now.attempt,run,priorRun:now.priorRun,priorTerminalSha256:now.terminalSha256,priorPointerSha256:now.pointerSha256,priorMarkerSha256:now.markerSha256,priorCombinedRunCu:now.priorCu};
  durableNew(marker(logs,inputDigest,now.attempt),JSON.stringify(record)+'\n');return now.attempt;};
 const checkOwner=({selection,run,inputDigest})=>{assert(issued.has(selection)&&inputDigest===m.input);checkRun(logs,run);const mb=bytes(marker(logs,inputDigest,selection.attempt)),rec=JSON.parse(mb);
  assert(rec.format==='sql-current-resume/v1'&&rec.run===run&&rec.priorRun===selection.priorRun&&rec.priorTerminalSha256===selection.terminalSha256&&rec.priorPointerSha256===selection.pointerSha256&&rec.priorMarkerSha256===selection.markerSha256&&rec.priorCombinedRunCu===selection.priorCu);return sha(mb);};
 const close=({inputDigest,selection,run,terminal,ledgerDir,ledgerWriter})=>{const markerSha256=checkOwner({selection,run,inputDigest});viable(terminal,run,selection.attempt,inputDigest,m.cap,selection.priorCu);
  assert(ledgerDir===join(logs,'sql512-cloud-guard')&&dirname(ledgerWriter)===ledgerDir&&/^official-control-[A-Za-z0-9]{6}$/.test(basename(ledgerWriter))&&terminal.priorRun===selection.priorRun);
  privateDir(ledgerWriter);privateDir(join(run,'continuation'));const pointerSha256=sha(bytes(join(run,'continuation/current.bin')));
  const dayPins=reconcileCalendar(ledgerDir,selection.dayPins,{writer:ledgerWriter,cloudRpc:terminal.cloudRpc});
  const check={schema:'sql-current-checkpoint/v1',parentTerminalSha256:selection.terminalSha256,markerSha256,pointerSha256,dayPins};
  assert(!Object.hasOwn(terminal,'resumeCheckpoint'),'checkpoint cannot be prepopulated');
  closed.set(run,{check:sha(JSON.stringify(check)),terminal:sha(JSON.stringify(terminal))});return freeze(check);};
 const finish=({inputDigest,selection,run})=>{const mh=checkOwner({selection,run,inputDigest}),b=bytes(join(run,'terminal.json')),t=JSON.parse(b);
  viable(t,run,selection.attempt,inputDigest,m.cap,selection.priorCu);const c=t.resumeCheckpoint;
  const {resumeCheckpoint,...rest}=t,record=closed.get(run);
  assert(c?.schema==='sql-current-checkpoint/v1'&&record?.check===sha(JSON.stringify(c))&&record.terminal===sha(JSON.stringify(rest))&&c.markerSha256===mh&&c.parentTerminalSha256===selection.terminalSha256&&sha(bytes(join(run,'continuation/current.bin')))===c.pointerSha256,'terminal differs from fully reconciled writer result');
  reconcileCalendar(join(logs,'sql512-cloud-guard'),c.dayPins);
  durableNew(seal(logs,inputDigest,selection.attempt),JSON.stringify({schema:'sql-current-terminal/v1',attempt:selection.attempt,run,terminalSha256:sha(b),markerSha256:mh,pointerSha256:c.pointerSha256})+'\n');};
 return {select:sel,claim,close,finish};
}
const official=createParentVerifier(logsRoot,genesis);
// Synthetic test roots must be newly made beneath the OS temp directory and
// cannot issue a selection that the official verifier will consume.
export function createFixtureVerifier(logs,m){
 assert(dirname(logs)===fs.realpathSync(tmpdir())&&/^sql-parent-test-[A-Za-z0-9]{6}$/.test(basename(logs)));
 privateDir(logs);return createParentVerifier(logs,m);
}
function invoke(op,o){assert(o.logs===logsRoot&&o.inputDigest===input,'wrong official workspace or input');return official[op](o);}
export const selectCurrentParent=o=>invoke('select',o),claimCurrentParent=o=>invoke('claim',o),
 closeCurrentCheckpoint=o=>invoke('close',o),sealCurrentTerminal=o=>invoke('finish',o);
