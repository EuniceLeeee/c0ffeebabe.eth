import { runBoundaryGate, writeReceipt } from "./index.ts";

// npm executes workspace scripts with the workspace directory as cwd.  The
// gate's denominator must always be the repository root derived from this
// file, never that mutable invocation cwd.
const receipt = runBoundaryGate({ requirePushed: true });
let output = "";
writeReceipt(receipt, (chunk) => {
  output += chunk;
  if (output.length >= 64 * 1024) {
    process.stdout.write(output);
    output = "";
  }
});
if (output.length > 0) process.stdout.write(output);
process.exitCode = receipt.verdict === "pass" ? 0 : 1;
