// SPDX-License-Identifier: GPL-3.0-or-later
import Foundation

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
        .init(id:"wine", title:"Wine: cmd /c ver", deadlineSeconds:110),
        .init(id:"wine-direct", title:"Wine: cmd /c ver with direct loader", deadlineSeconds:110),
        .init(id:"wine-flat", title:"Wine: source-built flat-window Win64", deadlineSeconds:110),
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
