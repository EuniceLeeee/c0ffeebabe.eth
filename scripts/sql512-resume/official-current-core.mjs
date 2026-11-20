// Operational primitives of the prior dry-only SQL runner. No executable entrypoint.
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import { hostname, userInfo } from "node:os";
import { createHash, randomBytes } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { createInterface } from "node:readline";
import { finished } from "node:stream/promises";
import { basename, dirname, join, isAbsolute } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseEnv, isDeepStrictEqual } from "node:util";
const root="/opt/mev-cloud/work/impl-aligned-84e18ec3", node="/opt/mev-cloud/node-v26.0.0-linux-x64/bin/node";
const window=[26377878,26378389], anchorHash="0x62b23cae3b410e09f24910f072a94e2a65b68917a91168dda8648e0d5375c618";
const edgeSha="3538d508a3eb2e731530518bedf2dbd89fc0799e687219fe6da0ee72e7b95cd8", rows=4930;
const fundingSha="6580bc7b849e7573383d2cc58a5e41dee8c6ebac8f364f57dc42d6ebf8a5f29a";
const owner="0xb8578B6de173C8554FF0390dB5a7effA567DDA3c", executor="0x4aF9495C4aC24c5CD3b0C90611550a1996415BCe";
const codeHash="0x4d0bb51b7d6cf404120e74462fad7135eb11b1ff5b16aa22757fc4c44a7c7623";
const methods=new Set(["eth_chainId","eth_blockNumber","eth_getBlockByNumber","eth_getBlockByHash","eth_getLogs",
  "eth_getBalance","eth_getStorageAt","eth_getCode","eth_call","eth_simulateV1","debug_traceCall","eth_getBlockReceipts","debug_getRawHeader"]);
const startupWallMs=90*60*1000, formalWallMs=3*60*60*1000, formalIdleMs=45*60*1000;
const msLimit=startupWallMs+formalWallMs;
const positive=n=>Number.isSafeInteger(n)&&n>0;
const clock=()=>new Date().toISOString();
// Published Ethereum CU (not throughput CU and not a provider-account balance).
// https://www.alchemy.com/docs/reference/compute-unit-costs — checked 2026-11-19.
// One JSON-RPC batch costs its individual method costs summed. In particular,
// eth_chainId is explicitly zero, debug_traceCall is 40 CU but 1,000 throughput CU.
export const rates=Object.freeze({eth_chainId:0,eth_blockNumber:10,eth_getBlockByNumber:20,eth_getBlockByHash:20,
  eth_getLogs:60,eth_getBalance:20,eth_getStorageAt:20,eth_getCode:20,eth_call:26,eth_simulateV1:40,debug_traceCall:40,
  eth_getBlockReceipts:20,debug_getRawHeader:40});
const warmCalls=8879,warmCu=296128; // measured initial 512-window snapshot: small-FsB17F/cloud-receipt.json
const referenceRate=20; // only an arithmetic budget-sizing convention, NEVER a dispatcher rate or forecast
const formalLimit=500, expectedSlotSeconds=12;
const windowMethods=(formalLimit+1)*expectedSlotSeconds*referenceRate;
export const limits=Object.freeze({formalBlocks:formalLimit,startupWallMs,formalWallMs,formalIdleMs,wallMs:msLimit,
  runCalls:Math.min(formalWallMs/1000*200,warmCalls+windowMethods),runCu:Math.min(formalWallMs/1000*200*60,warmCu+windowMethods*60)});
// For this requested cloud run only: counts are measurements, not a provider quota.
// Keep the old header reference to verify the existing accounting history.
export const repair8Limits=Object.freeze({...limits, requestsMeteredOnly:true});
// Only the named tenth continuation meters (rather than caps) the UTC-day total.
// budget.reserve still checks the unmodified per-run CU ceiling on every dispatch.
export const resume10Limits=Object.freeze({...repair8Limits,dailyCuPolicy:"meter-only"});
const callsAllowed=(calls,caps)=>Number.isSafeInteger(calls)&&calls>=0&&(caps.requestsMeteredOnly===true||calls<=caps.runCalls);
/** The first native price publication ends the startup envelope, not a live block.
 * Subsequent ordinary source deadlines and the independent steady watchdog are unchanged. */
