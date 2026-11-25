import {AsyncLocalStorage} from "node:async_hooks";
import {FunctionFragment, type Interface, type Result} from "ethers";

// Cache only the pure ABI operation performed *after* a real read. Nothing
// in this module answers an RPC, identifies a pool, or records a price.
export class VerifiedGetterDecodes {
  private readonly values=new Map<string,Map<string,Result|undefined>>();
  private readonly signatures=new Map<string,{key:string;length:number}|null>();
  private readonly fragments=new WeakMap<FunctionFragment,string>();
  private entries=0;
  private reused=0;
  get hits(){return this.reused;}
  remember(abi:string,raw:string){
    if(raw.length>1026 || raw.length<66 || !/^0x(?:[0-9a-f]{64})+$/.test(raw))return;
    let shape=this.signatures.get(abi);
    if(shape===undefined){
      try {
        const fn=FunctionFragment.from(abi);
        // Scalar ABI words only: no nested, mutable or lazily decoded objects.
        shape=fn.outputs.length>0&&fn.outputs.length<17&&fn.outputs.every(o=>/^(?:address|bool|u?int[0-9]+|bytes[0-9]+)$/.test(o.type))
          ?{key:fn.format("full"),length:2+fn.outputs.length*64}:null;
      }catch{return;}
      if(this.signatures.size>=512)this.signatures.clear();
      this.signatures.set(abi,shape);
    }
    if(!shape||shape.length!==raw.length||this.values.get(raw)?.has(shape.key))return;
    if(this.entries>=2048){
      const oldest=this.values.keys().next().value!;
      this.entries-=this.values.get(oldest)!.size;this.values.delete(oldest);
    }
    const bucket=this.values.get(raw)??new Map<string,Result|undefined>();
    bucket.set(shape.key,undefined);this.values.set(raw,bucket);this.entries++;
  }
  decode(iface:Interface,fn:string,raw:string):Result {
    const bucket=this.values.get(raw);
    if(bucket){
      const f=iface.getFunction(fn);
      if(f){
        let key=this.fragments.get(f);
        if(!key){key=f.format("full");this.fragments.set(f,key);}
        if(bucket.has(key)){
          const cached=bucket.get(key);
          if(cached){this.reused++;return cached.slice();}
          const decoded=iface.decodeFunctionResult(f,raw);
          // Preserve deferred errors on unusual inputs; never replace them
          // with a successful decode. Slice keeps Result field names and gives
          // each JSON evaluation the same fresh object semantics as ethers.
          try{decoded.toArray();bucket.set(key,decoded);}catch{}
          return decoded;
        }
      }
    }
    return iface.decodeFunctionResult(fn,raw);
  }
}

const current=new AsyncLocalStorage<VerifiedGetterDecodes>();
let scopes=0;
export async function withVerifiedGetterDecodes<T>(scope:VerifiedGetterDecodes,run:()=>Promise<T>):Promise<T>{
  scopes++;
  try{return await current.run(scope,run);}finally{scopes--;}
}
export function rememberMatchedGetter(abi:string,bytes:string):void {current.getStore()?.remember(abi,bytes);}
export function decodeDeclaredGetter(iface:Interface,fn:string,raw:string):Result {
  const scope=scopes?current.getStore():undefined;
  return scope?scope.decode(iface,fn,raw):iface.decodeFunctionResult(fn,raw);
}
