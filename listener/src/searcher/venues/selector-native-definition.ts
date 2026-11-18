import { FunctionFragment, type ParamType } from "ethers";
import { hashCanonical } from "./canonical-value.js";
import { familyId, type FamilyId } from "./adapter-family-identifiers.js";
import { selectorFamilyIdentity } from "./selector-execution-keys.js";
import { assertModuleData } from "./declarative-modules.js";

export type SelectorNativeData = Readonly<Record<string, any>>;
export interface SelectorNativeProgram {
  /** Canonical runtime data. Author metadata is removed before this type exists. */
  readonly parameters?: readonly { readonly path: readonly number[]; readonly role: "amountIn" | "minimumOut" | "recipient" | "executor" | "tokenIn" | "tokenOut" | "poolId" | "tokenInId" | "tokenOutId" | "bound" }[];
  readonly payment?: { readonly kind: "none" | "approval" | "pretransfer"; readonly address?: unknown };
  readonly values?: SelectorNativeData;
  readonly resourceValues?: SelectorNativeData;
  readonly binding?: {
    readonly nomination?: SelectorNativeData;
    readonly candidate?: unknown;
    readonly subject?: unknown;
    readonly flow?: SelectorNativeData;
    readonly facts: unknown;
    readonly descriptor: unknown;
    readonly descriptorReads?: SelectorNativeData;
    readonly match?: unknown;
  };
  readonly routes?: {
    readonly target: unknown;
    readonly directions?: unknown;
    readonly allowedDirections?: readonly string[];
    readonly venue?: unknown;
    readonly resource?: unknown;
    /** Complete physical resource set for an atomic call spanning several pools. */
    readonly resources?: readonly unknown[];
    readonly checks?: readonly unknown[];
    readonly assertions?: readonly unknown[];
  };
  readonly context?: unknown;
  readonly state?: unknown;
  readonly checks?: readonly unknown[];
  readonly execution?: SelectorNativeData;
  readonly math?: SelectorNativeData;
  readonly runtimeMath?: SelectorNativeData;
  readonly quoteOutput?: SelectorNativeData;
  readonly runtimeEvidence?: SelectorNativeData;
  readonly observations?: SelectorNativeData;
  readonly receiptChecks?: { readonly observe: readonly string[]; readonly checks: readonly unknown[]; readonly tokenBalances?: unknown; readonly totalSupplies?: unknown };
  readonly dependencies?: unknown;
  readonly refreshPolicy?: "on-touch" | "each-block";
  readonly ethCall?: { readonly signature: string; readonly arguments: readonly unknown[]; readonly outputWord: number };
}
export interface SelectorNativeExecutionDefinition {
  readonly format: "selector-family/v2";
  readonly selector: string;
  readonly signature: string;
  readonly domain: "swap" | "protocol";
  readonly activation?: { readonly enabled: boolean; readonly envKey: string };
  readonly programs: readonly SelectorNativeProgram[];
  readonly unsupportedReason?: string;
}
const PROGRAM_FIELDS = ["parameters", "payment", "values", "resourceValues", "binding", "routes", "context", "state", "checks", "execution", "math", "runtimeMath", "quoteOutput", "runtimeEvidence", "observations", "receiptChecks", "dependencies", "refreshPolicy", "ethCall"];
function shape(value: any, required: readonly string[], optional: readonly string[], label: string): void {
  if (!value || typeof value !== "object" || Array.isArray(value) || required.some(key => !Object.hasOwn(value,key)) ||
      Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) throw new Error(`selector-native ${label} fields`);
}
function validateParameters(signature:string,program:SelectorNativeProgram):void {
  const fn=FunctionFragment.from(signature),parameters=program.parameters??[];
  const paths=parameters.map(p=>p.path);
  const prefix=(a:readonly number[],b:readonly number[])=>a.length<=b.length&&a.every((n,i)=>b[i]===n);
  for(let i=0;i<paths.length;i++)for(let j=i+1;j<paths.length;j++)if(prefix(paths[i]!,paths[j]!)||prefix(paths[j]!,paths[i]!))throw new Error('selector-native parameter paths overlap');
  function typeAt(path:readonly number[]):ParamType {
    let current=fn.inputs[path[0]!] as ParamType|undefined;
    for(const index of path.slice(1)){
      if(current?.baseType==='tuple')current=current.components?.[index];
      else if(current?.baseType==='array'&&(current.arrayLength===-1||index<current.arrayLength!))current=current.arrayChildren??undefined;
      else current=undefined;
    }
    if(!current)throw new Error('selector-native parameter path exceeds ABI');return current;
  }
  for(const parameter of parameters){const type=typeAt(parameter.path);
    if(['amountIn','minimumOut'].includes(parameter.role)&&!/^u?int[0-9]+$/.test(type.type)||
      ['tokenInId','tokenOutId'].includes(parameter.role)&&!/^uint[0-9]+$/.test(type.type)||
      parameter.role==='poolId'&&!/^(?:u?int[0-9]+|bytes(?:[0-9]+)?|address|string)$/.test(type.type)||
      ['recipient','executor','tokenIn','tokenOut'].includes(parameter.role)&&type.type!=='address')throw new Error('selector-native parameter role differs from ABI type');
  }
  if(program.execution)return;
  if(!parameters.some(p=>p.role==='amountIn'))throw new Error('selector-native simple call requires an amountIn parameter');
  function covered(type:ParamType,path:readonly number[]):boolean {
    if(paths.some(p=>prefix(p,path)))return true;
    if(type.baseType==='tuple')return type.components!.every((child,index)=>covered(child,[...path,index]));
    if(type.baseType==='array'&&type.arrayLength!==-1&&type.arrayLength!<=256)return Array.from({length:type.arrayLength!},(_,index)=>covered(type.arrayChildren!,[...path,index])).every(Boolean);
    return false;
  }
  if(!fn.inputs.every((type,index)=>covered(type,[index])))throw new Error('selector-native simple call must declare every ABI parameter as mutable or bound');
}
export function freezeSelectorNative<T>(value: T): T {
  if (value && typeof value === "object") { Object.values(value).forEach(freezeSelectorNative); Object.freeze(value); }
  return value;
}
export function selectorNativeFamilyId(raw: Pick<SelectorNativeExecutionDefinition,"signature"|"selector">): FamilyId {
  return familyId(selectorFamilyIdentity(raw.signature, raw.selector).familyId);
}
export function selectorNativeProgramKey(program: SelectorNativeProgram): string {
  return `parameters:${hashCanonical(program as any)}`;
}
/** A single author syntax, with an optional one-program shorthand. Metadata is
 * validated as inert JSON, then omitted before any semantic fingerprint. */
