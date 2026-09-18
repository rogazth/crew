#!/usr/bin/env bash
# Installs the six npm projects under design/. They are deliberately separate:
# each prototype pins its own dependencies so one cannot quietly change another.
#
#   ./design/install.sh            # everything
#   ./design/install.sh proto-ink  # just one
set -euo pipefail

cd "$(dirname "$0")"
if [ "$#" -gt 0 ]; then
  targets=("$@")
else
  targets=(shared tools proto-ink proto-console proto-canvas live-check)
fi

for dir in "${targets[@]}"; do
  [ -f "$dir/package.json" ] || { echo "skip $dir (no package.json)"; continue; }
  printf '── %s\n' "$dir"
  (cd "$dir" && npm install --no-audit --no-fund --silent)
done

cat <<'DONE'

Ready.

  cd design/proto-ink     && npm run dev    # http://localhost:5181
  cd design/proto-console && npm run dev    # http://localhost:5182
  cd design/proto-canvas  && npm run dev    # http://localhost:5183

Switches (same in all three):

  ?stress=heavy                400 sessions, 5000-block transcripts, 20k files
  ?source=live                 a real crewd — needs `cargo build -p crewd` first
  #/session/s-harness          any surface is addressable; see design/BRIEF.md

Checks:

  cd design/shared && npm test          154 tests on the shared layer
  node design/tools/check-all.mjs       typecheck + build, everything
  node design/tools/smoke.mjs           every route, both themes, in a browser
DONE
