// Prepare a run-local Ready before any signer, permit or producer is created.
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {createReadStream,constants,copyFileSync,existsSync,mkdirSync,readFileSync,renameSync,writeFileSync,unlinkSync,rmdirSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
export async function readyFileSha256(path){const h=createHash('sha256');for await(const chunk of createReadStream(path))h.update(chunk);return h.digest('hex');}
export function readyActivationCacheKey(release,config){
  const activation=Object.entries(config).filter(([key])=>key.startsWith('SEARCHER_FAMILY_')).sort(([a],[b])=>a.localeCompare(b));
  return digest({schema:1,source:release.readySha256,code:release.sourceBundleSha256,config:release.config,
    executionIdentity:[config.BOTVM_ADDRESS,config.BOTVM_OWNER],activation});
}
const json=path=>JSON.parse(readFileSync(path,'utf8'));
const save=(path,value)=>writeFileSync(path,JSON.stringify(value,null,2)+'\n',{flag:'wx',mode:0o600});
function validate(receipt,release,key){
  assert.equal(receipt.schemaVersion,1);assert.equal(receipt.cacheKey,key);
  assert.equal(receipt.sourceSha256,release.readySha256);
  assert.equal(receipt.sourceGeneration,release.readyGeneration);
  assert(Number.isSafeInteger(receipt.generation)&&receipt.generation>=receipt.sourceGeneration&&receipt.generation<=receipt.sourceGeneration+1);
  assert(/^[0-9a-f]{64}$/.test(receipt.readySha256));
  assert.equal(receipt.scans,0);assert.equal(receipt.attestations,0);
}
async function execute({profile,config,run,key,release,onChild,log}){
  const endpoint=json(profile.rpcFile).MAINNET_RPC_URL;
  assert(typeof endpoint==='string'&&endpoint.length>0);
  const output=join(run,'ready-activation-result.json');
  const env={PATH:dirname(profile.node)+':/usr/bin:/bin',...config,MAINNET_RPC_URL:endpoint,
    SEARCHER_DRY_RUN:'1',SEARCHER_BLOCKSCAN_SUBMIT:'0',SEARCHER_TEST_DISABLE_DOTENV:'1',
    SEARCHER_READY_ACTIVATION_RECEIPT:output,SEARCHER_READY_ACTIVATION_KEY:key,
    SEARCHER_READY_SOURCE_SHA256:release.readySha256,SEARCHER_READY_SOURCE_GENERATION:String(release.readyGeneration)};
  for(const name of Object.keys(env))assert(!/PRIVATE_KEY|SECRET|PASSWORD/.test(name));
  const child=spawn(profile.node,['--max-old-space-size=8192','--import','tsx','src/searcher/ready-family-activation-cli.ts'],
    {cwd:join(profile.release,'runtime/listener'),env,stdio:['ignore','pipe','pipe']});
  onChild(child);
  const redact=value=>value.replaceAll(endpoint,'[RPC_REDACTED]').replace(/https?:\/\/[^\s"<>]+/g,'[URL_REDACTED]');
  for(const input of [child.stdout,child.stderr])createInterface({input}).on('line',line=>log(redact(line)+'\n'));
  const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',(code,signal)=>resolve(signal??code));});
  assert.equal(code,0,'automatic Ready activation failed; see live.log');
  onChild(null);return json(output);
}
export async function prepareRunReady({profile,release,config,run,onChild=()=>{},log=()=>{},executeActivation=execute}){
  const path=config.SEARCHER_UNIVERSE_REBUILD_CHECKPOINT_PATH;
  assert.equal(path,join(run,'checkpoint.json'));
  assert.equal(await readyFileSha256(path),release.readySha256,'run must start from the immutable Ready');
  const key=readyActivationCacheKey(release,config),cache=join(dirname(profile.runs),'ready-activation-cache',key);
  mkdirSync(dirname(cache),{recursive:true,mode:0o700});
  const receiptPath=join(cache,'receipt.json'),cachedPath=join(cache,'checkpoint.json');
  const hit=async()=>{
    const receipt=json(receiptPath);validate(receipt,release,key);
    assert.equal(await readyFileSha256(cachedPath),receipt.readySha256,'Ready activation cache changed');
    const temp=path+'.activation-'+randomUUID();copyFileSync(cachedPath,temp,constants.COPYFILE_EXCL);renameSync(temp,path);
    log('[ready-activation] cache hit; no scans or attestations\n');return {...receipt,cacheHit:true};
  };
  if(existsSync(receiptPath))return hit();
  const staging=cache+'.'+randomUUID();mkdirSync(staging,{mode:0o700});
  try{
    log('[ready-activation] synchronizing configured Family switches\n');
    const receipt=await executeActivation({profile,release,config,run,key,onChild,log});
    validate(receipt,release,key);assert.equal(await readyFileSha256(path),receipt.readySha256);
    copyFileSync(path,join(staging,'checkpoint.json'),constants.COPYFILE_EXCL);save(join(staging,'receipt.json'),receipt);
    try{renameSync(staging,cache);}catch(error){if(!['ENOTEMPTY','EEXIST'].includes(error.code))throw error;return await hit();}
    return {...receipt,cacheHit:false};
  }finally{
    // Only this invocation's staging files; never remove an existing cache/source.
    if(existsSync(staging)){for(const name of ['checkpoint.json','receipt.json']){const file=join(staging,name);if(existsSync(file))unlinkSync(file);}rmdirSync(staging);}
  }
}
