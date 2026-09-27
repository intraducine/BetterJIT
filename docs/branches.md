# Branch maintenance

Keep `main`, `feature/runtime-sdk`, and `private/iridium-addon` as the active lanes.
Use the existing consolidated SDK PR instead of opening a duplicate for each
hardening change. The private adapter and repository visibility are unchanged.

The retired FEX, WKWebView, and publishable-Iridium work is already ancestral to
the SDK. The two deleted IKEv2/interface experiments are retained through an
ancestry-only merge: the SDK tree is unchanged by that preservation commit.
Their files are not restored and no extra archive branch is created. The clean
SDK source export excludes Git history, as before.

`python3 scripts/cleanup-branches.py` reads remote refs and may fetch immutable
Git objects to prove ancestry, but does not push or edit local worktrees. With
`--apply`, matching remaining retired heads are archived under the plan's tag
prefix and pruned using one atomic leased push. Active branches, moved branch
tips, conflicting tags, and unproven history cause refusal. Missing heads with
verified SDK ancestry are accepted even when they were deleted without tags.

A shallow clone may need full history before ancestry can be established. The
script never guesses or treats a missing commit as preserved. Remote deletion
and tag creation require authenticated Git write access. The GitHub connector
used for source commits does not expose those mutations, so code updates alone
must not be described as having deleted the remaining heads.
