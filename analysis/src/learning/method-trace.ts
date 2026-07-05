export const METHOD_TRACE_FIELDS = [
  "task_class",
  "tools_used",
  "evidence_order",
  "analysis_frame",
  "sanity_checks",
  "tool_gap",
  "codify_next",
  "distill_for_opus",
] as const;

export type MethodTraceField = typeof METHOD_TRACE_FIELDS[number];

const FIELD_RE = new RegExp(`^\\s*(${METHOD_TRACE_FIELDS.join("|")})\\s*:(.*)$`, "i");
const METHOD_TRACE_FIELD_SET = new Set<string>(METHOD_TRACE_FIELDS);
const CODE_FENCE_RE = /^\s*```/;
const HEADING_RE = /^\s*#{1,6}\s/;

/** Parse ONE `## Method Trace` block into { field -> FULL value (continuation lines joined) }.
 *  A field's value = text after `field:` on its line + every following line UNTIL a terminator:
 *    - a line that starts another known field (`^\s*<field>\s*:`),
 *    - a code-fence line (`^\s*```),
 *    - a markdown heading (`^\s*#{1,6}\s`),
 *    - end of the block.
 *  Continuation lines are joined with "\n" and the whole value is trimmed. A missing field -> "". */
export function parseMethodTraceFields(block: string): Record<MethodTraceField, string> {
  const values = Object.fromEntries(
    METHOD_TRACE_FIELDS.map((field) => [field, ""]),
  ) as Record<MethodTraceField, string>;

  let currentField: MethodTraceField | null = null;
  let currentLines: string[] = [];

  function flush(): void {
    if (currentField === null) return;
    values[currentField] = currentLines.join("\n").trim();
    currentField = null;
    currentLines = [];
  }

  for (const line of block.split(/\r?\n/)) {
    const fieldMatch = line.match(FIELD_RE);
    if (fieldMatch) {
      flush();
      const field = fieldMatch[1].toLowerCase();
      if (!METHOD_TRACE_FIELD_SET.has(field)) continue;
      currentField = field as MethodTraceField;
      currentLines = [fieldMatch[2] ?? ""];
      continue;
    }

    if (CODE_FENCE_RE.test(line) || HEADING_RE.test(line)) {
      flush();
      continue;
    }

    if (currentField !== null) currentLines.push(line);
  }
  flush();

  return values;
}
