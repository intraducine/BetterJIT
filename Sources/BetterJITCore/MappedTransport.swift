import Foundation
#if canImport(Darwin)
import Darwin
#else
import Glibc
#endif

public enum Transport {
    public static let headerSize = 4096
    public static let maxPayload = 1_048_576
    public static let highOffset: UInt64 = 2_147_483_648 + 65_536

    public static func fnv1a(_ bytes: UnsafeRawBufferPointer) -> UInt32 {
        var hash: UInt32 = 2_166_136_261
        for byte in bytes { hash = (hash ^ UInt32(byte)) &* 16_777_619 }
        return hash
    }

    public static func marker(_ token: String) throws -> Data {
        guard let uuid = UUID(uuidString: token), uuid.uuidString.lowercased() == token else {
            throw ProbeError.invalid("Session must be a canonical lower-case UUID")
        }
        return Data(("BetterJIT-v1:" + token + "\n").utf8)
    }

    /// This is an implementation-layout experiment, not a public WebKit path API.
    /// Only the caller's explicit app-owned roots are searched; no symlinks followed.
    /// Native must never create a replacement file and call that an OPFS success.
    public static func discover(in roots: [URL], token: String) throws -> URL {
        let expected = try marker(token)
        let name = "betterjit-\(token).bin"
        var visited = 0
        let deadline = Date().addingTimeInterval(3)
        for root in roots {
            let resolved = root.resolvingSymlinksInPath().standardizedFileURL
            guard let enumerator = FileManager.default.enumerator(
                at: resolved,
                includingPropertiesForKeys: [.isSymbolicLinkKey, .isRegularFileKey],
                options: [.skipsPackageDescendants]) else { continue }
            for case let url as URL in enumerator {
                visited += 1
                guard visited <= 20_000, Date() < deadline else { throw ProbeError.invalid("OPFS discovery budget exhausted") }
                let values = try url.resourceValues(forKeys: [.isSymbolicLinkKey, .isRegularFileKey])
                if values.isSymbolicLink == true { enumerator.skipDescendants(); continue }
                guard values.isRegularFile == true, url.lastPathComponent == name else { continue }
                let path = url.resolvingSymlinksInPath().standardizedFileURL.path
                guard path.hasPrefix(resolved.path + "/") else { continue }
                // Recheck marker through the descriptor, not by trusting the filename.
                let file = try MappedFile(url: URL(fileURLWithPath: path), marker: expected)
                file.close()
                return URL(fileURLWithPath: path)
            }
        }
        throw ProbeError.invalid("OPFS backing file not found in app-owned WebKit storage; layout/access unsupported")
    }
}

/// A bounded window over an existing regular file. Never creates, truncates, maps
/// executable pages, or keeps a mapping alive across an OPFS resize.
public final class MappedFile {
    private var fd: Int32
    private let expectedMarker: Data
    public let device: UInt64
    public let inode: UInt64

    public init(url: URL, marker: Data) throws {
        guard !marker.isEmpty, marker.count <= Transport.headerSize else { throw ProbeError.invalid("Invalid marker") }
        fd = open(url.path, O_RDWR | O_NOFOLLOW | O_CLOEXEC)
        guard fd >= 0 else { throw ProbeError.invalid("open failed: errno \(errno)") }
        var info = stat()
        guard fstat(fd, &info) == 0, (info.st_mode & mode_t(S_IFMT)) == mode_t(S_IFREG), info.st_nlink == 1 else {
            Self.closeFD(fd); fd = -1
            throw ProbeError.invalid("Backing file must be a regular, non-hardlinked file")
        }
        self.expectedMarker = marker
        device = UInt64(info.st_dev)
        inode = UInt64(info.st_ino)
        do { try validateMarker() }
        catch { Self.closeFD(fd); fd = -1; throw error }
    }

    private static func closeFD(_ fd: Int32) {
        #if canImport(Darwin)
        _ = Darwin.close(fd)
        #else
        _ = Glibc.close(fd)
        #endif
    }
    public func close() { if fd >= 0 { Self.closeFD(fd); fd = -1 } }
    deinit { close() }

    private func validateMarker() throws {
        guard fd >= 0 else { throw ProbeError.invalid("File is closed") }
        var bytes = [UInt8](repeating: 0, count: expectedMarker.count)
        let count = bytes.withUnsafeMutableBytes { pread(fd, $0.baseAddress!, $0.count, 0) }
        guard count == bytes.count, Data(bytes) == expectedMarker else { throw ProbeError.invalid("Session marker mismatch") }
    }

    public func withWindow<T>(offset: UInt64, length: Int, _ body: (UnsafeMutableRawBufferPointer) throws -> T) throws -> T {
        try validateMarker()
        guard length > 0, length <= Transport.maxPayload, offset >= UInt64(Transport.headerSize),
              offset <= UInt64(Int64.max) - UInt64(length) else { throw ProbeError.invalid("Invalid mapping range") }
        var info = stat()
        guard fstat(fd, &info) == 0, info.st_size >= 0,
              offset + UInt64(length) <= UInt64(info.st_size) else { throw ProbeError.invalid("Mapping beyond EOF") }
        let page = sysconf(Int32(_SC_PAGESIZE))
        guard page > 0 else { throw ProbeError.invalid("Cannot determine page size") }
        let aligned = offset - offset % UInt64(page)
        let delta = Int(offset - aligned), mappedLength = delta + length
        let pointer = mmap(nil, mappedLength, PROT_READ | PROT_WRITE, MAP_SHARED, fd, off_t(aligned))
        guard pointer != MAP_FAILED, let pointer else { throw ProbeError.invalid("mmap failed: errno \(errno)") }
        defer { _ = munmap(pointer, mappedLength) }
        // The worker relinquishes this range until the native reply. No claim of
        // cross-process JS Atomics/lock-free coherence is made. No per-message fsync.
        return try body(UnsafeMutableRawBufferPointer(start: pointer.advanced(by: delta), count: length))
    }

    public func exchange(offset: UInt64, length: Int, expectedHash: UInt32) throws -> UInt32 {
        try withWindow(offset: offset, length: length) { bytes in
            guard Transport.fnv1a(UnsafeRawBufferPointer(bytes)) == expectedHash else {
                throw ProbeError.invalid("Worker -> native checksum mismatch")
            }
            for i in bytes.indices { bytes[i] ^= 0x5a }
            return Transport.fnv1a(UnsafeRawBufferPointer(bytes))
        }
    }
}
