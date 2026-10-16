// SPDX-License-Identifier: GPL-3.0-or-later
// Reproduce an early child exit without a probe report; the enclosing contract
// must retain its bounded diagnostics and partial successes before cleanup.
const fs=require('fs'),path=require('path'),os=require('os'),assert=require('node:assert/strict'),{spawnSync}=require('child_process');
const P=require('./sparse-linux-probe-report.cjs'),directory=fs.mkdtempSync(path.join(os.tmpdir(),'betterjit-probe-diagnostics-'));
try {
 const inject=path.join(directory,'inject.cjs'),output=path.join(directory,'failed-contract.json');
 fs.writeFileSync(inject,`const fs=require('fs'),c=require('child_process'),original=c.spawnSync;c.spawnSync=(command,args,options)=>{
 const preload=args?.find(value=>typeof value==='string'&&value.endsWith('/kill.cjs'));
 if(preload)fs.writeFileSync(preload,"throw Error('EARLY_CHILD_STARTUP /private/secret/file API_TOKEN=TOPSECRET token: OTHERSECRET https://hidden.invalid/?secret=value');");
 return original(command,args,options);};`);
 const child=spawnSync(process.execPath,['--require',inject,path.join(__dirname,'sparse-bootstrap-contract.cjs'),path.resolve(process.argv[2]),output],{encoding:'utf8',timeout:20000});
 assert.equal(child.status,1,P.stringify(P.subprocessInfo(child)));
 assert(fs.existsSync(output),'The failed contract must retain its report');const report=JSON.parse(fs.readFileSync(output));
 assert.equal(report.status,'contract-failed');assert.equal(report.phase,'native-child-died');assert.equal(report.completedCases.length,7);
 assert.equal(report.subprocess.status,1);assert.equal(report.subprocess.reportExists,false);assert.equal(report.subprocess.fault.killSent,false);
 assert.equal(report.subprocess.classification,'before-native-wrapper');assert.match(report.subprocess.stderr,/EARLY_CHILD_STARTUP/);
 const text=P.stringify(report);assert(!/TOPSECRET|OTHERSECRET|hidden\.invalid|secret\/file|\n\s*at\s/.test(text));assert(text.length<8000);
 const result={evidence:'Deliberately injected early child startup failure, with missing probe report and retained enclosing contract failure; not a reproduction of the macOS cause or Wine evidence.',retainedFailure:report};
 if(process.argv[3])fs.writeFileSync(process.argv[3],P.stringify(result));console.log(P.stringify(result));
}catch(error){console.error(P.stringify(P.errorInfo(error)));process.exitCode=1;}
finally{fs.rmSync(directory,{recursive:true,force:true});}
