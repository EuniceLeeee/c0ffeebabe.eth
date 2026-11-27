import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";

const sha = (data: Buffer|string) => createHash("sha256").update(data).digest("hex");
const owners = "./selector-direct-f3/receipt-call-owners.mjs";
async function bytes(dir:URL,name:string) {
  const path=new URL(name,dir);
  if(!(await lstat(path)).isFile())throw Error("discovery rule source must be a regular file: "+name);
  return readFile(path);
}
// The SQL UDF ships self-contained Family methods. Refuse additional module
// imports until their file bytes are included too; changing an unsealed
// helper must never preserve the evidence identity for a pool-touch profile.
function selfContained(code:string) {
  if(/\b(?:import|require)\b|\bexport\s*(?:\*|\{[^}]*\}\s*from\b)/.test(code))
    throw Error("unsealed selector discovery module dependency");
}
/** Both inputs are fixed release directories (URLs ending in '/'), never
 * paths from the SQL table. Does not import or execute any discovery code. */
export async function readSelectorDiscoveryRuleHash(familyDirectory:URL,scriptsDirectory:URL):Promise<string> {
  if(![familyDirectory,scriptsDirectory].every(p=>p.protocol==="file:"&&p.pathname.endsWith("/")))
    throw Error("discovery rule hash requires release directories");
  const [rule,common,owner]=await Promise.all([bytes(familyDirectory,"edge-discovery.json"),
    bytes(scriptsDirectory,"selector-family-event-discovery.mjs"),bytes(scriptsDirectory,owners)]);
  const type=JSON.parse(rule.toString("utf8")).type;
  const family=type==="familyModule"?await bytes(familyDirectory,"discover.mjs"):null;
  if(!family&&!(Array.isArray(type)&&type.length===2&&type[0]==="ordered"&&type[1]==="ChildEvent"))
    throw Error("unsupported selector discovery rule kind");
  if(family)selfContained(family.toString("utf8"));
  selfContained(owner.toString("utf8"));
  const kernel=common.toString("utf8"),knownImport=/^import\s*\{[^}]+\}\s*from\s*['"]\.\/selector-direct-f3\/receipt-call-owners\.mjs['"];?/m;
  if(!knownImport.test(kernel))throw Error("discovery kernel ownership dependency differs");
  selfContained(kernel.replace(knownImport,""));
  return sha(JSON.stringify(["selector-source-discovery/v1",sha(rule),family?sha(family):null,sha(common),sha(owner)]));
}
