import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

export type ToolKind = "analysis" | "view" | "gate" | "ops" | "replay" | "test" | "runtime";
export type ToolCost = "zero-cu" | "local-rpc" | "archive-rpc" | "fork" | "build";
export type ToolWindowBinding =
  | { kind: "flags"; from: string; to: string }
  | { kind: "positionals"; from_index: number; to_index: number };

export interface ToolDescriptor {
  id: string;
  package: "analysis" | "listener" | "repo";
  script: string;
  command: string;
  implementation: string | null;
  kind: ToolKind;
  capabilities: string[];
  cost: ToolCost;
  summary: string;
  priority: number;
  curated: boolean;
  window_binding: ToolWindowBinding | null;
}

export interface RecordedToolSelection {
  capability_query: string[];
  selected_tools: string[];
  catalog_check_exit_code: number;
  evidence_manifest: string;
  evidence_manifest_sha256: string;
}

export interface ToolExecutionReceipt {
  schema_version: 1;
  tool_id: string;
  descriptor_sha256: string;
  started_at: string;
  finished_at: string;
  exit_code: number;
  cwd: string;
  argv_sha256: string;
  argv_redacted: string[];
  window?: { from: number; to: number };
  stdout_sha256: string;
  stderr_sha256: string;
  stdout_bytes: number;
  stderr_bytes: number;
}

export interface ToolExecutionManifest {
  schema_version: 2;
  repo_root: string;
  pending_nonce: string | null;
  requested_capabilities: string[];
  recommended_tools: ToolDescriptor[];
  related_tools: ToolDescriptor[];
  executions: ToolExecutionReceipt[];
  generated_at: string;
  updated_at: string;
}

export const PRODUCTION_CANDIDATE_CAPABILITIES = [
  "single-transaction",
  "causality",
  "pnl",
  "competitor-window",
  "classification",
  "block-scan",
] as const;

export const PRODUCTION_DECISION_CAPABILITIES = [
  "competitor-window",
  "classification",
  "block-scan",
  "ab",
  "comparison",
] as const;

type Curated = Pick<ToolDescriptor, "kind" | "capabilities" | "cost" | "summary" | "priority">;

