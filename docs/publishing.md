# Publication preparation

## Source publication is a separate decision

The generalized branch remains suitable for private testing. No script changes
repository visibility, creates a release, uploads a package, signs an IPA or
pushes to public Iridium. Source export and local app building are separate.

Do not make the existing research repository public merely because this branch
looks clean. A branch is not a privacy boundary: other branches, commit history,
issues, pull requests and previous build outputs need their own review. GitHub
explicitly warns that Actions history/logs become public with repository visibility.
Primary reference: https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/managing-repository-settings/setting-repository-visibility

Prefer a fresh repository initialized from a reviewed export. Do not copy `.git`,
old refs or old release artifacts into that repository. Retain attribution,
license notices, patch provenance and the exported source manifest.

## Local export workflow

1. Commit intended source changes. `export-source.py` rejects tracked local edits
   and reads only committed blobs. Ignored and untracked files are not exported.
2. Run `bash scripts/check-addon.sh` and the applicable full-research tests.
3. Run `python3 scripts/export-source.py --check`, then export to a new `.tar.gz`
   path outside the checkout. This step performs no network requests.
4. Extract it into an empty folder. Inspect every allowlisted file, including
   fixture data, source comments and attribution. Automated pattern checks are
   deliberately not described as a complete secret scanner or license audit.
5. Run `bash scripts/check-addon.sh` from the extracted folder and rehearse local
   preparation/building from that source. Hash manifests support sources without
   Git; altered files are reported as dirty, not silently claimed as original.
6. Only after that review, decide whether to initialize a new public repository
   or distribute the archive. This tooling does not make that decision for you.

`distribution/source-files.txt` is the export contract: exact relative paths,
not directory globs. A new file is excluded until explicitly reviewed and added.
The binary fixture inventory pins each included guest image and identifies its
build sources. Modifying a fixture requires reviewing its source/provenance and
updating its hash. The included images are imported research fixtures, not
independently reproduced binaries. They contain test programs, not games.

Archive timestamps, numeric owners, owner names, file order and gzip headers are
normalized. Only file bytes, executable modes and the recorded source revision
vary between revisions. The output is created exclusively; existing files are
never overwritten. The manifest is not cryptographically signed.

## Licenses and provenance

Read `THIRD_PARTY.md`, `COPYING`, per-file headers and upstream dependency notices.
Keep the CoreMark acceptable-use/trademark notice separate from the Apache-2.0
code license. Do not advertise modified benchmark results as official scores.
Preserve upstream author notices; a privacy pass must not strip attribution.

FEX is pinned plus a local patch, but its full recursive source is fetched at
build time, not bundled by this small source exporter. A source candidate here
is **not** a corresponding-source package for a complete Iridium binary.

Before distributing an IPA, collect and review the actual linked Iridium,
FEX, Wine, DXMT, media libraries and other dependency sources/patches, required
notices and build/relink instructions for that exact artifact. Preserve the host's
existing packaging checks. This branch provides no IPA publication workflow and
makes no claim of completed binary-license compliance or App Store approval.
Primary license text: https://www.gnu.org/licenses/gpl-3.0.html

## Validation record for a future release

Record separately: source commit; source archive hash; toolchain; build result;
physical device/OS; workload; input; output checksums or observed rendering;
audio/save/shutdown checks if applicable; and untested capabilities. Do not publish
raw device identifiers, private paths, credentials, game data or personal logs.
A successful export, compiler invocation or CPU fixture is not a game-runtime
compatibility result.

## Updating compatibility

Profiles contain the entire set of integration hashes, not independent accepted
hashes per file. Review changed callers/build behavior, keep existing profiles
for reproducibility, add one new profile, add matching upstream source fixtures,
and run the safety tests. Explicit `--ref` never skips validation. The default
is a pinned reviewed source revision, not an assertion about the newest release.
