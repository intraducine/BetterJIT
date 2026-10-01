import Foundation
import Darwin

/// A file the WebView writes through OPFS, mapped MAP_SHARED into the app.
final class SharedFile {
    let path: String
    let fd: Int32
    let size: Int
    let base: UnsafeMutableRawPointer
    private let runFlag = UnsafeMutablePointer<Int32>.allocate(capacity: 1)

    init?(path: String) {
        self.path = path
        fd = open(path, O_RDWR)
        guard fd >= 0 else { return nil }
        var st = stat()
        fstat(fd, &st)
        size = Int(st.st_size)
        guard let p = mmap(nil, size, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0), p != MAP_FAILED else { close(fd); return nil }
        base = p
    }

    deinit { munmap(base, size); close(fd); runFlag.deallocate() }

    func u32(at off: Int) -> UnsafeMutablePointer<UInt32> { (base + off).assumingMemoryBound(to: UInt32.self) }

    func startResponder(reqOff: Int, respOff: Int) {
        runFlag.pointee = 1
        let req = (base + reqOff).assumingMemoryBound(to: UInt64.self)
        let resp = (base + respOff).assumingMemoryBound(to: UInt64.self)
        let run = runFlag
        let t = Thread { sh_responder(req, resp, run) }
        t.qualityOfService = .userInteractive
        t.start()
    }

    func stopResponder() { runFlag.pointee = 0 }

    /// Finds the OPFS backing file anywhere in the app container by its magic header.
    static func find(magic: String) -> (path: String, scanned: Int)? {
        let root = NSHomeDirectory()
        let want = Array(magic.utf8)
        var scanned = 0
        guard let e = FileManager.default.enumerator(atPath: root) else { return nil }
        for case let rel as String in e {
            let path = root + "/" + rel
            var st = stat()
            guard stat(path, &st) == 0, (st.st_mode & S_IFMT) == S_IFREG, st.st_size >= want.count else { continue }
            scanned += 1
            let fd = open(path, O_RDONLY)
            if fd < 0 { continue }
            var buf = [UInt8](repeating: 0, count: want.count)
            let n = read(fd, &buf, want.count)
            close(fd)
            if n == want.count && buf == want { return (path, scanned) }
        }
        return nil
    }
}

extension ProbeViewController {
    func opfs(_ op: String, _ args: [String: Any] = [:], worker: String = "A", timeout: Double = 1200) async -> [String: Any] {
        let payload: [String: Any] = ["op": op, "args": args, "worker": worker]
        let json = String(data: try! JSONSerialization.data(withJSONObject: payload), encoding: .utf8)!
        let r = await callProbe("opfs", argsJSON: json, timeout: timeout)
        return (try? JSONSerialization.jsonObject(with: Data(r.utf8))) as? [String: Any] ?? ["raw": r]
    }

    private func result(_ d: [String: Any]) -> [String: Any] { d["result"] as? [String: Any] ?? [:] }

    /// OPFS file as memory shared between the WebContent process and the app.
    func opfsShare() async {
        let magic = "WASMPROBE-OPFS-\(UUID().uuidString)"
        _ = await opfs("open", ["name": "probe.bin"])
        _ = await opfs("estimate")
        _ = await opfs("openOther", ["name": "probe.bin"], worker: "B")
        _ = await opfs("openOther", ["name": "probe.bin", "mode": "readwrite-unsafe"], worker: "B")
        _ = await opfs("header", ["magic": magic, "sizeBytes": 2 << 30])

        let t = NativeBench.nowMs()
        guard let found = SharedFile.find(magic: magic) else {
            Log.result(["suite": "opfs_share", "error": "backing file not found in app container"])
            return
        }
        let attrs = (try? FileManager.default.attributesOfItem(atPath: found.path)) ?? [:]
        Log.result(["suite": "opfs_share", "event": "found", "path": found.path.replacingOccurrences(of: NSHomeDirectory(), with: "~"),
                    "scannedFiles": found.scanned, "searchMs": NativeBench.nowMs() - t,
                    "protection": "\(attrs[.protectionKey] ?? "nil")", "size": "\(attrs[.size] ?? "?")"])
        guard let sf = SharedFile(path: found.path) else {
            Log.result(["suite": "opfs_share", "error": "open/mmap failed errno \(errno)"])
            return
        }
        sharedFile = sf
        let headerOK = memcmp(sf.base, magic, magic.utf8.count) == 0
        Log.result(["suite": "opfs_share", "event": "mapped", "bytes": sf.size, "headerMatches": headerOK])

        // WebView writes, app reads its mapping.
        let words = (64 << 20) / 4
        let w = result(await opfs("writeAt", ["off": 64 << 20, "lenMB": 64, "seed": 11]))
        var t1 = NativeBench.nowMs()
        let appHash = sh_fnv_u32(sf.u32(at: 64 << 20), words)
        Log.result(["suite": "opfs_share", "test": "webview-writes-app-reads", "jsHash": w["hash"] ?? -1, "appHash": appHash,
                    "match": (w["hash"] as? NSNumber)?.uint32Value == appHash, "jsWriteMBps": w["MBps"] ?? -1,
                    "appReadMBps": 64.0 / ((NativeBench.nowMs() - t1) / 1000)])

        // App writes its mapping, WebView reads.
        t1 = NativeBench.nowMs()
        sh_fill_u32(sf.u32(at: 256 << 20), words, 22)
        let fillMs = NativeBench.nowMs() - t1
        let expect = sh_fnv_u32(sf.u32(at: 256 << 20), words)
        let c = result(await opfs("checkAt", ["off": 256 << 20, "lenMB": 64]))
        Log.result(["suite": "opfs_share", "test": "app-writes-webview-reads", "appHash": expect, "jsHash": c["hash"] ?? -1,
                    "match": (c["hash"] as? NSNumber)?.uint32Value == expect, "appWriteMBps": 64.0 / (fillMs / 1000), "jsReadMBps": c["MBps"] ?? -1])

        _ = await opfs("tinyread", ["n": 3000])

        // Latency: worker write()/read() against an app thread spinning on the mapping.
        sf.startResponder(reqOff: 4096, respOff: 8192)
        _ = await opfs("pingpong", ["n": 5000, "reqOff": 4096, "respOff": 8192])
        sf.stopResponder()
        var info = NativeBench.memoryInfo(); info["suite"] = "opfs_share"; info["event"] = "app-memory"; Log.result(info)
    }

