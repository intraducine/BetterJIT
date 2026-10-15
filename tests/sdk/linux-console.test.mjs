// SPDX-License-Identifier: GPL-3.0-or-later
import assert from 'node:assert/strict';
import test from 'node:test';
import {createRequire} from 'node:module';
const {consoleText,windowsVersion}=createRequire(import.meta.url)('./linux-host/console.cjs');
test('recorded Wine terminal output with cursor controls retains its actual Windows version',()=>{
 const raw='BetterJIT Wine FS reset OK\n\r\n\x1b[?25lMicrosoft Windows 10.0.19043\r\n\x1b[?25h';
 assert.equal(windowsVersion(raw),'Microsoft Windows 10.0.19043');
 assert.ok(raw.includes('\x1b[?25l'));
 assert.equal(windowsVersion('BetterJIT Wine FS reset OK\n'),null);
 assert.equal(windowsVersion('wine: Windows 10.0.19043 failed\n'),null);
 assert.equal(windowsVersion('Windows without a version\n'),null);
});

test('character-wise Wine output reconstructs cursor-forward spaces without altering raw evidence',()=>{
 const marker='BetterJIT Wine nested CreateProcess OK';
 const raw=Array.from(marker,c=>'\x1b[?25l'+(c===' '?'\x1b[K\x1b[1C':c)+'\x1b[?25h').join('')+'\r\n';
 assert.equal(consoleText(raw),marker+'\r\n');
 assert.equal(raw.includes(marker),false);
 assert.equal(consoleText('\x1b[999999999C').length,256);
 assert.equal(consoleText('BetterJIT Wine nested CreateProcess failed').includes(marker),false);
});
