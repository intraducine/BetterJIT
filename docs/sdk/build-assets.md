# Reusable build assets

For a source checkout with the exact previously prepared Wine root and its
retained probe report, run one bounded local iteration:

```sh
# Linux x86_64 frontend diagnostics; use the normal host environment on arm64 macOS.
BETTERJIT_HOST_DEBUG_X86=1 python3 scripts/iterate-sparse.py run \
  --family word-compare --family read-arithmetic \
  --wine-root .build/device-linuxroot \
  --input-identity /path/to/retained/sparse-wine-bootstrap-results.json
```

The command verifies Wine/musl hashes, provenance and the unchanged probe
budget before building. It fingerprints the checkout, verifies the patched FEX
pin and recursive dependencies, and calls `Backends/FEX/build-host.sh` with only
the selected native test tools and server. Compiler depfiles, source/header
hashes, compiler/recipe identity and output hashes govern local object reuse.
Changed backend code recompiles that object; changed embedded build identity
recompiles the translator. Frontend receipts verify native libraries and generated
headers; missing or incompatible receipts trigger a clean frontend rebuild.
Tests always execute anew. Add `--expected-source SHA256` to require an exact
source fingerprint, or `--regressions-only` to explicitly omit unavailable Wine inputs.

Each invocation writes a fresh `.build/iterations/...` directory containing
`result.json`, `result.txt`, source identity, selected regression reports, the
unchanged Wine probe report and per-command logs. Nonzero subprocess exits and
timeouts remain failures. A passing bounded Wine prefix returns nonzero with
the first unsupported bytes/RIP; it never establishes command completion.
Runtime retirement acknowledgement and later host teardown remain separate.
This Linux frontend configuration is actual FEX-to-Wasm evidence, not native
FEX JIT, Apple compilation or device execution. No full Apple build or large
evidence archive is required for each local instruction iteration.

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
adapter sources. The portable bundle preserves the native `ASSET-MANIFEST.json`
byte for byte and links its hash from `PACKAGE-MANIFEST.json`; copied native files
must match that producer receipt. Its scope remains the original producer output,
of which the portable native package contains a subset. Older local packages
without a receipt remain explicitly unidentified rather than acquiring invented
producer provenance. Native validation requires the XCFramework slice's headers
and module map as well as the library, with matching producer header copies.

The first run after a recipe/key-format change fills new caches. A later compatible
run must show validated cache hits and skipped producer compilation, while all
current-source tests and final assemblies still run. Hermetic tests exercise the
accept/reject rules; only an observed CI hit establishes that remote reuse worked.
