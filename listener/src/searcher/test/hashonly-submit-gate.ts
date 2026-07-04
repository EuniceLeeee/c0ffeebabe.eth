import { hashOnlySubmitDecision } from "../main.js";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`FAIL: ${msg}`);
}

function main(): void {
  const cases: Array<{
    label: string;
    rawTx: boolean;
    overlayExact: boolean;
    allowApprox: boolean;
    expected: boolean;
  }> = [
    {
      label: "raw tx submits",
      rawTx: true,
      overlayExact: false,
      allowApprox: false,
      expected: true,
    },
    {
      label: "hash-only exact overlay submits",
      rawTx: false,
      overlayExact: true,
      allowApprox: false,
      expected: true,
    },
    {
      label: "hash-only approximate overlay stays gated",
      rawTx: false,
      overlayExact: false,
      allowApprox: false,
      expected: false,
    },
    {
      label: "hash-only approximate explicit override submits",
      rawTx: false,
      overlayExact: false,
      allowApprox: true,
      expected: true,
    },
  ];

  for (const item of cases) {
    const actual = hashOnlySubmitDecision(item.rawTx, item.overlayExact, item.allowApprox);
    assert(actual === item.expected, `${item.label}: expected ${item.expected}, got ${actual}`);
  }

  console.log("[hashonly-submit-gate] truth table: PASS");
  console.log("expected_transition: hash-only submit gate exact-overlay: skip \u2192 submit; approximate: stays skip");
}

main();
