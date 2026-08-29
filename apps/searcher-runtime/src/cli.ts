import {
  assertDirectCliNonProductionV1,
  startDryRunServiceV1,
} from "./deployment.ts";

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) throw new TypeError(`missing ${name}`);
  return value;
}

async function main(): Promise<void> {
  if (process.env.SEARCHER_DRY_RUN !== "1") throw new TypeError("runtime dry-run guard requires SEARCHER_DRY_RUN=1");
  if (process.env.PRIVATE_KEY !== undefined || process.env.OWNER_PRIVATE_KEY !== undefined) {
    throw new TypeError("credential environment is not accepted");
  }
  const manifestPath = required("SEARCHER_RUNTIME_MANIFEST_PATH");
  if (!manifestPath.startsWith("/")) throw new TypeError("deployment manifest path must be absolute");
  const loaderPath = required("SEARCHER_RUNTIME_BUNDLE_MODULE");
  assertDirectCliNonProductionV1({ manifestPath, bundleModulePath: loaderPath });
  const service = await startDryRunServiceV1({ manifestPath, bundleModulePath: loaderPath });
  const stop = () => { void service.stop(); };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  try {
    await service.done;
  } finally {
    process.removeListener("SIGTERM", stop);
    process.removeListener("SIGINT", stop);
  }
}

main().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
