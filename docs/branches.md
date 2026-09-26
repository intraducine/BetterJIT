# Development lanes

`feature/runtime-sdk` is the consolidated app-independent SDK track. It descends
from `feature/publishable-iridium-addon` and includes PR #3/#4 through their existing
merge ancestry. `private/iridium-addon` remains the user's frozen local experiment
lane. `main` is unchanged pending review and Apple/device validation.

The prototype branches are no longer separate active development directions.
The interface/localhost experiments contain unique history: preserve their exact
tips rather than assuming they were merged. `maintenance/branch-plan.json` records
all five reviewed retired branch tips. `scripts/cleanup-branches.py` first verifies
them and plans archive tags. `--apply` uses an atomic, leased Git push to create
any missing archive tags and delete only those reviewed remote heads. It refuses
moved refs and never overwrites tags or touches local worktrees. It does not create
releases or make the repository public.

The GitHub connector available during this change can close superseded PRs but
cannot delete branch refs or create tag refs. The branch-deletion plan therefore
remains a separate local maintainer command, not an action claimed as completed:

```sh
python3 scripts/cleanup-branches.py
python3 scripts/cleanup-branches.py --apply
```

Reopening a historical PR or restoring a branch from its archive tag is possible.
Archive tags are historical references, not stable SDK versions. Do not publish
this repository's whole history as the SDK distribution.
