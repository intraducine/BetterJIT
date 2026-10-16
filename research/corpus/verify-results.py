#!/usr/bin/env python3
"""Enforce export limits and emit explicit untested layers after infrastructure failure."""
import hashlib
import json
import shutil
import sys
from pathlib import Path

root = Path(sys.argv[1])
spec = json.loads((Path(__file__).parent / 'pilot.json').read_text())
assertions = json.loads((Path(__file__).parent / 'assertions.json').read_text())
results = root / 'results'
results.mkdir(parents=True, exist_ok=True)
for layer in ['oracle', 'single', 'block500', 'multi500', 'wasm']:
    path = results / (layer + '.jsonl')
    if not path.exists():
        rows = [{'schema': 2, 'comparisonContract': assertions['contract'],
                 'fixture': f['path'], 'sourceSHA256': f['sourceSHA256'],
                 'layer': layer, 'status': 'untested', 'semanticPass': None, 'rawExitCode': None,
                 'reason': 'layer did not produce an execution ledger; inspect workflow infrastructure/build outcome'}
                for f in spec['fixtures']]
        path.write_text(''.join(json.dumps(r, sort_keys=True) + '\n' for r in rows))
    rows = [json.loads(line) for line in path.read_text().splitlines()]
    assert [r['fixture'] for r in rows] == [f['path'] for f in spec['fixtures']], 'missing/duplicate/reordered fixture outcomes'
    assert all(r['layer'] == layer for r in rows), 'wrong layer'
manifest = {}
files = sorted((root / 'inputs').glob('*')) + sorted(results.glob('*'))
for source in sys.argv[2:]:
    path = Path(source)
    if path.is_file():
        target = results / (path.parent.name + '-' + path.name)
        shutil.copyfile(path, target)
        files.append(target)
for path in sorted(set(files)):
    if not path.is_file() or path.suffix not in ['.json', '.jsonl', '.asm', '.bin', '.lst']:
        continue
    assert not path.is_symlink(), 'symlink in evidence'
    data = path.read_bytes()
    manifest[str(path.relative_to(root))] = {'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()}
manifest.pop('results/files.json', None)
export = root / 'export'
if export.exists():
    shutil.rmtree(export)
export.mkdir()
total = sum(f['bytes'] for f in manifest.values())
if total > spec['budgets']['maximumResultArtifactBytes'] - 65536:
    (export / 'budget-failure.json').write_text(json.dumps({'status':'failure','reason':'artifact byte budget exceeded','files':manifest},indent=2)+'\n')
    raise SystemExit(1)
for relative in manifest:
    target = export / relative
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(root / relative, target)
(export / 'files.json').write_text(json.dumps(manifest, indent=2, sort_keys=True) + '\n')
print(json.dumps({'files': len(manifest), 'bytes': sum(f['bytes'] for f in manifest.values()), 'coveragePercentage': None}))
