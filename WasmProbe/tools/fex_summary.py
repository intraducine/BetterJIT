#!/usr/bin/env python3
"""Summarises fexkernels vs native_fexkernels from a results log."""
import json, sys
nat, rows = {}, []
for line in open(sys.argv[1]):
    if not line.startswith('@@R '):
        continue
    r = json.loads(line[4:])
    if r.get('suite') == 'native_fexkernels':
        nat[r['kernel']] = r['ms']
    elif r.get('suite') == 'fexkernels' and 'kernel' in r:
        rows.append(r)
    elif r.get('suite') == 'fexkernels' and 'stats' in r:
        print('runtime stats:', r['stats'])
print(f"{'kernel':9} {'native ms':>10} {'x86->wasm':>10} {'ratio':>7} {'match':>6} {'Mac ratio':>10}")
for r in rows:
    n = nat.get(r['kernel'], float('nan'))
    print(f"{r['kernel']:9} {n:10.1f} {r['ms']:10.1f} {r['ms'] / n:7.2f} {str(r['match']):>6} {r['macWasmMs'] / r['macNativeMs']:10.2f}")
