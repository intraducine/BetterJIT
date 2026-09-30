import assert from 'node:assert/strict';
import { runDiagnostic } from '../../Sources/BetterJITWebKit/Resources/diagnostics.mjs';

const features=await runDiagnostic('features');
assert.equal(features.status,'passed');
assert.equal(typeof features.details.jspi,'string');

let calls=0;
const echo=await runDiagnostic('native-roundtrip',{sizes:[64,4096],repeats:1},{
  mappedActive:true,
  hostCall:async (operation,payload)=>{
    calls++; assert.equal(operation,'diag.echo'); assert.ok(payload instanceof Uint8Array); return payload;
  }
});
assert.equal(echo.status,'passed');
assert.equal(calls,2);
assert.equal(echo.counters.roundTrips,2);

const opfs=await runDiagnostic('opfs-io',{megabytes:4});
assert.ok(['passed','unsupported'].includes(opfs.status));
console.log('PASS: diagnostics module feature snapshot, native round-trip protocol and unsupported handling.');