    /// Opens the OPFS file and maps it into the app, without the other sharing tests.
    func opfsMap() async {
        let magic = "WASMPROBE-OPFS-\(UUID().uuidString)"
        _ = await opfs("open", ["name": "probe.bin"])
        _ = await opfs("header", ["magic": magic, "sizeBytes": 4 << 20])
        guard let found = SharedFile.find(magic: magic), let sf = SharedFile(path: found.path) else {
            Log.result(["suite": "opfs_map", "error": "could not find/map the OPFS file"]); return
        }
        sharedFile = sf
        Log.result(["suite": "opfs_map", "bytes": sf.size])
    }

    /// Can the WebView use the app's RAM as a multi-GB second tier? Writes every
    /// page of a 7 GB guest space (about 6 GB of it evicted into app memory),
    /// then reads it all back and verifies.
    func appRAM(gb: Int) async {
        await withAppPager(spanBytes: gb << 30) {
            _ = await self.opfs("bigfill", ["frames": 65536, "spanGB": gb, "backing": "app", "ctrl": 65536,
                                            "slot0": 1 << 20, "slot1": (1 << 20) + 16384, "salt": 77])
        }
        let alive = await callProbe("env", timeout: 30)
        var info = NativeBench.memoryInfo(); info["suite"] = "appram"; info["webcontentAliveAfter"] = alive; Log.result(info)
    }

    /// Capacity: write GBs of real data through OPFS and see whether WebContent survives.
    func opfsBig(gb: Int) async {
        _ = await opfs("fill", ["fromMB": 1024, "toMB": 1024 + gb * 1024, "chunkMB": 64], timeout: 3000)
        _ = await opfs("estimate")
        _ = await opfs("randio", ["spanMB": gb * 1024, "offMB": 1024, "size": 16384, "n": 4000])
        _ = await opfs("randio", ["spanMB": gb * 1024, "offMB": 1024, "size": 16384, "n": 2000, "write": true])
        _ = await opfs("randio", ["spanMB": gb * 1024, "offMB": 1024, "size": 65536, "n": 2000])
        let alive = await callProbe("env", timeout: 30)
        var info = NativeBench.memoryInfo(); info["suite"] = "opfs_big"; info["webcontentAliveAfter"] = alive; Log.result(info)
    }

    /// Demand-paged 64-bit guest memory. Kept short: ~1M accesses per config.
    func opfsBigmem() async {
        // Translation overhead only: the working set fits in the resident pool.
        _ = await opfs("bigmem", ["frames": 65536, "spanGB": 0.5, "hotMB": 512, "hotPct": 100, "n": 5_000_000, "rounds": 2, "direct": 512])
        // 4 GB guest over 1 GB resident, 95% hot, paging to the OPFS file.
        let cfg: [String: Any] = ["frames": 65536, "spanGB": 4, "hotMB": 512, "hotPct": 95, "n": 1_000_000, "rounds": 2]
        var file = cfg; file["backing"] = "file"; file["fileOffMB"] = 4096
        _ = await opfs("bigmem", file)
        // Same config, paging to the app's RAM through the shared file. Checksums must match the file run.
        await withAppPager(spanBytes: 4 << 30) {
            var app = cfg; app["backing"] = "app"; app["ctrl"] = 65536; app["slot0"] = 1 << 20; app["slot1"] = (1 << 20) + 16384
            _ = await self.opfs("bigmem", app)
        }
        // Page-in cost alone: uniform over 4 GB, nearly every access faults.
        var f2 = cfg; f2["backing"] = "file"; f2["fileOffMB"] = 4096; f2["hotPct"] = 0; f2["n"] = 30_000; f2["rounds"] = 1
        _ = await opfs("bigmem", f2)
        await withAppPager(spanBytes: 4 << 30) {
            var a2 = cfg; a2["backing"] = "app"; a2["ctrl"] = 65536; a2["slot0"] = 1 << 20; a2["slot1"] = (1 << 20) + 16384
            a2["hotPct"] = 0; a2["n"] = 30_000; a2["rounds"] = 1
            _ = await self.opfs("bigmem", a2)
        }
        let alive = await callProbe("env", timeout: 30)
        var info = NativeBench.memoryInfo(); info["suite"] = "opfs_bigmem"; info["webcontentAliveAfter"] = alive; Log.result(info)
    }

