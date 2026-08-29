import assert from "node:assert/strict";
import test from "node:test";
import { hashDomain } from "../../canonical-codec/src/index.ts";
import { assertFundingRepaymentObligation, makeFundingRepaymentObligation } from "../src/index.ts";

const h = (label: string) => hashDomain("aloha/test/funding", label);
const token = "0x1111111111111111111111111111111111111111";

test("funding contract binds same-transaction repayment and effects", () => {
  const obligation = makeFundingRepaymentObligation({
    familyId: "morpho-flash",
    instanceKey: h("instance"),
    lender: token,
    receiver: "0x2222222222222222222222222222222222222222",
    asset: token,
    principal: "100",
    fee: "0",
    actionIntentHash: h("intent"),
    effects: [
      { asset: token, account: "lender", direction: "decrease", amount: "100" },
      { asset: token, account: "executor", direction: "increase", amount: "100" },
      { asset: token, account: "executor", direction: "decrease", amount: "100" },
      { asset: token, account: "lender", direction: "increase", amount: "100" },
    ],
  });
  assert.equal(assertFundingRepaymentObligation(obligation).repayment, "100");
  assert.throws(() => assertFundingRepaymentObligation({ ...obligation, repayment: "101" }), /repayment arithmetic/);
  assert.throws(() => assertFundingRepaymentObligation({ ...obligation, effects: obligation.effects.map((effect, index) => index === 0 ? { ...effect, amount: "101" } : effect) }), /effect binding/);
  assert.throws(() => makeFundingRepaymentObligation({
    familyId: "morpho-flash",
    instanceKey: h("instance"),
    lender: token,
    receiver: "0x2222222222222222222222222222222222222222",
    asset: token,
    principal: "100",
    fee: "0",
    actionIntentHash: h("intent"),
    effects: [
      { asset: token, account: "executor", direction: "decrease", amount: "100" },
      { asset: token, account: "executor", direction: "increase", amount: "100" },
      { asset: token, account: "executor", direction: "decrease", amount: "100" },
      { asset: token, account: "lender", direction: "increase", amount: "100" },
    ],
  }), /effects do not bind/);
});
