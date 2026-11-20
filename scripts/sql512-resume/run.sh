#!/usr/bin/env bash
# Explicit manual resume of the deployed SQL 512-table dry-run. No default
# start, no restart loop, no wallet configuration and no per-run file edits.
set -euo pipefail
umask 077
action=${1:---check}
[[ $# -le 1 && ( "$action" = --check || "$action" = --start ) ]]
root=/opt/mev-cloud/work/impl-aligned-84e18ec3
store=/opt/mev-cloud/sql512-dry-runtime
bin=/opt/mev-cloud/node-v26.0.0-linux-x64/bin/node
unit=mev-sql512-dryrun.service
[[ $(id -un) = eunice && $(hostname -f) = mev-impl-c4d-20261002.us-east1-b.c.eth-token-480803.internal ]]
safe_root_file(){
  [[ -f "$1" && ! -L "$1" && $(stat -c '%u' "$1") = 0 && $(readlink -f "$1") = "$1" ]]
  local oct; oct=$(stat -c '%a' "$1"); (( (8#$oct & 022) == 0 ))
}
safe_root_file "$store/active-release"
read -r release < "$store/active-release"
[[ "$release" =~ ^[a-f0-9]{64}$ ]]
pkg="$store/$release"
safe_root_file "$pkg/SHA256SUMS"
[[ $(sha256sum "$pkg/SHA256SUMS" | cut -d' ' -f1) = "$release" ]]
(
  cd "$pkg"
  while read -r hash file; do
    [[ "$hash" =~ ^[a-f0-9]{64}$ && "$file" =~ ^[a-z][a-z0-9.-]+$ ]]
    safe_root_file "$pkg/$file"
  done < SHA256SUMS
  sha256sum --strict --status -c SHA256SUMS
)
cd "$root"
[[ $(systemctl show "$unit" -p MainPID --value) = 0 ]]
state=$(systemctl show "$unit" -p ActiveState --value)
[[ "$state" = inactive || "$state" = failed ]]
preview=$("$bin" --import ./listener/node_modules/tsx/dist/loader.mjs "$pkg/official-current.mjs" --check-current)
parent=$("$bin" -e 'const p=JSON.parse(process.argv[1]); if(p.action!=="read_only_preflight"||p.dry!==true||!/^[a-f0-9]{64}$/.test(p.priorTerminalSha256))process.exit(1);process.stdout.write(p.priorTerminalSha256)' "$preview")
echo "$preview"
[[ "$action" = --start ]] || exit 0
# Starting the already-active name fails; do not replace/stop another run.
if [[ "$state" = failed ]]; then sudo -n systemctl reset-failed "$unit"; fi
sudo -n systemd-run --unit="$unit" --uid=eunice --service-type=exec --working-directory="$root" \
  --property=Restart=no --property=KillMode=control-group --property=TimeoutStopSec=25s \
  --property=RuntimeMaxSec=16260s --property=MemoryMax=13G --property=MemorySwapMax=0 \
  --property=NoNewPrivileges=yes --property=LoadCredential=rpc:/opt/mev-cloud/manual-live/rpc-private.json \
  "$bin" --import ./listener/node_modules/tsx/dist/loader.mjs "$pkg/official-current.mjs" --resume-current "$parent"
systemctl show "$unit" -p ActiveState -p MainPID -p InvocationID -p Restart
