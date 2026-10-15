import assert from "node:assert/strict";
import { ethers } from "ethers";
import { ABI as migrationAbi } from "../codec.js";
import { ABI as bearAbi } from "../../token-conversion-family/variants.js";
export const SAMPLES = {
  migration: {family:"protocol:token-migration", target:"0x5c30d7494da55e23f62130c642c22af1814ef65d", tx:"0x576dcfa02ef2f8c2a2038ed17070e14a757c9c2e0b2e19b2de65ff65b9e7c583", number:26029585, hash:"0x7d657e10588fe0327698837441079dc5568813e20a53057ae806a28ab210dead", routes:1, abi:migrationAbi},
  btb: {family:"protocol:token-conversion", target:"0x88888880d5ca13018d2dc11e2e4744bd91a5656f", tx:"0x86a480c93d60c9eb2c6a3c3ef7c322c8b3a290dc541a96554fa224adaf8d8f91", number:26029369, hash:"0x8406ef83427bd09be91ef479edff4830d245d4c4658b75299b12e37c8ac20928", routes:2, abi:bearAbi},
} as const;
export function selectedSample(name:string){assert(name==="migration"||name==="btb");return SAMPLES[name];}
export function originalInputs(name:string,receipt:any){
 const s=selectedSample(name);assert(receipt&&receipt.transactionHash.toLowerCase()===s.tx&&BigInt(receipt.status)===1n&&Number(BigInt(receipt.blockNumber))===s.number&&receipt.blockHash===s.hash);
 const logs=receipt.logs.filter((l:any)=>l.address.toLowerCase()===s.target&&!l.removed).map((l:any)=>{try{return {logIndex:Number(BigInt(l.logIndex)),event:s.abi.parseLog(l)};}catch{return undefined;}}).filter((x:any)=>x?.event);
 const found:Record<string,{amount:bigint,logIndex:number,event:string,field:string}>={};
 for(const {logIndex,event}of logs){
  if(name==="migration"&&event.name==="TokensMigrated"){
   assert(found.migrate===undefined,"ambiguous original migration amount");assert(event.args.amountOfBitSwapped>0n&&event.args.amountOfMntReceived>0n);
   found.migrate={amount:event.args.amountOfBitSwapped,logIndex,event:event.name,field:"amountOfBitSwapped"};
  }
  if(name==="btb"&&["Minted","Redeemed"].includes(event.name)){
   const direction=event.name==="Minted"?"mint":"redeem";assert(found[direction]===undefined,"ambiguous original conversion amount");
   const amount=direction==="mint"?event.args.btbAmount:event.args.btbbAmount;assert(amount>0n);
   found[direction]={amount,logIndex,event:event.name,field:direction==="mint"?"btbAmount":"btbbAmount"};
  }
 }
 if(name==="migration")assert(found.migrate);else{
  assert(found.mint||found.redeem,"no original Bear event");
  // A recorded token quantity may serve as independent input for the opposite
  // direction. This borrows only input size, never an expected quote/output.
  const original=logs.find((x:any)=>["Minted","Redeemed"].includes(x.event.name))!;
  if(!found.mint)found.mint={...found.redeem!,amount:original.event.args.btbAmount,field:"btbAmount (output quantity borrowed as mint input only)"};
  if(!found.redeem)found.redeem={...found.mint!,amount:original.event.args.btbbAmount,field:"btbbAmount (output quantity borrowed as redeem input only)"};
 }
 return found;
}
