# Contributing

Keep changes focused, preserve upstream notices and state what was actually tested.
Start from a new branch. Do not commit credentials, profiles, device identifiers,
raw personal logs, games, local configuration or built apps. Do not change repository
visibility, sign, install, upload or publish merely because a source change is merged.

Configuration and host compatibility belong in `addon/iridium`; translator behavior
belongs in `fexwasm`; publication selection belongs in `distribution`. Keep public
Iridium untouched unless separately authorized. Local push guards remain enabled
regardless of whether the add-on source is eventually public.

Run `bash scripts/check-addon.sh`, the applicable existing research tests, and
`git diff --check`. Compilation, device execution and game support are separate
evidence levels. Add regression tests for changed configuration, copying, lifecycle,
protocol or code-generation behavior; never relax a check to conceal a failure.

Review exact source-export paths and fixture hashes when adding distributable files.
No automated script can certify absence of all secrets or resolve all third-party
licensing questions. Follow `docs/publishing.md` for an actual publication.
