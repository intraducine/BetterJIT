# BetterJIT for Iridium

An experimental **source add-on** for locally rebuilt Iridium. FEX runs natively,
translates selected x86-64 code to WebAssembly, and the bundled lab executes it
in WKWebView. No native-process JIT activation is performed by the lab.

**Current scope: CPU fixtures and integration research, not a replacement game
backend.** Normal Iridium game launches are unchanged. This repository does not
include the complete Wine/rootfs/DXMT WebView game runtime. A passing CPU test
is not evidence of working games, App Store acceptance, or a performance target.

## Local setup

Use Python 3.9+, Git, and a committed Iridium checkout. Building requires a Mac
with Xcode, CMake, Ninja and XcodeGen. Native FEX tooling targets Apple silicon.
The first build fetches pinned dependencies; bundled lab execution is local.

From this source directory:

```sh
python3 addon/iridium/prepare.py \
  --iridium /path/to/iridium \
  --output /path/to/Iridium-Lab \
  --bundle-id org.example.iridium.betterjit \
  --display-name "Iridium Lab"
bash addon/iridium/build-local.sh /path/to/Iridium-Lab
```

Replace the paths and example bundle ID with your own. A helper identifier is
derived from the app identifier. The scripts do not read signing material,
sign, install, upload or publish. Sign the resulting unsigned app separately
using your own local workflow.

For repeatable settings, copy `addon/iridium/config.example.json` outside the
repository (or to an ignored `*.local.json` file), then pass `--config PATH`.
CLI identity options override that file. Unknown settings and invalid identifiers
are rejected before copying the host. Signing identities are intentionally not
accepted as configuration.

Omitting identity options preserves the earlier `software.iridium.betterjit-local`
and **Iridium Lab** defaults. Internal `private` class names, compilation flags
and generated project filenames remain stable for existing local integrations;
they are not a username restriction or a license restriction.

## Reviewed host compatibility

`addon/iridium/host-profiles.json` contains complete, reviewed integration-file
hash sets. The default remains `madeira-20260926`: Iridium
`update/madeira-upstream` at `f89099fa8810261fdffd334b2d4cd87e98b92ad1`.
The earlier `main-20260925` profile is also available. This update does not
silently retarget a newer moving branch.

Use `--host-profile main-20260925` to select its pinned revision, or `--ref SHA`
for a locally available committed revision with a matching reviewed profile.
An explicit profile plus incompatible integration hashes is rejected. Preparation never
fetches, switches the source working branch or falls back to another commit.
New host support requires reviewing and committing a complete profile; there
is no force/skip-hash option. These hashes validate integration points, not
every transitive runtime dependency or physical-device compatibility.

## Isolation and iteration

Preparation creates a separate checkout, copies committed host source only,
removes its remotes, blocks accidental pushes and disables its host workflows.
The original host is untouched. Existing output directories are never replaced.
The generated source overlay and local build script are not intended for a
public Iridium pull request.

Edit BetterJIT and rerun `build-local.sh` to refresh its owned snapshot. Refresh
preserves the configured app identity and refuses to overwrite local snapshot
edits. It does not upgrade the underlying Iridium checkout; create another output
directory for a host upgrade. Archive-based source distributions are supported
through `SOURCE-MANIFEST.json` and per-file checksums instead of requiring a
BetterJIT Git checkout. Those checksums are provenance diagnostics, not signatures.

Open **BetterJIT Lab** in Iridium's library, close any active game, and select an
x86-64 or Win64 test. Logs stay local unless you explicitly share them. The lab
checks WebKit capabilities at runtime. No performance or entitlement bypass is
promised for another device or OS.

## Tests

```sh
bash scripts/check-addon.sh
```

This runs configuration, checkout and distribution safety tests, including
clean-export use without `.git`. Tests use synthetic repositories/assets; they
do not compile or run Iridium. The full research checkout also retains
`bash scripts/check.sh` for the existing native/translated tests. Historical
results under `WasmProbe/results` are not measurements of this generalized add-on.

## Preparing a publication later

Nothing in this branch publishes automatically or changes repository access.
Optional Actions workflows are manual, read-only and do not upload artifacts.
They no longer depend on a particular GitHub username or private visibility.

After committing your selected source changes:

```sh
python3 scripts/export-source.py --check
python3 scripts/export-source.py --output /path/outside/repo/BetterJIT-source.tar.gz
```

The exporter uses a reviewed **exact-path allowlist**, committed bytes and pinned
binary-fixture checksums. It excludes research logs, private settings, signing
files, built IPAs and Git history. It refuses symlinks, unexpected binaries,
missing notices, suspicious credentials and existing output files. Its manifest
records the source revision and each payload hash; repeated exports of the same
revision are byte-identical.

This is a source candidate for human review, not a legal or security certification.
See [publishing](docs/publishing.md) before changing visibility or distributing
anything. The recommended first public release is a reviewed clean source
snapshot in a new repository, **not making this research repository public**.
See [THIRD_PARTY.md](THIRD_PARTY.md), `COPYING` and the retained component notices.
