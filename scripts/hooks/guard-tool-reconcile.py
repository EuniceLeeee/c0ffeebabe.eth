#!/usr/bin/env python3
"""PostToolUse gate for capability-selected RECONCILE-after.

Manual analysis runs first so it can test the repository tooling. When scratch analysis derives
venue, pool, trace, or PnL facts, this hook records pending state. The generated tool index then
selects current tools by capability. Pending clears only when the tools actually run (or are
explicitly reconciled by exact indexed id) collectively cover every requested capability.

Fail-open on parse or state errors so the hook cannot break ordinary repository work.
"""

import json
import hashlib
import os
import re
import secrets
import shlex
import subprocess
import sys


def configured_path(environment_name, default):
    if os.environ.get("MEV_HOOK_TEST") == "1":
        return os.environ.get(environment_name, default)
    return default


PENDING = configured_path("MEV_RECONCILE_PENDING_PATH", "/tmp/mev-reconcile-pending")
SELECTION = configured_path("MEV_TOOL_SELECTION_PATH", "/tmp/mev-tool-selection.json")
MARKERS = [
    "receiptLogs", "deriveEdgeKindsFromLogs", "deriveProtocolActionsFromLogs", "extractTouchedVenues",
    "captureAllVenues", "extractVenueCandidates", "traceTransaction", "callTracer", "debug_trace",
    "active-pools", "runtime-graph-pools", "previewRedeem", "asset()", "token0", "token1", "topic0",
    "log_address", "in_graph", "priceArb", "builderPayment", "getLogs", "eth_getLogs", "slot0",
    "get_dy", "coins(", "/discovery/", "/learning/edge-kinds", "/pnl/",
    "0xddf252ad", "0xc42079f9", "0x19b47279",
]
SCRATCH_EXT = (".ts", ".py", ".sh", ".mjs", ".js")


def is_scratch(path_value):
    if not path_value:
        return False
    base = path_value.rsplit("/", 1)[-1]
    if not base.endswith(SCRATCH_EXT):
        return False
    return base.startswith("_") or "/tmp/" in path_value or "/scratchpad/" in path_value


def marker_count(text):
    return sum(1 for marker in MARKERS if marker in text)


def read(path_value):
    try:
        with open(path_value, "r") as handle:
            return handle.read()
    except Exception:
        return ""


def remove(path_value):
    try:
        os.remove(path_value)
    except Exception:
        pass


def clear_pending():
    remove(PENDING)
    remove(SELECTION)


def add_pending(target):
    try:
        # A new manual analysis invalidates any selection made for an older analysis.
        remove(SELECTION)
        items = []
        try:
            with open(PENDING, "r") as handle:
                previous = json.load(handle)
            items = list(previous.get("items") or [])
        except Exception:
            pass
        if target not in items:
            items.append(target)
        temporary = f"{PENDING}.{os.getpid()}.tmp"
        with open(temporary, "w") as handle:
            json.dump({"schema_version": 1, "nonce": secrets.token_hex(16), "items": items}, handle, indent=2)
            handle.write("\n")
        os.replace(temporary, PENDING)
    except Exception:
        pass


def load_current_selection():
    try:
        if not os.path.exists(PENDING) or not os.path.exists(SELECTION):
            return None
        with open(PENDING, "r") as handle:
            pending = json.load(handle)
        with open(SELECTION, "r") as handle:
            plan = json.load(handle)
        project_dir = os.environ.get("CLAUDE_PROJECT_DIR")
        if not project_dir:
            project_dir = subprocess.check_output(
                ["git", "rev-parse", "--show-toplevel"],
                cwd=os.getcwd(),
                stderr=subprocess.DEVNULL,
                text=True,
            ).strip()
        expected_root = os.path.realpath(project_dir)
        if (plan.get("schema_version") != 2
                or pending.get("schema_version") != 1
                or plan.get("pending_nonce") != pending.get("nonce")
                or os.path.realpath(plan.get("repo_root") or "") != expected_root
                or not plan.get("requested_capabilities")):
            return None
        candidates = (plan.get("recommended_tools") or []) + (plan.get("related_tools") or [])
        by_id = {tool.get("id"): tool for tool in candidates if tool.get("id")}
        if not by_id:
            return None
        plan["_candidates"] = by_id
        return plan
    except Exception:
        return None


