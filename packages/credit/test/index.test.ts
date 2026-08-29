import assert from "node:assert/strict";
import test from "node:test";
import { hashDomain } from "../../canonical-codec/src/index.ts";
import { assertCreditObligationSet, makeCreditObligationSet } from "../src/index.ts";

const h = (label: string) => hashDomain("aloha/test/credit", label);
const collateral = "0x1111111111111111111111111111111111111111";
const debt = "0x2222222222222222222222222222222222222222";

test("credit contract binds standing position, repayment, and final safety", () => {
  const obligations = makeCreditObligationSet({
    familyId: "fluid-credit",
    instanceKey: h("instance"),
    positionKey: h("position"),
    collateralAsset: collateral,
    collateralAmount: "1000",
    debtAsset: debt,
    debtAmount: "100",
    actionIntentHash: h("intent"),
    effects: [
      { asset: collateral, account: "executor", delta: "-1000" },
      { asset: debt, account: "executor", delta: "100" },
    ],
  });
  assert.equal(assertCreditObligationSet(obligations).standingPosition.finalSafety, "repayment-and-position-safe");
  assert.equal(obligations.repayment.due, "final-simulation");
  assert.throws(() => assertCreditObligationSet({ ...obligations, obligationRoot: h("tampered") }), /obligation root mismatch/);
  assert.throws(() => assertCreditObligationSet({ ...obligations, standingPosition: { ...obligations.standingPosition, effects: obligations.standingPosition.effects.map((effect, index) => index === 0 ? { ...effect, delta: "-1001" } : effect) } }), /effect binding/);
  assert.throws(() => makeCreditObligationSet({
    familyId: "fluid-credit",
    instanceKey: h("instance"),
    positionKey: h("position"),
    collateralAmount: "1000",
    debtAmount: "100",
    actionIntentHash: h("intent"),
    collateralAsset: collateral,
    debtAsset: collateral,
    effects: [
      { asset: collateral, account: "executor", delta: "-1000" },
      { asset: collateral, account: "executor", delta: "100" },
    ],
  }), /assets must differ/);
});
