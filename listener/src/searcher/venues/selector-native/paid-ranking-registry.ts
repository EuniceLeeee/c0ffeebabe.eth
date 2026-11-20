import {paidRankRoles as managed} from "./selector-48c89491-family/historical-ranking.js";
import {paidRankRoles as pair} from "./selector-022c0d9f-family/historical-ranking.js";
import type {SelectorPaidRankRole} from "./paid-ranking-contract.js";
// Registration only; eligibility and binding evidence belong to each Family.
const byPaidProgram=new Map<string,SelectorPaidRankRole>();
for(const [key,role] of [...managed,...pair]){
  if(byPaidProgram.has(key)||!/^parameters:[a-f0-9]{64}$/.test(key))throw Error("ambiguous paid-ranking program registration");
  byPaidProgram.set(key,role);
}
export function selectorPaidRankRole(key:string){return byPaidProgram.get(key);}
