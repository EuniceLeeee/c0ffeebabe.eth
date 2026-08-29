#!/usr/bin/env bash
set -euo pipefail

ROOT=/opt/aloha

case "${1:-}" in
  --check-start|--check-restart)
    if [[ $# -ne 1 ]]; then
      echo "usage: deploy-aloha-searcher.sh --check-start|--check-restart" >&2
      exit 64
    fi
    exec "$ROOT/scripts/install-aloha-searcher.sh" --check-installed
    ;;
  *)
    echo "deployment is verification-only: use --check-start or --check-restart" >&2
    exit 64
    ;;
esac
