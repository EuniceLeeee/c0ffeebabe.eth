import { runBoundaryGate, writeBoundaryMachineReceiptV1 } from "./index.ts";

// npm executes workspace scripts with the workspace directory as cwd.  The
// gate's denominator must always be the repository root derived from this
// file, never that mutable invocation cwd.
const receipt = runBoundaryGate({ requirePushed: true });
writeBoundaryMachineReceiptV1(receipt, (chunk) => process.stdout.write(chunk));
process.exitCode = receipt.verdict === "pass" ? 0 : 1;
