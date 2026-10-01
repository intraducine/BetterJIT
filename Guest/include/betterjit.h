/* SPDX-License-Identifier: GPL-3.0-or-later */
#ifndef BETTERJIT_GUEST_H
#define BETTERJIT_GUEST_H
#include <stdint.h>
#if !defined(__wasm32__)
#error "This guest API targets wasm32 with imported betterjit.memory."
#endif
#ifdef __cplusplus
extern "C" {
#endif
/* A service is explicitly registered by the native application as host.<id>.
 * Buffers refer to this session's linear memory. A call may suspend via JSPI.
 * Traps/failures propagate to the host; there is no implicit native pointer ABI.
 */
__attribute__((import_module("betterjit"), import_name("call")))
int32_t betterjit_call(uint32_t service, const void *input, uint32_t input_size,
                      void *output, uint32_t output_capacity);
#ifdef __cplusplus
}
#endif
#endif
