# SDK source publication

The SDK is a standalone package, not the Iridium overlay. In the full repository,
commit selected SDK changes and use `python3 scripts/export-sdk.py --check`, then
`python3 scripts/export-sdk.py --output /outside/repository/BetterJIT-SDK.tar.gz`.
The exact-path allowlist creates a package with only the three public SDK products,
its standalone example, API tests, documentation and licenses. No Iridium checkout,
raw logs, old Git history, user settings or native binary is included. The FEX
service interface and concrete binding source are included; the optional native
FEX compiler/package must be obtained/built separately from the full source tree.

Extract and run `bash scripts/check-sdk.sh`. On a Mac also compile the WebKit target
and standalone iOS example. Run a physical-device test without a debugger, verify
startup, compute results, native service responses, cancellation, recovery and
memory-pressure behavior. Record the actual commit, device and OS; do not generalize
a Chromium fixture replay into an iOS/game/performance claim.

Before publication, review the selected source, imported FEX runtime provenance,
licenses, security boundaries and signing/distribution requirements. The exporter
has deterministic hashes and basic rejection checks, not legal or security
certification. The current package is GPL-3.0-or-later; this change does not grant
new permissions to relicense dependencies or make unsupported App Store claims.

Use a clean reviewed source snapshot for an initial public SDK repository rather
than exposing this research repository and all archived branches. Publishing a
source package, distributing native backend binaries and submitting an app are
separate decisions. None is automated here. The current repository stays private.

Version protocol/backend capabilities explicitly. Native execution, OPFS fast-path
transport, multithreaded guest process support, OS compatibility and renderers are
separate integrations; do not mark them implemented because the API is extensible.
