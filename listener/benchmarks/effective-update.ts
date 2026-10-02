// Manual only. Dispatch and policies live in the production runtime.
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { measureLiveHead, runLiveStageBenchmark } from "./live-stage.js";
export { parseHeads, assertEffectivePublication, withoutProductionConsole } from "./live-stage.js";

export const measureEffectiveHead = (input: Omit<Parameters<typeof measureLiveHead>[0], "stage">) =>
  measureLiveHead({ ...input, stage: "effective-update" });
export const main = (argv = process.argv.slice(2)) => runLiveStageBenchmark("effective-update", argv);

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main().catch(() => { console.error("effective benchmark failed; inspect local failure.json / input compatibility"); process.exitCode = 1; });
}
