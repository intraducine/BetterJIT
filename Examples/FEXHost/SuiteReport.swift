// SPDX-License-Identifier: GPL-3.0-or-later
import Foundation

enum CaseStatus: String, Codable { case pending, running, passed, failed, skipped }
enum ReportState: String, Codable { case running, completed, cancelled, interrupted }
struct CaseRecord: Codable, Identifiable {
    let id: String
    let title: String
    var status: CaseStatus = .pending
    var expected: String
    var actual: String? = nil
    var checkedCalls = 0
    var firstCallMilliseconds: Double? = nil
    var warmMilliseconds: [Double] = []
    var medianWarmMilliseconds: Double? {
        guard status == .passed, timingNote == nil else { return nil }
        return Self.median(warmMilliseconds)
    }
    var memoryMatched: Bool? = nil
    var error: String? = nil
    var timingNote: String? = nil
    static func median(_ samples: [Double]) -> Double? {
        guard !samples.isEmpty else { return nil }
        let values = samples.sorted(); let i = values.count / 2
        return values.count % 2 == 0 ? (values[i-1] + values[i])/2 : values[i]
    }
}
struct StageRecord: Codable, Identifiable {
    let id: String
    let title: String
    let kind: StageKind
    let abi: GuestABI?
    var status: CaseStatus = .pending
    var setupMilliseconds: [String: Double] = [:]
    var capabilities: [String: String] = [:]
    var counters: [String: Int] = [:]
    var error: String? = nil
    var cases: [CaseRecord]
}
struct SuiteReport: Codable {
    let schema: Int
    let suite: String
    let runID: UUID
    let startedAt: Date
    var finishedAt: Date? = nil
    let mode: SuiteMode
    var state: ReportState = .running
    var environment: [String: String]
    let conditions: [String: String]
    let fixtureHashes: [String: String]
    let timingContract: String
    var stages: [StageRecord]
    var overall: String {
        guard state == .completed else { return state.rawValue.uppercased() }
        if stages.contains(where: { $0.status == .failed || $0.cases.contains(where: { $0.status == .failed }) }) { return "FAIL" }
        if !stages.isEmpty && stages.allSatisfy({ $0.status == .passed && !$0.cases.isEmpty && $0.cases.allSatisfy { $0.status == .passed } }) { return "PASS" }
        return "INCOMPLETE"
    }
    init(mode: SuiteMode, environment: [String: String], conditions: [String: String]) {
        schema = 1; suite = SuitePlan.version
        timingContract = "Monotonic wall time around one SDK call, including bridge, translation misses and WebKit execution. Input reset, readback and reference checks are excluded. First-call is not guaranteed cold: native FEX caches can survive sessions. No native-FEX baseline, pure guest FPS, JIT ratio or resident-RAM measurement. Warmup calls are checked but untimed."
        runID = UUID(); startedAt = Date(); self.mode = mode; self.environment = environment; self.conditions = conditions
        fixtureHashes = ["source": CompiledGuest.sourceSHA256, "sysv": CompiledGuest.sysvSHA256, "win64": CompiledGuest.win64SHA256]
        stages = SuitePlan.stages(mode).map { stage in
            StageRecord(id: stage.id, title: stage.title, kind: stage.kind, abi: stage.abi,
                        cases: stage.cases.map { CaseRecord(id: $0.id, title: $0.title, expected: String($0.expected)) })
        }
    }
    // Checkpoint files left running after process death are explicitly interrupted.
    mutating func markInterrupted() {
        guard state == .running else { return }
        state = .interrupted; finishedAt = Date()
        for i in stages.indices {
            if stages[i].status == .pending || stages[i].status == .running { stages[i].status = .skipped }
            for j in stages[i].cases.indices where stages[i].cases[j].status == .pending || stages[i].cases[j].status == .running {
                stages[i].cases[j].status = .skipped
                stages[i].cases[j].error = "No completed reply was recorded before the app stopped."
            }
        }
    }
    func data() throws -> Data {
        let encoder = JSONEncoder(); encoder.outputFormatting = [.prettyPrinted,.sortedKeys]; encoder.dateEncodingStrategy = .iso8601
        // Include computed summaries without losing the full individual sample series.
        var object = try JSONSerialization.jsonObject(with: encoder.encode(self)) as! [String: Any]
        object["overall"] = overall
        object["warmMediansMilliseconds"] = Dictionary(uniqueKeysWithValues: stages.flatMap { stage in
            stage.cases.compactMap { c -> (String, Double)? in c.medianWarmMilliseconds.map { (stage.id + "/" + c.id, $0) } }
        })
        return try JSONSerialization.data(withJSONObject: object, options: [.prettyPrinted,.sortedKeys])
    }
}

struct StartEvidence {
    var timings: [String: Double] = [:]
    var capabilities: [String: String] = [:]
}
struct CallEvidence {
    let result: UInt64
    let milliseconds: Double
    var memory: Data? = nil
}
@MainActor protocol SuiteExecutor: AnyObject {
    func start() async throws -> StartEvidence
    func invoke(_ test: DeviceCase) async throws -> CallEvidence
    func counters() async -> [String: Int]
    func close() async
    func abort()
}
struct SuiteFailure: Error, LocalizedError {
    let message: String
    var errorDescription: String? { message }
    init(_ message: String) { self.message = message }
}
