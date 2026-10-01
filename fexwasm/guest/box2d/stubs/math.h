#pragma once
#define sqrtf(x) __builtin_sqrtf(x)
#define fabsf(x) __builtin_fabsf(x)
#define floorf(x) __builtin_floorf(x)
#define ceilf(x) __builtin_ceilf(x)
#define roundf(x) __builtin_roundf(x)
#define sqrt(x) __builtin_sqrt(x)
#define isnan(x) __builtin_isnan(x)
#define isinf(x) __builtin_isinf(x)
#define isfinite(x) __builtin_isfinite(x)
// Scene setup (benchmarks.c) takes sin/cos from box2d_driver.c, which is
// shared with the native build so both build identical scenes.
float det_sinf(float x);
float det_cosf(float x);
#define sinf(x) det_sinf(x)
#define cosf(x) det_cosf(x)
