# SDK source provenance

New SDK, bridge, examples and tests retain this repository's GPL-3.0-or-later
licensing. No imported component is relicensed. App independence is not a promise
that every proprietary app may redistribute linked code on its existing terms.

`Sources/BetterJITWebKit/Resources/fex-runtime.js` originated as an exact copy of
`WasmProbe/Web/fexruntime.js` at BetterJIT commit
`8eda1a28e1098812860e24ad609b12ea82850dd3`. The SDK copy now adds bounded function
tables, bounded dispatcher hash probing and typed capacity/missing-unit failures.
The historical research copy is unchanged. Its origin is Madeira's wasm-webview
fexwasm runtime. Preserve COPYING and upstream component notices.

The optional native compiler remains pinned to public FEX commit
`0f8edf8f6383ae8085e0ffac511c789cdae97514` plus `patches/fex-wasm.patch`.
The SDK-only source export includes the C interface header for binding tests,
not the compiler, its native archives, or transitive dependencies. Native FEX
builds require the full research checkout and its source/notices separately.
Imported benchmark dumps are not included in the SDK-only export.

Exported Swift tests use `SwiftTests/`; Node/Python tests retain `tests/`.
The SDK package declares the Swift test paths explicitly. These distinct roots
keep the source-manifest paths exact on both case-sensitive and case-insensitive
filesystems. The exporter rejects case aliases in any destination component
before materialization. Earlier macOS consumer bundles merged `Tests/` and
`tests/`: those file bytes matched after case mapping, not by exact path.

The C guest/reference example and small Wasm test emitters are source fixtures.
The native-binding C shim is only a failure/ownership test double. The separate
Swift stdio service is only a desktop integration-test adapter. Neither is a
replacement FEX compiler or a production runtime transport.
