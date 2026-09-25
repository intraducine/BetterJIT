#pragma once
#include <stdint.h>
#include <stddef.h>

// Must match fillPattern / fnv in Web/opfs_worker.js.
void sh_fill_u32(uint32_t *p, size_t words, uint32_t seed);
uint32_t sh_fnv_u32(const uint32_t *p, size_t words);
// Spins until *run == 0, echoing every new value of *req into *resp.
void sh_responder(volatile uint64_t *req, volatile uint64_t *resp, volatile int *run);
// App-side RAM backing store for the WebView pager (see appBacking in Web/pager.js).
// Serves swap requests posted in the shared file at `base+ctrl` until *run == 0.
void sh_pager_server(uint8_t *base, size_t ctrl, size_t slot0, size_t slot1,
                     uint8_t *store, uint8_t *present, uint32_t npages, volatile int *run, uint64_t *served);