export function normalizeSelectorNativeExecutionDefinition(raw: unknown): SelectorNativeExecutionDefinition {
  assertModuleData(raw);
  shape(raw,["selector","signature"],["format","domain","programs","activation","unsupportedReason","meta",...PROGRAM_FIELDS],"definition");
  const author=raw as Record<string,any>;
  if(author.format!==undefined&&author.format!=="selector-family/v2")throw new Error("selector-family requires v2; legacy execution formats are not supported");
  const inline=PROGRAM_FIELDS.filter(field=>Object.hasOwn(author,field));
  if(Object.hasOwn(author,'programs')&&inline.length)throw new Error('selector-family cannot mix top-level execution fields with programs');
  const programs=Object.hasOwn(author,'programs')?author.programs:inline.length?[Object.fromEntries(inline.map(field=>[field,author[field]]))]:[];
  if(!Array.isArray(programs))throw new Error('selector-family programs must be an array');
  const value={format:'selector-family/v2',selector:author.selector,signature:author.signature,domain:author.domain===undefined?'swap':author.domain,
    ...(author.activation===undefined?{}:{activation:author.activation}),...(author.unsupportedReason===undefined?{}:{unsupportedReason:author.unsupportedReason}),
    programs:programs.map((program:unknown)=>{
      shape(program,[],[...PROGRAM_FIELDS,'meta'],'program');
      const {meta:_meta,...semantic}=program as Record<string,any>;
      if(semantic.binding!==undefined){shape(semantic.binding,[],['nomination','candidate','subject','flow','facts','descriptor','descriptorReads','match'],'binding');
        semantic.binding={facts:{},descriptor:{},...semantic.binding};}
      if(semantic.routes!==undefined){shape(semantic.routes,[],['target','directions','venue','resource','resources','checks','assertions','allowedDirections'],'routes');
        semantic.routes={target:'$descriptor.target',...semantic.routes};}
      return semantic;
    })} as SelectorNativeExecutionDefinition;
  if(!["swap","protocol"].includes(value.domain)) throw new Error("selector-family execution domain");
  selectorFamilyIdentity(value.signature,value.selector);
  if(value.activation){shape(value.activation,["enabled","envKey"],[],"activation");
    if(typeof value.activation.enabled!=="boolean"||!/^SEARCHER_FAMILY_[A-Z0-9_]+_ENABLED$/.test(value.activation.envKey)) throw new Error("selector-native activation");}
  if(!Array.isArray(value.programs)||value.programs.length>256||(!value.programs.length)!==Boolean(value.unsupportedReason)) throw new Error("selector-native executable programs or explicit non-entry reason required");
  if(value.unsupportedReason!==undefined && (typeof value.unsupportedReason!=="string"||!value.unsupportedReason.trim())) throw new Error("selector-native non-entry reason");
  const keys=new Set<string>();
  for(const p of value.programs){
    shape(p,[],PROGRAM_FIELDS,"program");
    if(!p.execution&&!p.parameters?.length)throw new Error("selector-native parameters or execution required");
    if(p.values)shape(p.values,[],["abi","constants","expressions","programs","inputs"],"values");
    if(p.resourceValues)shape(p.resourceValues,[],["abi","constants","expressions","programs","inputs"],"resource values");
    if(p.payment){shape(p.payment,["kind"],["address"],"payment");if(!['none','approval','pretransfer'].includes(p.payment.kind)||p.payment.kind==='none'&&p.payment.address!==undefined)throw new Error('selector-native payment');}
    if(p.receiptChecks){shape(p.receiptChecks,["observe","checks"],["tokenBalances","totalSupplies"],"receipt checks");if(!Array.isArray(p.receiptChecks.checks)||!Array.isArray(p.receiptChecks.observe)||p.receiptChecks.observe.some((effect:string)=>!['return-data','revert-data','token-delta','native-delta','logs','total-supply-delta'].includes(effect)))throw new Error('selector-native receipt observations');}
    if(p.binding){shape(p.binding,["facts","descriptor"],["nomination","candidate","subject","flow","descriptorReads","match"],"binding");
      if(p.binding.flow){shape(p.binding.flow,["version","steps","result"],[],"binding flow");if(p.binding.flow.version!==1||!Array.isArray(p.binding.flow.steps)||!p.binding.flow.steps.length||p.binding.flow.steps.length>128)throw new Error('selector-native binding flow bounds');}}
    if(p.routes){shape(p.routes,["target"],["directions","venue","resource","resources","checks","assertions","allowedDirections"],"routes");
      if(p.routes.resources!==undefined&&(!Array.isArray(p.routes.resources)||!p.routes.resources.length||p.routes.resources.length>256))throw new Error('selector-native physical resources must be a nonempty bounded list');}
    if(p.refreshPolicy!==undefined&&!['on-touch','each-block'].includes(p.refreshPolicy))throw new Error("selector-native refresh policy");
    if(p.ethCall){shape(p.ethCall,["signature","arguments","outputWord"],[],"eth-call");
      const fn=FunctionFragment.from(p.ethCall.signature);if(!Array.isArray(p.ethCall.arguments)||fn.inputs.length!==p.ethCall.arguments.length||!Number.isSafeInteger(p.ethCall.outputWord)||p.ethCall.outputWord<0)throw new Error("selector-native eth-call ABI");}
    if(p.parameters){if(!Array.isArray(p.parameters)||p.parameters.length>256)throw new Error("selector-native parameters");
      for(const parameter of p.parameters){shape(parameter,["path","role"],[],"parameter");if(!Array.isArray(parameter.path)||!parameter.path.length||parameter.path.some((n:number)=>!Number.isSafeInteger(n)||n<0)||!['amountIn','minimumOut','recipient','executor','tokenIn','tokenOut','poolId','tokenInId','tokenOutId','bound'].includes(parameter.role))throw new Error("selector-native parameter role/path");}}
    validateParameters(value.signature,p);
    const key=selectorNativeProgramKey(p);if(keys.has(key))throw new Error("duplicate selector-native parameter program");keys.add(key);
  }
  return freezeSelectorNative(JSON.parse(JSON.stringify({...value,selector:value.selector.toLowerCase(),signature:FunctionFragment.from(value.signature).format('full')})));
}
export const validateSelectorNativeExecutionDefinition=(raw:unknown):void=>{normalizeSelectorNativeExecutionDefinition(raw);};
