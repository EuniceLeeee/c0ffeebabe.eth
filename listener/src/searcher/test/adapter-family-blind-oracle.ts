import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import {
  BLIND_SCHEMA_VERSION,
  canonicalJson,
  sealBlindOracle,
  type BlindOracle,
} from "./adapter-family-blind-contract.js";

export function buildSealedBlindOracle(
  oracle: BlindOracle,
  salt: string,
): ReturnType<typeof sealBlindOracle> {
  return sealBlindOracle(oracle, salt);
}

function parseArgs(args: readonly string[]): {
  oraclePath: string;
  saltPath: string;
  revealOut: string;
  commitmentOut: string;
} {
  const parsed: Record<string, string> = {};
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (!value) throw new Error(`${name} requires a value`);
    parsed[name ?? ""] = value;
  }
  const oraclePath = parsed["--oracle"];
  const saltPath = parsed["--salt-file"];
  const revealOut = parsed["--reveal-out"];
  const commitmentOut = parsed["--commitment-out"];
  if (!oraclePath || !saltPath || !revealOut || !commitmentOut) {
    throw new Error(
      "usage: --oracle <oracle.json> --salt-file <secret> " +
        "--reveal-out <private.json> --commitment-out <public.json>",
    );
  }
  return { oraclePath, saltPath, revealOut, commitmentOut };
}

function readSalt(path: string): string {
  const raw = readFileSync(path, "utf8").trim();
  if (!raw) throw new Error("oracle salt file is empty");
  try {
    const parsed = JSON.parse(raw) as { salt?: unknown };
    if (typeof parsed.salt === "string" && parsed.salt.length > 0) return parsed.salt;
  } catch {
    // A raw secret file is also accepted; its contents are never printed.
  }
  return raw;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const oracle = JSON.parse(readFileSync(args.oraclePath, "utf8")) as BlindOracle;
  const reveal = buildSealedBlindOracle(oracle, readSalt(args.saltPath));
  writeFileSync(args.revealOut, `${canonicalJson(reveal)}\n`, { mode: 0o600 });
  writeFileSync(args.commitmentOut, `${canonicalJson({
    schemaVersion: BLIND_SCHEMA_VERSION,
    profile: oracle.profile,
    experimentId: oracle.experimentId,
    source: oracle.source,
    commitment: reveal.commitment,
  })}\n`, { mode: 0o644 });
  console.log(`BLIND_ORACLE_COMMITMENT=${reveal.commitment}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
