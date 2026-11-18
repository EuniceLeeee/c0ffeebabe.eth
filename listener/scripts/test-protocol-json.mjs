// Common offline contract suite. Swap/Protocol migrations supply JSON/math and case
// data; they do not supply a replacement acceptance runner or assertion code.
import { existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = fileURLToPath(new URL("../", import.meta.url));
const directory = "src/searcher/test";
const shared = readdirSync(new URL("../src/searcher/test/", import.meta.url))
  .filter(name => /^(declarative-.*|protocol-json-.*|swap-json-.*|family-transaction-.*|family-evidence-.*|family-credit-.*|family-funding-.*|family-node-.*|family-discovery-.*|ready-proof-simulation|node-simulate-v1|selector-native-.*|selector-family-v2-.*|selector-typed-.*|selector-execution-(?:keys|observation)|ready-selector-.*|effective-.*|main-startup-execution-verification|node-trace-policy)\.test\.ts$/.test(name))
  .sort()
  .map(name => `${directory}/${name}`);
// Preserve existing shared contracts. scripts/test-family.mjs runs this suite
// before the all-domain installed-catalog transaction facts.
const preserved = ["node-rpc-simulation.ts", "settlement-registrar-evidence.test.ts",
  "declarative-callback-frames.ts", "funding-credit-family-plugin.ts",
  "blockscan-at-block-cli.ts", "strict-execution-projection.ts", "revm-canonical-anchor.ts"];
const files = [...shared, ...preserved.map(name => `${directory}/${name}`)];
const missing = files.filter(file => !existsSync(new URL(`../${file}`, import.meta.url)));
if (missing.length) throw new Error(`offline test inputs are missing: ${missing.join(", ")}`);
const args = process.argv.slice(2);
if (args.length !== 0 && (args.length !== 2 || args[0] !== "--activation-report" || !args[1]))
  throw new Error("expected --activation-report PATH");
const reporters = args.length === 0 ? [] : [
  "--test-reporter=spec", "--test-reporter-destination=stdout",
  "--test-reporter=./scripts/test-family-activation-report.mjs", `--test-reporter-destination=${args[1]}`,
];
const result = spawnSync(process.execPath,
  ["--import", "tsx", "--test", "--test-concurrency=1", ...reporters, ...files],
  { cwd: root, env: process.env, stdio: "inherit" });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
