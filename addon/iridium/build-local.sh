#!/usr/bin/env bash
# Rebuild the add-on, refresh its private snapshot, then use Iridium's own
# local runtime/build checks. No signing, installation, Git push or upload.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
DEST=${1:?usage: bash addon/iridium/build-local.sh /path/to/private-iridium-checkout}
DEST=$(cd "$DEST" && pwd)
[[ "$(uname -s)" == Darwin ]] || { echo 'The iOS build requires macOS and Xcode.' >&2; exit 1; }
[[ -f "$DEST/.betterjit-addon/manifest.json" ]] || { echo 'Not a prepared private checkout.' >&2; exit 1; }
[[ -z "$(git -C "$DEST" remote)" ]] || { echo 'Private checkout has a Git remote; refusing to build.' >&2; exit 1; }
cd "$ROOT"
bash scripts/prepare-fex.sh
bash fexwasm/build_ios.sh
python3 addon/iridium/sync.py "$DEST"
cd "$DEST"
# This private copy retains the upstream runtime prerequisite and provenance checks.
bash ci/build-betterjit-private.sh