export function runClock(start) {
  let warmAt=null, formalProgressAt=null;
  return { published(t) { if(warmAt===null&&t-start<startupWallMs){warmAt=t;formalProgressAt=t;} },
    advanced(t){if(warmAt!==null&&t-formalProgressAt<formalIdleMs)formalProgressAt=t;},
    reason(t){if(t-start>=msLimit)return "wall_limit";
      if(warmAt===null)return t-start>=startupWallMs?"startup_wall_limit":null;
      if(t-warmAt>=formalWallMs)return "formal_wall_limit";
      return t-formalProgressAt>=formalIdleMs?"no_formal_progress":null;},
    summary(){return {nativePricePublishedAt:warmAt,latestFormalProgressAt:formalProgressAt};} };
}
export function budget(onDebit=()=>{},now=Date.now(),caps=limits){
  const counts={};let cost=0,calls=0;
  return {reserve(batch,t=Date.now()){
    assert(t>=now && t<now+caps.wallMs,"run wall limit expired");
    assert(batch.length>0&&batch.length<=512,"batch limit");
    let charge=0;const methodCounts={};
    for(const r of batch){validateRequest(r);assert(Object.hasOwn(rates,r.method),"unknown method cost");charge+=rates[r.method];
      methodCounts[r.method]=(methodCounts[r.method]??0)+1;}
    assert(callsAllowed(calls+batch.length,caps),"local run request ceiling");assert(cost+charge<=caps.runCu,"local run CU ceiling");
    // Whole batch is authorized before invoking fetch; no change to native timing or order.
    onDebit({at:t,calls:batch.length,cu:charge,methodCounts});calls+=batch.length;cost+=charge;
    for(const [m,n] of Object.entries(methodCounts))counts[m]=(counts[m]??0)+n;
  },summary(){return {calls,dispatchedPublishedCu:cost,providerRemainingCu:null,methodCounts:{...counts}};}};
}
// One OS-held writer lock, shared by every repair attempt. flock(2) attaches to
// the inherited open file description: the parent retains it after the helper
// exits; process death releases it, without PID checks or deleting lock files.
function requirePrivate(f){const s=fs.fstatSync(f);assert(s.isFile()&&s.uid===process.getuid()&&s.nlink===1&&(s.mode&0o077)===0,"not a privately owned ledger/lock file");}
function exclusiveLock(path,busy){
    const {O_RDWR,O_CREAT,O_NOFOLLOW}=fs.constants;
    const f=fs.openSync(path,O_RDWR|O_CREAT|O_NOFOLLOW,0o600);
    try{requirePrivate(f);
      const py=spawnSync("/usr/bin/python3",["-I","-c",
        "import sys, fcntl\ntry: fcntl.flock(3, fcntl.LOCK_EX|fcntl.LOCK_NB)\nexcept BlockingIOError: sys.exit(75)"],
        {stdio:["ignore","ignore","ignore",f],timeout:5000,env:{PATH:"/usr/bin:/bin"}});
      assert.notEqual(py.status,75,busy);
      assert.equal(py.status,0,"could not acquire process OS lock");return f;
    }catch(e){fs.closeSync(f);throw e;}
}
function verifiedDebit(d,day){
    assert(Number.isSafeInteger(d.at)&&new Date(d.at).toISOString().startsWith(day+"T")&&positive(d.calls)&&Number.isSafeInteger(d.cu)&&d.cu>=0&&
      d.methodCounts&&typeof d.methodCounts==="object"&&!Array.isArray(d.methodCounts),"invalid daily debit; refusing to reset");
    let n=0,cost=0;for(const [m,k] of Object.entries(d.methodCounts)){assert(Object.hasOwn(rates,m)&&positive(k),"unknown daily method/count");
      n+=k;cost+=rates[m]*k;}
    assert(n===d.calls&&cost===d.cu,"daily debit does not match documented method counts");
}
function readDayBalance(fd,day,caps,pin){
  requirePrivate(fd);assert(fs.fstatSync(fd).size<=128*1024*1024,"unexpected daily ledger size");
  const buf=fs.readFileSync(fd),previous=buf.toString("utf8");
  if(pin?.earlier)assert(pin.earlier.day===day&&pin.earlier.bytes<pin.bytes&&buf.length>=pin.earlier.bytes&&
    shaBytes(buf.subarray(0,pin.earlier.bytes))===pin.earlier.sha256,"earlier ninth ledger prefix changed");
  if(pin)assert(buf.length>=pin.bytes&&buf[pin.bytes-1]===10&&createHash("sha256").update(buf.subarray(0,pin.bytes)).digest("hex")===pin.sha256,
    "repair 8 prior accounting history changed or truncated");
  if(pin?.closedDay)assert(buf.length===pin.bytes,"closed-day ledger bytes changed");
  assert(previous.endsWith("\n"),"incomplete daily ledger; refusing to reset");
  const [first,...lines]=previous.slice(0,-1).split("\n"),header=JSON.parse(first);
  const meter=caps.dailyCuPolicy==="meter-only";
  const validCuHeader=(header.localDayCu===caps.runCu&&header.dailyCuPolicy===undefined)||
    (meter&&header.localDayCu===null&&header.dailyCuPolicy==="meter-only");
  assert(header.day===day&&header.scope==="this supervisor only"&&header.localDayCalls===caps.runCalls&&validCuHeader,
    "existing daily ledger scope/cap mismatch; refusing to reset");
  let calls=0,cu=0,offset=Buffer.byteLength(first)+1,checkedPrefix=false;
  for(const line of lines){const row=JSON.parse(line);verifiedDebit(row,day);calls+=row.calls;cu+=row.cu;
    if(pin?.meteredPrefix&&!checkedPrefix){offset+=Buffer.byteLength(line)+1;if(offset===pin.bytes){
      assert(calls===pin.calls&&cu===pin.cu,"pinned prefix verified totals differ from terminal");checkedPrefix=true;
    }}}
  if(pin?.meteredPrefix)assert(checkedPrefix,"missing verified run9 debit prefix");
  assert(callsAllowed(calls,caps)&&Number.isSafeInteger(cu)&&(meter||cu<=caps.runCu),"invalid daily totals");
  if(pin?.closedDay)assert(calls===pin.calls&&cu===pin.cu,"closed-day verified totals differ from terminal");
  return {calls,cu};
}
function readPrivateDay(dir,day,caps,pin=null){
  const fd=fs.openSync(join(dir,"official500-daily-"+day+".jsonl"),fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
  try{return readDayBalance(fd,day,caps,pin);}finally{fs.closeSync(fd);}
}
function validateCalendar(dir,day,pin){
  if(pin?.closedDay)assert.equal(day,pin.admitDay,"outside the approved natural UTC day");
  assert(day>=pin.day&&!fs.readdirSync(dir).some(f=>/^official500-daily-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)&&f.slice(18,28)>day),"UTC date precedes charged history");
}
// A query is only advisory: the native service always repeats these checks
// under the existing writer lock. The CLI has no caller-supplied clock.
export function inspectRepairLedger(dir,pin,t=Date.now(),caps=limits){
  const day=new Date(t).toISOString().slice(0,10);validateCalendar(dir,day,pin);
  const prior=readPrivateDay(dir,pin.day,caps,pin);let current=prior;
  if(day!==pin.day){
    const path=join(dir,"official500-daily-"+day+".jsonl");
    current=fs.lstatSync(path,{throwIfNoEntry:false})?readPrivateDay(dir,day,caps):{calls:0,cu:0};
  }
  const meter=caps.dailyCuPolicy==="meter-only";
  return {utcDay:day,prior:{day:pin.day,...prior},used:current,remaining:{calls:caps.requestsMeteredOnly?null:caps.runCalls-current.calls,cu:meter?null:caps.runCu-current.cu},
    ...(meter?{dailyCuPolicy:"meter-only",runCuLimit:caps.runCu}:{}),providerRemainingCu:null};
}
export function dailyLedger(dir,id,caps=limits,pin=null){
  let date=null,fd=null,lock=null,dayCalls=0,dayCu=0,closed=false;
  const {O_RDWR,O_APPEND,O_CREAT,O_EXCL,O_NOFOLLOW}=fs.constants;
  const jsonLine=(obj)=>{const b=Buffer.from(JSON.stringify(obj)+"\n");assert.equal(fs.writeSync(fd,b),b.length);fs.fdatasyncSync(fd);};
  function openDay(day){
    assert(!closed,"daily ledger closed");
    lock??=exclusiveLock(join(dir,"official500-writer.lock"),"another official dry-run holds the ledger");
    if(day!==date){
      assert(!date||day>date,"UTC day moved backwards");
      if(pin){validateCalendar(dir,day,pin);if(day!==pin.day)readPrivateDay(dir,pin.day,caps,pin);}
      if(fd!==null){fs.closeSync(fd);fd=null;}
      const p=join(dir,"official500-daily-"+day+".jsonl");let created=false;
      if(day===pin?.day)fd=fs.openSync(p,O_RDWR|O_APPEND|O_NOFOLLOW);
      else try{fd=fs.openSync(p,O_RDWR|O_APPEND|O_CREAT|O_EXCL|O_NOFOLLOW,0o600);created=true;}
      catch(e){if(e.code!=="EEXIST")throw e;fd=fs.openSync(p,O_RDWR|O_APPEND|O_NOFOLLOW);}
      requirePrivate(fd);dayCalls=0;dayCu=0;
      if(created)jsonLine({day,run:id,scope:"this supervisor only",providerRemainingCu:null,localDayCalls:caps.runCalls,
        ...(caps.dailyCuPolicy==="meter-only"?{localDayCu:null,dailyCuPolicy:"meter-only"}:{localDayCu:caps.runCu})});
      else{
        const balance=readDayBalance(fd,day,caps,day===pin?.day?pin:null);dayCalls=balance.calls;dayCu=balance.cu;
      }
      date=day;
    }
  }
  return {prepare(t){openDay(new Date(t).toISOString().slice(0,10));assert(callsAllowed(dayCalls+1,caps)&&(caps.dailyCuPolicy==="meter-only"||dayCu<caps.runCu),"no remaining local daily allowance");},
    debit(d){const day=new Date(d.at).toISOString().slice(0,10);verifiedDebit(d,day);openDay(day);
    assert(callsAllowed(dayCalls+d.calls,caps)&&Number.isSafeInteger(dayCu+d.cu)&&(caps.dailyCuPolicy==="meter-only"||dayCu+d.cu<=caps.runCu),"local daily ceiling reached");
    jsonLine({...d,run:id});dayCalls+=d.calls;dayCu+=d.cu;
  },close(){closed=true;if(fd!==null){fs.closeSync(fd);fd=null;}if(lock!==null){fs.closeSync(lock);lock=null;}},
    summary(){return {day:date,localDayCalls:dayCalls,localDayCu:dayCu,...(caps.dailyCuPolicy==="meter-only"?{dailyCuPolicy:"meter-only",runCuLimit:caps.runCu}:{})};}};
}
const knownSocketCodes=new Set(["ECONNRESET","ECONNREFUSED","ECONNABORTED","EPIPE","ETIMEDOUT","ENOTFOUND","EAI_AGAIN",
  "ENETUNREACH","EHOSTUNREACH","UND_ERR_SOCKET","UND_ERR_CONNECT_TIMEOUT","UND_ERR_HEADERS_TIMEOUT","UND_ERR_BODY_TIMEOUT","ERR_STREAM_PREMATURE_CLOSE","ABORT_ERR"]);
