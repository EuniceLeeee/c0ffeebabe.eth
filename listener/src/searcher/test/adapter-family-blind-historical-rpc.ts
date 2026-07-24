import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import { canonicalJson } from "./adapter-family-blind-contract.js";
import {
  FrozenBlindHistoricalRpcServer,
  loadBlindHistoricalPrewarmPlan,
  loadBlindHistoricalRpcCache,
  materializeBlindHistoricalRpcCache,
} from "./adapter-family-blind-content-addressed-rpc.js";

const READY_PREFIX = "BLIND_HISTORICAL_RPC_READY=";

type Command =
  | {
      readonly kind: "materialize";
      readonly planPath: string;
      readonly outDir: string;
      readonly archiveEnv: string;
      readonly timeoutMs: number;
    }
  | {
      readonly kind: "serve";
      readonly manifestPath: string;
      readonly host: string;
      readonly port: number;
    }
  | {
      readonly kind: "inspect";
      readonly manifestPath: string;
    };

async function main(): Promise<void> {
  const command = parseArgs(process.argv.slice(2));
  if (command.kind === "materialize") {
    const archiveRpcUrl = process.env[command.archiveEnv];
    assert(
      typeof archiveRpcUrl === "string" && archiveRpcUrl.length > 0,
      `archive RPC environment ${command.archiveEnv} is unset`,
    );
    const plan = loadBlindHistoricalPrewarmPlan(command.planPath);
    const manifest = await materializeBlindHistoricalRpcCache({
      plan,
      archiveRpcUrl,
      outDir: command.outDir,
      timeoutMs: command.timeoutMs,
    });
    process.stdout.write(`${canonicalJson({
      kind: "materialized",
      outDir: command.outDir,
      base: manifest.base,
      source: manifest.source,
      planSha256: manifest.planSha256,
      descriptorSetSha256: manifest.descriptorSetSha256,
      exporterImplementationSha256:
        manifest.exporterImplementationSha256,
      exporterSourceClosureSha256:
        manifest.exporterSourceClosureSha256,
      exporterRequirementSetSha256:
        plan.exporter.requirementSetSha256,
      entries: manifest.entries.length,
      contentSha256: manifest.contentSha256,
    })}\n`);
    return;
  }

  const loaded = loadBlindHistoricalRpcCache(command.manifestPath);
  if (command.kind === "inspect") {
    process.stdout.write(`${canonicalJson({
      kind: "frozen",
      manifestSha256: loaded.manifestSha256,
      contentSha256: loaded.manifest.contentSha256,
      planSha256: loaded.manifest.planSha256,
      descriptorSetSha256: loaded.manifest.descriptorSetSha256,
      exporterImplementationSha256:
        loaded.manifest.exporterImplementationSha256,
      exporterSourceClosureSha256:
        loaded.manifest.exporterSourceClosureSha256,
      exporterRequirementSetSha256:
        loaded.plan.exporter.requirementSetSha256,
      base: loaded.manifest.base,
      source: loaded.manifest.source,
      entries: loaded.manifest.entries.length,
      descriptorCoverage: loaded.plan.descriptorCoverage,
    })}\n`);
    return;
  }

  const server = new FrozenBlindHistoricalRpcServer(
    loaded,
    command.host,
    command.port,
  );
  const rpcUrl = await server.start();
  process.stdout.write(`${READY_PREFIX}${canonicalJson({
    rpcUrl,
    pid: process.pid,
    manifestSha256: loaded.manifestSha256,
    contentSha256: loaded.manifest.contentSha256,
    base: loaded.manifest.base,
    source: loaded.manifest.source,
  })}\n`);
  const close = async (): Promise<void> => {
    await server.close();
    process.exit(0);
  };
  process.once("SIGINT", () => void close());
  process.once("SIGTERM", () => void close());
}

function parseArgs(args: readonly string[]): Command {
  const kind = args[0];
  assert(
    kind === "materialize" || kind === "serve" || kind === "inspect",
    "usage: materialize|serve|inspect [options]",
  );
  const values = new Map<string, string>();
  for (let index = 1; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    assert(name?.startsWith("--") && value !== undefined, `${name} requires a value`);
    assert(!values.has(name), `duplicate argument ${name}`);
    values.set(name, value);
  }
  if (kind === "materialize") {
    assertOnly(values, [
      "--archive-env",
      "--out",
      "--plan",
      "--timeout-ms",
    ]);
    const planPath = requiredAbsolute(values, "--plan");
    const outDir = requiredAbsolute(values, "--out");
    const archiveEnv = values.get("--archive-env") ??
      "BLIND_ARCHIVE_RPC_URL";
    assert(
      /^[A-Z][A-Z0-9_]*$/.test(archiveEnv),
      "archive environment name",
    );
    const timeoutMs = Number(values.get("--timeout-ms") ?? "30000");
    assert(
      Number.isSafeInteger(timeoutMs) && timeoutMs > 0,
      "materialization timeout",
    );
    return {
      kind,
      planPath,
      outDir,
      archiveEnv,
      timeoutMs,
    };
  }
  assertOnly(values, [
    "--host",
    "--manifest",
    "--port",
  ]);
  const manifestPath = requiredAbsolute(values, "--manifest");
  if (kind === "inspect") {
    assert(
      !values.has("--host") && !values.has("--port"),
      "inspect does not accept server options",
    );
    return { kind, manifestPath };
  }
  const host = values.get("--host") ?? "127.0.0.1";
  assert(
    host === "127.0.0.1" || host === "::1" || host === "localhost",
    "frozen RPC host must be loopback",
  );
  const port = Number(values.get("--port") ?? "0");
  assert(
    Number.isSafeInteger(port) && port >= 0 && port <= 65_535,
    "frozen RPC port",
  );
  return { kind, manifestPath, host, port };
}

function requiredAbsolute(
  values: ReadonlyMap<string, string>,
  name: string,
): string {
  const value = values.get(name);
  assert(value && isAbsolute(value), `${name} absolute path is required`);
  return value;
}

function assertOnly(
  values: ReadonlyMap<string, string>,
  allowed: readonly string[],
): void {
  for (const name of values.keys()) {
    assert(allowed.includes(name), `unknown argument ${name}`);
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
