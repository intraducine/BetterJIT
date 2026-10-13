// SPDX-License-Identifier: GPL-3.0-or-later
import assert from 'node:assert/strict';
import test from 'node:test';
import {createRequire} from 'node:module';
const {windowsVersion}=createRequire(import.meta.url)('./linux-host/console.cjs');
test('recorded Wine terminal output with cursor controls retains its actual Windows version',()=>{
 const raw='BetterJIT Wine FS reset OK\n\r\n\x1b[?25lMicrosoft Windows 10.0.19043\r\n\x1b[?25h';
 assert.equal(windowsVersion(raw),'Microsoft Windows 10.0.19043');
 assert.ok(raw.includes('\x1b[?25l'));
 assert.equal(windowsVersion('BetterJIT Wine FS reset OK\n'),null);
 assert.equal(windowsVersion('wine: Windows 10.0.19043 failed\n'),null);
 assert.equal(windowsVersion('Windows without a version\n'),null);
});
