import { formatReceipt, runBoundaryGate } from "./index.ts";

// npm executes workspace scripts with the workspace directory as cwd.  The
// gate's denominator must always be the repository root derived from this
// file, never that mutable invocation cwd.
const receipt = runBoundaryGate({ requirePushed: true });
process.stdout.write(formatReceipt(receipt));
process.exitCode = receipt.verdict === "pass" ? 0 : 1;
