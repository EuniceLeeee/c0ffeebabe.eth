import { readdir, readFile, stat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, writeText } from "../util.js";

type Profile = "review" | "public";

type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

type RedactOptions = {
  profile: Profile;
  repoRoot: string;
  redactOnchain: boolean;
  redactTimestamps: boolean;
  sensitiveValues: SensitiveValue[];
};

type EventStats = {
  rows: number;
  invalidRows: number;
  typeCounts: Map<string, number>;
  blocks: number[];
  dropCounts: Map<string, number>;
};

type SensitiveValue = {
  value: string;
  redaction: string;
};

const repoRoot = resolve(fileURLToPath(new URL("../../../", import.meta.url)));
const analysisDir = join(repoRoot, "analysis");
const defaultReportsDir = join(repoRoot, "docs", "research", "reports");

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const profile = readProfile(args.profile);
  const options: RedactOptions = {
    profile,
    repoRoot,
    redactOnchain: readBool(args["redact-onchain"], false),
    redactTimestamps: readBool(args["redact-timestamps"], false),
    sensitiveValues: [],
  };

  const logPath =
    readString(args.log) ?? (await latestFile("/tmp", /^mev-live-.+\.log$/));
  const eventsPath =
    readString(args.events) ??
    (await latestFile(join(analysisDir, "events"), /^searcher-.+\.jsonl$/).catch(
      () => undefined,
    ));
  const outDir = resolve(readString(args["out-dir"]) ?? defaultReportsDir);
  const label = readString(args.label) ?? deriveLabel(logPath, eventsPath);

  const rawLog = await readFile(logPath, "utf8");
  options.sensitiveValues = collectSensitiveValues(rawLog);
  const redactedLog = redactText(rawLog, options);

  let eventStats: EventStats | undefined;
  let redactedEvents = "";
  if (eventsPath) {
    const eventResult = await redactEvents(eventsPath, options);
    eventStats = eventResult.stats;
    redactedEvents = eventResult.redactedJsonl;
  }

  const logReportName = `${label}-redacted.log`;
  const eventReportName = `${label}-events.redacted.jsonl`;
  const summaryReportName = `${label}-summary.md`;

  await writeText(join(outDir, logReportName), redactedLog);
  if (eventsPath) await writeText(join(outDir, eventReportName), redactedEvents);
  await writeText(
    join(outDir, summaryReportName),
    renderSummary({
      label,
      logPath,
      eventsPath,
      profile,
      logReportName,
      eventReportName: eventsPath ? eventReportName : undefined,
      redactedLog,
      eventStats,
    }),
  );

  console.log(`[redact-live-run] wrote ${join(outDir, summaryReportName)}`);
  console.log(`[redact-live-run] wrote ${join(outDir, logReportName)}`);
  if (eventsPath) console.log(`[redact-live-run] wrote ${join(outDir, eventReportName)}`);
}

function readString(value: string | boolean | undefined): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readProfile(value: string | boolean | undefined): Profile {
  if (value === undefined || value === true) return "review";
  if (value === "review" || value === "public") return value;
  throw new Error(`--profile must be review or public, got ${value}`);
}

function readBool(value: string | boolean | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (typeof value === "boolean") return value;
  return !["0", "false", "no", "off"].includes(value.toLowerCase());
}

async function latestFile(dir: string, pattern: RegExp): Promise<string> {
  const entries = await readdir(dir);
  const candidates = await Promise.all(
    entries
      .filter((entry) => pattern.test(entry))
      .map(async (entry) => {
        const path = join(dir, entry);
        const info = await stat(path);
        return { path, mtimeMs: info.mtimeMs };
      }),
  );
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const latest = candidates[0];
  if (!latest) throw new Error(`No files matching ${pattern} in ${dir}`);
  return latest.path;
}

function deriveLabel(logPath: string, eventsPath?: string): string {
  const fromLog = basename(logPath).match(/^mev-live-(\d{8})(?:-(\d{6}))?\.log$/);
  if (fromLog) return `live-run-${fromLog[1]}${fromLog[2] ? `-${fromLog[2]}` : ""}`;

  if (eventsPath) {
    const fromEvents = basename(eventsPath).match(/^searcher-(\d{8})(?:-(\d{6}))?\.jsonl$/);
    if (fromEvents) {
      return `live-run-${fromEvents[1]}${fromEvents[2] ? `-${fromEvents[2]}` : ""}`;
    }
  }

  const today = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  return `live-run-${today}`;
}

