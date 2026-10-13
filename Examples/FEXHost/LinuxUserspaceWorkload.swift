// SPDX-License-Identifier: GPL-3.0-or-later
import Foundation

/// A real bundled musl/BusyBox workload, not a synthetic Wasm diagnostic.
enum LinuxUserspaceWorkload {
    static let payloadBytes = 256 * 1024
    static let expectedSHA256 = "d30eb241f95e7c37c033251a78eae1610ac9b02dc99625442158180d35818c1b"
    static let marker = "BetterJIT userspace OK"
    static let requiredMarkers = ["BetterJIT files OK", "BetterJIT signals OK", "BetterJIT process status OK", marker]
    // The host runner reads this exact script too: no separate easier workload.
    static let script = #"""
    set -e
    umask 077
    work=/tmp/betterjit-session-$$
    /bin/busybox mkdir "$work"
    /bin/busybox cp /test/userspace.bin "$work/copy"
    /bin/busybox cmp /test/userspace.bin "$work/copy"
    /bin/busybox mv "$work/copy" "$work/renamed"
    /bin/busybox sha256sum "$work/renamed"
    printf 'BetterJIT files OK\n'
    signal_seen=0
    trap 'signal_seen=1' USR1
    kill -USR1 "$$"
    test "$signal_seen" = 1
    trap - USR1
    printf 'BetterJIT signals OK\n'
    /bin/busybox sh -c 'exit 7' &
    child=$!
    if wait "$child"; then exit 1; else child_status=$?; fi
    test "$child_status" = 7
    printf 'BetterJIT process status OK\n'
    /bin/busybox cat /test/userspace.bin | /bin/busybox sha256sum
    /bin/busybox rm "$work/renamed"
    /bin/busybox rmdir "$work"
    printf 'BetterJIT userspace OK\n'
    """#
    static let arguments = ["/bin/busybox", "sh", "-c", script]
    static var payload: Data { Data((0..<payloadBytes).map { UInt8(truncatingIfNeeded:$0 * 31 + 7) }) }
}
