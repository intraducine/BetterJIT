// SPDX-License-Identifier: GPL-3.0-or-later
'use strict';
const fs = require('node:fs');
const {materializeNZCV} = require('./flags.cjs');
const rows = JSON.parse(fs.readFileSync(0, 'utf8'));
process.stdout.write(JSON.stringify(rows.map(([kind, a, b, nzcv]) => materializeNZCV(kind, a, b, nzcv))));
