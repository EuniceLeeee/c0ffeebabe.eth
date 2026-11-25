import { keccak256 } from "ethers";

/** Public price receipt discriminator, not an execution handle. At execution
 * time a source-pinned issuer must independently reproduce both components. */
export function sqlTrialVariantId(programKey:string,program:string):string {
  if(!/^parameters:[a-f0-9]{64}$/.test(programKey)||!/^0x(?:[0-9a-fA-F]{2})+$/.test(program))
    throw new Error("invalid SQL trial recipe or runtime program");
  return "sql-trial:v1:"+programKey.slice("parameters:".length)+":"+keccak256(program);
}
