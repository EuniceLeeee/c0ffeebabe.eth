import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import vm from 'node:vm';
import {compileReadyDiscovery} from './ready-bigquery-sql.mjs';
export const sha=x=>createHash('sha256').update(x).digest('hex');
export function googleApi(config=process.env.SELECTOR_GCLOUD_CONFIG??'mev-rpc-latency'){
 const token=execFileSync('gcloud',['--configuration='+config,'auth','print-access-token'],{encoding:'utf8',stdio:['ignore','pipe','ignore'],timeout:30000}).trim();
 return async(url,{headers={},allowStatus,bytes=false,timeoutMs=20000,maxAttempts=5,...options}={})=>{
   assert(Number.isInteger(timeoutMs)&&timeoutMs>=1000&&timeoutMs<=180000&&Number.isInteger(maxAttempts)&&maxAttempts>=1&&maxAttempts<=5);
   for(let attempt=0;;attempt++){
     let r;
     try{r=await fetch(url,{...options,headers:{...headers,Authorization:'Bearer '+token},signal:AbortSignal.timeout(timeoutMs)});}
     catch(e){if(attempt+1>=maxAttempts)throw Error('Cannot reach '+new URL(url).hostname+': '+(e.cause?.code??e.name));}
     if(r?.status===allowStatus&&r){await r.body?.cancel();return null;}
     if(r?.ok)return bytes?Buffer.from(await r.arrayBuffer()):r.json();
     if(r&&(![429,500,502,503,504].includes(r.status)||attempt+1>=maxAttempts)){const err=await r.json().catch(()=>({}));throw Error('Google query service: '+String(err.error?.message??r.status).slice(0,600));}
     await r?.body?.cancel();await new Promise(resolve=>setTimeout(resolve,500*2**attempt));
   }
 };
}
export async function loadPublishedRules(root,api){
 const lib=await compileReadyDiscovery(root,null,process.env.SELECTOR_BQ_LIBRARY_BUCKET??'contract_yoyo'),ctx=vm.createContext({});
 await Promise.all(lib.map(async l=>{
   const data=await api('https://storage.googleapis.com/storage/v1/b/'+l.bucket+'/o/'+encodeURIComponent(l.object)+'?alt=media',{bytes:true});
   assert.equal(sha(data),l.sha256,'published library differs from workspace: '+l.object);
 }));
 for(const l of lib)vm.runInContext(l.bytes.toString(),ctx,{timeout:30000});
 return {rules:JSON.parse(JSON.stringify(ctx.DiscoveryKernel.rules())),libraries:lib.map(l=>l.uri)};
}
