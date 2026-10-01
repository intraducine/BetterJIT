#!/usr/bin/env python3
"""Prints the bigmem / app_pager lines of a results log compactly."""
import json, sys
for line in open(sys.argv[1]):
    if not line.startswith('@@R '):
        continue
    r = json.loads(line[4:])
    if r.get('op') == 'bigmem' and 'result' in r:
        x = r['result']
        print(f"bigmem backing={x['backing']:4} span={x['spanGB']}GB hot={x['hotMB']}MB@{x['hotPct']}% n={x['n']} direct={x.get('direct')}")
        for rd in x['rounds']:
            print('    ', {k: rd[k] for k in ('round', 'nsPerAccess', 'pageIns', 'minor', 'writeBacks', 'usPerPageIn', 'chk')})
    elif r.get('op') == 'bigmem':
        print('bigmem error:', r.get('error'))
    elif r.get('suite') in ('app_pager', 'opfs_bigmem', 'webcontent-terminated'):
        print({k: v for k, v in r.items() if k in ('suite', 'served', 'appFootprintMB', 'appAvailableMB', 'webcontentAliveAfter', 'error')})
