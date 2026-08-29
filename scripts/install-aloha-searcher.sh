#!/usr/bin/env bash
set -euo pipefail

ROOT=/opt/aloha
CLI="$ROOT/tools/runtime-release-packager/src/cli.ts"

case "${1:-}" in
  --check-package)
    if [[ $# -ne 3 ]]; then
      echo "usage: install-aloha-searcher.sh --check-package ABSOLUTE_PACKAGE_DIR ABSOLUTE_PACKAGE_APPROVAL" >&2
      exit 64
    fi
    exec /usr/bin/node --experimental-strip-types "$CLI" check-package --directory "$2" --signer-pin /etc/aloha/trust/runtime-release-signer-pin.json --approval "$3"
    ;;
  --check-installed)
    if [[ $# -ne 1 ]]; then
      echo "usage: install-aloha-searcher.sh --check-installed" >&2
      exit 64
    fi
    exec /usr/bin/node --experimental-strip-types "$CLI" check-installed
    ;;
  *)
    echo "installer is verification-only: use --check-package or --check-installed" >&2
    exit 64
    ;;
esac
