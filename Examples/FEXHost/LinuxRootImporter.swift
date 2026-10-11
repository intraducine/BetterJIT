// SPDX-License-Identifier: GPL-3.0-or-later
import Foundation

/// Transfer staged, user-selected redistributable inputs without a new app build.
/// Build into a sibling directory, then replace only after validation succeeds.
actor LinuxRootImporter {
    static func copy(from source:URL,to target:URL,progress:@escaping @Sendable (Int)->Void) async throws {
        try await LinuxRootImporter().perform(source:source,target:target,progress:progress)
    }
    private func perform(source:URL,target:URL,progress:@escaping @Sendable (Int)->Void) throws {
        let fm=FileManager.default
        let source=source.standardizedFileURL.resolvingSymlinksInPath()
        guard source != target.standardizedFileURL,
              fm.fileExists(atPath:source.appendingPathComponent("opt/wine/bin/wine").path) else {
            throw SuiteFailure("Select a staged root folder containing opt/wine/bin/wine, .symlinks.json and .modes.json.")
        }
        let parent=target.deletingLastPathComponent()
        let staging=parent.appendingPathComponent(".linuxroot-import-\(UUID().uuidString)")
        let backup=parent.appendingPathComponent(".linuxroot-previous-\(UUID().uuidString)")
        try fm.createDirectory(at:staging,withIntermediateDirectories:true)
        defer { try? fm.removeItem(at:staging) }
        guard let items=fm.enumerator(at:source,includingPropertiesForKeys:[.isRegularFileKey,.isDirectoryKey,.isSymbolicLinkKey,.fileSizeKey],options:[]) else {
            throw SuiteFailure("Could not read the selected folder.")
        }
        var count=0, bytes:UInt64=0
        for case let item as URL in items {
            try Task.checkCancellation()
            count += 1
            guard count <= 150_000 else { throw SuiteFailure("Root exceeds 150,000 entries.") }
            let values=try item.resourceValues(forKeys:[.isRegularFileKey,.isDirectoryKey,.isSymbolicLinkKey,.fileSizeKey])
            let relative=String(item.path.dropFirst(source.path.count+1))
            let destination=staging.appendingPathComponent(relative)
            if values.isSymbolicLink == true {
                // Use the staging tool's manifests so symlinks survive Files providers.
                throw SuiteFailure("Root contains filesystem symlinks. Stage it with scripts/stage-linux-runtime.py first.")
            } else if values.isDirectory == true {
                try fm.createDirectory(at:destination,withIntermediateDirectories:true)
            } else if values.isRegularFile == true {
                bytes += UInt64(max(0,values.fileSize ?? 0))
                guard bytes <= 8*1024*1024*1024 else { throw SuiteFailure("Root exceeds the 8 GiB import limit.") }
                try fm.createDirectory(at:destination.deletingLastPathComponent(),withIntermediateDirectories:true)
                guard fm.createFile(atPath:destination.path,contents:nil) else { throw SuiteFailure("Could not create imported file.") }
                let input=try FileHandle(forReadingFrom:item), output=try FileHandle(forWritingTo:destination)
                defer { try? input.close(); try? output.close() }
                while let chunk=try input.read(upToCount:1024*1024), !chunk.isEmpty {
                    try Task.checkCancellation(); try output.write(contentsOf:chunk)
                }
            } else { throw SuiteFailure("Root contains an unsupported filesystem entry.") }
            if count % 100 == 0 { progress(count) }
        }
        try Task.checkCancellation()
        if fm.fileExists(atPath:target.path) { try fm.moveItem(at:target,to:backup) }
        do { try fm.moveItem(at:staging,to:target) }
        catch { if fm.fileExists(atPath:backup.path) { try? fm.moveItem(at:backup,to:target) }; throw error }
        try? fm.removeItem(at:backup); progress(count)
    }
}
