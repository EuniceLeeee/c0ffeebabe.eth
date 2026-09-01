import {
  startRuntimeServiceV1,
} from "./deployment.ts";

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) throw new TypeError(`missing ${name}`);
  return value;
}

async function main(): Promise<void> {
  const service = await startRuntimeServiceV1({
    sourceConfigPath: required("SEARCHER_RUNTIME_SOURCE_CONFIG_PATH"),
    policyPath: required("SEARCHER_RUNTIME_POLICY_PATH"),
    revmWorkerExecutablePath: required("SEARCHER_REVM_WORKER_PATH"),
    rpcEndpoint: required("MAINNET_RPC_URL"),
  });
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

function formatError(error: unknown): string {
  if (error instanceof AggregateError) {
    return [
      error.message,
      ...error.errors.map((nested, index) => `[${index + 1}] ${formatError(nested)}`),
    ].join("\n");
  }
  return error instanceof Error ? (error.stack ?? error.message) : String(error);
}

main().catch(error => {
  process.stderr.write(`${formatError(error)}\n`);
  process.exitCode = 1;
});
