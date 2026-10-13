// SPDX-License-Identifier: GPL-3.0-or-later
import Foundation
@main struct SessionTests {
    static func main() async throws {
        let terminal="BetterJIT Wine FS reset OK\n\r\n\u{001B}[?25lMicrosoft Windows 10.0.19043\r\n\u{001B}[?25h"
        precondition(DeviceSessionGuestOutput.windowsVersion(in:terminal) == "Microsoft Windows 10.0.19043")
        precondition(DeviceSessionGuestOutput.windowsVersion(in:"BetterJIT Wine FS reset OK\n") == nil)
        precondition(DeviceSessionGuestOutput.windowsVersion(in:"wine: Windows 10.0.19043 failed\n") == nil)
        var original=DeviceSessionReport(environment:["sourceRevision":"fixture"],conditions:[:])
        original.phases[0].status = .passed
        original.phases[1].status = .running
        original.phases[1].log="last completed log line"
        original.interrupt()
        precondition(original.overall == "INTERRUPTED")
        precondition(original.phases[0].status == .passed && original.phases[1].status == .skipped)
        precondition(original.canResume)
        var cancelled=DeviceSessionReport(environment:[:],conditions:[:])
        cancelled.state = .cancelled; cancelled.phases[0].status = .running
        cancelled.interrupt()
        precondition(cancelled.overall == "CANCELLED" && cancelled.phases[0].status == .skipped)
        var resumed=DeviceSessionReport(environment:[:],conditions:[:],resuming:original)
        precondition(resumed.runID != original.runID && resumed.resumedFrom == original.runID)
        precondition(resumed.phases[0].status == .passed && resumed.phases[1].status == .pending)
        for i in resumed.phases.indices { resumed.phases[i].status = .passed }
        resumed.state = .completed
        precondition(resumed.overall == "PASS")
        resumed.phases[3].status = .unsupported
        precondition(resumed.overall == "PARTIAL")
        resumed.phases[2].status = .failed
        precondition(resumed.overall == "FAIL")
        let decoder=JSONDecoder(); decoder.dateDecodingStrategy = .iso8601
        let restored=try decoder.decode(DeviceSessionReport.self,from:original.data())
        precondition(restored.phases[1].log == "last completed log line")
        let json=try JSONSerialization.jsonObject(with:resumed.data()) as! [String:Any]
        precondition(json["overall"] as? String == "FAIL")
        precondition(json["linuxFixtureSHA256"] as? String == LinuxSessionFixture.elfSHA256)
        // An invalid or cancelled import must leave the previously staged root intact.
        let root=FileManager.default.temporaryDirectory.appendingPathComponent("root-import-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at:root) }
        let source=root.appendingPathComponent("source"), target=root.appendingPathComponent("target")
        try FileManager.default.createDirectory(at:source.appendingPathComponent("opt/wine/bin"),withIntermediateDirectories:true)
        try FileManager.default.createDirectory(at:target,withIntermediateDirectories:true)
        try Data("existing".utf8).write(to:target.appendingPathComponent("keep"))
        do {
            try await LinuxRootImporter.copy(from:source,to:target,progress:{ _ in })
            preconditionFailure("Invalid Wine root was accepted")
        } catch {}
        let retained=try Data(contentsOf:target.appendingPathComponent("keep"))
        precondition(retained == Data("existing".utf8))
        try Data("wine fixture".utf8).write(to:source.appendingPathComponent("opt/wine/bin/wine"))
        try await LinuxRootImporter.copy(from:source,to:target,progress:{ _ in })
        precondition(FileManager.default.fileExists(atPath:target.appendingPathComponent("opt/wine/bin/wine").path))
        try FileManager.default.moveItem(at:source.appendingPathComponent("opt/wine/bin/wine"),to:source.appendingPathComponent("opt/wine/bin/wine64"))
        try JSONEncoder().encode(["/opt/wine/bin/wine":"wine64"]).write(to:source.appendingPathComponent(".symlinks.json"))
        precondition(LinuxRootManifest.wineEntryExists(at:source))
        try await LinuxRootImporter.copy(from:source,to:target,progress:{ _ in })
        precondition(LinuxRootManifest.wineEntryExists(at:target))
        print("PASS session interruption/resume, honest aggregate outcomes, JSON round trip and transactional root import")
    }
}
