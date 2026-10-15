import assert from "node:assert/strict";
import test from "node:test";
import { executionData } from "../codec.js";
import { recipientNomination } from "./recipient-nomination.js";
const from="0x1000000000000000000000000000000000000001",to="0x1000000000000000000000000000000000000002",pool="0x5018be882dcce5e3f2f3b0913ae2096b9b3fb61f";
const receipt={status:"0x1",from,to,transactionHash:"0x"+"11".repeat(32),logs:[]};
const call={type:"CALL",from:to,to:pool,input:executionData("exchange",1,0,189392825855902n,1n,to),output:"0x"+"00".repeat(30)+"0bd5"};
function trace(){return {type:"CALL",from,to,calls:[{type:"CALL",from:to,to,error:"execution reverted",revertReason:"Paymaster: postOp token transfer failed",calls:[{...call}]}]};}
test("real observed-call shape remains provenance when ancestor rolled back logs",()=>{const proof=recipientNomination(receipt,pool,trace());assert.equal(proof.kind,"observed-call-nomination");assert.equal(proof.originalPersistentSwapProven,false);assert.equal(proof.calls![0].ancestorReverted,true);assert.deepEqual(proof.calls![0].ancestorErrors,[{path:[0],error:"execution reverted"}]);});
test("wrong transaction root, target and selector cannot supply provenance",()=>{assert.throws(()=>recipientNomination({...receipt,from:pool},pool,trace()));assert.throws(()=>recipientNomination(receipt,from,trace()));const t=trace();t.calls[0].calls[0].input="0x12345678";assert.throws(()=>recipientNomination(receipt,pool,t));});
test("reverted child and zero requested input cannot replace successful observed call",()=>{const t:any=trace();t.calls[0].calls[0].error="execution reverted";assert.throws(()=>recipientNomination(receipt,pool,t));t.calls[0].calls[0]={...call,input:executionData("exchange",1,0,0n,1n,to)};assert.throws(()=>recipientNomination(receipt,pool,t));});
test("noncanonical extra call bytes do not create a nominated pool",()=>{const t=trace();t.calls[0].calls[0].input+="00";assert.throws(()=>recipientNomination(receipt,pool,t));});

import { probeBalance, splitWrappedCalls, assertExecutionModeParity } from "./recipient-observation.js";
test("empty proxy read invalidates only the storage candidate, never means zero", async () => {
  assert.equal(await probeBalance(async () => "0x"), null);
  assert.equal(await probeBalance(async () => "0x" + "0".repeat(64)), 0n);
  assert.equal(await probeBalance(async () => "0x" + "0".repeat(63) + "1"), 1n);
});
test("candidate read cannot suppress malformed ABI or RPC failures", async () => {
  await assert.rejects(probeBalance(async () => "0x01"), /malformed uint256/);
  await assert.rejects(probeBalance(async () => { throw new Error("HTTP 429"); }), /HTTP 429/);
});

test("pool-internal WETH conversion does not impersonate executor asset boundary", () => {
  const wrapped="0x1000000000000000000000000000000000000003";
  const poolDeposit={from:pool,to:wrapped,input:"0xd0e30db0",value:"0x5"};
  const actorDeposit={from:to,to:wrapped,input:"0xd0e30db0",value:"0x0"};
  const actorWithdraw={from:to,to:wrapped,input:"0x2e1a7d4d"+"0".repeat(63)+"1"};
  const out=splitWrappedCalls([poolDeposit,actorDeposit,actorWithdraw],wrapped,to);
  assert.deepEqual(out.internal,[poolDeposit]); assert.deepEqual(out.boundary,[actorDeposit,actorWithdraw]);
});

