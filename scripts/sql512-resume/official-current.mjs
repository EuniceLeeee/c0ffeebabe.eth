// The only two executable commands are a read-only preview and a service-only,
// explicitly selected successor. This module neither creates units nor retries them.
import assert from 'node:assert/strict';
import fs from 'node:fs';import http from 'node:http';import {hostname,userInfo} from 'node:os';
import {randomBytes} from 'node:crypto';import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';import {finished} from 'node:stream/promises';
import {dirname,join} from 'node:path';import {fileURLToPath,pathToFileURL} from 'node:url';
import {root,node,window as sqlWindow,owner,codeHash,formalLimit,clock,shaBytes,exclusiveLock,assertService,repair7Ledger as ledgerDir,
  flags,runClock,tracker,savedJournalWatch,catchupObserver,guardedStop,approvedEndpoint,assertNoOtherProductionMain,verifyInputs,
  archivedSqlContext,limits,resume10Limits,inspectRepairLedger,dailyLedger,budget,relayHttpTransport,guardedDispatch} from './official-current-core.mjs';
import {selectCurrentParent,claimCurrentParent,closeCurrentCheckpoint,sealCurrentTerminal} from './current-parent.mjs';
import {prepareCurrentNative,createCurrentBindingGate} from './current-native.mjs';
const logs=join(root,'logs'),path=join(logs,'sql-512-prices-pyzdrr/raw-live-input-v2.json');
const inputDigest='a4c58be9aa587a7d209038e188dee15d981560c3ff3962b9b4dc0c6d6c5c240d';
const hex=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v),importRoot=p=>import(pathToFileURL(join(root,p)).href);
export function parseCommand(argv){if(argv.length===1&&argv[0]==='--check-current')return {check:true};
  assert(argv.length===2&&argv[0]==='--resume-current'&&hex(argv[1]),'use --check-current or --resume-current <exact previewed prior terminal SHA-256>');return {check:false,parent:argv[1]};}
function host(){assert(process.cwd()===root&&userInfo().username==='eunice'&&hostname()==='mev-impl-c4d-20261002.us-east1-b.c.eth-token-480803.internal','wrong dry-run cloud context');}
function readReview(){const base=dirname(fileURLToPath(import.meta.url));assert.equal(fs.realpathSync(base),base);
  const dir=fs.lstatSync(base);assert(dir.isDirectory()&&dir.uid===0&&(dir.mode&0o022)===0,'unsealed code package');
  const fd=fs.openSync(join(base,'current-release.json'),fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
  try{const st=fs.fstatSync(fd);assert(st.isFile()&&st.uid===0&&st.nlink===1&&(st.mode&0o022)===0&&st.size<4096);
    const p=JSON.parse(fs.readFileSync(fd,'utf8'));assert.deepEqual(Object.keys(p).sort(),['reviewPath','reviewSha256']);
    assert(typeof p.reviewPath==='string'&&p.reviewPath.startsWith(logs+'/')&&fs.realpathSync(p.reviewPath)===p.reviewPath&&hex(p.reviewSha256));return p;
  }finally{fs.closeSync(fd);}}
export function requireParent(s,expected){assert(hex(expected)&&s.terminalSha256===expected,'preview changed; do not launch another parent');
  assert(s.runCuLimit===limits.runCu&&Number.isSafeInteger(s.priorCu)&&s.priorCu>=0&&s.remainingCu===s.runCuLimit-s.priorCu&&s.remainingCu>0,'invalid remaining allowance');}
async function preflight(expected=null){host();assertNoOtherProductionMain();const review=readReview();
  assert.equal(fs.realpathSync(path),path);assert.equal(shaBytes(fs.readFileSync(path)),inputDigest,'changed 512-block SQL input');
  const s=selectCurrentParent({logs,inputDigest});requireParent(s,expected??s.terminalSha256);
  const ledger=inspectRepairLedger(ledgerDir,s.dayPin,Date.now(),resume10Limits);
  fs.accessSync(node,fs.constants.X_OK);assert(fs.statSync(node).isFile());
  const {loadLiveSqlTables}=await importRoot('listener/src/searcher/sql-live-tables.ts');await verifyInputs(loadLiveSqlTables,path,inputDigest);
  const {loadBotVmRuntimeCode}=await importRoot('listener/src/shared/executor/botvm-executor.ts');assert.equal(loadBotVmRuntimeCode(owner).keccak256,codeHash);
  const prepared=await prepareCurrentNative({root,priorRun:s.priorRun,terminal:s.terminal,pointerSha256:s.pointerSha256,...review,ctx:archivedSqlContext});
  assert.deepEqual(prepared.source,s.source);assert.equal(prepared.sqlInputSha256,inputDigest);assert.equal(prepared.pointerSha256,s.pointerSha256);
  return {s,prepared,report:{action:'read_only_preflight',attempt:s.attempt,dry:true,priorRun:s.priorRun,priorTerminalSha256:s.terminalSha256,
    inputSha256:inputDigest,nativePointerSha256:s.pointerSha256,source:s.source.number,hash:s.source.hash,generation:s.source.generation,
    startupCatchupSource:'rpc',requestPolicy:'meter-only',consumerIdentity:prepared.consumerId,consumerAllSourceSha256:prepared.consumerAllSourceSha256,
    priorRunCu:s.priorCu,repairCu:s.remainingCu,...ledger}};}
export function currentFlags(run,relay,restored,upstream){assert(restored.destination===join(run,'continuation')&&restored.proofPath===join(run,'native-pricing-proof.json')&&hex(restored.proofDigest));
  assert(/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}\/[a-f0-9]{48}$/.test(relay));
  return {...flags(path,inputDigest,relay,run),SEARCHER_DISCOVERY_TO_BLOCK:'26455077',SEARCHER_BLOCKSCAN_STARTUP_CATCHUP_SOURCE:'rpc',
    SEARCHER_BLOCKSCAN_LIVE_CONTINUATION_ENABLED:'1',SEARCHER_BLOCKSCAN_LIVE_CONTINUATION_DIR:restored.destination,
    SEARCHER_SQL_NATIVE_RESUME_REVIEW:restored.proofPath,SEARCHER_SQL_NATIVE_RESUME_REVIEW_SHA256:restored.proofDigest,
    SEARCHER_LIVE_WS_URL:approvedEndpoint(upstream).replace(/^https:/,'wss:')};}
