// SPDX-License-Identifier: GPL-3.0-or-later
import Foundation

enum DiagnosticStatus: String, Codable {
    case pending, running, passed, failed, skipped, unsupported
}
enum DiagnosticRunState: String, Codable {
    case running, completed, cancelled, interrupted
}
enum DiagnosticPreset: String, Codable, CaseIterable, Identifiable {
    case quick, runtimeCore, transport, memory, threads, wineReadiness, graphicsReadiness, full
    var id: String { rawValue }
    var title: String {
        switch self {
        case .quick: return "Quick"
        case .runtimeCore: return "Runtime Core"
        case .transport: return "Transport"
        case .memory: return "Memory / Paging"
        case .threads: return "Threads"
        case .wineReadiness: return "Wine Readiness"
        case .graphicsReadiness: return "Graphics Readiness"
        case .full: return "Full Diagnostic Matrix"
        }
    }
}
enum DiagnosticTransportMode: String, Codable {
    case copied, mappedPreferred, mappedRequired
}

struct DiagnosticOutcome {
    var status: DiagnosticStatus
    var details: [String: String] = [:]
    var metrics: [String: Double] = [:]
    var counters: [String: Int] = [:]
    var notes: [String] = []
    static func pass(details: [String:String] = [:], metrics: [String:Double] = [:],
                     counters: [String:Int] = [:], notes: [String] = []) -> Self {
        Self(status: .passed, details: details, metrics: metrics, counters: counters, notes: notes)
    }
    static func unsupported(_ reason: String, details: [String:String] = [:]) -> Self {
        var d = details; d["reason"] = reason
        return Self(status: .unsupported, details: d)
    }
}

struct WorkerDiagnosticReply: Codable {
    let status: String
    let details: [String: String]
    let metrics: [String: Double]
    let counters: [String: Int]
    let notes: [String]
    func outcome() throws -> DiagnosticOutcome {
        guard let s = DiagnosticStatus(rawValue: status), s == .passed || s == .unsupported else {
            throw SuiteFailure("Worker diagnostic returned an invalid status.")
        }
        return DiagnosticOutcome(status: s, details: details, metrics: metrics, counters: counters, notes: notes)
    }
}

struct DiagnosticRecord: Codable, Identifiable {
    let id: String
    let title: String
    let category: String
    var status: DiagnosticStatus = .pending
    var startedAt: Date? = nil
    var finishedAt: Date? = nil
    var durationMilliseconds: Double? = nil
    var details: [String: String] = [:]
    var metrics: [String: Double] = [:]
    var counters: [String: Int] = [:]
    var notes: [String] = []
    var error: String? = nil
}

struct DiagnosticReport: Codable {
    let schema: Int
    let suite: String
    let runID: UUID
    let startedAt: Date
    var finishedAt: Date? = nil
    let preset: DiagnosticPreset
    let includeStress: Bool
    var state: DiagnosticRunState = .running
    var environment: [String: String]
    let conditions: [String: String]
    var records: [DiagnosticRecord]

    var overall: String {
        guard state == .completed else { return state.rawValue.uppercased() }
        if records.contains(where: { $0.status == .failed }) { return "FAIL" }
        if records.contains(where: { $0.status == .passed }) &&
            records.allSatisfy({ [.passed,.unsupported,.skipped].contains($0.status) }) { return "PASS" }
        return "INCOMPLETE"
    }
    init(preset: DiagnosticPreset, includeStress: Bool, environment: [String:String],
         conditions: [String:String], specs: [DiagnosticSpec]) {
        schema = 1; suite = "runtime-diagnostics-v1"
        runID = UUID(); startedAt = Date(); self.preset = preset; self.includeStress = includeStress
        self.environment = environment; self.conditions = conditions
        records = specs.map { DiagnosticRecord(id: $0.id, title: $0.title, category: $0.category) }
    }
    mutating func markInterrupted() {
        guard state == .running else { return }
        state = .interrupted; finishedAt = Date()
        for i in records.indices where records[i].status == .pending || records[i].status == .running {
            records[i].status = .skipped
            records[i].error = "No completed result was recorded before the app stopped."
        }
    }
    func data() throws -> Data {
        let encoder = JSONEncoder(); encoder.outputFormatting = [.prettyPrinted,.sortedKeys]; encoder.dateEncodingStrategy = .iso8601
        var object = try JSONSerialization.jsonObject(with: encoder.encode(self)) as! [String: Any]
        object["overall"] = overall
        var counts: [String:Int] = [:]
        for record in records { counts[record.status.rawValue, default: 0] += 1 }
        object["summary"] = counts
        object["unsupported"] = records.filter { $0.status == .unsupported }.map { $0.id }
        return try JSONSerialization.data(withJSONObject: object, options: [.prettyPrinted,.sortedKeys])
    }
}
