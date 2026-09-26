#!/usr/bin/env python3
"""Archive exact reviewed branch tips and prune them in one atomic Git push.

Dry-run by default. Never deletes main, the private experiment lane, local
branches, worktrees, or unique history. Does not merge or change visibility.
"""
from __future__ import annotations
import argparse
import json
from pathlib import Path
import re
import subprocess

ROOT = Path(__file__).resolve().parents[1]

def plan_actions(plan, refs):
    active = set(plan['active'])
    if 'main' not in active or 'private/iridium-addon' not in active or 'feature/runtime-sdk' not in active:
        raise ValueError('Missing protected development lanes.')
    if 'refs/heads/feature/runtime-sdk' not in refs:
        raise ValueError('Create and preserve the consolidated SDK branch first.')
    actions = []
    for branch, expected in plan['archive'].items():
        if branch in active or not re.fullmatch(r'[a-f0-9]{40}', expected):
            raise ValueError('Unsafe archive plan.')
        head, tag = 'refs/heads/' + branch, 'refs/tags/' + plan['tagPrefix'] + branch
        current, archived = refs.get(head), refs.get(tag)
        if archived is not None and archived != expected:
            raise ValueError('Archive tag differs from expected commit: ' + tag)
        if current is None:
            if archived != expected: raise ValueError('Branch missing without verified archive: ' + branch)
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
    allowed = {f'https://github.com/{repository}', f'https://github.com/{repository}.git',
               f'git@github.com:{repository}.git', f'ssh://git@github.com/{repository}.git'}
    if remote not in allowed: raise ValueError('Origin must be the exact reviewed BetterJIT repository.')
    refs = {}
    for line in git('ls-remote', '--refs', 'origin').splitlines():
        sha, name = line.split('\t', 1); refs[name] = sha
    actions = plan_actions(plan, refs)
    for head, tag, sha, create in actions:
        print(f'{head} @ {sha} -> {tag}; archive {"create" if create else "verified"}, then prune head')
    if not args.apply:
        print('Dry run only. --apply performs the exact archive/prune push atomically.'); return
    if not actions: print('All planned branches already archived.'); return
    # Fetch only the reviewed refs; this does not switch or edit a working tree.
    git('fetch', '--no-tags', 'origin', *[head for head, _, _, _ in actions])
    leases, refspecs = [], []
    for head, tag, sha, create in actions:
        leases.append(f'--force-with-lease={head}:{sha}')
        if create:
            leases.append(f'--force-with-lease={tag}:')
            refspecs.append(f'{sha}:{tag}')
        refspecs.append(':' + head)
    # Server-side atomicity + leases preserve all history if any ref moved.
    subprocess.run(['git', '-C', str(ROOT), 'push', '--atomic', *leases, 'origin', *refspecs], check=True)
    print('Archived and pruned reviewed remote branches. Local branches and active lanes are unchanged.')

if __name__ == '__main__':
    try: main()
    except (ValueError, OSError, subprocess.CalledProcessError) as error:
        raise SystemExit('Cleanup stopped: ' + str(error))
