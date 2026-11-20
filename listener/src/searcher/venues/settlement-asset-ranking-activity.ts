import {id} from "ethers";
import {ADDR} from "../../shared/constants/addresses.js";
const transfer=id("Transfer(address,address,uint256)"),approval=id("Approval(address,address,uint256)");
const deposit=id("Deposit(address,uint256)"),withdrawal=id("Withdrawal(address,uint256)");
const wrapper=ADDR.WETH.toLowerCase();
/** Rank hints only. Never used to select actual touched pools, promote a
 * quote, or infer a venue from an unallocated manager balance. Unknown
 * currency operations (fees, pause, rebase, code changes) veto every
 * historical hint using that currency for this activity interval. */
export function settlementAssetRankingActors(log:{address:string;topics:readonly string[];data:string}):readonly string[]|{readonly possibleSupplyHolder:string}|null {
  const [topic,...words]=log.topics;
  if(!/^0x[0-9a-f]{64}$/i.test(log.data)||!words.every(w=>/^0x0{24}[0-9a-f]{40}$/i.test(w)))return null;
  const owners=words.map(w=>"0x"+w.slice(-40).toLowerCase());
  const t=topic?.toLowerCase();
  if(owners.some(a=>/^0x0{40}$/.test(a))){
    const nonzero=owners.filter(a=>!/^0x0{40}$/.test(a));
    // Shape only; not proof of mint/burn or of its economic effect. Still
    // vetoes every market without a separately proven target/method model.
    return t===transfer&&owners.length===2&&nonzero.length===1?{possibleSupplyHolder:nonzero[0]!}:null;
  }
  if((t===transfer||t===approval)&&owners.length===2)return owners;
  if(log.address.toLowerCase()===wrapper&&(t===deposit||t===withdrawal)&&owners.length===1)return owners;
  return null;
}