const CURATED: Record<string, Curated> = {
  "analysis:address": meta("analysis", ["address-profile", "strategy-cluster", "trace"], "archive-rpc", "Profile one address and cluster its on-chain strategies.", 60),
  "analysis:live-loss": meta("analysis", ["competitor-window", "production-events", "loss-attribution"], "local-rpc", "Analyze watched competitors or our dropped opportunities over a live window.", 80),
  "analysis:bundle-postmortem": meta("analysis", ["single-transaction", "competitor-loss", "causality", "pnl", "flow", "graph"], "archive-rpc", "Canonical deep landed/lost transaction analysis.", 100),
  "analysis:onchain-loss-scan": meta("analysis", ["competitor-window", "chain-first", "loss-attribution", "classification"], "local-rpc", "Find chain-first competitor wins absent from our funnel.", 85),
  "analysis:census-report": meta("analysis", ["competitor-window", "classification", "pnl", "graph"], "local-rpc", "Enumerate and classify a watchlist over a bounded block window.", 90),
  "analysis:tx-profit": meta("view", ["single-transaction", "pnl"], "archive-rpc", "Thin PnL-only transaction view over the canonical pricer.", 95),
  "analysis:tx-flow": meta("view", ["single-transaction", "flow"], "archive-rpc", "Thin ordered token-flow transaction view.", 95),
  "analysis:tx-source-shape": meta("analysis", ["single-transaction", "causality", "classification", "backrun", "block-scan"], "archive-rpc", "Classify one landed swap transaction as victim-driven or block-scan from a strict preceding opposite-direction same-pool swap.", 100),
  "analysis:redact-live-run": meta("ops", ["redaction", "live-window", "production-events"], "zero-cu", "Redact and summarize live-run artifacts before analysis or commit.", 100),
  "analysis:hermes-gate": meta("gate", ["hermes", "close-gate", "method-trace"], "zero-cu", "Mechanical Hermes report close gate.", 100),
  "analysis:ab-canary-compare": meta("analysis", ["ab", "comparison", "block-scan"], "zero-cu", "Compare paired A/B block-scan logs after manual analysis.", 100),
  "analysis:ab-canary-gate": meta("gate", ["ab", "candidate-gate", "close-gate"], "local-rpc", "Validate A/B candidate, decision, and cleanup invariants.", 100),
  "analysis:historical-gap-gate": meta("gate", ["historical-gap", "promotion", "pinned-replay", "branch-lifecycle"], "fork", "Route historical gap repairs to direct-main, replay-plus-smoke, or Hermes A/B and enforce promotion evidence.", 100),
  "analysis:ab-promotion-close": meta("ops", ["ab", "branch-lifecycle", "promotion", "cleanup"], "zero-cu", "Execute an already adjudicated win/lose: exact merge or reject, archive, gate, and cleanup.", 100),
  "analysis:ab-resolution-sweep": meta("ops", ["ab", "branch-lifecycle", "pinned-replay"], "fork", "Re-run main-committed resolution claims and clean resolved retained branches.", 100),
  "analysis:competitor-calibration": meta("gate", ["classification", "calibration", "fixture"], "zero-cu", "Regression calibration for competitor style and comparability classification; it does not inspect a live window.", 100),
  "analysis:method-trace-check": meta("gate", ["method-trace", "learning"], "zero-cu", "Validate one reusable Method Trace.", 90),
  "analysis:session-evidence": meta("ops", ["method-trace", "learning", "session"], "zero-cu", "Extract bounded evidence from a local session transcript.", 80),
  "analysis:distill-harvest": meta("ops", ["method-trace", "learning"], "zero-cu", "Harvest validated Method Traces into the shared learning asset.", 80),
  "analysis:venue-discovery-scan": meta("analysis", ["venue-discovery", "classification", "fixture"], "zero-cu", "Classify venue candidates from a fixture.", 75),
  "analysis:venue-discovery-window": meta("analysis", ["venue-discovery", "competitor-window"], "local-rpc", "Discover and aggregate venues over an RPC block window.", 75),
  "analysis:venue-discovery-bq": meta("analysis", ["venue-discovery", "historical-export", "bigquery"], "zero-cu", "Classify exported BigQuery receipt roles, unrecognized topics, funding identity, and descriptor-backed production routability without node crawling; the export itself does not attest factory identity or an exact live window.", 75),
  "analysis:venue-registry": meta("ops", ["venue-discovery", "venue-registry"], "zero-cu", "Ingest and inspect the durable venue evidence registry.", 70),
  "analysis:graph-in": meta("view", ["graph", "single-venue"], "zero-cu", "Check canonical runtime graph membership without conflating unavailable and absent.", 95),
  "analysis:block-activity": meta("view", ["single-block", "production-events", "block-scan"], "zero-cu", "Summarize one block's production funnel and block-scan evidence.", 90),
  "analysis:blockscan-kpi": meta("analysis", ["block-scan", "production-events", "state-coverage", "kpi"], "zero-cu", "Measure periodic non-warm block-scan passes whose joined N-1 coarse state has at least 80% price coverage.", 100),
  "analysis:discovery-lag": meta("analysis", ["discovery", "coverage", "state-coverage", "diagnostic"], "zero-cu", "Attribute discovery source lags (complete-through vs head) and per-stage scan cost from the live searcher log.", 80),
  "analysis:tool-index": meta("ops", ["tool-discovery", "tool-selection"], "zero-cu", "Generate and query the current analysis/replay capability index.", 100),
  "analysis:tool-run": meta("ops", ["tool-execution", "tool-evidence"], "zero-cu", "Run one dynamically selected read-only tool and append a machine execution receipt.", 100),
  "listener:auto-close-route-gap": meta("ops", ["route-gap", "auto-close", "graph"], "local-rpc", "Close a confirmed route gap from a canonical report.", 90),
  "listener:auto-close-router-gap": meta("ops", ["router-gap", "auto-close", "flow-admission"], "local-rpc", "Close a confirmed router admission gap.", 90),
  "listener:searcher:blockscan-hunt": meta("replay", ["block-scan", "pinned-replay", "production-stage"], "fork", "Trusted parent-block replay for a pinned production sample.", 100),
  "listener:searcher:loop-fork-gate": meta("replay", ["block-scan", "pinned-replay", "closed-loop"], "fork", "Fork gate for one explicit closed-loop fixture.", 95),
  "listener:searcher:liveready": meta("gate", ["live-readiness", "graph", "execution"], "fork", "Validate live searcher readiness against a fork.", 85),
  "listener:searcher:planner": meta("test", ["planner", "path", "replay"], "zero-cu", "Planner and replay regression suite.", 80),
  "listener:searcher:protocol-legs": meta("test", ["protocol", "adapter", "execution"], "zero-cu", "Protocol-leg regression suite.", 80),
  "listener:searcher:taxonomy": meta("test", ["classification", "taxonomy"], "zero-cu", "Strategy/edge taxonomy regression suite.", 80),
  "listener:searcher:universe-split": meta("test", ["venue-discovery", "graph", "admission"], "zero-cu", "Universe/admission split regression suite.", 80),
  "repo:scripts/census-gap.sh": meta("analysis", ["competitor-window", "classification", "competitor-loss", "block-scan"], "local-rpc", "Canonical production-window glue from census takes to per-transaction and scanner evidence.", 100),
  "repo:scripts/deploy-ab-challenger.sh": meta("ops", ["ab", "deployment", "branch-lifecycle"], "build", "Trusted bounded-live challenger deploy, lease, pause, close, and reap wrapper.", 100),
  "repo:scripts/deploy-node.sh": meta("ops", ["deployment", "champion", "safety-envelope"], "build", "Trusted champion deployment wrapper with live posture preservation.", 100),
};

