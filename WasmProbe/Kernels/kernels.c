// Benchmark kernels compiled twice: natively into the app (arm64) and to
// wasm32 (Web/bench.wasm). Freestanding: no libc, so both builds run the
// exact same code. Every kernel returns a checksum; native and wasm results
// must match for a run to count.
#include <stdint.h>
#include <stddef.h>

#ifdef __wasm__
#define EXPORT(name) __attribute__((export_name(#name)))
#else
#define EXPORT(name)
#endif

#define BUF_BYTES (32u << 20)
static uint8_t g_a[BUF_BYTES] __attribute__((aligned(64)));
static uint8_t g_b[BUF_BYTES] __attribute__((aligned(64)));

static inline uint64_t xs64(uint64_t *s) {
    uint64_t x = *s;
    x ^= x << 13; x ^= x >> 7; x ^= x << 17;
    return *s = x;
}

static void fill_random(uint8_t *p, size_t n, uint64_t seed) {
    uint64_t *q = (uint64_t *)p;
    for (size_t i = 0; i < n / 8; i++) q[i] = xs64(&seed) * 0x2545F4914F6CDD1Dull;
}

// 1. Pure integer ALU chain.
EXPORT(k_intmix) uint32_t k_intmix(int n) {
    uint64_t x = 88172645463325252ull, acc = 0;
    for (int i = 0; i < n; i++) {
        x ^= x << 13; x ^= x >> 7; x ^= x << 17;
        acc += (x * 0x9E3779B97F4A7C15ull) >> (x & 31);
        acc ^= acc >> 11;
    }
    return (uint32_t)(acc ^ (acc >> 32));
}

// 2. Sieve of Eratosthenes over 8M bytes, repeated n times.
EXPORT(k_sieve) uint32_t k_sieve(int n) {
    const uint32_t N = 8u << 20;
    uint32_t count = 0;
    for (int r = 0; r < n; r++) {
        uint8_t *s = g_a;
        for (uint32_t i = 0; i < N; i++) s[i] = 1;
        s[0] = s[1] = 0;
        for (uint32_t i = 2; i * i < N; i++)
            if (s[i]) for (uint32_t j = i * i; j < N; j += i) s[j] = 0;
        for (uint32_t i = 0; i < N; i++) count += s[i];
    }
    return count;
}

// 3. Quicksort of 1M random uint32, n times.
static void isort(uint32_t *a, int lo, int hi) {
    for (int i = lo + 1; i <= hi; i++) {
        uint32_t v = a[i]; int j = i - 1;
        while (j >= lo && a[j] > v) { a[j + 1] = a[j]; j--; }
        a[j + 1] = v;
    }
}
static void qsort_u32(uint32_t *a, int lo, int hi) {
    while (hi - lo > 16) {
        uint32_t p = a[lo + (hi - lo) / 2];
        int i = lo, j = hi;
        while (i <= j) {
            while (a[i] < p) i++;
            while (a[j] > p) j--;
            if (i <= j) { uint32_t t = a[i]; a[i] = a[j]; a[j] = t; i++; j--; }
        }
        if (j - lo < hi - i) { qsort_u32(a, lo, j); lo = i; }
        else { qsort_u32(a, i, hi); hi = j; }
    }
    isort(a, lo, hi);
}
EXPORT(k_qsort) uint32_t k_qsort(int n) {
    const int N = 1 << 20;
    uint32_t *a = (uint32_t *)g_a, h = 0;
    for (int r = 0; r < n; r++) {
        fill_random(g_a, N * 4, 1234 + r);
        qsort_u32(a, 0, N - 1);
        h = h * 31 + a[N / 2] + a[N / 3];
    }
    return h;
}

// 4. 256x256 float matmul (i-k-j, vectorisable), n times.
EXPORT(k_matmul) uint32_t k_matmul(int n) {
    enum { M = 256 };
    float *A = (float *)g_a, *B = A + M * M, *C = B + M * M;
    uint64_t seed = 42;
    for (int i = 0; i < M * M; i++) {
        A[i] = (float)(xs64(&seed) & 1023) / 1024.0f;
        B[i] = (float)(xs64(&seed) & 1023) / 1024.0f;
    }
    float sum = 0;
    for (int r = 0; r < n; r++) {
        for (int i = 0; i < M * M; i++) C[i] = 0;
        for (int i = 0; i < M; i++)
            for (int k = 0; k < M; k++) {
                float a = A[i * M + k];
                for (int j = 0; j < M; j++) C[i * M + j] += a * B[k * M + j];
            }
        sum += C[(r * 7919) % (M * M)];
    }
    return (uint32_t)(sum * 16.0f);
}

