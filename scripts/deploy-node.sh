#!/usr/bin/env bash
# Safe node deploy: update /opt/MEV to latest origin/main and restart the dry-run searcher.
#
# Runs ON the EC2 node (SSM-only, no SSH). Bootstraps itself from git so it is always
# the latest version:
#   aws ssm send-command ... --parameters 'commands=[
#     "git -C /opt/MEV fetch origin -q && git -C /opt/MEV show origin/main:scripts/deploy-node.sh | sudo bash"]'
#
# Guarantees (the .env dry-run-guard lesson, baked in — see project-node-env-dryrun-guard):
#  - The searcher restarts in DRY-RUN. If SEARCHER_DRY_RUN=1 cannot be ensured, it ABORTS
#    WITHOUT restarting (never risk an accidental live broadcast).
#  - The full working env is recovered from the RUNNING process BEFORE reset, so a truncated
#    /opt/MEV/.env can never silently drop mempool/backend/RPC keys on restart.
#  - Dirty working-tree files are tar-backed-up before `git reset --hard`.
set -uo pipefail
REPO=/opt/MEV
ENVF=$REPO/.env
TS=$(date +%Y%m%d-%H%M%S)
say() { echo "[deploy $TS] $*"; }

# Non-SEARCHER keys the searcher needs. SEARCHER_* vars are recovered by prefix
# from the live process so deploy cannot silently drop tuning knobs.
NON_SEARCHER_KEYS="MAINNET_RPC_URL OWNER_PRIVATE_KEY BOTVM_ADDRESS BOTVM_OWNER"
OPP_TTL_MS="${SEARCHER_OPP_TTL_MS:-5000}"   # override via env when invoking

cd "$REPO" || { say "no $REPO"; exit 1; }

recover_running_env() {
  tr '\0' '\n' < "/proc/$PID/environ" | while IFS= read -r line; do
    [ -n "$line" ] || continue
    key=${line%%=*}
    case "$key" in
      SEARCHER_DRY_RUN|SEARCHER_OPP_TTL_MS)
        continue
        ;;
      SEARCHER_*)
        echo "$line"
        continue
        ;;
    esac
    for wanted in $NON_SEARCHER_KEYS; do
      if [ "$key" = "$wanted" ]; then
        echo "$line"
        break
      fi
    done
  done
}

# ── 1. Recover the full working env from the RUNNING process (ground truth) ──
PID=$(systemctl show -p MainPID --value mev-searcher 2>/dev/null)
if [ -n "$PID" ] && [ "$PID" != "0" ] && [ -r "/proc/$PID/environ" ]; then
  say "recovering env from running PID $PID"
  tmp=$(mktemp)
  recover_running_env > "$tmp"
  echo "SEARCHER_OPP_TTL_MS=$OPP_TTL_MS" >> "$tmp"
  echo "SEARCHER_DRY_RUN=1" >> "$tmp"
  cp -f "$ENVF" "$ENVF.bak-$TS" 2>/dev/null
  cp -f "$tmp" "$ENVF"; chmod 600 "$ENVF"; rm -f "$tmp"
  say "env rebuilt ($(wc -l < "$ENVF") keys) + DRY_RUN=1 + TTL=$OPP_TTL_MS"
else
  say "no running process to recover env from — ensuring DRY_RUN=1 in existing .env"
  tmp=$(mktemp)
  cp -f "$ENVF" "$ENVF.bak-$TS" 2>/dev/null
  if [ -f "$ENVF" ]; then
    grep -v -E '^(SEARCHER_DRY_RUN|SEARCHER_OPP_TTL_MS)=' "$ENVF" > "$tmp"
  fi
  echo "SEARCHER_OPP_TTL_MS=$OPP_TTL_MS" >> "$tmp"
  echo "SEARCHER_DRY_RUN=1" >> "$tmp"
  cp -f "$tmp" "$ENVF"; chmod 600 "$ENVF"; rm -f "$tmp"
fi

# ── 2. HARD broadcast-guard: refuse to continue unless DRY_RUN=1 is present ──
if [ "$(grep -c '^SEARCHER_DRY_RUN=1' "$ENVF")" != "1" ]; then
  say "ABORT: SEARCHER_DRY_RUN=1 not in $ENVF — not restarting (broadcast guard)."
  exit 9
fi

# ── 3. Backup dirty files, then update code ──
git ls-files -m -o --exclude-standard 2>/dev/null | grep -v node_modules > "/tmp/dirty-$TS.txt"
tar czf "$REPO-deploy-$TS.tar.gz" -T "/tmp/dirty-$TS.txt" 2>/dev/null
git fetch origin -q
git reset --hard origin/main || { say "reset failed"; exit 1; }
say "code now at $(git rev-parse --short HEAD): $(git log --oneline -1)"

# ── 4. Build ──
( cd "$REPO/listener" && npm run build ) || { say "build failed — NOT restarting"; exit 1; }

# ── 5. Restart + verify dry-run ──
RESTART_EPOCH=$(date +%s)
systemctl restart mev-searcher
sleep 8
ACTIVE=$(systemctl is-active mev-searcher)
NEWPID=$(systemctl show -p MainPID --value mev-searcher)
DRY=$(tr '\0' '\n' < "/proc/$NEWPID/environ" 2>/dev/null | grep -c '^SEARCHER_DRY_RUN=1')
say "restarted: active=$ACTIVE pid=$NEWPID dry_run_env=$DRY"
if [ "$DRY" != "1" ]; then
  say "WARNING: restarted process env has no DRY_RUN=1 — STOP and investigate."; exit 9
fi
BANNER=""
for _ in $(seq 1 60); do
  BANNER=$(journalctl -u mev-searcher --since "@$RESTART_EPOCH" -o cat --no-pager 2>/dev/null \
    | grep 'pool registry:' | tail -1)
  [ -n "$BANNER" ] && break
  sleep 1
done
if [ -z "$BANNER" ]; then
  say "ABORT: missing pool registry startup banner after restart."
  exit 9
fi
say "startup banner: $BANNER"
if echo "$BANNER" | grep -Eq '(^|[[:space:]])universe=0([^0-9]|$)|\+ 0 universe([^0-9]|$)'; then
  say "ABORT: pool universe loaded zero pools after restart."
  exit 9
fi
say "DONE — dry-run on latest main. backup: $REPO-deploy-$TS.tar.gz"
