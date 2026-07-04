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
    allowHashOnlyMevShareSubmit: boolean;
    expected: boolean;
  }> = [
    {
      label: "raw tx submits",
      rawTx: true,
      overlayExact: false,
      allowApprox: false,
      allowHashOnlyMevShareSubmit: false,
      expected: true,
    },
    {
      label: "hash-only exact overlay default gated",
      rawTx: false,
      overlayExact: true,
      allowApprox: false,
      allowHashOnlyMevShareSubmit: false,
      expected: false,
    },
    {
      label: "hash-only exact overlay opt-in submits",
      rawTx: false,
      overlayExact: true,
      allowApprox: false,
      allowHashOnlyMevShareSubmit: true,
      expected: true,
    },
    {
      label: "hash-only approximate overlay stays gated",
      rawTx: false,
      overlayExact: false,
      allowApprox: false,
      allowHashOnlyMevShareSubmit: false,
      expected: false,
    },
    {
      label: "hash-only approximate explicit override submits",
      rawTx: false,
      overlayExact: false,
      allowApprox: true,
      allowHashOnlyMevShareSubmit: false,
      expected: true,
    },
  ];

  for (const item of cases) {
    const actual = hashOnlySubmitDecision(
      item.rawTx,
      item.overlayExact,
      item.allowApprox,
      item.allowHashOnlyMevShareSubmit,
    );
    assert(actual === item.expected, `${item.label}: expected ${item.expected}, got ${actual}`);
  }

  console.log("[hashonly-submit-gate] truth table: PASS");
  console.log(
    "expected_transition: hash-only exact-overlay submit true\u2192false (default); opt-in stays true",
  );
}

main();