const WINDOW_BINDINGS: Record<string, ToolWindowBinding> = {
  "analysis:live-loss": { kind: "flags", from: "--from-block", to: "--to-block" },
  "analysis:onchain-loss-scan": { kind: "flags", from: "--from-block", to: "--to-block" },
  "analysis:census-report": { kind: "flags", from: "--from-block", to: "--to-block" },
  "analysis:venue-discovery-window": { kind: "flags", from: "--from-block", to: "--to-block" },
  "repo:scripts/census-gap.sh": { kind: "positionals", from_index: 0, to_index: 1 },
};

function meta(kind: ToolKind, capabilities: string[], cost: ToolCost, summary: string, priority: number): Curated {
  return { kind, capabilities, cost, summary, priority };
}

function normalize(value: string): string {
  return value.trim().toLowerCase().replace(/_/g, "-");
}

function scriptImplementation(command: string): string | null {
  return command.match(/(?:^|\s)((?:src|revm-sim)\/[^\s"']+\.(?:ts|js|mjs|json|toml))/)?.[1] ?? null;
}

function inferredKind(packageName: "analysis" | "listener" | "repo", script: string): ToolKind {
  if (packageName === "repo") return script.includes("hooks/") ? "gate" : "ops";
  if (["start", "dev", "searcher:live"].includes(script)) return "runtime";
  if (script === "build") return "test";
  if (script === "test" || script.startsWith("test:") || script === "regression" || script === "equivalence") return "test";
  if (script.startsWith("searcher:")) return "replay";
  if (/^(auto-close|discover|route-gap|v4-backfill|replicate)/.test(script)) return "ops";
  return packageName === "analysis" ? "analysis" : "ops";
}

function inferredCapabilities(packageName: "analysis" | "listener" | "repo", script: string, kind: ToolKind): string[] {
  const tokens = script.split(/[:_-]/).map(normalize).filter(Boolean);
  const capabilities = new Set<string>([packageName, kind, ...tokens]);
  if (tokens.includes("blockscan")) capabilities.add("block-scan");
  if (tokens.includes("v4")) capabilities.add("uniswap-v4");
  if (tokens.includes("curve")) capabilities.add("curve");
  if (tokens.includes("protocol")) capabilities.add("protocol");
  if (kind === "replay" || kind === "test") capabilities.add("verification");
  return [...capabilities].sort();
}

function inferredCost(kind: ToolKind, script: string): ToolCost {
  if (/fork|anvil|hunt|revm|live|protocol-loop/.test(script)) return "fork";
  if (/address|loss|census|venue-discovery-window|auto-close|discover-routers/.test(script)) return "local-rpc";
  if (kind === "runtime") return "build";
  return "zero-cu";
}

export function discoverToolIndex(repoRoot: string): ToolDescriptor[] {
  const tools: ToolDescriptor[] = [];
  for (const packageName of ["analysis", "listener"] as const) {
    const packagePath = path.join(repoRoot, packageName, "package.json");
    const packageJson = JSON.parse(fs.readFileSync(packagePath, "utf8")) as { scripts?: Record<string, string> };
    for (const [script, implementationCommand] of Object.entries(packageJson.scripts ?? {})) {
      const id = `${packageName}:${script}`;
      const curated = CURATED[id];
      const kind = curated?.kind ?? inferredKind(packageName, script);
      tools.push({
        id,
        package: packageName,
        script,
        command: `cd ${packageName} && npm run ${script} --`,
        implementation: scriptImplementation(implementationCommand),
        kind,
        capabilities: (curated?.capabilities ?? inferredCapabilities(packageName, script, kind)).map(normalize),
        cost: curated?.cost ?? inferredCost(kind, script),
        summary: curated?.summary ?? `${packageName} package script: ${script}`,
        priority: curated?.priority ?? 10,
        curated: Boolean(curated),
        window_binding: WINDOW_BINDINGS[id] ?? null,
      });
    }
  }
  const scriptRoot = path.join(repoRoot, "scripts");
  const visit = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === "__pycache__" || entry.name.startsWith("._")) continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(absolute);
        continue;
      }
      if (!/\.(?:sh|py)$/.test(entry.name)) continue;
      const relative = path.relative(repoRoot, absolute).split(path.sep).join("/");
      const id = `repo:${relative}`;
      const curated = CURATED[id];
      const kind = curated?.kind ?? inferredKind("repo", relative);
      tools.push({
        id,
        package: "repo",
        script: relative,
        command: relative,
        implementation: relative,
        kind,
        capabilities: (curated?.capabilities ?? inferredCapabilities("repo", relative, kind)).map(normalize),
        cost: curated?.cost ?? inferredCost(kind, relative),
        summary: curated?.summary ?? `Repository script: ${relative}`,
        priority: curated?.priority ?? 10,
        curated: Boolean(curated),
        window_binding: WINDOW_BINDINGS[id] ?? null,
      });
    }
  };
  visit(scriptRoot);
  return tools.sort((a, b) => a.id.localeCompare(b.id));
}

