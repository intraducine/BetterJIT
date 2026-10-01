// SPDX-License-Identifier: GPL-3.0-or-later
import Foundation
#if canImport(Darwin)
import Darwin
#elseif canImport(Glibc)
import Glibc
#endif

public protocol LinuxTranslationBackend: AnyObject {
    func configuration(space: UInt32) throws -> Data
    func dispatcher(space: UInt32) throws -> Data
    func initialState(space: UInt32) throws -> Data
    func unit(space: UInt32, rip: UInt32) throws -> Data
    func region(space: UInt32, profile: Data) throws -> Data
    func mapCode(space: UInt32, address: UInt64, bytes: Data, abi: UInt32) throws
    func patchCode(space: UInt32, address: UInt64, bytes: Data) throws
    func unmapCode(space: UInt32, address: UInt64, size: UInt64) throws
    func drop(space: UInt32)
    func close()
}

public protocol LinuxFileSystemSource: AnyObject {
    func indexJSON() throws -> Data
    func readFile(path: String, offset: Int?, length: Int?) throws -> Data
}

public struct LinuxRuntimeConfiguration: Sendable, Equatable {
    public var arguments: [String]
    public var environment: [String:String]
    public var currentDirectory: String
    public var timeoutSeconds: Double
    public var display: String?
    public var screenOnly: Bool
    public var regions: Bool
    public var trace: Bool
    public var traceCode: Bool
    public var traceMaps: Bool
    public var slowWaitMilliseconds: Double
    public var kernelSpinMilliseconds: Double
    public var threadSpinMilliseconds: Double

    public init(arguments: [String],
                environment: [String:String] = [:],
                currentDirectory: String = "/",
                timeoutSeconds: Double = 60,
                display: String? = nil,
                screenOnly: Bool = false,
                regions: Bool = true,
                trace: Bool = false,
                traceCode: Bool = false,
                traceMaps: Bool = false,
                slowWaitMilliseconds: Double = 0,
                kernelSpinMilliseconds: Double = 0.05,
                threadSpinMilliseconds: Double = 0.02) {
        self.arguments = arguments
        self.environment = environment
        self.currentDirectory = currentDirectory
        self.timeoutSeconds = timeoutSeconds
        self.display = display
        self.screenOnly = screenOnly
        self.regions = regions
        self.trace = trace
        self.traceCode = traceCode
        self.traceMaps = traceMaps
        self.slowWaitMilliseconds = slowWaitMilliseconds
        self.kernelSpinMilliseconds = kernelSpinMilliseconds
        self.threadSpinMilliseconds = threadSpinMilliseconds
    }
}

public struct LinuxRuntimeResult: Sendable, Equatable {
    public let exitCode: Int
    public let milliseconds: Double
    public let log: String
    public init(exitCode: Int, milliseconds: Double, log: String) {
        self.exitCode = exitCode; self.milliseconds = milliseconds; self.log = log
    }
}

public enum LinuxRuntimeError: Error, LocalizedError, Sendable, Equatable {
    case invalidConfiguration(String)
    case server(String)
    case guest(String)
    case closed

    public var errorDescription: String? {
        switch self {
        case .invalidConfiguration(let m), .server(let m), .guest(let m): return m
        case .closed: return "The Linux runtime session is closed."
        }
    }
}

public final class DirectoryLinuxFileSystem: LinuxFileSystemSource {
    public let root: URL
    private let overlay: [String:Data]
    private let fm = FileManager.default

    public init(root: URL, overlay: [String:Data] = [:]) throws {
        self.root = root.standardizedFileURL
        var checked: [String:Data] = [:]
        for (path,data) in overlay {
            guard Self.validGuestPath(path) else {
                throw LinuxRuntimeError.invalidConfiguration("Invalid overlay guest path.")
            }
            checked[path] = data
        }
        self.overlay = checked
    }

