// SPDX-License-Identifier: GPL-3.0-or-later
import Foundation
@main struct SessionTests {
    static func main() async throws {
        let terminal="BetterJIT Wine FS reset OK\n\r\n\u{001B}[?25lMicrosoft Windows 10.0.19043\r\n\u{001B}[?25h"
        precondition(DeviceSessionGuestOutput.windowsVersion(in:terminal) == "Microsoft Windows 10.0.19043")
        precondition(DeviceSessionGuestOutput.windowsVersion(in:"BetterJIT Wine FS reset OK\n") == nil)
        precondition(DeviceSessionGuestOutput.windowsVersion(in:"wine: Windows 10.0.19043 failed\n") == nil)
        let encoded=AdaptedWinePhase.nestedCreateProcess.markers.joined(separator:"\n").map { char in
            "\u{001B}[?25l"+(char == " " ? "\u{001B}[K\u{001B}[1C" : String(char))+"\u{001B}[?25h"
        }.joined()
        precondition(AdaptedWinePhase.nestedCreateProcess.missingMarkers(in:encoded).isEmpty)
        precondition(AdaptedWinePhase.nestedCreateProcess.missingMarkers(in:"Microsoft Windows 10.0").count == 4)
        precondition(AdaptedWinePhase.nestedCreateProcess.arguments.last == "--captured-stdio")
        precondition(AdaptedWinePhase.nestedCreateProcess.missingMarkers(in:AdaptedWinePhase.nestedCreateProcess.markers.dropLast().joined(separator:"\n")).count == 1)
        precondition(DeviceSessionGuestOutput.consoleText("a\u{001B}[9999999999999999999999999999999999Cb").count == 258)
        precondition(AdaptedWinePhase.command.arguments == ["/opt/wine-flat/bin/wine","/usr/lib/wine/x86_64-windows/cmd.exe","/c","ver"])
        let ids=DeviceSessionReport.plan.map(\.id)
        precondition(ids[1]=="compiled-rot13" && ids[2]=="compiled-cat")
        for phase in AdaptedWinePhase.allCases { precondition(ids.filter{$0 == phase.rawValue}.count == 1) }
        precondition(ids.firstIndex(of:AdaptedWinePhase.nestedCreateProcess.rawValue)! < ids.firstIndex(of:AdaptedWinePhase.spawnContract.rawValue)!)
        precondition(AdaptedWinePhase.fsContract.arguments.count == 1 && AdaptedWinePhase.spawnContract.arguments.count == 1)
        let full=String(repeating:"trace before\r\n",count:20) + "err:fixture:first failure\r\ncontext after\r\n" +
            String(repeating:"later trace 😀\r\n",count:100) + "final milestone\r\n"
        let excerpt=SessionOutputRetention.capture(full,limit:240)
        precondition(excerpt.retention.truncated && excerpt.retention.firstErrorContext?.contains("first failure") == true)
        precondition(excerpt.tail.hasSuffix("final milestone\r\n"))
        precondition(excerpt.tail.count+(excerpt.retention.firstErrorContext?.count ?? 0)<=240)
        precondition(excerpt.retention.originalCharacters==full.count && excerpt.retention.originalUTF8Bytes==full.utf8.count)
        precondition(excerpt.retention.retainedTailUTF8Bytes==excerpt.tail.utf8.count)
        precondition(excerpt.retention.droppedPrefixCharacters==full.count-excerpt.tail.count)
        let middle=SessionOutputRetention.capture("abcdef",limit:3)
        precondition(middle.tail=="def" && middle.retention.tailStartsMidLine)
        let boundary=SessionOutputRetention.capture("abc\r\ndef",limit:3)
        precondition(boundary.tail=="def" && !boundary.retention.tailStartsMidLine)
        let short=SessionOutputRetention.capture("😀\r\n")
        precondition(short.tail=="😀\r\n" && !short.retention.truncated && short.retention.originalUTF8Bytes==6)
        let memoryError=SessionOutputRetention.capture("[memory-allocation] {\"event\":\"failed\"}\n"+String(repeating:"x",count:300),limit:160)
        precondition(memoryError.retention.firstErrorContext?.contains("memory-allocation") == true)
        let longPrelude=SessionOutputRetention.capture(String(repeating:"p",count:1000)+"\nerr:fixture:first failure\n"+String(repeating:"x",count:1000),limit:240)
        precondition(longPrelude.retention.firstErrorContext?.contains("first failure") == true && longPrelude.retention.errorContextClipped)
        let tiny=SessionOutputRetention.capture("trace\nerr:fixture:failed\n",limit:3)
        precondition(tiny.tail.count+(tiny.retention.firstErrorContext?.count ?? 0)<=3)
        var captured=SessionPhase(id:"capture",title:"capture",deadlineSeconds:1)
        captured.captureOutput(log:"diagnostic",stdout:"passed\n",stderr:String(repeating:full,count:100),runtimeTruncated:false)
        precondition(captured.outputTruncated == true && captured.runtimeOutputTruncated == false)
        precondition(captured.outputRetention?["stderr"]?.truncated == true)
        precondition(captured.outputRetention?["stdout"]?.truncated == false)
        let capturedJSON=try JSONEncoder().encode(captured)
        let capturedAgain=try JSONDecoder().decode(SessionPhase.self,from:capturedJSON)
        precondition(capturedAgain.outputRetention?["stderr"]?.firstErrorContext?.contains("first failure") == true)
        captured.captureOutput(log:"",stdout:"short",stderr:"",runtimeTruncated:true)
        precondition(captured.outputTruncated == true && captured.runtimeOutputTruncated == true)
        precondition(captured.outputRetention?.values.allSatisfy({!$0.truncated}) == true)
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