// Mirror the admitted run13 relay: no relay retries, no switch to other providers,
// same per-method debits and 429 handling; fail closed until the slot is claimed.
async function relayServer(upstream,dispatch,nonce,isClaimed){const transport=relayHttpTransport();
  const proxy=http.createServer(async(req,res)=>{const onFault=transport.request(req,res);try{
    if(!isClaimed()){res.writeHead(410).end();return;}if(req.method!=='POST'||req.url!=='/'+nonce){res.writeHead(403).end();return;}
    let size=0;const chunks=[];for await(const c of req){size+=c.length;assert(size<=8e6,'request size limit');chunks.push(c);}
    const raw=Buffer.concat(chunks),v=JSON.parse(raw),batch=Array.isArray(v)?v:[v],client=new AbortController();
    res.once('close',()=>{if(!res.writableEnded)client.abort();});const r=await dispatch.forward(batch,raw,client.signal,onFault);
    const key=new URL(upstream).pathname.slice(4);res.writeHead(r.status,r.headers).end(r.body.split(key).join('[redacted]'));
  }catch(e){if(!res.destroyed&&!res.headersSent)res.writeHead(502).end('{"error":"restricted dry-run relay failed"}');if(e?.code==='ERR_ASSERTION')dispatch.stop('policy_or_budget_guard');}});
  transport.bind(proxy);proxy.on('upgrade',(_r,s)=>s.destroy());await new Promise((ok,fail)=>{proxy.once('error',fail);proxy.listen(0,'127.0.0.1',ok);});
  return {url:'http://127.0.0.1:'+proxy.address().port+'/'+nonce,close(){dispatch.close();proxy.closeAllConnections();proxy.close();}};}
async function confirmHead(url){const r=await fetch(url,{method:'POST',headers:{'content-type':'application/json'},redirect:'error',signal:AbortSignal.timeout(15000),
  body:JSON.stringify({jsonrpc:'2.0',id:1,method:'eth_getBlockByNumber',params:['latest',false]})});assert(r.ok,'cannot confirm a current head');const h=(await r.json()).result;
  assert(/^0x[0-9a-f]{64}$/.test(h?.hash)&&Number(BigInt(h.number))>sqlWindow[1]&&Math.abs(Date.now()/1000-Number(BigInt(h.timestamp)))<120,'RPC is not at the current head');}
export function terminalEligible(result){return result.dry===true&&result.graph===true&&result.reorgPending===false&&result.finalJournal?.verified===true&&result.nativeBinding?.verified===true&&
  ((result.reason==='block_limit'&&result.formalCompleted===formalLimit&&result.code===0&&result.signal===null)||
   (result.reason==='supervisor_interrupted'&&result.formalCompleted<formalLimit&&((result.code===0&&result.signal===null)||(result.code===null&&result.signal==='SIGTERM'))));}
