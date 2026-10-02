// Manual only; the same live head scheduler and dispatcher stop at enumeration.
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { runLiveStageBenchmark } from "./live-stage.js";
export const main = (argv = process.argv.slice(2)) => runLiveStageBenchmark("live-enumeration", argv);
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main().catch(() => { console.error("enumeration benchmark failed; inspect local failure.json / input compatibility"); process.exitCode = 1; });
}