export function validateToolIndex(repoRoot: string, tools = discoverToolIndex(repoRoot)): string[] {
  const errors: string[] = [];
  const ids = new Set<string>();
  for (const tool of tools) {
    if (ids.has(tool.id)) errors.push(`duplicate tool id ${tool.id}`);
    ids.add(tool.id);
    if (tool.capabilities.includes("competitor-window") && !tool.window_binding) {
      errors.push(`competitor-window tool has no executable window binding: ${tool.id}`);
    }
  }
  for (const id of Object.keys(CURATED)) if (!ids.has(id)) errors.push(`curated tool missing from package scripts: ${id}`);

  const cliDirectory = path.join(repoRoot, "analysis/src/cli");
  const referenced = new Set(tools
    .filter((tool) => tool.package === "analysis" && tool.implementation?.startsWith("src/cli/"))
    .map((tool) => path.basename(tool.implementation!)));
  for (const file of fs.readdirSync(cliDirectory)
    .filter((file) => file.endsWith(".ts") && !file.startsWith("._"))
    .sort()) {
    if (!referenced.has(file)) errors.push(`analysis CLI has no package-script index entry: src/cli/${file}`);
  }
  return errors;
}

export function selectTools(tools: ToolDescriptor[], requestedCapabilities: string[]): ToolDescriptor[] {
  const requested = [...new Set(requestedCapabilities.map(normalize).filter(Boolean))];
  const uncovered = new Set(requested);
  const selected: ToolDescriptor[] = [];
  const candidates = tools.filter((tool) => tool.capabilities.some((capability) => uncovered.has(capability)));
  while (uncovered.size > 0) {
    const ranked = candidates
      .filter((tool) => !selected.includes(tool))
      .map((tool) => ({
        tool,
        coverage: tool.capabilities.filter((capability) => uncovered.has(capability)).length,
      }))
      .filter(({ coverage }) => coverage > 0)
      .sort((a, b) => b.coverage - a.coverage
        || b.tool.priority - a.tool.priority
        || Number(b.tool.curated) - Number(a.tool.curated)
        || a.tool.id.localeCompare(b.tool.id));
    const next = ranked[0]?.tool;
    if (!next) break;
    selected.push(next);
    for (const capability of next.capabilities) uncovered.delete(capability);
  }
  return selected;
}

export function relatedTools(tools: ToolDescriptor[], requestedCapabilities: string[]): ToolDescriptor[] {
  const requested = new Set(requestedCapabilities.map(normalize).filter(Boolean));
  return tools.filter((tool) => tool.capabilities.some((capability) => requested.has(capability)))
    .sort((a, b) => {
      const aCoverage = a.capabilities.filter((capability) => requested.has(capability)).length;
      const bCoverage = b.capabilities.filter((capability) => requested.has(capability)).length;
      return bCoverage - aCoverage || b.priority - a.priority
        || Number(b.curated) - Number(a.curated) || a.id.localeCompare(b.id);
    });
}