test("only typed local eth_call EVM revert disproves an injected balance slot", async () => {
  const error=Object.assign(new Error("eth_call execution reverted"),{localCall:true,rpcCode:3,returnData:"0x"});
  assert.equal(await probeBalance(async()=>{throw error;}),null);
  for(const fields of [{localCall:false,rpcCode:3,returnData:"0x"},{localCall:true,rpcCode:-32000,returnData:"0x"},{localCall:true,rpcCode:3,returnData:undefined}])
    await assert.rejects(probeBalance(async()=>{throw Object.assign(new Error("unclassified failure"),fields);}),/unclassified failure/);
});

// Actual native81 row observations; raw SHA e152769bf83508e125b41fafce7c2d88ee1fc2ff46c069044a445782d42182fd.
const retryActual = [
  {
    "amountIn": "2000303179930373",
    "executions": [
      {
        "encoding": "direct-self",
        "status": "pass",
        "balances": [
          {
            "before": "2491790097288204",
            "after": "491486917357832",
            "delta": "-2000303179930372"
          },
          {
            "before": "1999680011505975",
            "after": "3999360023011847",
            "delta": "1999680011505872"
          }
        ],
        "recipientBalances": [
          {
            "before": "133",
            "after": "133",
            "delta": "0"
          },
          {
            "before": "109",
            "after": "109",
            "delta": "0"
          }
        ]
      },
      {
        "encoding": "direct-external",
        "status": "pass",
        "balances": [
          {
            "before": "2491790097288204",
            "after": "491486917357832",
            "delta": "-2000303179930372"
          },
          {
            "before": "1999680011505975",
            "after": "1999680011505975",
            "delta": "0"
          }
        ],
        "recipientBalances": [
          {
            "before": "133",
            "after": "133",
            "delta": "0"
          },
          {
            "before": "109",
            "after": "1999680011505981",
            "delta": "1999680011505872"
          }
        ]
      }
    ]
  },
  {
    "amountIn": "20003031799303730",
    "executions": [
      {
        "encoding": "direct-self",
        "status": "pass",
        "balances": [
          {
            "before": "24917900972880916",
            "after": "4914869173577187",
            "delta": "-20003031799303729"
          },
          {
            "before": "19996800056825298",
            "after": "39993600113650493",
            "delta": "19996800056825195"
          }
        ],
        "recipientBalances": [
          {
            "before": "133",
            "after": "133",
            "delta": "0"
          },
          {
            "before": "109",
            "after": "109",
            "delta": "0"
          }
        ]
      },
      {
        "encoding": "direct-external",
        "status": "pass",
        "balances": [
          {
            "before": "24917900972880916",
            "after": "4914869173577187",
            "delta": "-20003031799303729"
          },
          {
            "before": "19996800056825298",
            "after": "19996800056825298",
            "delta": "0"
          }
        ],
        "recipientBalances": [
          {
            "before": "133",
            "after": "133",
            "delta": "0"
          },
          {
            "before": "109",
            "after": "19996800056825304",
            "delta": "19996800056825195"
          }
        ]
      }
    ]
  }
];
test("actual subset retry compares self delivery only, not the external recipient account", () => {
  for (const sample of retryActual) {
    assert.notDeepEqual(sample.executions[0].balances, sample.executions[1].balances);
    assertExecutionModeParity(sample.executions);
    assertExecutionModeParity([...sample.executions].reverse());
  }
});
test("mode parity keeps normal self equivalence, rejects unknown, duplicate and failed modes", () => {
  const self = retryActual[0].executions[0];
  const rows = ["quoted", "runtime", "direct-self"].map(encoding => ({ ...self, encoding }));
  assertExecutionModeParity(rows);
  assert.throws(() => assertExecutionModeParity([...rows, { ...self, encoding: "runtime" }]));
  assert.throws(() => assertExecutionModeParity([{ ...self, encoding: "other" }]));
  assert.throws(() => assertExecutionModeParity([{ ...self, status: "failed" }]));
  assert.throws(() => assertExecutionModeParity([]));
  const wrong = rows.map(row => structuredClone(row)); wrong[1].balances[1].delta = "0";
  assert.throws(() => assertExecutionModeParity(wrong));
});
