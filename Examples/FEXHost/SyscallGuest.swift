// SPDX-License-Identifier: GPL-3.0-or-later
import Foundation

enum SyscallGuest {
    static let base: UInt32 = 0x400000
    // Linux x86-64: mov eax,NR; syscall; ret. Unknown syscall deliberately checks -ENOSYS.
    static let image = Data([
        0xb8,0x27,0,0,0,0x0f,0x05,0xc3,       // getpid 39
        0xb8,0xba,0,0,0,0x0f,0x05,0xc3,       // gettid 186
        0xb8,0x18,0,0,0,0x0f,0x05,0xc3,       // sched_yield 24
        0xb8,0x0f,0x27,0,0,0x0f,0x05,0xc3     // syscall 9999 -> -ENOSYS
    ])
    static let getpid = base
    static let gettid = base + 8
    static let yield = base + 16
    static let unsupported = base + 24
    static let enosys = UInt64.max - 37
}