// 5. n-body (double precision), n steps.
typedef struct { double x, y, z, vx, vy, vz, m; } body_t;
EXPORT(k_nbody) uint32_t k_nbody(int n) {
    const double PI = 3.141592653589793, SM = 4 * PI * PI, DPY = 365.24;
    body_t b[5] = {
        {0, 0, 0, 0, 0, 0, SM},
        {4.84143144246472090e+00, -1.16032004402742839e+00, -1.03622044471123109e-01,
         1.66007664274403694e-03 * DPY, 7.69901118419740425e-03 * DPY, -6.90460016972063023e-05 * DPY,
         9.54791938424326609e-04 * SM},
        {8.34336671824457987e+00, 4.12479856412430479e+00, -4.03523417114321381e-01,
         -2.76742510726862411e-03 * DPY, 4.99852801234917238e-03 * DPY, 2.30417297573763929e-05 * DPY,
         2.85885980666130812e-04 * SM},
        {1.28943695621391310e+01, -1.51111514016986312e+01, -2.23307578892655734e-01,
         2.96460137564761618e-03 * DPY, 2.37847173959480950e-03 * DPY, -2.96589568540237556e-05 * DPY,
         4.36624404335156298e-05 * SM},
        {1.53796971148509165e+01, -2.59193146099879641e+01, 1.79258772950371181e-01,
         2.68067772490389322e-03 * DPY, 1.62824170038242295e-03 * DPY, -9.51592254519715870e-05 * DPY,
         5.15138902046611451e-05 * SM}};
    const double dt = 0.01;
    for (int s = 0; s < n; s++) {
        for (int i = 0; i < 5; i++)
            for (int j = i + 1; j < 5; j++) {
                double dx = b[i].x - b[j].x, dy = b[i].y - b[j].y, dz = b[i].z - b[j].z;
                double d2 = dx * dx + dy * dy + dz * dz;
                double d = __builtin_sqrt(d2);
                double mag = dt / (d2 * d);
                b[i].vx -= dx * b[j].m * mag; b[i].vy -= dy * b[j].m * mag; b[i].vz -= dz * b[j].m * mag;
                b[j].vx += dx * b[i].m * mag; b[j].vy += dy * b[i].m * mag; b[j].vz += dz * b[i].m * mag;
            }
        for (int i = 0; i < 5; i++) { b[i].x += dt * b[i].vx; b[i].y += dt * b[i].vy; b[i].z += dt * b[i].vz; }
    }
    double e = 0;
    for (int i = 0; i < 5; i++) e += b[i].x + b[i].y * 3 + b[i].z * 7;
    return (uint32_t)(int64_t)(e * 1e6);
}

// 6. 64-bit multiply hash over 16 MB, n passes.
EXPORT(k_hash) uint32_t k_hash(int n) {
    const size_t W = (16u << 20) / 8;
    uint64_t *p = (uint64_t *)g_b;
    fill_random(g_b, 16u << 20, 7);
    uint64_t h = 0x9E3779B97F4A7C15ull;
    for (int r = 0; r < n; r++)
        for (size_t i = 0; i < W; i += 2) {
            uint64_t a = p[i] ^ h, c = p[i + 1] + (h >> 29);
            h = (a * 0xff51afd7ed558ccdull) ^ ((c * 0xc4ceb9fe1a85ec53ull) >> 17);
        }
    return (uint32_t)(h ^ (h >> 32));
}

