#!/usr/bin/env bash
set -euo pipefail
LISTENER="$(cd "$(dirname "$0")/.." && pwd)"
STEM="$1"; shift
ENTRY="$LISTENER/src/searcher/venues/production-families/$STEM.production.ts"
BACKUP="$(mktemp)"
cp "$ENTRY" "$BACKUP"
cleanup() { cp "$BACKUP" "$ENTRY"; rm -f "$BACKUP"; }
trap cleanup EXIT
node --import tsx "$LISTENER/.migration-arcana/render-entry.ts" "$STEM" > "$ENTRY"
cd "$LISTENER"
node --import tsx --test "$@"
