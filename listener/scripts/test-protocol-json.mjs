// Common offline contract suite. Swap/Protocol migrations supply JSON/math and case
// data; they do not supply a replacement acceptance runner or assertion code.
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = fileURLToPath(new URL("../", import.meta.url));
const directory = "src/searcher/test";
const shared = readdirSync(new URL("../src/searcher/test/", import.meta.url))
  .filter(name => /^(declarative-.*|protocol-json-.*|swap-json-.*)\.test\.ts$/.test(name))
  .sort()
  .map(name => `${directory}/${name}`);
// The all-domain installed-family fixture audit remains a separate existing
// audit. It also covers swaps, credit and disabled entries outside this suite.
const preserved = ["erc4626-declarative-pipeline.ts",
  "settlement-registrar-evidence.test.ts", "family-settlement-review-contract.ts", "adapter-credit-runtime.ts", "capability-content-hash.ts", "declarative-callback-frames.ts"];
const files = [...shared, ...preserved.map(name => `${directory}/${name}`)];
const result = spawnSync(process.execPath,
  ["--import", "tsx", "--test", "--test-concurrency=1", ...files],
  { cwd: root, env: process.env, stdio: "inherit" });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