export function toolDescriptorSha256(tool: ToolDescriptor): string {
  return createHash("sha256").update(JSON.stringify({
    id: tool.id,
    package: tool.package,
    script: tool.script,
    command: tool.command,
    implementation: tool.implementation,
    kind: tool.kind,
    capabilities: tool.capabilities,
    cost: tool.cost,
    window_binding: tool.window_binding,
  })).digest("hex");
}

export function bindToolWindowArguments(
  tool: ToolDescriptor,
  toolArgs: string[],
  window: { from: number; to: number } | undefined,
): string[] {
  if (!window) return [...toolArgs];
  const binding = tool.window_binding;
  if (!binding) throw new Error(`${tool.id} cannot bind an exact execution window`);
  if (binding.kind === "flags") {
    if (toolArgs.includes(binding.from) || toolArgs.includes(binding.to)) {
      throw new Error(`${tool.id} window flags are owned by tool-run; pass only --window from..to`);
    }
    return [...toolArgs, binding.from, String(window.from), binding.to, String(window.to)];
  }
  const bound = [...toolArgs];
  const insert = (index: number, value: string): void => {
    if (index < 0 || index > bound.length) throw new Error(`${tool.id} has invalid positional window binding`);
    bound.splice(index, 0, value);
  };
  insert(binding.from_index, String(window.from));
  insert(binding.to_index, String(window.to));
  return bound;
}

function windowFromReceiptArgv(tool: ToolDescriptor, argv: string[]): { from: number; to: number } | null {
  const binding = tool.window_binding;
  if (!binding) return null;
  const separator = argv.indexOf("--");
  const toolArgs = tool.package === "repo" ? argv.slice(2) : separator >= 0 ? argv.slice(separator + 1) : [];
  let fromText: string | undefined;
  let toText: string | undefined;
  if (binding.kind === "flags") {
    const fromIndex = toolArgs.indexOf(binding.from);
    const toIndex = toolArgs.indexOf(binding.to);
    fromText = fromIndex >= 0 ? toolArgs[fromIndex + 1] : undefined;
    toText = toIndex >= 0 ? toolArgs[toIndex + 1] : undefined;
  } else {
    fromText = toolArgs[binding.from_index];
    toText = toolArgs[binding.to_index];
  }
  const from = Number(fromText);
  const to = Number(toText);
  return Number.isSafeInteger(from) && Number.isSafeInteger(to) && from >= 0 && from <= to
    ? { from, to }
    : null;
}

