// Seal the two discovery inputs for the production process, without prices,
// RPC, an execution grant or a separate launch path.
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {readFile,writeFile} from "node:fs/promises";
import {dirname,relative,resolve} from "node:path";
import {pathToFileURL} from "node:url";
import {parseArgs} from "node:util";
import {loadSqlPriceEdges} from "./sql-edge-price-index.js";
import {readSqlFundingRows} from "./sql-live-tables.js";
const sha=(b:Buffer|string)=>createHash("sha256").update(b).digest("hex");
export async function sealSqlLiveInput(options:{manifest:string;funding:string;out:string}){
  const manifest=resolve(options.manifest),funding=resolve(options.funding),out=resolve(options.out);
  const [meta,fund,swaps]=await Promise.all([readFile(manifest),readFile(funding),loadSqlPriceEdges(manifest)]);
  const raw=JSON.parse(meta.toString("utf8"));
  for(const k of ["edgeSha256","fromBlock","toBlock","cutoffHash","rows"] as const)
    assert.equal(raw[k],swaps.manifest[k],"swap manifest changed while sealing");
  const rows=readSqlFundingRows(JSON.parse(fund.toString("utf8")),swaps.manifest);
  const rel=(p:string)=>relative(dirname(out),p);
  const descriptor={format:"sql-live-input/v2",chainId:1,swaps:{manifest:rel(manifest),manifestSha256:sha(meta),...swaps.manifest},
    funding:{path:rel(funding),sha256:sha(fund)}};
  const bytes=JSON.stringify(descriptor)+"\n";await writeFile(out,bytes,{flag:"wx",mode:0o600});
  return {path:out,sha256:sha(bytes),...swaps.manifest,fundingRows:rows.length};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  const {values}=parseArgs({options:{manifest:{type:"string"},funding:{type:"string"},out:{type:"string"},help:{type:"boolean"}}});
  if(values.help)console.log("Seal raw discovery for searcher:live: --manifest fixed-edge-manifest.json --funding funding.json --out new-input.json (offline; no pricing or live run)");
  else {
    assert(values.manifest&&values.funding&&values.out,"swap manifest, funding table and new output are required");
    sealSqlLiveInput({manifest:values.manifest,funding:values.funding,out:values.out}).then(r=>console.log(JSON.stringify(r))).catch(e=>{console.error(e.message);process.exitCode=1;});
  }
}
