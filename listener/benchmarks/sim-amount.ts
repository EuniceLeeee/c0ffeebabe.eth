// Manual only. The live runHead owns preparation, enumeration and sim sizing.
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { measureLiveHead, runLiveStageBenchmark } from "./live-stage.js";

export const measureSimHead = (input: Omit<Parameters<typeof measureLiveHead>[0], "stage">) =>
  measureLiveHead({ ...input, stage: "sim-amount" });
export const main = (argv = process.argv.slice(2)) => runLiveStageBenchmark("sim-amount", argv);

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main().catch(() => { console.error("sim benchmark failed; inspect local failure.json / input compatibility"); process.exitCode = 1; });
}
