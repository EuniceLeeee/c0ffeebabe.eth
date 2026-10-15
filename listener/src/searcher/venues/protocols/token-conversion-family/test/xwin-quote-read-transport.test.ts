import assert from "node:assert/strict";
import test from "node:test";
import { options, assertPinnedQuoteRead } from "../../../../test/family-integration/kyber-yb-compound/evidence.js";
import { assertNoSecretBearingToolArgs } from "../../../../../../../analysis/src/tool-run-security.js";
const args=["--family","xwin-mint","--ready","r","--prices","p","--port","18961","--out","o"],hash="0x"+"11".repeat(32),pin={blockHash:hash,requireCanonical:true},address="0x"+"12".repeat(20),tx={to:address,data:"0x12345678"};
test("quote reads default to fork and canonical upstream is an explicit bounded option",()=>{assert.equal(options(args).quoteReadRpc,"fork");assert.equal(options([...args,"--quote-read-transport","upstream"]).quoteReadRpc,"upstream");assert.throws(()=>options([...args,"--quote-read-transport","https://example.invalid"]));assert.throws(()=>options([...args,"--quote-read-transport","upstream","--quote-read-transport","fork"]));});
test("canonical read provider admits only hash-bound call/code/storage with no writes",()=>{
 assertPinnedQuoteRead("eth_call",[tx,pin,{}],hash);assertPinnedQuoteRead("eth_getCode",[address,pin],hash);assertPinnedQuoteRead("eth_getStorageAt",[address,"0x00",pin],hash);
 for(const method of ["debug_traceCall","eth_sendTransaction","anvil_reset","eth_estimateGas"])assert.throws(()=>assertPinnedQuoteRead(method,[tx,pin,{}],hash));
 for(const bad of ["latest",1,{blockHash:hash},{blockHash:"0x"+"22".repeat(32),requireCanonical:true}])assert.throws(()=>assertPinnedQuoteRead("eth_call",[tx,bad,{}],hash));
 assert.throws(()=>assertPinnedQuoteRead("eth_call",[{...tx,value:"0x1"},pin,{}],hash));assert.throws(()=>assertPinnedQuoteRead("eth_call",[{...tx,blockTag:1},pin,{}],hash));
});

test("public transport enum works through canonical argv security and the old RPC name remains rejected",()=>{
 for(const mode of ["fork","upstream"]){const argv=[...args,"--quote-read-transport",mode];assertNoSecretBearingToolArgs(argv);assert.equal(options(argv).quoteReadRpc,mode);}
 assert.throws(()=>options([...args,"--quote-read-rpc","upstream"]));assert.throws(()=>assertNoSecretBearingToolArgs([...args,"--quote-read-rpc","upstream"]));
 assert.throws(()=>assertNoSecretBearingToolArgs([...args,"--quote-read-transport","https://example.invalid"]));
});