    public func indexJSON() throws -> Data {
        var entries: [[Any]] = []
        var known = Set<String>()

        func add(_ row: [Any]) {
            guard let path = row.first as? String, known.insert(path).inserted else { return }
            entries.append(row)
        }
        func walk(_ url: URL, guest: String) {
            guard guest != "/.symlinks.json",
                  let attrs = try? fm.attributesOfItem(atPath: url.path) else { return }
            let type = attrs[.type] as? FileAttributeType
            let mode = (attrs[.posixPermissions] as? NSNumber)?.intValue ?? 0o644
            let mtime = ((attrs[.modificationDate] as? Date) ?? Date()).timeIntervalSince1970 * 1000
            if type == .typeSymbolicLink {
                let target = (try? fm.destinationOfSymbolicLink(atPath: url.path)) ?? ""
                if target != "fexwasm:socket" { add([guest,"l",0o777,target.utf8.count,mtime,target]) }
            } else if type == .typeDirectory {
                add([guest,"d",mode,0,mtime])
                if guest == "/tmp" { return }
                for name in (try? fm.contentsOfDirectory(atPath: url.path)) ?? [] {
                    walk(url.appendingPathComponent(name), guest: (guest == "/" ? "" : guest) + "/" + name)
                }
            } else if type == .typeRegular {
                add([guest,"f",mode,(attrs[.size] as? NSNumber)?.intValue ?? 0,mtime])
            }
        }

        if fm.fileExists(atPath: root.path) { walk(root, guest:"/") }
        else { add(["/","d",0o755,0,Date().timeIntervalSince1970 * 1000]) }

        if let manifest = try? Data(contentsOf: root.appendingPathComponent(".symlinks.json")),
           let links = try? JSONDecoder().decode([String:String].self, from: manifest) {
            for (path,target) in links.sorted(by: { $0.key < $1.key }) where Self.validGuestPath(path) {
                add([path,"l",0o777,target.utf8.count,Date().timeIntervalSince1970 * 1000,target])
            }
        }

        func ensureParents(_ path: String) {
            let parts = path.split(separator:"/")
            if parts.count < 2 { return }
            var current = ""
            for part in parts.dropLast() {
                current += "/" + part
                add([current,"d",0o755,0,Date().timeIntervalSince1970 * 1000])
            }
        }
        for (path,data) in overlay.sorted(by: { $0.key < $1.key }) {
            ensureParents(path)
            add([path,"f",0o755,data.count,Date().timeIntervalSince1970 * 1000])
        }
        for path in ["/proc","/dev","/sys","/tmp","/usr","/usr/bin","/bin","/home","/home/user","/test"] {
            add([path,"d",0o755,0,Date().timeIntervalSince1970 * 1000])
        }

        entries.sort { (($0.first as? String) ?? "") < (($1.first as? String) ?? "") }
        let object: [String:Any] = ["entries":entries,"uid":Int(getuid()),"gid":Int(getgid())]
        return try JSONSerialization.data(withJSONObject: object)
    }

    public func readFile(path: String, offset: Int?, length: Int?) throws -> Data {
        guard Self.validGuestPath(path), path != "/.symlinks.json" else {
            throw LinuxRuntimeError.guest("Invalid guest file path.")
        }
        if let data = overlay[path] {
            return Self.slice(data, offset: offset, length: length)
        }
        let relative = path.split(separator:"/").map(String.init)
        var url = root
        for component in relative { url.appendPathComponent(component, isDirectory:false) }
        let standardized = url.standardizedFileURL
        let base = root.path.hasSuffix("/") ? root.path : root.path + "/"
        guard standardized.path == root.path || standardized.path.hasPrefix(base) else {
            throw LinuxRuntimeError.guest("Guest file escaped its root.")
        }
        let attrs = try fm.attributesOfItem(atPath: standardized.path)
        guard attrs[.type] as? FileAttributeType == .typeRegular else {
            throw LinuxRuntimeError.guest("Guest file is not a regular file.")
        }
        let handle = try FileHandle(forReadingFrom: standardized)
        defer { try? handle.close() }
        let fileSize = (attrs[.size] as? NSNumber)?.intValue ?? 0
        let start = max(0, min(offset ?? 0, fileSize))
        let requested = length.map { max(0, min($0, fileSize - start)) } ?? (fileSize - start)
        try handle.seek(toOffset: UInt64(start))
        return try handle.read(upToCount: requested) ?? Data()
    }

    private static func slice(_ data: Data, offset: Int?, length: Int?) -> Data {
        let start = max(0, min(offset ?? 0, data.count))
        let n = length.map { max(0, min($0, data.count - start)) } ?? (data.count - start)
        return data.subdata(in: start..<(start+n))
    }

    private static func validGuestPath(_ path: String) -> Bool {
        guard path.first == "/", path.utf8.count <= 4096, !path.contains("\0") else { return false }
        return !path.split(separator:"/", omittingEmptySubsequences:false).contains(where: { $0 == ".." || $0 == "." })
    }
}