function validIso(value: unknown): boolean {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

export function validateToolExecutionManifest(
  manifest: ToolExecutionManifest | undefined,
  tools: ToolDescriptor[],
  requiredCapabilities: readonly string[] = [],
  expectedWindow?: { from: number; to: number },
): string[] {
  if (!manifest || manifest.schema_version !== 2) return ["tool execution manifest schema_version=2 is required"];
  const errors: string[] = [];
  const requested = [...new Set((manifest.requested_capabilities ?? []).map(normalize).filter(Boolean))];
  for (const capability of requiredCapabilities.map(normalize)) {
    if (!requested.includes(capability)) errors.push(`tool execution manifest must request ${capability}`);
  }
  const byId = new Map(tools.map((tool) => [tool.id, tool]));
  const covered = new Set<string>();
  if (!Array.isArray(manifest.executions) || manifest.executions.length === 0) {
    errors.push("tool execution manifest has no machine execution receipts");
    return errors;
  }
  for (const receipt of manifest.executions) {
    const tool = byId.get(receipt?.tool_id);
    if (!tool) {
      errors.push(`tool execution receipt references unknown tool ${String(receipt?.tool_id)}`);
      continue;
    }
    if (receipt.schema_version !== 1 || receipt.descriptor_sha256 !== toolDescriptorSha256(tool)) {
      errors.push(`tool execution receipt descriptor mismatch: ${tool.id}`);
    }
    if (receipt.exit_code !== 0) errors.push(`tool execution did not exit 0: ${tool.id}`);
    if (!validIso(receipt.started_at) || !validIso(receipt.finished_at)
        || Date.parse(receipt.started_at) > Date.parse(receipt.finished_at)) {
      errors.push(`tool execution timestamps invalid: ${tool.id}`);
    }
    for (const field of ["argv_sha256", "stdout_sha256", "stderr_sha256"] as const) {
      if (!/^[a-f0-9]{64}$/.test(String(receipt[field] ?? ""))) {
        errors.push(`tool execution ${field} invalid: ${tool.id}`);
      }
    }
    if (!Number.isInteger(receipt.stdout_bytes) || receipt.stdout_bytes < 0
        || !Number.isInteger(receipt.stderr_bytes) || receipt.stderr_bytes < 0) {
      errors.push(`tool execution byte counts invalid: ${tool.id}`);
    }
    const overlap = tool.capabilities.filter((capability) => requested.includes(capability));
    if (receipt.exit_code === 0) for (const capability of overlap) covered.add(capability);
    if (overlap.includes("competitor-window")) {
      const executedWindow = windowFromReceiptArgv(tool, receipt.argv_redacted ?? []);
      if (!executedWindow
          || receipt.window?.from !== executedWindow.from
          || receipt.window?.to !== executedWindow.to) {
        errors.push(`${tool.id} competitor-window receipt does not match its executed argv`);
      }
    }
    if (expectedWindow && overlap.includes("competitor-window")) {
      if (receipt.window?.from !== expectedWindow.from || receipt.window?.to !== expectedWindow.to) {
        errors.push(`${tool.id} competitor-window receipt must exactly match ${expectedWindow.from}..${expectedWindow.to}`);
      }
    }
  }
  for (const capability of requested) {
    if (!covered.has(capability)) errors.push(`successful tool executions do not provide requested capability ${capability}`);
  }
  return errors;
}

export function validateRecordedToolSelection(
  selection: RecordedToolSelection | undefined,
  tools: ToolDescriptor[],
  requiredCapabilities: readonly string[] = [],
  manifest?: ToolExecutionManifest,
  expectedWindow?: { from: number; to: number },
): string[] {
  if (!selection) return ["analysis.tool_selection is required for schema-v3 candidate deployment"];
  const errors: string[] = [];
  if (selection.catalog_check_exit_code !== 0) errors.push("tool catalog check must exit 0");
  if (!Array.isArray(selection.capability_query) || selection.capability_query.length === 0) {
    errors.push("tool selection capability_query is required");
  }
  if (!Array.isArray(selection.selected_tools) || selection.selected_tools.length === 0) {
    errors.push("tool selection selected_tools is required");
    return errors;
  }
  if (!selection.evidence_manifest?.trim() || !/^[a-f0-9]{64}$/.test(selection.evidence_manifest_sha256 ?? "")) {
    errors.push("tool selection must bind a machine execution manifest by path and SHA-256");
  }
  const byId = new Map(tools.map((tool) => [tool.id, tool]));
  const requested = [...new Set(selection.capability_query.map(normalize).filter(Boolean))];
  for (const capability of requiredCapabilities.map(normalize)) {
    if (!requested.includes(capability)) {
      errors.push(`tool selection capability_query must include ${capability}`);
    }
  }
  const covered = new Set<string>();
  const seen = new Set<string>();
  for (const selected of selection.selected_tools) {
    if (seen.has(selected)) {
      errors.push(`selected tool is duplicated: ${selected}`);
      continue;
    }
    seen.add(selected);
    const tool = byId.get(selected);
    if (!tool) {
      errors.push(`selected tool is not in the current index: ${selected}`);
      continue;
    }
    const overlap = requested.filter((capability) => tool.capabilities.includes(capability));
    if (overlap.length === 0) {
      errors.push(`${selected} does not provide any requested capability`);
    }
    for (const capability of overlap) covered.add(capability);
  }
  for (const capability of requested) {
    if (!covered.has(capability)) errors.push(`selected tool set does not provide requested capability ${capability}`);
  }
  errors.push(...validateToolExecutionManifest(manifest, tools, requiredCapabilities, expectedWindow));
  if (manifest) {
    const manifestRequested = [...new Set(manifest.requested_capabilities.map(normalize).filter(Boolean))].sort();
    if (JSON.stringify(manifestRequested) !== JSON.stringify([...requested].sort())) {
      errors.push("tool selection capability_query does not match its execution manifest");
    }
    const successful = [...new Set(manifest.executions.filter((receipt) => receipt.exit_code === 0)
      .map((receipt) => receipt.tool_id))].sort();
    if (JSON.stringify(successful) !== JSON.stringify([...selection.selected_tools].sort())) {
      errors.push("tool selection selected_tools must equal the successfully executed receipt set");
    }
  }
  return errors;
}
