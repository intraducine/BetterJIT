// SPDX-License-Identifier: GPL-3.0-or-later
import Foundation

/// A real bundled musl/BusyBox workload, not a synthetic Wasm diagnostic.
enum LinuxUserspaceWorkload {
    static let payloadBytes = 256 * 1024
    static let expectedSHA256 = "d30eb241f95e7c37c033251a78eae1610ac9b02dc99625442158180d35818c1b"
    static let marker = "BetterJIT userspace OK"
    static let arguments = ["/bin/busybox", "sh", "-c",
        "set -e; /bin/busybox cat /test/userspace.bin | /bin/busybox sha256sum; /bin/busybox printf 'BetterJIT userspace OK\\n'"]
    static var payload: Data { Data((0..<payloadBytes).map { UInt8(truncatingIfNeeded:$0 * 31 + 7) }) }
}
