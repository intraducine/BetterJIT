# Reusable build assets

The device-session workflow reuses prepared inputs and compiled components across
consumer commits. It always reruns the current SDK/session tests, live host cases,
adapter generation, SDK export, complete app build, independent consumer build and
final payload audit. A previous app or test result is never a reusable asset.

| Asset | Compatibility inputs | Retained outputs |
| --- | --- | --- |
| Wine input snapshot | Both preparation scripts, extractor, Wine patch, native contract helpers, Win64 fixture, pinned Wine commit and Alpine image, preparation environment | Stock root plus matching adapted Wine/prefix, exact dependency inventories, source archive, patch, notices and build evidence |
| Native iOS FEX | Translator sources, all embedded build-ID recipes, frontend pin/patch, packaging recipe, COPYING, selected compiler/build tools and Apple SDK identities | Device-arm64 native package and XCFramework |
| Host FEX translator | Translator and server sources, all embedded build-ID recipes, frontend pin/patch, host recipe, selected compiler/build tools and Apple SDK identities | arm64 host translator |

Wine stock and adapted outputs are cached together because the adapted candidate
references stock files and modifies their portable link/mode manifests. Their
matching source and preparation evidence travels with the snapshot. Alpine runtime
and build dependencies currently resolve from signed repositories; they are not
all version-locked. The manifest records the exact installed-package inventories
and build compiler identity, and fingerprints that dependency snapshot. Reuse means
reuse of those verified bytes, not a claim that fresh package resolution is
reproducible or that the snapshot contains the latest package updates. A successful
native prefix is required before a Wine snapshot can be cached.

`scripts/build-assets.py` computes component identities from file contents and
actual selected tools. Both FEX identities include `build.sh`, `build_ios.sh` and
`build_id.sh`, since those inputs affect the embedded translator identity. UI and
ordinary documentation changes do not invalidate native components. Changed native
notices, recipes, compilers, SDKs or upstream pins do.

Each `ASSET-MANIFEST.json` records full inputs, a dependency fingerprint, producer
repository/workflow/run/attempt/commit and successful component step, plus every
output's hash, length and mode. Restores check that manifest, required output shape,
all hashes and an expiry of fourteen days before using a component. Missing,
incomplete, expired, mismatched or corrupt assets are discarded only from their
dedicated generated directory and rebuilt. Cache service failures also rebuild.
Symlinks and special files are rejected. Wine archives are extracted into fresh
staging with path, duplicate, member-type and size checks before installation.

Cache lookup uses the complete component compatibility hash; its only prefix
fallback selects producer run IDs under that exact hash. There is no fallback to a
different source/toolchain identity. Producer metadata is checked within GitHub's
repository/branch cache trust boundary; it is not a cryptographic attestation from
an independent producer. A successful component is sealed and saved before later
app checks, so a downstream app failure need not discard valid native work.

Manual runs expose `rebuild_assets` to bypass all restores. They still validate and
save successfully rebuilt components. `asset-usage/*.json` and the final
`BUILD-MANIFEST.json` distinguish built/reused inputs and their original producers
from the exact consuming app commit. The full producer checkout is required to
compute FEX identities; SDK consumers use the exported native package and current
adapter sources.

The first run after a recipe/key-format change fills new caches. A later compatible
run must show validated cache hits and skipped producer compilation, while all
current-source tests and final assemblies still run. Hermetic tests exercise the
accept/reject rules; only an observed CI hit establishes that remote reuse worked.
