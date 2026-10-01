// SPDX-License-Identifier: GPL-3.0-or-later
import Foundation

@MainActor final class ExtendedFixture: SuiteExecutor {
    enum Mode { case okay, requestOnly, noStatistics, severalUnits, flushed, tooFast, drift, badMemory }
    let stage: DeviceStage
    let mode: Mode
    var count=0, closes=0
    var afterInvoke: (() -> Void)?
    init(_ stage: DeviceStage, _ mode: Mode = .okay) { self.stage=stage; self.mode=mode }
    func start() async throws -> StartEvidence { StartEvidence(capabilities:["fixture":"not WebKit/FEX"]) }
    func invoke(_ test: DeviceCase) async throws -> CallEvidence {
        count += 1; afterInvoke?()
        let ms: Double = test.benchmark == nil ? 0.5 : mode == .tooFast ? 0 : mode == .drift && count>3 ? 99 : 200
        return CallEvidence(result:test.expected,milliseconds:ms,memory:mode == .badMemory ? Data() : test.expectedMemory)
    }
    func counters() async -> [String:Int] {
        let region = stage.kind == .region && count>=9
        return ["unitRequests":1,"nativeServiceCalls":count,"regionRequests":region ? 1:0,
                "runtimeStatisticsAvailable":mode == .noStatistics ? 0:1,
                "unitModulesInstalled":mode == .severalUnits ? 2:1,
                "regionModulesInstalled":region && mode != .requestOnly ? 1:0,
                "regionUnitsInstalled":region && mode != .requestOnly ? 1:0,
                "fexCacheFlushes":mode == .flushed ? 1:0]
    }
    func close() async { closes+=1 }
    func abort() {}
}