def command_segments(command):
    """Return (connector-before, argv) without treating quoted text as executable syntax."""
    try:
        lexer = shlex.shlex(command, posix=True, punctuation_chars=";&|")
        lexer.whitespace = " \t\r"
        lexer.commenters = ""
        tokens = list(lexer)
    except Exception:
        return []
    segments = []
    current = []
    conditional = False
    for token in tokens:
        if token in (";", "&&", "||", "|", "\n"):
            if current:
                segments.append((conditional, current))
                current = []
            if token in (";", "\n"):
                conditional = False
            elif token in ("||", "|"):
                conditional = True
        else:
            current.append(token)
    if current:
        segments.append((conditional, current))
    return segments


def strip_prefixes(segment):
    index = 0
    while index < len(segment) and (re.match(r"^[A-Za-z_][A-Za-z0-9_]*=", segment[index])
                                    or segment[index] in ("env", "command", "exec", "sudo")):
        index += 1
    return segment[index:]


def command_runs_tool(command, tool):
    script = tool.get("script") or ""
    package = tool.get("package") or ""
    implementation = tool.get("implementation") or ""
    implementation_paths = set()
    if implementation:
        implementation_paths.add(implementation.removeprefix("./"))
        if package != "repo":
            implementation_paths.add((package + "/" + implementation).removeprefix("./"))
    repo_paths = {script.removeprefix("./")} if package == "repo" and script else set()
    for conditional, raw_segment in command_segments(command):
        # A command following || may be skipped; a pipeline may hide its failure. Be conservative.
        if conditional:
            continue
        segment = strip_prefixes(raw_segment)
        if not segment:
            continue
        executable = os.path.basename(segment[0])
        if package in ("analysis", "listener") and script:
            if executable in ("npm", "pnpm") and len(segment) >= 3 and segment[1:3] == ["run", script]:
                return True
            if executable == "yarn" and len(segment) >= 2:
                offset = 2 if segment[1] == "run" else 1
                if len(segment) > offset and segment[offset] == script:
                    return True
        head = segment[0].removeprefix("./")
        if package == "repo":
            if head in repo_paths:
                return True
            if executable in ("bash", "sh", "python", "python3") and len(segment) >= 2 \
                    and segment[1].removeprefix("./") in repo_paths:
                return True
        if implementation_paths:
            if executable in ("tsx", "node"):
                # The implementation must be the executed program, not a quoted/printed argument.
                program_tokens = segment[1:]
                if executable == "node" and len(program_tokens) >= 2 and program_tokens[:2] == ["--import", "tsx"]:
                    program_tokens = program_tokens[2:]
                if program_tokens and program_tokens[0].removeprefix("./") in implementation_paths:
                    return True
    return False


def command_runs_tool_runner(command):
    for conditional, raw_segment in command_segments(command):
        if conditional:
            continue
        segment = strip_prefixes(raw_segment)
        if not segment:
            continue
        executable = os.path.basename(segment[0])
        if executable in ("npm", "pnpm") and len(segment) >= 3 and segment[1:3] == ["run", "tool-run"]:
            return True
        if executable == "yarn" and len(segment) >= 2:
            offset = 2 if segment[1] == "run" else 1
            if len(segment) > offset and segment[offset] == "tool-run":
                return True
    return False


def descriptor_sha256(tool):
    payload = {}
    for key in (
        "id", "package", "script", "command", "implementation", "kind", "capabilities", "cost",
        "window_binding",
    ):
        if key in tool:
            payload[key] = tool[key]
    source = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
    return hashlib.sha256(source.encode()).hexdigest()


def successful_receipt_ids(plan):
    successful = set()
    for receipt in plan.get("executions") or []:
        tool = plan["_candidates"].get(receipt.get("tool_id"))
        if (tool
                and receipt.get("schema_version") == 1
                and receipt.get("exit_code") == 0
                and receipt.get("descriptor_sha256") == descriptor_sha256(tool)):
            successful.add(tool["id"])
    return successful


def reconciled_tool_ids(text, candidate_ids):
    found = set()
    pattern = re.compile(r"tool-reconciled:\s*([A-Za-z0-9:._/-]+)\s+(?:agrees|diverged|n/a)\b")
    for match in pattern.finditer(text):
        if match.group(1) in candidate_ids:
            found.add(match.group(1))
    return found


