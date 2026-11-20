import test from "node:test";
import assert from "node:assert/strict";
import {GENERATED_PRODUCTION_FAMILY_ENTRIES} from "../generated/production-family-entries.generated.js";
import {PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG as catalog} from "../venues/production-family-composition.js";
import {issueSqlFamilyAlternatives} from "../venues/selector-native-sql-live-materializer.js";

// Real direction from the fixed 512-block SQL input (SHA-256 3538d508…b95cd8).
// The manager and logical pool ID are not the swap adapter or its tuple argument.
const edge={chainId:1,selector:"0xa88f90c1",poolAddress:"0x000000000004444c5dc75cb358380d2e3de08a90",
  poolId:"0xaf2514683cac32527d88f3d6a113af4df17f07cd53a70833d71ce4f5812cf139",
  tokenIn:"0xdac17f958d2ee523a2206206994597c13d831ec7",tokenOut:"0xd4fa1460f537bb9085d22c7bccb5dd450ef28e3a"};
const modules=GENERATED_PRODUCTION_FAMILY_ENTRIES.map(e=>e.module.selectorFamilyModule);
const source={number:26378389,hash:"0x62b23cae3b410e09f24910f072a94e2a65b68917a91168dda8648e0d5375c618",generation:1};
const actors={executor:"0x"+"12".repeat(20),transactionOrigin:"0x"+"34".repeat(20)};
test("a poolId and token direction do not manufacture calldata, a paid quote, or an execution target",async()=>{
  let reads=0;const forbidden=async()=>{reads++;throw Error("unexpected read");};
  const result=await issueSqlFamilyAlternatives({definition:modules.find(m=>m.definition.selector===edge.selector)!.definition,
    edge,source,...actors,catalog,read:forbidden,readCode:forbidden});
  assert.equal(reads,0);assert.deepEqual(result.alternatives,[]);assert.ok(result.issues.length>0);
  assert.ok(result.issues.every(i=>i.includes("quote-unavailable: recipe needs original call inputs args[0]")));
});
test("address-only recipes cannot consume a shared poolId as the target",async()=>{
  const e={...edge,selector:"0x128acb08"};let reads=0;const forbidden=async()=>{reads++;throw Error("unexpected read");};
  const result=await issueSqlFamilyAlternatives({definition:modules.find(m=>m.definition.selector===e.selector)!.definition,
    edge:e,source,...actors,catalog,read:forbidden,readCode:forbidden});
  assert.equal(reads,0);assert.deepEqual(result.alternatives,[]);
  assert.ok(result.issues.some(i=>i.includes("recipe needs an address-scoped pool; SQL identifies a logical pool")));
});
