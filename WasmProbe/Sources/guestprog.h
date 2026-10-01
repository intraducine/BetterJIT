#pragma once
#include <stdint.h>
void gp_reset(uint64_t *R);
uint32_t gp_checksum(const uint64_t *R);
void gp_run_fnptr(uint64_t *R, uint32_t steps);
void gp_run_switch(uint64_t *R, uint32_t steps);
void gp_run_tail(uint64_t *R, uint32_t steps);