    /// Runs `body` while an app thread serves page swaps from anonymous app memory.
    private func withAppPager(spanBytes: Int, _ body: () async -> Void) async {
        guard let sf = sharedFile else { Log.result(["suite": "app_pager", "error": "no shared file; run opfs_share first"]); return }
        let npages = spanBytes / 16384
        guard let store = mmap(nil, spanBytes, PROT_READ | PROT_WRITE, MAP_PRIVATE | MAP_ANON, -1, 0), store != MAP_FAILED else {
            Log.result(["suite": "app_pager", "error": "store mmap failed"]); return
        }
        let present = UnsafeMutablePointer<UInt8>.allocate(capacity: npages); present.initialize(repeating: 0, count: npages)
        let run = UnsafeMutablePointer<Int32>.allocate(capacity: 1); run.pointee = 1
        let served = UnsafeMutablePointer<UInt64>.allocate(capacity: 1); served.pointee = 0
        let base = sf.base.assumingMemoryBound(to: UInt8.self), storeP = store.assumingMemoryBound(to: UInt8.self)
        let t = Thread { sh_pager_server(base, 65536, 1 << 20, (1 << 20) + 16384, storeP, present, UInt32(npages), run, served) }
        t.qualityOfService = .userInteractive
        t.start()
        await body()
        run.pointee = 0
        try? await Task.sleep(nanoseconds: 50_000_000)
        var info = NativeBench.memoryInfo(); info["suite"] = "app_pager"; info["served"] = served.pointee; Log.result(info)
        munmap(store, spanBytes); present.deallocate(); run.deallocate(); served.deallocate()
    }

    /// Deletes OPFS test files left in any origin directory by earlier runs.
    static func removeStaleOPFSFiles() {
        let root = NSHomeDirectory() + "/Library/WebKit/WebsiteData"
        var removed: [String] = []
        if let e = FileManager.default.enumerator(atPath: root) {
            for case let rel as String in e where rel.hasSuffix("/FileSystem/probe.bin") {
                if (try? FileManager.default.removeItem(atPath: root + "/" + rel)) != nil { removed.append(rel) }
            }
        }
        Log.result(["suite": "native_cleanup", "removed": removed])
    }

    func opfsCleanup() async {
        sharedFile = nil
        _ = await opfs("remove", ["name": "probe.bin"])
        let est = await opfs("estimate")
        Log.result(["suite": "opfs_cleanup", "estimateAfter": est["result"] ?? "?"])
    }
}

extension ProbeViewController {
    /// Is the shared file RAM or flash? Raw flash vs page cache, and whether a
    /// constantly rewritten doorbell page turns into flash writes.
    func storageCheck() async {
        let tmp = NSTemporaryDirectory()
        await Task.detached {
            var r = sh_storage_t()
            let rc = sh_storage_check(tmp + "storagecheck.bin", 256 << 20, &r)
            Log.result(["suite": "storagecheck", "rc": rc,
                        "flashWriteMBps": r.flashWriteMBps, "flashSeqReadMBps": r.flashSeqReadMBps,
                        "flashRand16k_us": ["p50": r.flashRandUsP50, "avg": r.flashRandUsAvg, "p99": r.flashRandUsP99],
                        "cacheSeqReadMBps": r.cacheSeqReadMBps,
                        "cacheRand16k_us": ["p50": r.cacheRandUsP50, "avg": r.cacheRandUsAvg, "p99": r.cacheRandUsP99],
                        "ramMemcpy16k_us": r.ramMemcpy16kUs])
            for (mode, name) in [(0, "mmap-store"), (1, "pwrite-8B")] {
                var p0: UInt64 = 0, l0: UInt64 = 0, p1: UInt64 = 0, l1: UInt64 = 0
                sh_disk_counters(&p0, &l0)
                let iters = sh_doorbell_load(tmp + "doorbell.bin", 15, Int32(mode))
                sh_disk_counters(&p1, &l1)
                Log.result(["suite": "storagecheck", "test": "doorbell-\(name)", "seconds": 15, "iterations": iters,
                            "flashBytesWritten": p1 &- p0, "logicalBytesWritten": l1 &- l0])
            }
        }.value
    }
}