@main struct ExtendedTests {
    @MainActor static func main() async throws {
        if CommandLine.arguments.contains("--vectors") {
            var rows:[[String:Any]]=[]
            for abi in GuestABI.allCases {
                var tests=AdvancedPlan.simdCases(abi)
                tests += [0,1,2,257,10000].map{AdvancedPlan.vectorLoop(abi,iterations:UInt64($0))}
                for t in tests { rows.append(["abi":abi.rawValue,"entry":t.entry,"expected":String(t.expected),"input":t.input!.base64EncodedString(),
                                              "memory":t.expectedMemory!.base64EncodedString(),"iterations":String(t.arguments.count>1 ? t.arguments[1]:0)]) }
            }
            print(String(data:try JSONSerialization.data(withJSONObject:rows),encoding:.utf8)!);return
        }
        var checks=0
        func check(_ okay:@autoclosure()->Bool,_ message:String) { precondition(okay(),message);checks+=1 }
        check(SuitePlan.stages(.baseline).flatMap(\.cases).count==2,"working baseline unchanged")
        check(SuitePlan.stages(.full).flatMap(\.cases).count==27,"v1 inventory unchanged")
        check(SuitePlan.stages(.extended).flatMap(\.cases).count==43,"v2 inventory")
        check(SuitePlan.stages(.extended).count==16,"v2 stage count")
        check(SuitePlan.stages(.extended).flatMap(\.cases).filter{$0.benchmark != nil}.count==6,"six calibrated workloads")
        for n:UInt64 in [0,1,2,17,1000] {
            var x=UInt32.max
            for _ in 0..<n { x=x &* 5 &+ 7 }
            check(AdvancedPlan.affine(n,seed:.max,add:7)==x,"independent affine oracle")
        }
        let growth=try BenchmarkPolicy.next(iterations:100,milliseconds:0);check(growth==400,"growth bounded")
        let shrink=try BenchmarkPolicy.next(iterations:100,milliseconds:10000);check(shrink==25,"shrink bounded")
        let capped=try BenchmarkPolicy.next(iterations:BenchmarkPolicy.maximumIterations,milliseconds:0);check(capped==BenchmarkPolicy.maximumIterations,"iteration cap")
        for ms in [Double.nan,.infinity,-1] {
            do { _=try BenchmarkPolicy.next(iterations:10,milliseconds:ms);preconditionFailure("bad timer accepted") } catch {checks+=1}
        }
        check(!BenchmarkPolicy.inWindow(99) && BenchmarkPolicy.inWindow(100) && BenchmarkPolicy.inWindow(500) && !BenchmarkPolicy.inWindow(501),"target edges")
        for mode in [ExtendedFixture.Mode.okay,.requestOnly,.noStatistics,.severalUnits,.flushed,.badMemory] {
            var hosts:[ExtendedFixture]=[]
            let runner=SuiteRunner(mode:.extended,environment:[:],conditions:[:],factory:{stage in
                let h=ExtendedFixture(stage,mode);hosts.append(h);return h
            },changed:{_ in})
            let report=await runner.run()
            check(report.overall == (mode == .okay ? "PASS":"FAIL"),"coverage/failure cannot turn into pass")
            check(hosts.allSatisfy{$0.closes==1},"all executors closed once")
            let json=try JSONSerialization.jsonObject(with:report.data()) as! [String:Any]
            if mode == .okay {
                check(json["calibratedTimingStatus"] as? String == "COMPLETE","calibrated series complete")
                let regions=report.stages.flatMap(\.cases).compactMap(\.region)
                check(regions.count==2 && regions.allSatisfy{$0.postInstallationCheckedCalls==2},"checked after installation")
            }
        }
        for mode in [ExtendedFixture.Mode.tooFast,.drift] {
            // Avoid spending time calculating huge scalar oracle inputs in this
            // orchestration fixture: trigger thermal stop after three calls.
            var invocations=0
            let runner=SuiteRunner(mode:.extended,environment:[:],conditions:[:],factory:{stage in
                let h=ExtendedFixture(stage,mode);h.afterInvoke={invocations+=1};return h
            },timingAllowed:{mode != .tooFast || invocations<3},changed:{_ in})
            let report=await runner.run()
            check(report.overall=="PASS","timing limitation is not false correctness failure")
            check(report.stages.flatMap(\.cases).filter{$0.benchmark != nil}.allSatisfy{$0.medianWarmMilliseconds==nil},"no comparable medians on partial series")
            let json=try JSONSerialization.jsonObject(with:report.data()) as! [String:Any]
            check(json["calibratedTimingStatus"] as? String == "INCOMPLETE","partial timing explicit")
        }
        var timingOkay = true
        let lastSampleHot = SuiteRunner(mode:.extended,environment:[:],conditions:[:],factory:{stage in
            timingOkay = true
            let h = ExtendedFixture(stage)
            h.afterInvoke = { if stage.id.hasPrefix("simd-calibration-") && h.count == 8 { timingOkay = false } }
            return h
        },timingAllowed:{timingOkay},changed:{_ in})
        let hotAtEnd = await lastSampleHot.run()
        check(hotAtEnd.overall == "PASS", "last-sample thermal transition is not a false correctness failure")
        let hotVectors = hotAtEnd.stages.filter{$0.id.hasPrefix("simd-calibration-")}.flatMap(\.cases)
        check(hotVectors.allSatisfy{$0.benchmark?.windowSatisfied == false && $0.medianWarmMilliseconds == nil}, "last-sample thermal transition invalidates comparable timings")
        check(hotVectors.allSatisfy{$0.benchmark?.initialIterations == 10_000 && $0.benchmark?.firstExpected == $0.benchmark?.firstActual}, "first-call workload and evidence stay identifiable")
        var stopRunner:SuiteRunner!
        stopRunner=SuiteRunner(mode:.extended,environment:[:],conditions:[:],factory:{stage in
            let h=ExtendedFixture(stage);if stage.kind == .region {h.afterInvoke={stopRunner.stop()}};return h
        },changed:{_ in})
        let cancelled=await stopRunner.run()
        check(cancelled.overall=="CANCELLED","region priming cancellable")
        check(cancelled.stages.last?.status == .skipped,"later stages never implicitly pass")
        let decoder=JSONDecoder();decoder.dateDecodingStrategy = .iso8601
        let restored=try decoder.decode(SuiteReport.self,from:cancelled.data())
        check(restored.schema==2 && restored.overall=="CANCELLED","v2 roundtrip")
        if let i=CommandLine.arguments.firstIndex(of:"--old-report"),CommandLine.arguments.count>i+1 {
            let old=try decoder.decode(SuiteReport.self,from:Data(contentsOf:URL(fileURLWithPath:CommandLine.arguments[i+1])))
            check(old.schema==1 && old.overall=="PASS","user v1 report still readable")
            check(old.stages.flatMap(\.cases).count==27,"old report not relabeled as v2")
        }
        print("PASS: \(checks) extended orchestration/policy assertions. Fixture executors are not WebKit or FEX.")
    }
}
