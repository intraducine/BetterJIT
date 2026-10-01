#!/usr/bin/env python3
"""Prune reviewed remote heads only after proving history is preserved.

Dry run may fetch Git objects to prove ancestry; it never pushes or edits a
checkout. --apply archives existing retired heads and deletes them atomically.
Missing heads are accepted only with a verified archive or SDK ancestry.
"""
from __future__ import annotations
import argparse
import json
from pathlib import Path
import re
import subprocess
ROOT = Path(__file__).resolve().parents[1]


def plan_actions(plan, refs, ancestors=()):
    active = set(plan['active'])
    if not {'main', 'private/iridium-addon', 'feature/runtime-sdk'} <= active:
        raise ValueError('Missing protected development lanes.')
    if 'refs/heads/feature/runtime-sdk' not in refs:
        raise ValueError('Preserve the consolidated SDK branch first.')
    prefix = plan['tagPrefix']
    if not re.fullmatch(r'archive/[A-Za-z0-9._/-]+/', prefix) or '..' in prefix:
        raise ValueError('Unsafe archive tag prefix.')
    actions = []
    for branch, expected in plan['archive'].items():
        if branch in active or not re.fullmatch(r'[a-f0-9]{40}', expected):
            raise ValueError('Unsafe archive plan.')
        if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._/-]*[A-Za-z0-9]', branch) or '..' in branch or '//' in branch:
            raise ValueError('Unsafe branch name.')
        head, tag = 'refs/heads/' + branch, 'refs/tags/' + prefix + branch
        current, archived = refs.get(head), refs.get(tag)
        if archived is not None and archived != expected:
            raise ValueError('Archive tag differs from expected commit: ' + tag)
        if current is None:
            if archived != expected and expected not in ancestors:
                raise ValueError('Branch missing without verified archive or SDK ancestry: ' + branch)
            continue
        if current != expected: raise ValueError('Branch moved; review before cleanup: ' + branch)
        actions.append((head, tag, expected, archived is None))
    return actions


def git(*args):
    return subprocess.check_output(['git', '-C', str(ROOT), *args], text=True).strip()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    plan = json.loads((ROOT / 'maintenance/branch-plan.json').read_text())
    repository = plan['repository']
    remote = git('remote', 'get-url', 'origin')
    if remote not in {f'https://github.com/{repository}', f'https://github.com/{repository}.git',
                      f'git@github.com:{repository}.git', f'ssh://git@github.com/{repository}.git'}:
        raise ValueError('Origin must be the exact reviewed BetterJIT repository.')
    refs = dict((name, sha) for sha, name in (line.split('\t', 1) for line in git('ls-remote', '--refs', 'origin').splitlines()))
    sdk = refs.get('refs/heads/feature/runtime-sdk')
    if not sdk: raise ValueError('SDK branch is missing.')
    # Fetch immutable objects, not local branch refs. Never switch a worktree.
    git('fetch', '--no-tags', 'origin', sdk)
    ancestors = set()
    for expected in plan['archive'].values():
        if not re.fullmatch(r'[a-f0-9]{40}', expected): raise ValueError('Invalid expected commit.')
        exists = subprocess.run(['git','-C',str(ROOT),'cat-file','-e',expected+'^{commit}'],capture_output=True)
        if exists.returncode: git('fetch','--no-tags','origin',expected)
        check = subprocess.run(['git','-C',str(ROOT),'merge-base','--is-ancestor',expected,sdk],capture_output=True)
        if check.returncode == 0: ancestors.add(expected)
        elif check.returncode != 1: raise ValueError('Could not establish retired commit ancestry.')
    actions = plan_actions(plan, refs, ancestors)
    # Requiring ancestry also protects against an archive tag changing concurrently.
    if any(sha not in ancestors for _,_,sha,_ in actions):
        raise ValueError('A retired head is not in SDK history; preserve it before pruning. Shallow clones may need full history.')
    for head, tag, sha, create in actions:
        print(f'{head} @ {sha} -> {tag}; then prune head (history verified in SDK)')
    if not args.apply: print('Dry run; no push. --apply performs the leased atomic archive/prune.'); return
    if not actions: print('No remaining reviewed remote heads to prune.'); return
    leases, refspecs = [], []
    for head, tag, sha, create in actions:
        leases += [f'--force-with-lease={head}:{sha}', f'--force-with-lease={tag}:{"" if create else sha}']
        refspecs += [f'{sha}:{tag}', ':' + head]
    subprocess.run(['git','-C',str(ROOT),'push','--atomic',*leases,'origin',*refspecs],check=True)
    print('Retired heads archived/pruned; active and local branches unchanged.')

if __name__ == '__main__':
    try: main()
    except (ValueError, OSError, subprocess.CalledProcessError) as error:
        raise SystemExit('Cleanup stopped: ' + str(error))
