#!/usr/bin/env python3
"""Stop hook — reminds about unharvested daily Method Trace outputs.

This is a skippable nudge, not a hard gate: exit 2 reminds once, and
`stop_hook_active` lets the next stop proceed.
"""
import os, sys, json, glob, re

TRACE_RE = re.compile(r"^##\s*Method Trace", re.MULTILINE | re.IGNORECASE)


def collect_problems(analysis_dir, lib):
    problems = []
    for path in sorted(glob.glob(os.path.join(analysis_dir, "*.md"))):
        name = os.path.basename(path)
        if name == "README.md":
            continue

        with open(path, "r", encoding="utf-8", errors="replace") as f:
            text = f.read()

        if not TRACE_RE.search(text):
            problems.append(
                f"{name}: no `## Method Trace` — add the 8-field block, then "
                f"`npm run method-trace-check -- ../docs/analysis/{name}`"
            )
        elif not os.path.exists(lib) or os.path.getmtime(path) > os.path.getmtime(lib):
            problems.append(
                f"{name}: not harvested into the Opus library — run "
                "`cd analysis && npm run distill-harvest`"
            )
    return problems


def main():
    try:
        data = json.load(sys.stdin)
    except Exception:
        sys.exit(0)

    if data.get("stop_hook_active"):
        sys.exit(0)

    root = os.environ.get("CLAUDE_PROJECT_DIR") or os.getcwd()
    analysis_dir = os.path.join(root, "docs", "analysis")
    lib = os.path.join(root, "docs", "distill", "method-traces.md")

    if not os.path.isdir(analysis_dir):
        sys.exit(0)

    problems = collect_problems(analysis_dir, lib)
    if not problems:
        sys.exit(0)

    sys.stderr.write(
        "DAILY LEARNING LOOP — a docs/analysis/ output isn't in the Opus library yet (skippable):\n"
    )
    for problem in problems:
        sys.stderr.write(f"  - {problem}\n")
    sys.stderr.write(
        "Fix, OR — if this file isn't a reusable analysis (draft / not meant for the Opus library) — re-affirm and\n"
        "the stop proceeds (this is a nudge, not a hard gate).\n"
    )
    sys.exit(2)


def _write(path, text):
    with open(path, "w", encoding="utf-8") as f:
        f.write(text)


if __name__ == "__main__" and "--selftest" in sys.argv:
    root = os.path.join(os.environ.get("TMPDIR", "/tmp"), "guard-daily-methodtrace-selftest-%s" % os.getpid()); analysis = os.path.join(root, "docs", "analysis"); distill = os.path.join(root, "docs", "distill"); os.makedirs(analysis); os.makedirs(distill)
    _write(os.path.join(analysis, "README.md"), "# ignored\n"); _write(os.path.join(analysis, "a.md"), "# A\n"); _write(os.path.join(analysis, "b.md"), "# B\n\n## Method Trace\n")
    lib = os.path.join(distill, "method-traces.md"); _write(lib, "# lib\n"); os.utime(lib, (100, 100)); os.utime(os.path.join(analysis, "b.md"), (200, 200))
    assert collect_problems(analysis, lib) == ["a.md: no `## Method Trace` — add the 8-field block, then `npm run method-trace-check -- ../docs/analysis/a.md`", "b.md: not harvested into the Opus library — run `cd analysis && npm run distill-harvest`"]
    sys.exit(0)
if __name__ == "__main__":
    main()