function safeSocketCode(e){
  for(let i=0;e&&i<4;i++,e=e.cause){if(knownSocketCodes.has(e.code))return e.code;}return null;
}
/** Mirror the known working operator-side HTTP lifetime. Measure both sides
 * separately: a tunnel peer closing is not evidence of an upstream 429.
 * Never record URLs, messages, payloads, token headers or local addresses. */
export function relayHttpTransport(){
  const used=new WeakSet(),recent=[];let id=0,connections=0,reusedRequests=0,earlyClientClose=0,socketErrorCloses=0,failedForwards=0;
  function note(row){recent.push({...row,at:Date.now()});if(recent.length>12)recent.shift();}
  return {bind(server){server.keepAliveTimeout=120000;server.headersTimeout=130000;
      server.on("connection",s=>{connections++;s.once("close",hadError=>{if(hadError)socketErrorCloses++;});});},
    request(req,res){const reused=used.has(req.socket);used.add(req.socket);if(reused)reusedRequests++;
      const request=++id;res.once("close",()=>{if(!res.writableFinished){earlyClientClose++;note({request,reused,phase:"relay_peer_closed_before_finish"});}});
      return (phase,error,status,batch)=>{failedForwards++;const methodCounts={};
        for(const r of batch)if(methods.has(r?.method))methodCounts[r.method]=(methodCounts[r.method]??0)+1;
        note({request,reused,phase,code:safeSocketCode(error),status,methodCounts});};},
    summary(){return {connections,requests:id,reusedRequests,earlyClientClose,socketErrorCloses,failedForwards,recent:[...recent]};}};
}
export function guardedDispatch(ledger,send,halt){
  let stopped=false;const controls=new AbortController();
  const stop=(reason)=>{if(!stopped){stopped=true;controls.abort();halt(reason);}};
  return {stop,close(){stopped=true;controls.abort();},async forward(batch,raw,clientSignal,onFault){
    assert(!stopped,"relay stopped");
    try{ledger.reserve(batch);}catch{stop("policy_or_budget_guard");throw Error("local budget or request policy guard");}
    // Preserve the provider's body/status and native batch order. Only production
    // classifies a rate limit, retains successes and decides what/when to retry.
    const signal=clientSignal?AbortSignal.any([controls.signal,clientSignal]):controls.signal;
    let response,body;
    try{response=await send(raw,signal);body=await response.text();}
    catch(e){try{onFault?.(controls.signal.aborted?"supervisor_cancelled":clientSignal?.aborted?"relay_peer_cancelled":
        response?"upstream_read_body":"upstream_before_headers",e,response?.status??null,batch);}catch{/* Observation never changes dispatch. */}throw e;}
    const retryAfter=response.headers.get("retry-after");
    const headers={"content-type":response.headers.get("content-type")?.toLowerCase().startsWith("text/")?"text/plain; charset=utf-8":"application/json"};
    if(retryAfter!==null&&(/^[0-9]+(?:\.[0-9]+)?$/.test(retryAfter)||/^(Sun|Mon|Tue|Wed|Thu|Fri|Sat), \d\d [A-Z][a-z]{2} \d{4} \d\d:\d\d:\d\d GMT$/.test(retryAfter)))headers["retry-after"]=retryAfter;
    if(stopped)throw Error("relay stopped");
    return {status:response.status,headers,body};
  }};
}
export function validateRequest(r){
  assert(r&&r.jsonrpc==="2.0"&&methods.has(r.method)&&Array.isArray(r.params),"RPC method not permitted");
  if(r.method==="eth_getBlockReceipts")assert(r.params.length===1&&typeof r.params[0]==="string"&&/^0x[0-9a-f]{64}$/i.test(r.params[0]),"expected exact block hash");
  if(r.method==="debug_getRawHeader")assert(r.params.length===1&&typeof r.params[0]==="string"&&/^0x(?:0|[1-9a-f][0-9a-f]{0,12})$/i.test(r.params[0]),"expected one explicit safe block number");
  if(r.method==="debug_traceCall")assert(r.params[2]?.tracer==="callTracer","custom trace programs not permitted");
  if(r.method==="eth_getLogs"){const f=r.params[0];assert(f && (typeof f.blockHash==="string" || (f.fromBlock!==undefined&&f.fromBlock===f.toBlock)),"unbounded logs not permitted");}
}
export function flags(path,digest,relay,run,saveFreshJournal=false) {
  return {PATH:dirname(node)+":/usr/local/bin:/usr/bin:/bin",SEARCHER_TEST_DISABLE_DOTENV:"1",SEARCHER_DRY_RUN:"1",SEARCHER_SUBMIT:"0",SEARCHER_BLOCKSCAN_SUBMIT:"0",
    SEARCHER_ENABLE_BLOCK_SCAN:"1",SEARCHER_ENABLE_BACKRUN:"0",SEARCHER_ENABLE_MEMPOOL:"0",SEARCHER_ENABLE_MEV_SHARE:"0",
    BOTVM_ADDRESS:executor,BOTVM_OWNER:owner,SEARCHER_DRY_RUN_BOTVM_CODE_OVERRIDE:"1",SEARCHER_CHAIN_ID:"1",
    SEARCHER_SQL_LIVE_INPUT_PATH:path,SEARCHER_SQL_LIVE_INPUT_SHA256:digest,MAINNET_RPC_URL:relay,
    // Websocket is advisory; the same production head scheduler consumes real HTTP heads.
    SEARCHER_LIVE_WS_URL:relay.replace(/^http:/,"ws:"),
    SEARCHER_BLOCKSCAN_FINAL_SIM_METHOD:"eth_simulateV1",SEARCHER_EAGER_STATE_BACKEND:"0",SEARCHER_BLOCKSCAN_EAGER_STATE_BACKEND:"0",
    SEARCHER_BLOCKSCAN_STARTUP_REVERT_FILTER:"1",SEARCHER_BLOCKSCAN_POOL_REVERT_FILTER:"1",SEARCHER_STATE_LATENCY_DIAGNOSTICS:"1",
    SEARCHER_BLOCKSCAN_STARTUP_PREWARM_BUDGET_MS:String(startupWallMs),
    SEARCHER_BLOCKSCAN_EFFECTIVE_WETH_INPUT:"0.002",SEARCHER_BLOCKSCAN_EFFECTIVE_AMOUNT_CASCADE_ENABLED:"0",
    SEARCHER_BLOCKSCAN_N_MINUS_ONE_FALLBACK:"0",SEARCHER_BLOCKSCAN_ACTIVITY_MODE:"logs",SEARCHER_RPC_TRANSPORT_MAX_CONCURRENCY:"20",
    // Same native profile as the original bounded launcher, not relay retries.
    SEARCHER_RPC_THROTTLE_RETRIES_AT_ONE:"20",SEARCHER_RPC_THROTTLE_MAX_DELAY_MS:"8000",
    SEARCHER_BLOCKSCAN_MAX_CANDIDATES:"10",SEARCHER_BLOCKSCAN_REFINE_CANDIDATES:"512",SEARCHER_BLOCKSCAN_SINGLE_FUNDING_ENABLED:"1",
    SEARCHER_BLOCKSCAN_MIN_SPREAD_BPS:"10",SEARCHER_BLOCKSCAN_ALLOW_REPEATED_POOLS_ENABLED:"0",
    SEARCHER_BLOCKSCAN_ALLOW_REPEATED_TOKENS_ENABLED:"0",SEARCHER_BLOCKSCAN_ALLOW_PROTOCOL_REPEATS_ENABLED:"1",
    SEARCHER_EV_GATE:"1",SEARCHER_BLOCKSCAN_PROFIT_MODE:"positive-gross-profit",SEARCHER_BRIBE_BPS:"9900",
    SEARCHER_BRIBE_ALL_ABOVE_GAS:"0",SEARCHER_BRIBE_GAS_BASIS:"measured-gas",SEARCHER_PROFIT_HAIRCUT_BPS:"0",
    // 0 + a new per-run directory = fresh prices now, native journal for the next live.
    SEARCHER_BLOCKSCAN_LIVE_CONTINUATION_ENABLED:"0",
    ...(saveFreshJournal?{SEARCHER_BLOCKSCAN_LIVE_CONTINUATION_DIR:join(run,"continuation")}:{ }),
    SEARCHER_EVENTS_PATH:join(run,"events.jsonl")};
}
const shaBytes=b=>createHash("sha256").update(b).digest("hex");
export function savedJournalWatch(resume=false,origin=null){
  let identity=null,baseline=null,last=null,failed=false;
  return {read(line){
    const tag="[searcher/live-continuation] ";if(!line.startsWith(tag))return;
    try {
    const body=line.slice(tag.length);
    if(body.startsWith("final_checkpoint_failed")){failed=true;return;}
    if(!body.startsWith("{"))return;
    const v=JSON.parse(body);
    if(v.phase==="save-failed"){failed=true;return;}
    if(resume&&["new-logical-round","disabled-cold-start","no-checkpoint-cold-start"].includes(v.phase)){failed=true;return;}
    if(resume&&v.phase==="restored"){assert(!identity&&v.sourceBlock===origin.source&&v.sourceBlockHash===origin.hash&&v.trading===false&&/^[a-f0-9]{64}$/.test(v.identity)&&(!origin.consumerIdentity||v.identity===origin.consumerIdentity));
      identity=v.identity;baseline=origin.baseline;last=origin.source;}
    if(!resume&&v.phase==="disabled-cold-start"){assert(/^[a-f0-9]{64}$/.test(v.identity));identity=v.identity;}
    if(v.phase==="saved"){
      assert(identity&&positive(v.sourceBlock));
      if(v.kind==="baseline"){assert(baseline===null);baseline=v.sourceBlock;}
      else assert(v.kind==="delta"&&baseline!==null);
      last=v.sourceBlock;
    }
    }catch(e){if(resume)failed=true;throw e;}
  },status:()=>({identity,baseline,last,failed}),async verify(load,minBlock,lastFormalHash){
    assert(!failed && identity && positive(baseline) && positive(last) && (!minBlock||last>=minBlock),"missing final saved pricing");
    const producer=resume?origin.baselineIdentity:identity,data=await load(identity,producer);
    const p=data?.pricing?.pricing, s=p?.effectiveMids?.source;
    assert(data?.identity===producer && p?.effectiveMids?.complete===true && s?.number===last && p.sourceBlock===last &&
      s.hash===p.sourceBlockHash && /^0x[0-9a-f]{64}$/.test(s.hash) && s.generation===p.generation,"unreadable or mismatched native saved pricing");
    if(resume&&minBlock!=null){
      let hash=s.hash;
      if(last>minBlock){
        // Native reader's retained headers, not observations from stdout. Prove a connected path, never just an older matching height.
        const headers=data.amounts?.headers;assert(Array.isArray(headers)&&headers.length>=last-minBlock,"saved journal lacks retained formal ancestry");
        const byHeight=new Map();
        for(const h of headers)if(h.number>minBlock&&h.number<=last){
          assert(positive(h.number)&&/^0x[0-9a-f]{64}$/.test(h.hash)&&/^0x[0-9a-f]{64}$/.test(h.parentHash)&&!byHeight.has(h.number),"invalid retained formal header");byHeight.set(h.number,h);
        }
        for(let i=last;i>minBlock;i--){const h=byHeight.get(i);assert(h&&h.hash===hash,"broken retained formal ancestry");hash=h.parentHash;}
      }
      assert.equal(hash,lastFormalHash,"saved prices disagree with last counted formal hash");
    }
    return {verified:true,baseline,sourceBlock:last,sourceBlockHash:s.hash,generation:s.generation,identity,...(resume?{baselineIdentity:producer}:{})};
  }};
}
// Observation only. A completed activity range is not a published price, and
// neither counts as a formal pass or refreshes the no-progress watchdog.
export function catchupObserver(){
  let published=null,range=null,lastPass=null,lastRead=null;
  return {read(line){
    const split=line.indexOf(" {");if(split<0)return;
    const tag=line.slice(0,split);
    if(!["[searcher/blockscan-activity-range]","[searcher/live-continuation]","[searcher/blockscan-family]","[searcher/activity-read-timing]"].includes(tag))return;
    let v;try{v=JSON.parse(line.slice(split+1));}catch{return;}
    if(!v)return;
    if(tag==="[searcher/blockscan-activity-range]")range={from:v.previousSourceBlock,to:v.sourceBlock,wallMs:v.wallMs};
    if(tag==="[searcher/live-continuation]"&&v.phase==="catching-up-prices")published={from:v.from,to:v.to,targetHead:v.head};
    if(tag==="[searcher/blockscan-family]"&&v.type==="block_scan_timing")lastPass={source:v.source_block,outcome:v.outcome,warm:v.startup_warm,stateMs:v.stage_timing_ms?.state,activityStart:v.state_preparation_detail?.activity_started_at_ms,activityEnd:v.state_preparation_detail?.activity_finished_at_ms};
    if(tag==="[searcher/activity-read-timing]")lastRead={method:v.method,block:v.block,ms:v.wallMs,status:v.status};
  },snapshot(){return {range,published,lastPass,lastRead};}};
}
export function tracker(resume=false,origin=null){
  let dry=false,graph=false,firstPrice=null,completedEffective=null,baseline=null,first=null,last=null,count=0;const seen=new Map(),transitions=new Map(),outcomes={};
  let restoredIdentity=null,through=null,caught=null,draining=false,pendingReorg=false,retired=null,recoveryFloor=null,orphaned=0;
  let repair=null,lastSaved=null,repairUsed=false,failedHeads=[];
  function discardAbove(height){
    for(const n of seen.keys())if(n>height){seen.delete(n);orphaned++;}
    for(const n of transitions.keys())if(n>height)transitions.delete(n);
    const keys=[...seen.keys()];count=seen.size;first=keys[0]??null;last=keys.at(-1)??null;
  }
  return {beginDrain(){draining=true;},read(line){
    if(line==="[searcher/live] mode=live-submit"||line.includes('"type":"strict_simulation_fatal"'))throw Error("unsafe mode or fatal simulation");
    if(line==="[searcher/live] mode=dry-run")dry=true;
    if(line.startsWith("[searcher/live] SQL runtime catalog loaded:"))graph=true;
    if(resume&&line.startsWith("[searcher/live-continuation] {")){
      const v=JSON.parse(line.slice(line.indexOf("{")));
      assert(!["new-logical-round","disabled-cold-start","no-checkpoint-cold-start","save-failed"].includes(v.phase),"resume cannot use cold or failed storage");
      if(v.phase==="saved"&&restoredIdentity&&positive(v.sourceBlock))lastSaved=v.sourceBlock;
      if(v.phase==="hot-prices-required"){
        assert(!draining&&caught!==null&&!pendingReorg&&!repair&&!repairUsed&&v.trading===false&&
          [caught,last,recoveryFloor,lastSaved].includes(v.from)&&v.from>=Math.max(last??0,recoveryFloor??0,caught)&&
          /^0x[0-9a-f]{64}$/.test(v.fromHash)&&(v.from!==origin.source||v.fromHash===origin.hash)&&(!seen.has(v.from)||seen.get(v.from)===v.fromHash)&&
          failedHeads.length===2&&failedHeads[0]>v.from&&failedHeads[1]>failedHeads[0]&&
          isDeepStrictEqual(v.failed,failedHeads),"unproven repeated hot preparation deadlines");
        repair={through:v.from,from:v.from};repairUsed=true;failedHeads=[];return;
      }
      if(v.phase==="hot-prices-advanced"){
        assert(repair&&!pendingReorg&&v.trading===false&&v.startupSimulation===false&&v.from===repair.through&&
          positive(v.to)&&positive(v.head)&&v.from<v.to&&v.to<=v.head&&v.to-v.from<=256,"invalid hot price recovery transition");
        repair.through=v.to;return;
      }
      if(v.phase==="hot-prices-ready"){
        assert(repair&&!pendingReorg&&v.sourceBlock===repair.through&&v.sourceBlock>repair.from&&v.head===v.sourceBlock&&
          v.nextHead==="full-production-pipeline","unproven hot recovery handoff");
        recoveryFloor=repair.through;repair=null;return;
      }
      if(v.phase==="restored"){
        assert(dry&&graph&&firstPrice===null&&v.trading===false&&v.sourceBlock===origin.source&&v.sourceBlockHash===origin.hash&&(!origin.consumerIdentity||v.identity===origin.consumerIdentity)&&
          /^[a-f0-9]{64}$/.test(v.identity)&&Number.isSafeInteger(v.observations)&&v.observations>=0,"incorrect restore provenance");
        // Native main emits this after reviewed identity, canonical anchors, effective receipt restore and startup rows install.
        firstPrice=through=v.sourceBlock;restoredIdentity=v.identity;
      }
      if(v.phase==="catching-up-prices"){assert(restoredIdentity&&caught===null&&v.trading===false&&v.startupSimulation===false&&
        v.from===through&&positive(v.to)&&v.to>through&&positive(v.head)&&v.to<=v.head,"invalid resume price catchup chain");through=v.to;}
      if(v.phase==="caught-up"){assert(restoredIdentity&&caught===null&&v.sourceBlock===through&&v.head===through&&v.nextHead==="full-production-pipeline","unproven catchup handoff");caught=through;}
    }
    if(resume&&line.startsWith("[searcher/blockscan-activity-anchor-retired]")){
      const v=JSON.parse(line.slice("[searcher/blockscan-activity-anchor-retired] ".length));
      assert(restoredIdentity&&positive(v.previousSourceBlock)&&positive(v.sourceBlock)&&v.sourceBlock>v.previousSourceBlock&&
        /^0x[0-9a-f]{64}$/.test(v.previousSourceHash)&&/^0x[0-9a-f]{64}$/.test(v.canonicalSourceHash)&&v.previousSourceHash!==v.canonicalSourceHash&&
        v.trading===false&&v.recovery==="two-branch-incremental"&&typeof v.startupWarmPending==="boolean"&&
        (!retired||(retired.height===v.previousSourceBlock&&retired.hash===v.previousSourceHash))&&
        (!seen.has(v.previousSourceBlock)||seen.get(v.previousSourceBlock)===v.previousSourceHash),"unproven retired activity anchor");
      pendingReorg=true;retired={height:v.previousSourceBlock,hash:v.previousSourceHash};
      repair=null;failedHeads=[];lastSaved=null;
      discardAbove(v.previousSourceBlock-1);return;
    }
    if(resume&&line.startsWith("[searcher/blockscan-reorg-recovery-pending]")){
      const v=JSON.parse(line.slice("[searcher/blockscan-reorg-recovery-pending] ".length));
      assert(restoredIdentity&&positive(v.sourceBlock)&&v.fullWarmup===false&&v.trading===false&&typeof v.reason==="string","invalid pending reorg");
      pendingReorg=true;return;
    }
    if(resume&&line.startsWith("[searcher/blockscan-reorg-recovered]")){
      const v=JSON.parse(line.slice("[searcher/blockscan-reorg-recovered] ".length));
      assert(restoredIdentity&&positive(v.previousSourceBlock)&&positive(v.sourceBlock)&&v.sourceBlock>v.previousSourceBlock&&
        positive(v.ancestor)&&v.ancestor>=origin.source&&v.ancestor<=v.previousSourceBlock&&v.oldDepth===v.previousSourceBlock-v.ancestor&&
        Number.isSafeInteger(v.touchedStateKeys)&&v.touchedStateKeys>=0&&v.fullWarmup===false&&v.trading===false&&
        (!retired||retired.height===v.previousSourceBlock)&&(last===null||last<=v.previousSourceBlock),"unproven reorg common ancestor");
      discardAbove(v.ancestor);pendingReorg=false;retired=null;recoveryFloor=v.sourceBlock;return;
    }
    if(!resume && dry && graph && firstPrice===null && line.startsWith("[searcher/effective-mid] {")){
      const v=JSON.parse(line.slice(line.indexOf("{")));
      completedEffective=v.complete===true && positive(v.quoted) && v.quoted<=v.directions &&
        positive(v.sourceBlock) && /^0x[0-9a-f]{64}$/.test(v.sourceBlockHash) && Number.isSafeInteger(v.generation)
        ? v : null;
    }
    if(!resume && dry && graph && firstPrice===null && line.startsWith("[searcher/blockscan-nminus1-state] {")){
      const v=JSON.parse(line.slice(line.indexOf("{")));
      if(v.warm===true && ["complete","degraded"].includes(v.status) && positive(v.sourceBlock) &&
        completedEffective?.sourceBlock===v.sourceBlock && completedEffective.sourceBlockHash===v.sourceBlockHash &&
        completedEffective.generation===v.generation && positive(v.priced) && v.priced<=v.expected) firstPrice=v.sourceBlock;
    }
    if(line.startsWith("[searcher/blockscan-activity-range] ")){const v=JSON.parse(line.slice(line.indexOf("{")));transitions.set(v.sourceBlock,v.transitions);if(transitions.size>128)transitions.delete(transitions.keys().next().value);}
    const familyTag="[searcher/blockscan-family] ";if(!line.startsWith(familyTag))return;
    const record=line.slice(familyTag.length);
    // This channel also carries the runtime's plain-text per-head diagnostics.
    // Only the structured timing record counts the pass, never text or JSON nested in a reason.
    if(/^block=[1-9]\d* (?:error=|(?:state_incomplete|degraded|planner_failed|sim_amount_no_opportunity|solve_failed) )/.test(record))return;
    const v=JSON.parse(record);if(v.type!=="block_scan_timing")return;
    assert(typeof v.startup_warm==="boolean","timing record missing explicit warm/formal flag");
    if(v.startup_warm||!dry||!graph||firstPrice===null)return;
    const n=v.source_block;if(!positive(n))throw Error("invalid source height");
    if(resume && (caught===null||n<=caught||pendingReorg))return;
    if(resume&&repair)throw Error("formal pass seen during prices-only hot recovery");
    if(resume){
      if(["stale_state","budget_exceeded"].includes(v.outcome)&&v.stages?.state?.status==="failed"&&
          v.decision==="runtime_error:strict current runtime deadline expired"){
        if(n!==failedHeads.at(-1))failedHeads=[...failedHeads,n].slice(-2);
      }else failedHeads=[];
    }
    if(resume&&recoveryFloor!==null&&n<=recoveryFloor&&!seen.has(n))return; // the verified recovery target itself was pricing-only
    if(resume&&baseline===null){
      if(v.stages?.state?.status!=="ran"||!["ran","degraded"].includes(v.outcome))return;
      baseline=caught; // the first successful ordinary pass is countable, never the restored/handoff block
    }
    if(baseline===null){if(v.stages?.state?.status==="ran" && transitions.get(n)===1)baseline=n;return;}
    if(n<=baseline)return;
    outcomes[v.outcome]=(outcomes[v.outcome]??0)+1;
    // Busy notifications and failed/skipped preparations are not completed passes.
    if(!["ran","degraded"].includes(v.outcome)||v.stages?.state?.status!=="ran")return;
    const h=v.exact_source_block_hash;if(!/^0x[0-9a-f]{64}$/.test(h))throw Error("completed pass lacks exact block hash");
    if(seen.has(n)){if(seen.get(n)!==h)throw Error("counted source reorged");return;}
    if(last!==null && n<=last)throw Error("nonmonotonic formal source");
    if(draining)throw Error("new completed formal pass after stop");
    seen.set(n,h);first??=n;last=n;count++;repairUsed=false;return count;
  },summary(){return {dry,graph,firstPrice,baseline,first,last,formalCompleted:count,skippedHeights:first===null?null:last-first+1-count,outcomes,
    ...(resume?{restoredIdentity,catchupThrough:through,caughtUp:caught,lastFormalHash:last===null?null:seen.get(last),
      initialSkippedHeights:first===null?null:first-caught-1,reorgPending:pendingReorg,orphanedFormal:orphaned}:{})};}};
}
// A stop request only provisionally reaches the block limit. Late evidence or failures during child drain veto it.
export function guardedStop(send){
  let reason=null;
  return {reason:()=>reason,request(next){
    if(reason===null){reason=next;send();}else if(reason==="block_limit"&&next!=="block_limit")reason=next;
  }};
}
export function productionMainArgs(comm,args){
  if(!/^(?:node(?:js)?|tsx|npm(?:\s.*)?)$/.test(comm))return false;
  return args.some(a=>/(?:^|\/)(?:src|dist)\/searcher\/(?:main|index)\.(?:ts|js|mjs|cjs)$/.test(a))||
    args.some(a=>a==="searcher:live"||a==="npm run searcher:live");
}
export function assertNoOtherProductionMain(proc="/proc"){
  // Never inspect or emit environment, endpoints or argument values. We only
  // check process names and locally compare exact entrypoint tokens.
  for(const entry of fs.readdirSync(proc)){
    if(!/^\d+$/.test(entry)||Number(entry)===process.pid)continue;
    try{const comm=fs.readFileSync(join(proc,entry,"comm"),"utf8").trim();
      if(!/^(?:node(?:js)?|tsx|npm(?:\s.*)?)$/.test(comm))continue;
      const args=fs.readFileSync(join(proc,entry,"cmdline"),"utf8").split("\0");
      if(productionMainArgs(comm,args))throw Error("another production searcher main is running; not starting");
    }catch(e){if(e.code!=="ENOENT"&&e.code!=="ESRCH")throw e;}
  }
}
const repair7Ledger=join(root,"logs/sql512-cloud-guard"), unit="mev-sql512-dryrun.service";
export const archivedSqlContext=Object.freeze({"chainId":"1","topology":"sql-edges:26455077:98dcbbf64c6a1990f867c6f7cab1e69079838d7af3bef42532a65008939cdfce","activityMode":"logs","executor":"0x4af9495c4ac24c5cd3b0c90611550a1996415bce","transactionOrigin":"0xb8578b6de173c8554ff0390db5a7effa567dda3c","executorCode":"0x4d0bb51b7d6cf404120e74462fad7135eb11b1ff5b16aa22757fc4c44a7c7623","rawExecutionEntry":false,"fixedWethInput":"2000000000000000","maxInputPathHops":4,"spreadBps":10,"cascade":false,"sqlInputFingerprint":"9dd6a3923971893a3fd30d73a8ba448086e161300601beddd776e12ba78b9d4a"});
function assertService(c){
  assert(c.host==="mev-impl-c4d-20261002.us-east1-b.c.eth-token-480803.internal" && c.user==="eunice" &&
    c.cwd===root && c.ledger===repair7Ledger && /^[a-f0-9]{32}$/.test(c.invocation??"") &&
    c.credDir==="/run/credentials/"+unit && c.cgroup.split("\n").includes("0::/system.slice/"+unit),"wrong cloud dry-run host, service or ledger");
}
export async function verifyInputs(load,path,digest){
  // Use the production reader; don't maintain another joint schema or require a prepriced artifact.
  const {manifest,edges,fundingAssets,fundingTableSha256}=await load(path,digest);
  assert(edges.length===rows&&manifest.rows===rows&&fundingAssets.length>0,"wrong raw SQL input counts");
  assert(manifest.edgeSha256===edgeSha&&manifest.cutoffHash===anchorHash&&manifest.fromBlock===window[0]&&manifest.toBlock===window[1],"wrong discovery window");
  assert.equal(fundingTableSha256,fundingSha,"not the same selected small SQL funding table");
}
export function approvedEndpoint(v){
  // Only the single selected upstream may enter this process; no .env records,
  // userinfo, custom ports, alternate services, fragments, or extra parameters.
  if(typeof v!=="string"||v.length>2048||/\s/.test(v)||!/^https:\/\/eth-mainnet\.(?:g\.alchemy\.com|alchemyapi\.io)\/v2\/[A-Za-z0-9_-]+$/.test(v))
    throw Error("invalid selected Ethereum mainnet Alchemy endpoint");
  const u=URL.parse(v);
  if(!u||u.protocol!=="https:"||!["eth-mainnet.g.alchemy.com","eth-mainnet.alchemyapi.io"].includes(u.hostname)||u.port||u.username||u.password||u.search||u.hash)
    throw Error("invalid selected Ethereum mainnet Alchemy endpoint");
  return v;
}

export {root,node,window,owner,executor,codeHash,formalLimit,clock,shaBytes,exclusiveLock,assertService,repair7Ledger,unit};
