#!/usr/bin/env python3
"""Histogram of IR op names in fexir output."""
import re, sys, collections
c = collections.Counter()
for line in open(sys.argv[1]):
    m = re.match(r'\s+(?:\(%\d+[^)]*\)|%\d+(?:\([^)]*\))?\s+\S+\s+=)\s+([A-Za-z][A-Za-z0-9]*)', line)
    if m:
        c[m.group(1)] += 1
for op, n in c.most_common():
    print(f"{n:6} {op}")
