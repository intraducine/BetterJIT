import Foundation
import Darwin

/// Native arm64 baselines: the same C kernels and guest program the wasm
/// suites run.
enum NativeBench {
    static func nowMs() -> Double { Double(clock_gettime_nsec_np(CLOCK_UPTIME_RAW)) / 1e6 }

    // Keep in sync with KERNELS in Web/core.js.
    static let kernels: [(String, (Int32) -> UInt32, Int32)] = [
        ("intmix", k_intmix, 100_000_000), ("sieve", k_sieve, 10), ("qsort", k_qsort, 4),
        ("matmul", k_matmul, 60), ("nbody", k_nbody, 3_000_000), ("hash", k_hash, 40),
        ("interp", k_interp, 20_000_000), ("ptrchase", k_ptrchase, 5_000_000), ("memcpy", k_memcpy, 200),
        ("crc32", k_crc32, 4), ("tree", k_tree, 1_000_000),
        ("calls", k_calls, 10_000_000), ("switch", k_switch, 10_000_000),
        ("vcall", k_vcall, 10_000_000), ("fib", k_fib, 200), ("rswitch", k_rswitch, 10_000_000),
        ("walk", k_walk, 2000), ("coremark", k_coremark, 2000),
        ("box2d", k_box2d, 30), ("box2d_tumbler", k_box2d_tumbler, 60), ("box2d_joints", k_box2d_joints, 20), ("box2d_rain", k_box2d_rain, 100),
    ]

    static func runKernels() {
        for (name, f, n) in kernels {
            _ = f(1)
            var best = Double.greatestFiniteMagnitude, first = 0.0, chk: UInt32 = 0
            for r in 0..<3 {
                let t = nowMs()
                chk = f(n)
                let d = nowMs() - t
                if r == 0 { first = d }
                best = min(best, d)
            }
            Log.result(["suite": "kernels", "engine": "native", "kernel": name, "n": n, "ms": best, "firstMs": first, "chk": chk])
        }
    }

    /// Native counterpart of the page's fexkernels suite: same kernels, n and order.
    static func runFexKernels(configURL: URL) {
        guard let data = try? Data(contentsOf: configURL),
              let cfg = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let list = cfg["kernels"] as? [[String: Any]] else {
            Log.result(["suite": "native_fexkernels", "error": "no fex/config.json"])
            return
        }
        let byName = Dictionary(uniqueKeysWithValues: kernels.map { ($0.0, $0.1) })
        for k in list {
            guard let name = k["name"] as? String, let n = (k["n"] as? NSNumber)?.int32Value, let f = byName[name] else { continue }
            _ = f(max(1, n / 10)) // same warm-up as the wasm side
            let t = nowMs()
            let chk = f(n)
            Log.result(["suite": "native_fexkernels", "kernel": name, "n": n, "ms": nowMs() - t, "chk": chk])
        }
    }

    /// Box2D with its own scheduler threads (pthreads), 1-4 workers: the native
    /// counterpart of the page's fexthreads suite (same scenes and steps).
    static func runBox2DThreads() {
        for (name, scene, steps) in [("box2d_mt4", Int32(0), Int32(300)), ("box2d_joints_mt4", Int32(3), Int32(200))] {
            for w in Int32(1)...4 {
                let arg = (w << 28) | (scene << 24)
                _ = k_box2d(arg | steps / 10)
                let t = nowMs()
                let chk = k_box2d(arg | steps)
                Log.result(["suite": "native_box2d_threads", "kernel": name, "workers": w, "n": steps, "ms": nowMs() - t, "chk": chk])
            }
        }
    }

    /// Native memory-ordering costs on this CPU, matching the page's w:tso loop.
    static func runTSO() {
        let names = ["plain ldr/str", "FEX TSO ldapr/stlr", "FEX half-barrier ldr+dmb ishld", "wasm fence ldr/str+dmb ish"]
        for threads in [1, 4] {
            for stores in [0, 1] {
                var row: [String: Any] = ["suite": "native_tso", "threads": threads, "stores": stores]
                for v in 0..<4 {
                    _ = tso_native_bench(Int32(v), Int32(stores), Int32(threads), 200_000)
                    row[names[v]] = (tso_native_bench(Int32(v), Int32(stores), Int32(threads), 5_000_000) * 100).rounded() / 100
                }
                Log.result(row)
            }
        }
    }

    static func runDispatch(steps: UInt32 = 2_000_000) {
        let regs = UnsafeMutablePointer<UInt64>.allocate(capacity: 16)
        defer { regs.deallocate() }
        let variants: [(String, (UnsafeMutablePointer<UInt64>?, UInt32) -> Void)] = [
            ("switch", gp_run_switch), ("fnptr", gp_run_fnptr), ("tail", gp_run_tail),
        ]
        for (name, run) in variants {
            var best = Double.greatestFiniteMagnitude, chk: UInt32 = 0
            for _ in 0..<3 {
                gp_reset(regs)
                let t = nowMs()
                run(regs, steps)
                best = min(best, nowMs() - t)
                chk = gp_checksum(regs)
            }
            Log.result(["suite": "dispatch", "engine": "native", "variant": name, "steps": steps, "ms": best,
                        "nsPerBlock": best * 1e6 / Double(steps), "chk": chk])
        }
    }

    /// Another process's physical footprint (MB), or -errno.
    static func footprintMB(pid: pid_t) -> Int {
        var ri = rusage_info_v4()
        let r = withUnsafeMutablePointer(to: &ri) {
            $0.withMemoryRebound(to: rusage_info_t?.self, capacity: 1) { proc_pid_rusage(pid, RUSAGE_INFO_V4, $0) }
        }
        return r == 0 ? Int(ri.ri_phys_footprint >> 20) : -Int(errno)
    }

    /// Memory in use system-wide (MB): everything but free, inactive and
    /// purgeable pages. Its rise during a run approximates WebContent's growth
    /// (this app can't read another process's footprint).
    static func systemUsedMB() -> Int {
        var vm = vm_statistics64_data_t()
        var count = mach_msg_type_number_t(MemoryLayout<vm_statistics64_data_t>.size / MemoryLayout<integer_t>.size)
        let kr = withUnsafeMutablePointer(to: &vm) {
            $0.withMemoryRebound(to: integer_t.self, capacity: Int(count)) { host_statistics64(mach_host_self(), HOST_VM_INFO64, $0, &count) }
        }
        if kr != KERN_SUCCESS { return -1 }
        let page = UInt64(vm_kernel_page_size)
        let unused = UInt64(vm.free_count) + UInt64(vm.inactive_count) + UInt64(vm.purgeable_count)
        return Int((ProcessInfo.processInfo.physicalMemory - unused * page) >> 20)
    }

    static func memoryInfo() -> [String: Any] {
        var info = task_vm_info_data_t()
        var count = mach_msg_type_number_t(MemoryLayout<task_vm_info_data_t>.size / MemoryLayout<natural_t>.size)
        let kr = withUnsafeMutablePointer(to: &info) {
            $0.withMemoryRebound(to: integer_t.self, capacity: Int(count)) {
                task_info(mach_task_self_, task_flavor_t(TASK_VM_INFO), $0, &count)
            }
        }
        return [
            "physicalMemoryMB": Int(ProcessInfo.processInfo.physicalMemory >> 20),
            "appAvailableMB": Int(os_proc_available_memory() >> 20),
            "appFootprintMB": kr == KERN_SUCCESS ? Int(info.phys_footprint >> 20) : -1,
            "cpuCount": ProcessInfo.processInfo.activeProcessorCount,
            "os": ProcessInfo.processInfo.operatingSystemVersionString,
        ]
    }
}
