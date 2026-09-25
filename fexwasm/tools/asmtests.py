#!/usr/bin/env python3
"""Runs FEX's ASM unit tests (FEX/unittests/ASM) through the wasm backend.

  tools/asmtests.py [-j N] [filter ...]

Assembles each test like FEX's CMake does (BITS 64 prepended, ret appended,
nasm -f bin), writes its config with FEX's Scripts/json_asm_config_parse.py,
runs out/fextest on it, and summarises the results. Build products go to
out/asm/. Filters are substrings of the test path.
"""
import collections, concurrent.futures, os, subprocess, sys

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FEX = os.environ.get('FEX_DIR', os.path.join(HERE, '..', '..', 'FEX'))  # the clone's FEX submodule
ASM = os.path.join(FEX, 'unittests', 'ASM')
OUT = os.path.join(HERE, 'out', 'asm')


def tests(filters):
    for root, dirs, files in os.walk(ASM):
        dirs[:] = sorted(d for d in dirs if not d.startswith(('Disabled_Tests', 'Known_Failures')) and d != 'Includes')
        for f in sorted(files):
            if f.endswith('.asm'):
                rel = os.path.relpath(os.path.join(root, f), ASM)
                if not filters or any(x in rel for x in filters):
                    yield rel


def build(rel):
    src = os.path.join(ASM, rel)
    base = os.path.join(OUT, rel[:-4])
    binf, cfg = base + '.bin', base + '.config.bin'
    if os.path.exists(binf) and os.path.exists(cfg) and os.path.getmtime(binf) > os.path.getmtime(src):
        return binf, cfg, None
    os.makedirs(os.path.dirname(base), exist_ok=True)
    tmp = base + '_TMP.asm'
    with open(src) as f:
        text = f.read()
    with open(tmp, 'w') as f:
        f.write('BITS 64\n' + text + '\nret\n')
    r = subprocess.run(['nasm', '-i', os.path.join(ASM, 'Includes') + '/', tmp, '-o', binf], capture_output=True, text=True)
    if r.returncode:
        return None, None, 'nasm: ' + r.stderr.strip().splitlines()[-1][:120]
    r = subprocess.run([sys.executable, os.path.join(FEX, 'Scripts', 'json_asm_config_parse.py'), src, cfg],
                       capture_output=True, text=True, cwd=os.path.join(FEX, 'Scripts'))
    if r.returncode or not os.path.exists(cfg):
        return None, None, 'config: ' + (r.stderr or r.stdout).strip()[-120:]
    return binf, cfg, None


def run(rel):
    binf, cfg, err = build(rel)
    if err:
        return rel, 'BUILD', err
    try:
        r = subprocess.run([os.path.join(HERE, 'out', 'fextest'), binf, cfg], capture_output=True, text=True, timeout=30,
                           env=dict(os.environ, FEXWASM_DIR=HERE))
    except subprocess.TimeoutExpired:
        return rel, 'TIMEOUT', ''
    line = (r.stdout.strip().splitlines() or [''])[-1]
    if r.returncode < 0:
        sig = -r.returncode
        tail = (r.stderr.strip().splitlines() or [''])[-1][:160]
        return rel, 'TIMEOUT' if sig == 14 else 'CRASH', f'signal {sig} {tail}'
    kind = line.split(' ', 1)[0] if line else 'ERROR'
    return rel, kind, line[len(kind):].strip() or (r.stderr.strip().splitlines() or [''])[-1][:160]


def main():
    args = sys.argv[1:]
    jobs = os.cpu_count() or 8
    if args[:1] == ['-j']:
        jobs, args = int(args[1]), args[2:]
    names = list(tests(args))
    results = []
    with concurrent.futures.ThreadPoolExecutor(jobs) as ex:
        for res in ex.map(run, names):
            results.append(res)
    counts = collections.Counter(k for _, k, _ in results)
    unsup = collections.Counter()
    for _, k, d in results:
        if k == 'UNSUP':
            unsup.update(set(e.split(' size')[0].replace('unsupported IR op ', '') for e in d.split('; ')))
    with open(os.path.join(OUT, 'results.txt'), 'w') as f:
        for rel, k, d in results:
            f.write(f'{k:8} {rel} {d}\n')
    ran = sum(counts[k] for k in counts if k not in ('SKIP',))
    print(f'{len(results)} tests: ' + ', '.join(f'{k} {v}' for k, v in counts.most_common()))
    print(f'pass rate of non-skipped: {counts["PASS"]}/{ran}')
    if unsup:
        print('\nunsupported ops (tests blocked by each, first failing unit only):')
        for op, n in unsup.most_common(int(os.environ.get('TOP', 60))):
            print(f'  {n:4} {op}')
    by_dir = collections.defaultdict(collections.Counter)
    for rel, k, _ in results:
        by_dir[rel.split('/')[0] if '/' in rel else '.'][k] += 1
    print('\nby directory:')
    for d in sorted(by_dir):
        c = by_dir[d]
        print(f'  {d:24} ' + ' '.join(f'{k}={v}' for k, v in sorted(c.items())))
    print(f'\nfull list: {os.path.relpath(os.path.join(OUT, "results.txt"))}')


if __name__ == '__main__':
    main()
