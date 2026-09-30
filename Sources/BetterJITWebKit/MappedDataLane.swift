// SPDX-License-Identifier: GPL-3.0-or-later
#if canImport(Darwin)
import Foundation
import Darwin
import BetterJIT

public enum MappedTransportPreference: String, Sendable {
    case disabled
    case preferred
    case required
}

public struct MappedTransportStatistics: Sendable, Equatable {
    public let active: Bool
    public let nativeReadBytes: Int
    public let nativeWriteBytes: Int
    public let mappedServiceCalls: Int
    public let fallbackReason: String?
}

struct MappedLease: Equatable {
    let token: String
    let slot: Int
    let offset: UInt64
    let capacity: Int
    let generation: UInt64
}

/// Experimental bounded data plane over one OPFS backing file. The WebWorker owns
/// allocation/leases; native only accepts offsets derived from a validated slot.
/// No executable mappings, arbitrary paths or file resizing are allowed here.
final class MappedDataLane {
    static let headerSize = 4096
    static let slotSize = 16 * 1024 * 1024 + 4096
    static let slotCount = 4
    static let fileSize = headerSize + slotSize * slotCount
    static let thresholdBytes = 4096
    static let requestTag = "__betterjitMappedRequestV1"
    static let valueTag = "__betterjitMappedValueV1"
    static let responseTag = "__betterjitMappedResponseV1"

    let token: String
    private var fd: Int32
    private var mapping: UnsafeMutableRawPointer?

    init(url: URL, token: String) throws {
        guard UUID(uuidString: token)?.uuidString.lowercased() == token else {
            throw RuntimeFault("mappedTransport", "Mapped session token is invalid.")
        }
        self.token = token
        fd = open(url.path, O_RDWR | O_NOFOLLOW | O_CLOEXEC)
        guard fd >= 0 else { throw RuntimeFault("mappedTransport", "Mapped backing file could not be opened.") }
        do {
            var info = stat()
            guard fstat(fd, &info) == 0,
                  (info.st_mode & mode_t(S_IFMT)) == mode_t(S_IFREG),
                  info.st_nlink == 1,
                  info.st_size == off_t(Self.fileSize) else {
                throw RuntimeFault("mappedTransport", "Mapped backing file is not a valid regular file.")
            }
            let p = mmap(nil, Self.fileSize, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0)
            guard p != MAP_FAILED, let p else {
                throw RuntimeFault("mappedTransport", "Mapped backing file could not be memory-mapped.")
            }
            mapping = p
            let marker = Data("BetterJIT-mapped-v1:\(token)\n".utf8)
            guard marker.count <= Self.headerSize,
                  Data(bytes: p, count: marker.count) == marker else {
                throw RuntimeFault("mappedTransport", "Mapped backing file marker does not match this session.")
            }
        } catch {
            if let mapping { _ = munmap(mapping, Self.fileSize); self.mapping = nil }
            _ = Darwin.close(fd); fd = -1
            throw error
        }
    }

    deinit { close() }

    func close() {
        if let mapping { _ = munmap(mapping, Self.fileSize); self.mapping = nil }
        if fd >= 0 { _ = Darwin.close(fd); fd = -1 }
    }

    static func discover(token: String) throws -> MappedDataLane {
        let fm = FileManager.default
        var roots: [URL] = []
        let libraries = fm.urls(for: .libraryDirectory, in: .userDomainMask)
        roots.append(contentsOf: libraries.map { $0.appendingPathComponent("WebKit", isDirectory: true) })
        roots.append(contentsOf: libraries)
        roots.append(contentsOf: fm.urls(for: .applicationSupportDirectory, in: .userDomainMask))
        roots.append(contentsOf: fm.urls(for: .cachesDirectory, in: .userDomainMask))
        roots.append(fm.temporaryDirectory)
        let filename = "betterjit-\(token).bin"
        let deadline = Date().addingTimeInterval(3)
        var visited = 0
        for root in roots {
            let base = root.resolvingSymlinksInPath().standardizedFileURL
            guard let enumerator = fm.enumerator(at: base,
                                                 includingPropertiesForKeys: [.isSymbolicLinkKey, .isRegularFileKey],
                                                 options: [.skipsPackageDescendants]) else { continue }
            for case let candidate as URL in enumerator {
                visited += 1
                guard visited <= 20_000, Date() < deadline else {
                    throw RuntimeFault("mappedTransport", "Mapped backing-file discovery exceeded its bounded search budget.")
                }
                guard candidate.lastPathComponent == filename else { continue }
                guard let values = try? candidate.resourceValues(forKeys: [.isSymbolicLinkKey, .isRegularFileKey]) else { continue }
                if values.isSymbolicLink == true { enumerator.skipDescendants(); continue }
                guard values.isRegularFile == true else { continue }
                let resolved = candidate.resolvingSymlinksInPath().standardizedFileURL
                guard resolved.path.hasPrefix(base.path + "/") else { continue }
                if let lane = try? MappedDataLane(url: resolved, token: token) { return lane }
            }
        }
        throw RuntimeFault("mappedTransport", "WebKit's OPFS backing file was not discoverable from the app sandbox.")
    }

    func validate(_ lease: MappedLease) throws {
        guard lease.token == token,
              (0..<Self.slotCount).contains(lease.slot),
              lease.capacity == Self.slotSize,
              lease.generation > 0,
              lease.offset == UInt64(Self.headerSize + lease.slot * Self.slotSize) else {
            throw RuntimeFault("mappedTransport", "Mapped slot descriptor is invalid.")
        }
    }

    func read(_ lease: MappedLease, length: Int, expectedHash: UInt32) throws -> Data {
        try validate(lease)
        guard let mapping, (0...lease.capacity).contains(length) else {
            throw RuntimeFault("mappedTransport", "Mapped request length is invalid.")
        }
        let p = mapping.advanced(by: Int(lease.offset))
        let data = Data(bytes: p, count: length)
        guard Self.fnv1a(data) == expectedHash else {
            throw RuntimeFault("mappedTransport", "Mapped request checksum mismatch.")
        }
        return data
    }

    func write(_ data: Data, to lease: MappedLease) throws -> UInt32 {
        try validate(lease)
        guard let mapping, data.count <= lease.capacity else {
            throw RuntimeFault("mappedTransport", "Mapped response exceeds its slot capacity.")
        }
        data.withUnsafeBytes { bytes in
            if let base = bytes.baseAddress, !bytes.isEmpty {
                memcpy(mapping.advanced(by: Int(lease.offset)), base, bytes.count)
            }
        }
        return Self.fnv1a(data)
    }

    static func fnv1a(_ data: Data) -> UInt32 {
        data.reduce(UInt32(2_166_136_261)) { ($0 ^ UInt32($1)) &* 16_777_619 }
    }
}
#endif
