# Source provenance and third-party notices

The imported research was described by its source as GPL-3.0-or-later and came
from Madeira's `wasm-webview` work (`dfbb409`) and the local WasmProbe research
snapshot. BetterJIT integration changes do not replace component licenses or
upstream copyright notices. The full GPL text remains in `COPYING`.

| Component | Source in this tree | Notice / provenance |
| --- | --- | --- |
| FEX-to-Wasm backend and integration | `fexwasm/src`, `addon/iridium` | Imported GPL-3.0-or-later research plus BetterJIT integration; preserve headers and `COPYING`. |
| FEX frontend | Fetched by `scripts/prepare-fex.sh` | `willfaust/FEX` at `0f8edf8f6383ae8085e0ffac511c789cdae97514`, plus `patches/fex-wasm.patch`. The checkout and recursive dependencies carry additional notices. |
| Box2D | `fexwasm/guest/box2d`, retained native reference sources in the research checkout | MIT; Erin Catto's notice is retained in both original locations. |
| CoreMark-derived fixtures | `fexwasm/guest/coremark`, native reference sources in the research checkout | Source headers specify Apache-2.0. `LICENSES/Apache-2.0.txt` provides its full text. Existing `LICENSE.md` is the separate acceptable-use/trademark agreement, not a substitute for the code license. |
| Guest images | `WasmProbe/Web/fex/image.bin`, `WasmProbe/Web/fexw64/image.bin` | Imported CPU/physics test images. Exact checksums and build-source paths are in `distribution/binary-fixtures.json`. They have not been independently regenerated for this change. |
| Iridium host | Separate user-supplied checkout | Not included or relicensed. Its policies, licenses, notices and binary/source obligations remain applicable. |

The source export intentionally omits raw historical logs, the full Madeira
Windows game runtime, signing files, games and compiled iOS libraries. It includes
fixture source and build tools for review. Fetching a dependency from a pinned URL
is not a substitute for collecting all required source/notices when distributing
a complete binary. No legal-compliance or App Store certification is asserted.
