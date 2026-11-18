import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { transform } from "../listener/node_modules/esbuild/lib/main.js";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { bindSelectorNativeMath } from "../listener/src/searcher/venues/selector-native-math.js";

async function main() {
const base = process.argv[process.argv.indexOf("--base-source-root") + 1];
if (!process.argv.includes("--base-source-root") || !base) throw new Error("--base-source-root required");
const root = resolve(import.meta.dirname, ".."), require = createRequire(resolve(root, "listener/package.json"));
const source = readFileSync(resolve(base, "listener/src/searcher/venues/credit/fluid-family/math.ts"), "utf8")
  .replace('from "ethers"', `from ${JSON.stringify(pathToFileURL(require.resolve("ethers")).href)}`);
const compiled = await transform(source, { loader: "ts", format: "esm", target: "es2022" });
const old = (await import(`data:text/javascript;base64,${Buffer.from(compiled.code).toString("base64")}`)).fluidCreditMathModels as any[];
const native = JSON.parse(readFileSync(resolve(root, "listener/src/searcher/venues/selector-native/selector-032d2276-family/selector-032d2276.json"), "utf8"));
const models = bindSelectorNativeMath(native.math), rows: any[] = [];
const clean = (value: any): any => typeof value === "bigint" ? value.toString() : Array.isArray(value) ? value.map(clean)
  : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clean(item)])) : value;
function outcome(run: () => any) { try { return { result: clean(run()) }; } catch { return { rejected: true }; } }
function compare(name: string, input: bigint[]) {
  const id = native.math.entries[name].model, prior = old.find(model => model.id === id)!;
  const expected = outcome(() => { prior.validateInput(input); const result = prior.evaluate(input); prior.validateOutput(result); return result; });
  const actual = outcome(() => models[name]!(input));
  assert.deepEqual(actual, expected, `${name} ${input.join(",")}`);
  rows.push({ model: name, input: input.map(String), ...expected });
}
for (const amount of [10000n, 10001n, 1000000n, 10n ** 18n, 10n ** 28n, (1n << 127n) - 1n])
  for (const fee of [0n, 20n, 1023n]) for (const fraction of [8500n, 9500n, 10000n])
    compare("maxBorrow", [amount, 10n ** 27n, 8000n, fee, 10n ** 12n, 10n ** 12n, fraction]);
for (const oracle of [10n ** 9n, 10n ** 15n, 10n ** 21n, 10n ** 33n, 10n ** 39n, 10n ** 45n, 10n ** 54n])
  for (const cf of [1n, 5000n, 10000n]) compare("maxBorrow", [10n ** 24n, oracle, cf, 3n, 1234567890123n, 1987654321098n, 10000n]);
for (const [index, value] of [[0, 9999n], [0, 1n << 127n], [1, 999999999n], [1, 10n ** 54n + 1n], [2, 0n], [2, 10001n], [3, 1024n], [4, 0n], [5, 0n], [6, 0n], [6, 10001n]] as const) {
  const inputs = [1000000n, 10n ** 27n, 8000n, 20n, 10n ** 12n, 10n ** 12n, 10000n]; inputs[index] = value; compare("maxBorrow", inputs);
}
for (const oracle of [0n, 17n, (1n << 160n) - 1n]) for (const cf of [0n, 1n, 800n, 1000n, 1023n])
  for (const fee of [0n, 20n, 1023n]) compare("configState", [(oracle << 96n) | (cf << 32n) | (fee << 82n)]);
const report = { base: "fdb859a9b9b606a38c3b7afa52452752849ee465", source: "credit/fluid-family/math.ts", rows };
writeFileSync(resolve(root, "listener/src/searcher/test/fixtures/selector-credit-v2-math.json"), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ cases: rows.length, successful: rows.filter(row => !row.rejected).length, rejected: rows.filter(row => row.rejected).length }));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
