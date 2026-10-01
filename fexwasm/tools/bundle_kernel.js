// The guest kernel's CommonJS modules (js/linux) as one script for a Web
// Worker's importScripts: defines LinuxBundle.require.
//   node tools/bundle_kernel.js > linux-kernel.js
'use strict';

const fs = require('fs');
const path = require('path');

function bundle() {
  const dir = path.join(__dirname, '..', 'js', 'linux');
  const mods = ['abi.js', 'elf.js', 'kernel.js', 'oss.js', 'ntsync.js', 'syscalls.js', 'snapshot.js', 'vfs_web.js'];
  let out = '(function (G) {\n"use strict";\nconst defs = {};\n';
  for (const m of mods) out += `defs['./${m}'] = function (module, exports, require) {\n${fs.readFileSync(path.join(dir, m), 'utf8')}\n};\n`;
  out += `const cache = {};
function require(name) {
  if (cache[name]) return cache[name].exports;
  if (!defs[name]) throw new Error('no module ' + name);
  const m = (cache[name] = { exports: {} });
  defs[name](m, m.exports, require);
  return m.exports;
}
G.LinuxBundle = { require };
})(self);\n`;
  return out;
}

module.exports = { bundle };
if (require.main === module) process.stdout.write(bundle());
