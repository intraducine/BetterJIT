# SDK source provenance

New SDK, bridge, example and test code retains this repository's GPL-3.0-or-later
licensing. This change does not relicense any imported component. App-independent
architecture is not a promise that every proprietary app can redistribute a linked
build under its existing licensing terms.

`Sources/BetterJITWebKit/Resources/fex-runtime.js` is an unchanged copy of
`WasmProbe/Web/fexruntime.js` at BetterJIT commit
`8eda1a28e1098812860e24ad609b12ea82850dd3`. Its source is the imported fexwasm
runtime from Madeira's wasm-webview work (see the existing THIRD_PARTY.md and
WasmProbe provenance). Preserve the root COPYING and upstream notices.

The native FEX compiler is optional and continues to use pinned public FEX commit
`0f8edf8f6383ae8085e0ffac511c789cdae97514` plus patches/fex-wasm.patch. The wrapper
binds the existing C interface; it does not claim that an SDK-only archive contains
the native compiler or its transitive dependencies. Build or distribute that
backend separately from the clean default SDK package, with its applicable source
and notices. Existing imported benchmark fixtures are test inputs only and are
not included in the SDK-only export.