def record_progress(plan, executed_ids=None, reconciled_ids=None):
    executed = set(plan.get("executed_tools") or []) | set(executed_ids or [])
    reconciled = set(plan.get("reconciled_tools") or []) | set(reconciled_ids or [])
    completed = executed | reconciled
    covered = set()
    for tool_id in completed:
        tool = plan["_candidates"].get(tool_id)
        if tool:
            covered.update(tool.get("capabilities") or [])
    requested = set(plan.get("requested_capabilities") or [])
    if requested.issubset(covered):
        clear_pending()
        return

    serializable = {key: value for key, value in plan.items() if not key.startswith("_")}
    serializable["executed_tools"] = sorted(executed)
    serializable["reconciled_tools"] = sorted(reconciled)
    serializable["covered_capabilities"] = sorted(covered & requested)
    temporary = f"{SELECTION}.{os.getpid()}.tmp"
    try:
        with open(temporary, "w") as handle:
            json.dump(serializable, handle, indent=2)
            handle.write("\n")
        os.replace(temporary, SELECTION)
    except Exception:
        remove(temporary)


try:
    data = json.load(sys.stdin)
except Exception:
    sys.exit(0)

tool_name = data.get("tool_name")
tool_input = data.get("tool_input") or {}
tool_response = data.get("tool_response") or {}
target = ""
body = ""

if tool_name == "Write":
    target = tool_input.get("file_path", "") or ""
    body = tool_input.get("content", "") or ""
    scratch = is_scratch(target)
elif tool_name in ("Edit", "MultiEdit"):
    target = tool_input.get("file_path", "") or ""
    body = (tool_input.get("new_string", "") or "") + " " + " ".join(
        (edit.get("new_string", "") or "") for edit in (tool_input.get("edits") or [])
    )
    scratch = is_scratch(target)
elif tool_name == "Bash":
    command = tool_input.get("command", "") or ""
    body = command
    if re.search(
        r"\b(git|gh)\s+(commit|add|push|pull|mv|rm|fetch|show|log|status|diff|checkout|reset|stash|branch|clone|tag|pr|issue)\b",
        command,
    ):
        sys.exit(0)

    plan = load_current_selection()
    if plan:
        # PostToolUse is the success event. Interrupted calls are never execution evidence.
        if not isinstance(tool_response, dict) or bool(tool_response.get("interrupted")):
            sys.exit(0)
        if command_runs_tool_runner(command):
            receipts = successful_receipt_ids(plan)
            if receipts:
                record_progress(plan, receipts)
            sys.exit(0)
        executed = {
            tool_id for tool_id, descriptor in plan["_candidates"].items()
            if command_runs_tool(command, descriptor)
        }
        if executed:
            record_progress(plan, executed)
            sys.exit(0)

    match = re.search(
        r"(?:>\s*|node\s[^\n|;&]*?|tsx\s|python3?\s|bash\s|sh\s)([^\s;|&'\"]+\.(?:ts|py|sh|mjs|js))",
        command,
    )
    if match:
        reference = match.group(1)
        target = reference
        base = reference.rsplit("/", 1)[-1]
        scratch = base.startswith("_") or "/tmp/" in reference or "/scratchpad/" in reference
        for candidate in (reference, os.path.join("analysis", reference), os.path.join("listener", reference)):
            if os.path.exists(candidate):
                body += "\n" + read(candidate)
                break
    elif re.search(r"(python3?|node)\s+-[ce]\b", command):
        target = "inline-code"
        scratch = True
    else:
        scratch = False
else:
    sys.exit(0)

if tool_name != "Bash":
    plan = load_current_selection()
    if plan:
        reconciled = reconciled_tool_ids(body, set(plan["_candidates"]))
        if reconciled:
            record_progress(plan, reconciled_ids=reconciled)
            sys.exit(0)

if not scratch:
    sys.exit(0)
threshold = 2 if target == "inline-code" else 1
if marker_count(body) < threshold:
    sys.exit(0)

add_pending(target or "scratch-analysis")
sys.stderr.write(
    "RECONCILE REQUIRED (CLAUDE.md §5 / HERMES rules 16+17): a hand-rolled analysis "
    f"({target}) derived venue/pool/trace/PnL facts. Query the generated inventory with "
    "`cd analysis && npm run tool-index -- --select <capability[,capability]> --out <manifest.json>`, inspect "
    "the recommended coverage set and related alternatives, then use `npm run tool-run -- --manifest "
    "<manifest.json> --tool <indexed-id> -- <args>` for enough selected tools on the same input for their "
    "capability union to cover the query. An explicit exception/finding must use an exact selected id: "
    "`tool-reconciled: <indexed-tool-id> agrees|diverged|n/a <reason>`.\n"
)
sys.exit(2)
