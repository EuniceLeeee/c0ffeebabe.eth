import assert from "node:assert/strict"; import test from "node:test"; import { PSM_WAD, psmSellQuote } from "../kernel/quote.ts";
test("PSM quote floors fixed-point fee and rejects invalid parameters",()=>{assert.equal(psmSellQuote(1_000_001n,PSM_WAD/1_000n,10n**12n),999_000_999_000_000_000n);assert.equal(psmSellQuote(7n,PSM_WAD,3n),0n);assert.throws(()=>psmSellQuote(1n,PSM_WAD+1n,1n));});