async function worker({s,prepared,run,upstream,relay,day,ledgerWriter,debit,enable,freeze,fatal}){
 const priorRun=s.priorRun,summary=()=>({...day.summary(),...debit.summary(),priorRunCu:s.priorCu,repairCu:s.remainingCu,combinedRunCu:s.priorCu+debit.summary().dispatchedPublishedCu});
 const write=(n,v,once=false)=>fs.writeFileSync(join(run,n),JSON.stringify(v)+'\n',{mode:0o600,flag:once?'wx':'w',flush:once});
 const spaceOK=()=>{const d=fs.statfsSync(run);return d.bavail*d.bsize>=2*1024**3;};assert(spaceOK(),'less than 2 GiB of free disk');
 const staged=await prepared.copyTo(join(run,'continuation')),binding=createCurrentBindingGate(prepared,staged.proofDigest);
 const origin={source:s.source.number,hash:s.source.hash,baseline:prepared.rawSource.number,baselineIdentity:prepared.producerIds[0],get consumerIdentity(){return binding.identity;}};
 const counter=tracker(true,origin),timer=runClock(Date.now()),journal=savedJournalWatch(true,origin),observer=catchupObserver(),env=currentFlags(run,relay,staged,upstream);
 assertNoOtherProductionMain();const attempt=claimCurrentParent({logs,inputDigest,selection:s,run});assert.equal(attempt,s.attempt);enable();
 try{await confirmHead(relay);}catch(e){freeze();write('terminal.json',{run,attempt,priorRun,inputSha256:inputDigest,reason:'resume_head_preflight_failed',ended:clock(),...counter.summary(),...timer.summary(),cloudRpc:summary()},true);throw e;}
 const startedAt=Date.now(),log=fs.createWriteStream(join(run,'progress.log'),{mode:0o600,flags:'wx'}),key=new URL(upstream).pathname.slice(4),nonce=new URL(relay).pathname.slice(1);
 const scrub=s=>s.replaceAll(key,'[redacted]').replaceAll(nonce,'[relay]').replace(/(?:https?|wss?):\/\/[^\s"']+/g,'[endpoint]');
 const child=spawn(node,['--import','tsx','src/searcher/main.ts'],{cwd:join(root,'listener'),env,stdio:['ignore','pipe','pipe']});
 const done=new Promise(ok=>child.once('close',(c,sig)=>ok([c,sig])));let killTimer,integrity=true;
 const stopping=guardedStop(()=>{counter.beginDrain();child.kill('SIGTERM');killTimer=setTimeout(()=>child.kill('SIGKILL'),15000);});const stop=r=>stopping.request(r);
 const watch=setInterval(()=>{const r=timer.reason(Date.now())??fatal();if(r)stop(r);else if(!spaceOK())stop('disk_guard');},1000);
 const diagnostic=setInterval(()=>{try{if(counter.summary().firstPrice!==null)write('catchup-progress.json',observer.snapshot());}catch{/* observations only */}},30000);
 const interrupted=()=>stop('supervisor_interrupted');for(const sig of ['SIGHUP','SIGINT','SIGTERM'])process.once(sig,interrupted);
 child.once('error',()=>{integrity=false;stop('child_spawn_failed');});log.on('error',()=>{integrity=false;stop('log_write_failed');});
 try{write('start.json',{startedAt,attempt,run},true);}catch{integrity=false;stop('log_write_failed');}
 for(const stream of [child.stdout,child.stderr])createInterface({input:stream}).on('line',line=>{try{log.write(scrub(line)+'\n');observer.read(line);binding.read(line);
   journal.read(line);if(journal.status().failed){integrity=false;stop('continuation_save_failed');}
   const n=counter.read(line),v=counter.summary(),at=Date.now(),timeout=timer.reason(at);
   if(stopping.reason()==='block_limit'&&(v.formalCompleted!==formalLimit||v.reorgPending)){integrity=false;stop('formal_window_invalidated');return;}
   if(timeout){stop(timeout);return;}if(v.firstPrice!==null&&timer.summary().nativePricePublishedAt===null){timer.published(at);write('first-price.json',{startedAt,publishedAt:at,elapsedMs:at-startedAt,sourceBlock:v.firstPrice});}
   if(n){timer.advanced(at);if(n===formalLimit)stop('block_limit');if(n===1||n%10===0)write('progress.json',{...v,...timer.summary()});}
 }catch{integrity=false;stop('invalid_runtime_evidence');}});
 console.log(JSON.stringify({run,phase:'started',limit:formalLimit,dry:true,attempt,priorRun}));
 const [code,signal]=await done;clearInterval(watch);clearInterval(diagnostic);clearTimeout(killTimer);freeze();log.end();
 for(const sig of ['SIGHUP','SIGINT','SIGTERM'])process.removeListener(sig,interrupted);
 try{await finished(log);}catch{integrity=false;stop('log_write_failed');}
 let finalJournal;try{assert(binding.verified()&&journal.status().identity===binding.identity);const {LivePricingContinuationStore:Store}=await importRoot('listener/src/searcher/blockscan-live-continuation.ts');
   finalJournal=await journal.verify(id=>new Store(env.SEARCHER_BLOCKSCAN_LIVE_CONTINUATION_DIR,id,prepared.producerIds.filter(i=>i!==id)).read(),counter.summary().last,counter.summary().lastFormalHash);
 }catch{finalJournal={verified:false,...journal.status()};integrity=false;stop('continuation_not_verified');}
 if(fatal()){integrity=false;stop(fatal());}const result={run,attempt,priorRun,inputSha256:inputDigest,reason:stopping.reason()??'unexpected_exit',code,signal,ended:clock(),...counter.summary(),...timer.summary(),lease:null,cloudRpc:summary(),finalJournal,
   nativeBinding:{verified:binding.verified(),consumerIdentity:binding.identity,consumerAllSourceSha256:prepared.consumerAllSourceSha256},catchup:observer.snapshot()};
 const refs={logs,inputDigest,selection:s,run};if(integrity&&terminalEligible(result))try{result.resumeCheckpoint=closeCurrentCheckpoint({...refs,ledgerDir,ledgerWriter,terminal:result});}catch{integrity=false;}
 write('terminal.json',result,true);if(result.resumeCheckpoint)sealCurrentTerminal(refs);
 console.log(JSON.stringify({run,reason:result.reason,formalCompleted:result.formalCompleted,terminalPrice:finalJournal.verified?finalJournal.sourceBlock:null,certified:!!result.resumeCheckpoint}));
 if(!integrity||!result.resumeCheckpoint||result.reason!=='block_limit')process.exitCode=1;
}
async function run(expected){host();assertService({host:hostname(),user:userInfo().username,cwd:process.cwd(),ledger:fs.realpathSync(ledgerDir),invocation:process.env.INVOCATION_ID,credDir:process.env.CREDENTIALS_DIRECTORY,cgroup:fs.readFileSync('/proc/self/cgroup','utf8')});
 const lock=exclusiveLock('/tmp/mev-official-production-main.worker.lock','another official cloud worker is active');let day,server;
 try{const {s,prepared}=await preflight(expected);requireParent(s,expected);
   const cred=JSON.parse(fs.readFileSync(join(process.env.CREDENTIALS_DIRECTORY,'rpc'),'utf8'));assert.deepEqual(Object.keys(cred),['MAINNET_RPC_URL']);const upstream=approvedEndpoint(cred.MAINNET_RPC_URL);
   const ledgerWriter=fs.mkdtempSync(join(ledgerDir,'official-control-'));fs.chmodSync(ledgerWriter,0o700);
   day=dailyLedger(ledgerDir,ledgerWriter,resume10Limits,s.dayPin);day.prepare(Date.now());
   const debit=budget(d=>day.debit(d),Date.now(),{...resume10Limits,runCu:s.remainingCu});let failure=null,permitted=false;
   const dispatch=guardedDispatch(debit,(raw,signal)=>fetch(upstream,{method:'POST',headers:{'content-type':'application/json'},body:raw,redirect:'error',signal}),r=>{failure=r;});
   server=await relayServer(upstream,dispatch,randomBytes(24).toString('hex'),()=>permitted&&failure===null);
   const run=fs.mkdtempSync(join(logs,'sql-official-500-'));fs.chmodSync(run,0o700);
   await worker({s,prepared,run,upstream,relay:server.url,day,ledgerWriter,debit,enable:()=>{permitted=true;},freeze:()=>{permitted=false;dispatch.close();},fatal:()=>failure});
 }finally{server?.close();day?.close();fs.closeSync(lock);}}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){const cmd=parseCommand(process.argv.slice(2));
 if(cmd.check)console.log(JSON.stringify((await preflight()).report));else await run(cmd.parent);}
