#!/usr/bin/env bash
# codex-run.sh — the ONE sanctioned way to launch a long `codex exec` (CLAUDE.md rule 11).
# NEVER hand-write the codex invocation: the guards below keep getting forgotten and each one
# has burned a run. This script bakes them in so they CANNOT be omitted.
#
#   < /dev/null      the stdin-read hang guard. `codex exec "$BRIEF"` otherwise inherits the
#                    parent shell's stdin (a pipe/tty that never sends EOF) and blocks forever on
#                    "Reading additional input from stdin..." — 0 work, looks alive. (2026-07-02:
#                    a plan-review sat stdin-hung 15 min.) /dev/null gives immediate EOF.
#   caffeinate -i    the machine won't idle-sleep mid-run (bg suspend freezes codex + its proxy).
#                    A persistent workflow keeper is separate (Rounds Step 0); this covers the run.
#   -o + --json      judge by the output FILE (final message) + events jsonl, never stdout.
#   brief-from-FILE  the brief is read from a file, not passed as a shell arg — avoids the
#                    quoting/escaping bugs that also silently corrupt invocations.
#   launch watchdog  within LIVENESS_S, the events MUST show `thread.started`; a stdin-hang shows
#                    "Reading additional input from stdin..." with NO thread.started → kill loud,
#                    so a hang costs ~30s not 15 min. A healthy run emits thread.started in ~1-2s.
#
# Usage:  scripts/codex-run.sh <read-only|workspace-write> <brief-file> <out-prefix>
#   out-prefix e.g. /tmp/codex-passA  ->  /tmp/codex-passA.out + /tmp/codex-passA.events.jsonl
# Run it via the Bash tool with run_in_background=true; it `wait`s on codex so the harness
# completion notification fires exactly when codex finishes (not before).
set -u

SANDBOX="${1:?sandbox: read-only | workspace-write}"
BRIEF_FILE="${2:?path to a file containing the brief}"
OUT="${3:?output prefix, e.g. /tmp/codex-passA}"
REPO="${CODEX_REPO:-/Users/eunice/src/MEV}"
LIVENESS_S="${CODEX_LIVENESS_S:-30}"

case "$SANDBOX" in read-only|workspace-write) ;; *) echo "codex-run: bad sandbox '$SANDBOX'" >&2; exit 2;; esac
[ -r "$BRIEF_FILE" ] || { echo "codex-run: brief not readable: $BRIEF_FILE" >&2; exit 2; }
BRIEF="$(cat "$BRIEF_FILE")"
[ -n "$BRIEF" ] || { echo "codex-run: brief is empty: $BRIEF_FILE" >&2; exit 2; }
: > "$OUT.out"; : > "$OUT.events.jsonl"

# launch codex in the background, stdin from /dev/null (THE guard)
caffeinate -i codex -s "$SANDBOX" -a never exec -C "$REPO" --json -o "$OUT.out" "$BRIEF" \
  < /dev/null > "$OUT.events.jsonl" 2>&1 &
CODEX_PID=$!
echo "codex-run: launched PID=$CODEX_PID sandbox=$SANDBOX repo=$REPO out=$OUT.out"

# launch-liveness watchdog: kill a stdin-hang (no thread.started within LIVENESS_S)
(
  for _ in $(seq 1 "$LIVENESS_S"); do
    grep -q '"type":"thread.started"' "$OUT.events.jsonl" 2>/dev/null && exit 0
    kill -0 "$CODEX_PID" 2>/dev/null || exit 0   # codex already exited; nothing to guard
    sleep 1
  done
  if ! grep -q '"type":"thread.started"' "$OUT.events.jsonl" 2>/dev/null; then
    echo "codex-run: WATCHDOG — no thread.started in ${LIVENESS_S}s (stdin-hang?); killing $CODEX_PID" >&2
    kill "$CODEX_PID" 2>/dev/null
  fi
) &
WATCHDOG_PID=$!

wait "$CODEX_PID"; CODEX_RC=$?
kill "$WATCHDOG_PID" 2>/dev/null   # reap the watchdog if codex finished fast
if grep -q '"type":"thread.started"' "$OUT.events.jsonl" 2>/dev/null; then
  echo "codex-run: done rc=$CODEX_RC — thread.started seen; judge by $OUT.out + git diff --stat"
else
  echo "codex-run: done rc=$CODEX_RC — NO thread.started (stdin-hang or immediate failure); inspect $OUT.events.jsonl" >&2
fi
exit "$CODEX_RC"
