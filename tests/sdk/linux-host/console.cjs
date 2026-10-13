// SPDX-License-Identifier: GPL-3.0-or-later
// Match actual terminal text without discarding the raw execution log.
function windowsVersion(raw) {
 const plain=raw.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g,'');
 return plain.match(/^\s*(Microsoft )?Windows[^\n]*\d+\.\d+/im)?.[0].trim()??null;
}
module.exports={windowsVersion};