// 7. Bytecode interpreter (switch dispatch) — stands in for emulator/script loops.
enum { OP_LI, OP_ADD, OP_SUB, OP_MUL, OP_XOR, OP_SHR, OP_AND, OP_LD, OP_ST, OP_JNZ, OP_DEC, OP_HALT };
typedef struct { uint8_t op, a, b, c; int32_t imm; } insn_t;
EXPORT(k_interp) uint32_t k_interp(int n) {
    static const insn_t prog[] = {
        {OP_LI, 0, 0, 0, 0},       // r0 = n (patched)
        {OP_LI, 1, 0, 0, 12345},   // r1 = seed
        {OP_LI, 2, 0, 0, 0},       // r2 = acc
        {OP_LI, 5, 0, 0, 1023},    // r5 = mask
        // loop @4
        {OP_MUL, 1, 1, 6, 0},      // r1 *= r6 (r6 = 1103515245)
        {OP_ADD, 1, 1, 7, 0},      // r1 += r7 (12345)
        {OP_SHR, 3, 1, 0, 7},      // r3 = r1 >> 7
        {OP_AND, 4, 3, 5, 0},      // r4 = r3 & 1023
        {OP_LD, 3, 4, 0, 0},       // r3 = mem[r4]
        {OP_XOR, 2, 2, 3, 0},      // acc ^= r3
        {OP_ADD, 2, 2, 1, 0},      // acc += r1
        {OP_ST, 2, 4, 0, 0},       // mem[r4] = acc
        {OP_DEC, 0, 0, 0, 0},      // r0--
        {OP_JNZ, 0, 0, 0, 4},      // if r0 goto 4
        {OP_HALT, 0, 0, 0, 0},
    };
    uint32_t r[8] = {0};
    uint32_t *mem = (uint32_t *)g_a;
    for (int i = 0; i < 1024; i++) mem[i] = i * 2654435761u;
    r[6] = 1103515245u; r[7] = 12345;
    const insn_t *pc = prog;
    for (;;) {
        const insn_t in = *pc++;
        switch (in.op) {
        case OP_LI:  r[in.a] = in.a == 0 ? (uint32_t)n : (uint32_t)in.imm; break;
        case OP_ADD: r[in.a] = r[in.b] + r[in.c]; break;
        case OP_SUB: r[in.a] = r[in.b] - r[in.c]; break;
        case OP_MUL: r[in.a] = r[in.b] * r[in.c]; break;
        case OP_XOR: r[in.a] = r[in.b] ^ r[in.c]; break;
        case OP_SHR: r[in.a] = r[in.b] >> in.imm; break;
        case OP_AND: r[in.a] = r[in.b] & r[in.c]; break;
        case OP_LD:  r[in.a] = mem[r[in.b]]; break;
        case OP_ST:  mem[r[in.b]] = r[in.a]; break;
        case OP_DEC: r[in.a]--; break;
        case OP_JNZ: if (r[in.a]) pc = prog + in.imm; break;
        case OP_HALT: return r[2];
        }
    }
}

// 8. Random pointer chase over 16 MB (cache/TLB-miss latency), n steps.
EXPORT(k_ptrchase) uint32_t k_ptrchase(int n) {
    const uint32_t N = (16u << 20) / 4;
    uint32_t *next = (uint32_t *)g_b;
    for (uint32_t i = 0; i < N; i++) next[i] = i;
    uint64_t seed = 99;
    for (uint32_t i = N - 1; i > 0; i--) {   // Sattolo: one big cycle
        uint32_t j = (uint32_t)(xs64(&seed) % i);
        uint32_t t = next[i]; next[i] = next[j]; next[j] = t;
    }
    uint32_t p = 0;
    for (int i = 0; i < n; i++) p = next[p];
    return p;
}

// 9. Bulk copy 16 MB, n times (memory.copy in wasm, memcpy natively).
EXPORT(k_memcpy) uint32_t k_memcpy(int n) {
    uint32_t h = 0;
    for (int r = 0; r < n; r++) {
        g_a[r & 4095] = (uint8_t)r;
        __builtin_memcpy(g_b, g_a, 16u << 20);
        h += g_b[(r * 131) & 4095];
    }
    return h;
}

// 10. Table-driven CRC32 over 16 MB, n passes.
EXPORT(k_crc32) uint32_t k_crc32(int n) {
    static uint32_t T[256];
    for (uint32_t i = 0; i < 256; i++) {
        uint32_t c = i;
        for (int k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320u ^ (c >> 1) : c >> 1;
        T[i] = c;
    }
    fill_random(g_a, 16u << 20, 3);
    uint32_t crc = 0xFFFFFFFFu;
    for (int r = 0; r < n; r++)
        for (uint32_t i = 0; i < (16u << 20); i++) crc = T[(crc ^ g_a[i]) & 0xFF] ^ (crc >> 8);
    return ~crc;
}

// 11. Binary-tree insert/lookup with index links (struct-heavy, branchy).
typedef struct { uint32_t key, left, right, pad; } node_t;
EXPORT(k_tree) uint32_t k_tree(int n) {
    node_t *nd = (node_t *)g_a;
    const uint32_t CAP = BUF_BYTES / sizeof(node_t) - 1;
    uint32_t count = 1, found = 0;
    uint64_t seed = 5;
    nd[1].key = 0x80000000u; nd[1].left = nd[1].right = 0;
    for (int i = 0; i < n; i++) {
        uint32_t k = (uint32_t)xs64(&seed);
        uint32_t cur = 1;
        for (;;) {
            if (k == nd[cur].key) { found++; break; }
            uint32_t *link = k < nd[cur].key ? &nd[cur].left : &nd[cur].right;
            if (!*link) {
                if (count >= CAP) break;
                *link = ++count;
                nd[count].key = k; nd[count].left = nd[count].right = 0;
                break;
            }
            cur = *link;
        }
        if ((i & 3) == 0) {   // lookup a recent-ish key
            uint32_t q = nd[1 + (k % count)].key, c = 1;
            while (c && nd[c].key != q) c = q < nd[c].key ? nd[c].left : nd[c].right;
            found += c != 0;
        }
    }
    return found * 2654435761u + count;
}
