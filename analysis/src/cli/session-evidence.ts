// Authorized defensive on-chain arbitrage research; analysis tooling only.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import { pathToFileURL } from "node:url";

export type Evidence = {
  transcript: string;
  human_asks: string[];
  tools_used: ToolCount[];
  evidence_order: EvidenceStep[];
  assistant_conclusions: string[];
};

type ToolCount = {
  tool: string;
  count: number;
};

type EvidenceStep = {
  tool: string;
  detail: string;
};

type JsonRecord = Record<string, unknown>;

const MAX_TEXT_LENGTH = 500;
const MAX_BASH_DETAIL_LENGTH = 80;
const MAX_CONCLUSIONS = 8;

export function extractSessionEvidence(lines: string[]): Evidence;
export function extractSessionEvidence(lines: string[], transcript: string): Evidence;
export function extractSessionEvidence(lines: string[], transcript = ""): Evidence {
  const humanAsks: string[] = [];
  const assistantConclusions: string[] = [];
  const evidenceOrder: EvidenceStep[] = [];
  const toolCounts = new Map<string, { count: number; firstSeen: number }>();

  for (const line of lines) {
    if (line.trim() === "") continue;
    const event = JSON.parse(line) as JsonRecord;
    const message = asRecord(event.message);
    if (!message) continue;

    const role = typeof message.role === "string" ? message.role : "";
    const content = message.content;

    if (role === "user") {
      for (const text of visibleUserTexts(content)) {
        if (!isHumanAskNoise(text)) humanAsks.push(truncate(text));
      }
    }

    if (role === "assistant") {
      for (const text of assistantTextBlocks(content)) {
        assistantConclusions.push(truncate(text));
      }
    }

    for (const toolUse of toolUseBlocks(content)) {
      const tool = typeof toolUse.name === "string" ? toolUse.name : "";
      if (tool === "") continue;

      const existing = toolCounts.get(tool);
      if (existing) {
        existing.count += 1;
      } else {
        toolCounts.set(tool, { count: 1, firstSeen: toolCounts.size });
      }

      evidenceOrder.push({
        tool,
        detail: truncate(detailForToolUse(tool, asRecord(toolUse.input))),
      });
    }
  }

  return {
    transcript,
    human_asks: humanAsks,
    tools_used: [...toolCounts.entries()]
      .map(([tool, seen]) => ({ tool, count: seen.count, firstSeen: seen.firstSeen }))
      .sort((a, b) => b.count - a.count || a.firstSeen - b.firstSeen)
      .map(({ tool, count }) => ({ tool, count })),
    evidence_order: evidenceOrder,
    assistant_conclusions: assistantConclusions.slice(-MAX_CONCLUSIONS),
  };
}

function visibleUserTexts(content: unknown): string[] {
  if (typeof content === "string") return [content];
  if (!Array.isArray(content)) return [];

  return content.flatMap((block) => {
    const record = asRecord(block);
    if (!record || record.type !== "text") return [];
    return typeof record.text === "string" ? [record.text] : [];
  });
}

function assistantTextBlocks(content: unknown): string[] {
  if (!Array.isArray(content)) return [];

  return content.flatMap((block) => {
    const record = asRecord(block);
    if (!record || record.type !== "text") return [];
    return typeof record.text === "string" ? [record.text] : [];
  });
}

function toolUseBlocks(content: unknown): JsonRecord[] {
  if (!Array.isArray(content)) return [];
  return content.flatMap((block) => {
    const record = asRecord(block);
    return record?.type === "tool_use" ? [record] : [];
  });
}

function detailForToolUse(tool: string, input: JsonRecord | null): string {
  if (!input) return "";

  if (tool === "Read" || tool === "Edit" || tool === "Write") {
    return stringInput(input.file_path);
  }
  if (tool === "Bash") {
    return stringInput(input.command).slice(0, MAX_BASH_DETAIL_LENGTH);
  }
  if (tool === "Agent" || tool === "Task") {
    return stringInput(input.description);
  }
  if (tool === "Grep" || tool === "Glob") {
    return stringInput(input.pattern);
  }
  return "";
}

function stringInput(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function isHumanAskNoise(text: string): boolean {
  const trimmed = text.trimStart();
  return trimmed.startsWith("Stop hook feedback")
    || trimmed.startsWith("<")
    || trimmed.startsWith("Caveat")
    || text.includes("command-name")
    || text.includes("local-command");
}

function truncate(text: string): string {
  return text.length > MAX_TEXT_LENGTH ? text.slice(0, MAX_TEXT_LENGTH) : text;
}

function asRecord(value: unknown): JsonRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as JsonRecord
    : null;
}

function parseArgs(argv: string[]): { transcriptPath: string; outPath: string | null } {
  const transcriptPath = argv[0];
  let outPath: string | null = null;

  for (let i = 1; i < argv.length; i++) {
    if (argv[i] === "--out") {
      outPath = argv[i + 1] ?? null;
      i += 1;
    }
  }

  if (!transcriptPath || outPath === "") {
    console.error("usage: session-evidence -- <transcript.jsonl> [--out <file.json>]");
    process.exit(2);
  }

  if (argv.includes("--out") && outPath === null) {
    console.error("usage: session-evidence -- <transcript.jsonl> [--out <file.json>]");
    process.exit(2);
  }

  return { transcriptPath, outPath };
}

function main(): void {
  const { transcriptPath, outPath } = parseArgs(process.argv.slice(2));
  if (!existsSync(transcriptPath)) {
    console.error(`session-evidence: file not found: ${transcriptPath}`);
    process.exit(2);
  }

  const lines = readFileSync(transcriptPath, "utf8").split(/\r?\n/);
  const evidence = extractSessionEvidence(lines, basename(transcriptPath));
  const json = `${JSON.stringify(evidence, null, 2)}\n`;

  if (outPath) {
    writeFileSync(outPath, json);
  } else {
    process.stdout.write(json);
  }
}

function isCliEntrypoint(): boolean {
  const argv1 = process.argv[1];
  return Boolean(argv1 && import.meta.url === pathToFileURL(argv1).href);
}

if (isCliEntrypoint()) {
  main();
}
