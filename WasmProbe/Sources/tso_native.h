#pragma once
#include <stdint.h>

// ns per iteration of 4 loads from shared lines (+ 2 stores to per-thread
// lines when WithStores) on `Threads` threads (max over threads).
// Variant: 0 plain ldr/str, 1 FEX TSO (ldapr/stlr), 2 FEX half-barrier
// (ldr+dmb ishld / dmb ish+str), 3 wasm atomic.fence (ldr+dmb ish / dmb ish+str).
double tso_native_bench(int Variant, int WithStores, int Threads, long Iters);
