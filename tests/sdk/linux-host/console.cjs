// SPDX-License-Identifier: GPL-3.0-or-later
// Decode the Wine console sequences used by textual milestones. Keep raw logs.
function consoleText(raw) {
 return raw.replace(/\x1b\[([0-?]*)([ -/]*)([@-~])/g,(_escape,parameters,intermediates,command)=>{
  // Wine emits cursor-forward instead of literal blanks when writing a console
  // one character at a time. Bound padding from malformed/huge counts.
  if(command==='C'&&!intermediates&&/^\d*$/.test(parameters))return ' '.repeat(Math.min(Number(parameters)||1,256));
  return '';
 });
}
function windowsVersion(raw) {
 return consoleText(raw).match(/^\s*(Microsoft )?Windows[^\n]*\d+\.\d+/im)?.[0].trim()??null;
}
module.exports={consoleText,windowsVersion};
