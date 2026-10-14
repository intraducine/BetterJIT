// SPDX-License-Identifier: GPL-3.0-or-later
import Foundation

enum DeviceSessionGuestOutput {
    static func consoleText(_ raw:String) -> String {
        let expression=try! NSRegularExpression(pattern:"\u{001B}\\[([0-?]*)([ -/]*)([@-~])")
        let value=NSMutableString(string:raw)
        for match in expression.matches(in:raw,range:NSRange(raw.startIndex...,in:raw)).reversed() {
            let source=raw as NSString
            let parameters=source.substring(with:match.range(at:1))
            let padding=source.substring(with:match.range(at:3)) == "C" && match.range(at:2).length == 0 &&
                parameters.allSatisfy({$0.isASCII && $0.isNumber})
            let count=parameters.isEmpty ? 1 : min(Double(parameters) ?? 256,256)
            value.replaceCharacters(in:match.range,with:padding ? String(repeating:" ",count:max(1,Int(count))) : "")
        }
        return value as String
    }
    static func windowsVersion(in raw:String) -> String? {
        let plain=consoleText(raw)
        guard let range=plain.range(of:"(?im)^\\s*(Microsoft )?Windows[^\\n]*[0-9]+\\.[0-9]+",options:.regularExpression) else { return nil }
        return String(plain[range]).trimmingCharacters(in:.whitespacesAndNewlines)
    }
}

// Each entry owns a fresh runtime session. Diagnostic contracts must not add
// fork/exec allocations to the runtime that starts the actual Wine workload.
enum AdaptedWinePhase: String, CaseIterable {
    case command="wine-flat", nestedCreateProcess="wine-nested-createprocess"
    case fsContract="wine-fs-contract", spawnContract="wine-spawn-contract"
    static let directory="/opt/wine-flat/share/betterjit-provenance/"
    var arguments:[String] {
        switch self {
        case .command: return ["/opt/wine-flat/bin/wine","/usr/lib/wine/x86_64-windows/cmd.exe","/c","ver"]
        case .nestedCreateProcess: return ["/opt/wine-flat/bin/wine",Self.directory+"createprocess.exe","--captured-stdio"]
        case .fsContract: return [Self.directory+"fs-reset.elf"]
        case .spawnContract: return [Self.directory+"spawn-contract.elf"]
        }
    }
    var markers:[String] {
        switch self {
        case .command: return []
        case .nestedCreateProcess: return ["BetterJIT captured stdio OK","GRANDCHILD argv/env/cwd/stdio OK","CHILD nested wait/exit OK","BetterJIT Wine nested CreateProcess OK"]
        case .fsContract: return ["BetterJIT Wine FS reset OK"]
        case .spawnContract: return ["PASS: real spawn fd/cwd/environment/signal/session contracts"]
        }
    }
    var title:String {
        switch self {
        case .command: return "Wine: source-built Win64 cmd /c ver"
        case .nestedCreateProcess: return "Wine: nested Win64 CreateProcess"
        case .fsContract: return "Wine contract: FS reset in an isolated session"
        case .spawnContract: return "Wine contract: spawn and exact-child reaping in an isolated session"
        }
    }
    var timeout:Double { self == .command || self == .nestedCreateProcess ? 180 : 90 }
    func missingMarkers(in log:String) -> [String] {
        let plain=DeviceSessionGuestOutput.consoleText(log)
        return markers.filter{!plain.contains($0)}
    }
}