function redactText(input: string, options: RedactOptions): string {
  let out = input;

  for (const item of options.sensitiveValues) {
    out = out.replace(new RegExp(`\\b${escapeRegExp(item.value)}\\b`, "gi"), item.redaction);
  }

  out = out.replace(
    /\bwss:\/\/eth-mainnet\.g\.alchemy\.com\/v2\/[^\s"'`<>]+/gi,
    "wss://eth-mainnet.g.alchemy.com/v2/<REDACTED_ALCHEMY_KEY>",
  );
  out = out.replace(
    /\bhttps:\/\/eth-mainnet\.g\.alchemy\.com\/v2\/[^\s"'`<>]+/gi,
    "https://eth-mainnet.g.alchemy.com/v2/<REDACTED_ALCHEMY_KEY>",
  );
  out = out.replace(
    /([?&](?:api[_-]?key|key|token|auth|access_token)=)[^&\s"'`<>]+/gi,
    "$1<REDACTED>",
  );
  out = out.replace(
    /\b([A-Z0-9_]*(?:PRIVATE_KEY|SECRET|API_KEY|AUTH_KEY|MNEMONIC|SEED|RPC_URL|WS_URL|ALCHEMY|INFURA|TENDERLY)[A-Z0-9_]*)=("[^"]*"|'[^']*'|[^\s]+)/g,
    "$1=<REDACTED>",
  );
  out = out.replace(/\b(wallet)=0x[a-fA-F0-9]{40}\b/g, "$1=<REDACTED_WALLET>");
  out = out.replace(/\b(botvm)=0x[a-fA-F0-9]{40}\b/g, "$1=<REDACTED_BOTVM>");
  out = out.replace(
    /\b(builder|relay)=https?:\/\/[^\s"'`<>]+/gi,
    "$1=<REDACTED_URL>",
  );
  out = out.replace(
    /\b(builder|relay)=wss?:\/\/[^\s"'`<>]+/gi,
    "$1=<REDACTED_URL>",
  );
  out = out.replace(new RegExp(escapeRegExp(options.repoRoot), "g"), "<REPO_PATH>");
  out = out.replace(/\/Users\/eunice\/src\/MEV/g, "<REPO_PATH>");
  out = out.replace(/\/Users\/eunice\/[^\s"'`<>]+/g, "<USER_PATH>");
  out = out.replace(/\/tmp\/mev-live-[^\s"'`<>]+\.log/g, "<TMP_LIVE_LOG>");
  out = out.replace(/\b0x[a-fA-F0-9]{128,}\b/g, (value) => {
    return `<REDACTED_HEX_BLOB:${value.length - 2}hex>`;
  });

  if (options.redactTimestamps) {
    out = out.replace(
      /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\b/g,
      "<TIMESTAMP>",
    );
    out = out.replace(/\b1[6-9]\d{11}\b/g, "<MS_TIMESTAMP>");
  }

  if (options.redactOnchain) out = redactOnchainIdentifiers(out);
  return out;
}

function collectSensitiveValues(input: string): SensitiveValue[] {
  const values: SensitiveValue[] = [];
  for (const match of input.matchAll(/\b(wallet|botvm)=((?:0x)[a-fA-F0-9]{40})\b/g)) {
    values.push({
      value: match[2],
      redaction: match[1].toLowerCase() === "wallet" ? "<REDACTED_WALLET>" : "<REDACTED_BOTVM>",
    });
  }

  const seen = new Set<string>();
  return values.filter((item) => {
    const key = item.value.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function redactOnchainIdentifiers(input: string): string {
  return input
    .replace(/\b0x[a-fA-F0-9]{64}\b/g, shortenHex)
    .replace(/\b0x[a-fA-F0-9]{40}\b/g, shortenHex);
}

function shortenHex(value: string): string {
  return `${value.slice(0, 10)}...${value.slice(-6)}`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function redactEvents(
  eventsPath: string,
  options: RedactOptions,
): Promise<{ redactedJsonl: string; stats: EventStats }> {
  const raw = await readFile(eventsPath, "utf8");
  const stats: EventStats = {
    rows: 0,
    invalidRows: 0,
    typeCounts: new Map(),
    blocks: [],
    dropCounts: new Map(),
  };
  const output: string[] = [];

  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    stats.rows++;
    try {
      const parsed = JSON.parse(line) as JsonValue;
      collectEventStats(parsed, stats);
      output.push(JSON.stringify(redactJsonValue(parsed, options)));
    } catch {
      stats.invalidRows++;
      output.push(redactText(line, options));
    }
  }

  return {
    redactedJsonl: output.length > 0 ? `${output.join("\n")}\n` : "",
    stats,
  };
}

function collectEventStats(value: JsonValue, stats: EventStats): void {
  if (!isRecord(value)) return;
  const type = typeof value.type === "string" ? value.type : "unknown";
  addCount(stats.typeCounts, type);

  const block = numberLike(value.target_block ?? value.block);
  if (block !== undefined) stats.blocks.push(block);

  if (type === "pipeline_dropped") {
    const stage = typeof value.stage === "string" ? value.stage : "unknown";
    const reason = typeof value.reason === "string" ? value.reason : "unknown";
    addCount(stats.dropCounts, `${stage}/${reason}`);
  }
}

function numberLike(value: JsonValue | undefined): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && /^\d+$/.test(value)) return Number(value);
  return undefined;
}

function addCount(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function redactJsonValue(value: JsonValue, options: RedactOptions, key = ""): JsonValue {
  if (value === null || typeof value === "boolean" || typeof value === "number") {
    if (key === "emitted_at_ms" && options.redactTimestamps) return "<MS_TIMESTAMP>";
    return value;
  }
  if (typeof value === "string") {
    if (shouldRedactJsonString(key, value)) return redactionForKey(key);
    return redactText(value, options);
  }
  if (Array.isArray(value)) return value.map((item) => redactJsonValue(item, options, key));

  const out: { [key: string]: JsonValue } = {};
  for (const [childKey, childValue] of Object.entries(value)) {
    if (shouldRedactJsonKey(childKey)) {
      out[childKey] = redactionForKey(childKey);
    } else {
      out[childKey] = redactJsonValue(childValue, options, childKey);
    }
  }
  return out;
}

function shouldRedactJsonKey(key: string): boolean {
  const lower = key.toLowerCase();
  if (lower.endsWith("_hash") || lower === "tx_hash" || lower === "victim_hash") return false;
  if (lower === "wallet" || lower === "botvm" || lower === "builder" || lower === "relay") {
    return true;
  }
  return /(?:privatekey|private_key|secret|mnemonic|seed|rpcurl|rpc_url|wsurl|ws_url|apikey|api_key|authkey|auth_key|rawtx|raw_tx|signedtx|signed_tx|calldata|signature)/.test(
    lower,
  );
}

function shouldRedactJsonString(key: string, value: string): boolean {
  const lower = key.toLowerCase();
  if ((lower.includes("url") || lower.includes("endpoint")) && /\/v2\/[A-Za-z0-9_-]+/.test(value)) {
    return true;
  }
  if (lower === "wallet" || lower === "botvm") return /^0x[a-fA-F0-9]{40}$/.test(value);
  return false;
}

function redactionForKey(key: string): string {
  const normalized = key.replace(/[^a-zA-Z0-9]+/g, "_").toUpperCase();
  return `<REDACTED_${normalized || "VALUE"}>`;
}

function isRecord(value: JsonValue): value is { [key: string]: JsonValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function renderSummary(input: {
  label: string;
  logPath: string;
  eventsPath?: string;
  profile: Profile;
  logReportName: string;
  eventReportName?: string;
  redactedLog: string;
  eventStats?: EventStats;
}): string {
  const startupFacts = extractStartupFacts(input.redactedLog);
  const lastCounters = extractLastCounters(input.redactedLog);
  const timings = uniqueMatches(
    input.redactedLog.match(/match=\d+ms fork=\d+ms prep=\d+ms detect=\d+ms total=\d+ms/g) ?? [],
  ).slice(-12);
  const observations = buildObservations(input.redactedLog, lastCounters, input.eventStats);

  return [
    `# ${input.label} Redacted Live Run`,
    "",
    "This file is generated by `npm run redact-live-run`. The redacted log and JSONL are the source of truth; this summary is only an index plus mechanical counters.",
    "",
    "## Files",
    "",
    `- profile: \`${input.profile}\``,
    `- log: \`${input.logReportName}\``,
    input.eventReportName ? `- events: \`${input.eventReportName}\`` : "- events: not supplied",
    `- source log: \`${redactText(input.logPath, { profile: input.profile, repoRoot, redactOnchain: false, redactTimestamps: false, sensitiveValues: [] })}\``,
    input.eventsPath
      ? `- source events: \`${redactText(input.eventsPath, { profile: input.profile, repoRoot, redactOnchain: false, redactTimestamps: false, sensitiveValues: [] })}\``
      : "",
    "",
    "## Redaction Profile",
    "",
    profileDescription(input.profile),
    "",
    "## Startup Facts",
    "",
    bulletList(startupFacts, "No matching startup lines found."),
    "",
    "## Event Counters",
    "",
    renderEventStats(input.eventStats),
    "",
    "## Searcher Counters",
    "",
    lastCounters ? `- last counters: \`${lastCounters}\`` : "- last counters: not found",
    "",
    "## Pipeline Drops",
    "",
    renderDropStats(input.eventStats),
    "",
    "## Representative Timings",
    "",
    bulletList(timings.map((line) => `\`${line}\``), "No detector timing samples found."),
    "",
    "## Mechanical Observations",
    "",
    bulletList(observations, "No observations generated."),
    "",
  ]
    .filter((line) => line !== "")
    .join("\n");
}

function profileDescription(profile: Profile): string {
  void profile;
  return [
    "- Secrets, RPC URLs, local paths, wallet/BotVM, raw calldata, and private configuration are redacted.",
    "- Public on-chain addresses and tx/pool/token hashes are preserved because they are required evidence for review accuracy.",
    "- Use `--redact-onchain` only for a deliberately less replayable artifact.",
  ].join("\n");
}

function extractStartupFacts(log: string): string[] {
  const needles = [
    "mempool=",
    "liveBackend=",
    "stateUpdater=",
    "solverDeadlineMs=",
    "mempool filtered subscription",
    "mempool WS connected filteredSub=",
  ];
  return uniqueMatches(
    log
      .split(/\r?\n/)
      .filter((line) => line.includes("[searcher/live]"))
      .filter((line) => needles.some((needle) => line.includes(needle)))
      .map((line) => `\`${line}\``),
  );
}

function extractLastCounters(log: string): string | undefined {
  const lines = log.match(/\[searcher\/live\] counters .*/g) ?? [];
  const last = lines[lines.length - 1];
  return last?.replace(/^.* counters /, "");
}

function renderEventStats(stats?: EventStats): string {
  if (!stats) return "- events: not supplied";
  const blocks = stats.blocks;
  const blockRange =
    blocks.length > 0 ? `${Math.min(...blocks)}-${Math.max(...blocks)}` : "n/a";
  return [
    `- event rows: \`${stats.rows}\``,
    `- invalid rows: \`${stats.invalidRows}\``,
    `- event block range: \`${blockRange}\``,
    `- event types: ${formatMap(stats.typeCounts)}`,
  ].join("\n");
}

function renderDropStats(stats?: EventStats): string {
  if (!stats || stats.dropCounts.size === 0) return "- no pipeline_dropped events found";
  return sortedEntries(stats.dropCounts)
    .map(([key, count]) => `- \`${key}\`: \`${count}\``)
    .join("\n");
}

function buildObservations(log: string, lastCounters: string | undefined, stats?: EventStats): string[] {
  const out: string[] = [];
  if (log.includes("mempool filtered subscription")) {
    out.push("Filtered mempool subscription was active in this run.");
  }
  if (lastCounters && /\bcuProxyRpcCalls=0\b/.test(lastCounters)) {
    out.push("Mempool CU proxy calls stayed at zero, which indicates the filtered subscription path avoided the pending-hash getTransaction firehose.");
  }
  if (log.includes("liveBackend=rpc")) {
    out.push("The run used `liveBackend=rpc`, so downstream fork/prep work may still be on the slower remote-fork path.");
  }
  if (lastCounters && /\bsolverEntered=0\b/.test(lastCounters)) {
    out.push("No opportunity reached solver in this snapshot.");
  }
  const drops = stats ? sortedEntries(stats.dropCounts) : [];
  if (drops.length > 0) {
    const top = drops[0];
    out.push(`Most recorded drops were \`${top[0]}\` (${top[1]}).`);
  }
  return out;
}

function formatMap(map: Map<string, number>): string {
  if (map.size === 0) return "`{}`";
  const body = sortedEntries(map)
    .map(([key, count]) => `${JSON.stringify(key)}: ${count}`)
    .join(", ");
  return `\`{${body}}\``;
}

function sortedEntries(map: Map<string, number>): [string, number][] {
  return [...map.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

function uniqueMatches(items: string[]): string[] {
  return [...new Set(items)];
}

function bulletList(items: string[], fallback: string): string {
  if (items.length === 0) return `- ${fallback}`;
  return items.map((item) => `- ${item}`).join("\n");
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