enum SessionCheckStatus: String, Codable { case pending, running, passed, failed, unsupported, skipped }
struct SessionPhase: Codable, Identifiable {
    let id: String
    let title: String
    let deadlineSeconds: Double
    var status: SessionCheckStatus = .pending
    var startedAt: Date?
    var finishedAt: Date?
    var details: [String:String] = [:]
    var counters: [String:Int] = [:]
    var milliseconds: Double?
    var log = ""
    var error: String?
}
struct DeviceSessionReport: Codable {
    let schema: Int
    let runID: UUID
    let startedAt: Date
    var finishedAt: Date?
    var state: ReportState = .running
    var resumedFrom: UUID?
    var environment: [String:String]
    var conditions: [String:String]
    var phases: [SessionPhase]
    var suites: [String:SuiteReport] = [:]
    var diagnostics: DiagnosticReport?
    static let plan: [SessionPhase] = [
        .init(id:"linux-smoke", title:"Linux ELF: stdout and exit", deadlineSeconds:40),
        .init(id:"linux-services", title:"Linux files, GS base, mmap, clock, random, clone / futex", deadlineSeconds:50),
        .init(id:"linux-channels", title:"Linux workload with native channels requested", deadlineSeconds:50),
        .init(id:"linux-userspace", title:"Linux shell: files, pipes, signals and processes", deadlineSeconds:110),
        .init(id:"consumer-digest",title:"Consumer: packaged backend document digest",deadlineSeconds:80),
        .init(id:AdaptedWinePhase.command.rawValue,title:AdaptedWinePhase.command.title,deadlineSeconds:200),
        .init(id:AdaptedWinePhase.nestedCreateProcess.rawValue,title:AdaptedWinePhase.nestedCreateProcess.title,deadlineSeconds:200),
        .init(id:AdaptedWinePhase.fsContract.rawValue,title:AdaptedWinePhase.fsContract.title,deadlineSeconds:110),
        .init(id:AdaptedWinePhase.spawnContract.rawValue,title:AdaptedWinePhase.spawnContract.title,deadlineSeconds:110),
        .init(id:"wine", title:"Wine: cmd /c ver", deadlineSeconds:110),
        .init(id:"wine-direct", title:"Wine: cmd /c ver with direct loader", deadlineSeconds:110),
        .init(id:"copied-suite", title:"FEX ABI, SIMD, hot regions and timings / copied", deadlineSeconds:480),
        .init(id:"mapped-suite", title:"FEX ABI, SIMD, hot regions and timings / mapped", deadlineSeconds:480),
        .init(id:"diagnostics", title:"Transport, memory, threading and graphics matrix", deadlineSeconds:480)
    ]
    init(environment:[String:String], conditions:[String:String], resuming previous: Self? = nil) {
        schema=1; runID=UUID(); startedAt=Date(); self.environment=environment; self.conditions=conditions
        phases=Self.plan
        if let previous {
            resumedFrom=previous.runID
            for i in phases.indices {
                if let old=previous.phases.first(where:{$0.id == phases[i].id}),
                   [.passed,.failed,.unsupported].contains(old.status) { phases[i]=old }
            }
            suites=previous.suites.filter { key,_ in phases.contains { $0.id == key && $0.status != .pending } }
            if phases.last?.status != .pending { diagnostics=previous.diagnostics }
        }
    }
    var overall: String {
        guard state == .completed else { return state.rawValue.uppercased() }
        if phases.contains(where:{$0.status == .failed}) { return "FAIL" }
        if phases.allSatisfy({$0.status == .passed}) { return "PASS" }
        return "PARTIAL"
    }
    var completedCount: Int { phases.filter { ![.pending,.running].contains($0.status) }.count }
    var canResume: Bool { state != .running && phases.contains { [.pending,.running,.skipped].contains($0.status) } }
    mutating func interrupt(_ reason:String = "App stopped before a completed result was saved.") {
        guard state != .completed else { return }
        if state == .running { state = .interrupted }
        finishedAt=Date()
        for i in phases.indices where [.pending,.running].contains(phases[i].status) {
            phases[i].status = .skipped; phases[i].error=reason
        }
        for key in Array(suites.keys) { suites[key]?.markInterrupted() }
        diagnostics?.markInterrupted()
    }
    func data() throws -> Data {
        let encoder=JSONEncoder(); encoder.dateEncodingStrategy = .iso8601
        var object=try JSONSerialization.jsonObject(with:encoder.encode(self)) as! [String:Any]
        object["overall"]=overall
        object["evidenceContract"]="Linux/Wine phases execute guest ELF through live native FEX and the Linux kernel. ABI suites use fresh x86 translation. Diagnostics identify host primitives and prototypes individually. Unsupported integration is never a complete PASS; timings are transport/call timings, not game speed."
        object["linuxFixtureSHA256"]=LinuxSessionFixture.elfSHA256
        object["linuxFixtureSourceSHA256"]=LinuxSessionFixture.sourceSHA256
        // Preserve each suite's computed summaries as well as its raw checked calls.
        object["suites"]=try suites.mapValues { try JSONSerialization.jsonObject(with:$0.data()) }
        if let diagnostics { object["diagnostics"]=try JSONSerialization.jsonObject(with:diagnostics.data()) }
        return try JSONSerialization.data(withJSONObject:object,options:[.prettyPrinted,.sortedKeys])
    }
}
