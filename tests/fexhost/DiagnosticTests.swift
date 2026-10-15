// SPDX-License-Identifier: GPL-3.0-or-later
import Foundation

@main struct DiagnosticTests {
    static func main() throws {
        var checks=0
        func check(_ value:@autoclosure()->Bool,_ message:String){precondition(value(),message);checks+=1}
        check(DiagnosticPlan.specs(.quick,includeStress:false).count==7,"quick inventory")
        check(DiagnosticPlan.specs(.full,includeStress:false).count==26,"full safe inventory")
        check(DiagnosticPlan.specs(.full,includeStress:true).count==28,"full stress inventory")
        check(DiagnosticPlan.specs(.transport,includeStress:false).map(\.category).allSatisfy{$0=="Transport" || $0=="Storage"},"transport preset")
        let specs=DiagnosticPlan.specs(.quick,includeStress:false)
        var report=DiagnosticReport(preset:.quick,includeStress:false,environment:[:],conditions:[:],specs:specs)
        check(report.overall=="RUNNING","running report cannot pass")
        report.records[0].status = .passed
        for i in 1..<report.records.count { report.records[i].status = .unsupported }
        report.state = .completed
        check(report.overall=="PARTIAL","unsupported readiness is partial rather than a complete pass or failure")
        let partial=try JSONSerialization.jsonObject(with:report.data()) as! [String:Any]
        check(partial["overall"] as? String == "PARTIAL","shared JSON preserves partial integration")
        var complete=report
        for i in complete.records.indices { complete.records[i].status = .passed }
        check(complete.overall=="PASS","all passed checks are a complete pass")
        for i in complete.records.indices { complete.records[i].status = .unsupported }
        check(complete.overall=="UNSUPPORTED","no implemented checks do not produce a pass")
        report.records[1].status = .failed
        check(report.overall=="FAIL","failure dominates")
        var interrupted=DiagnosticReport(preset:.quick,includeStress:false,environment:[:],conditions:[:],specs:specs)
        interrupted.markInterrupted()
        check(interrupted.state == .interrupted && interrupted.records.allSatisfy{$0.status == .skipped},"interruption explicit")
        _=try interrupted.data()
        print("PASS: \(checks) diagnostic-plan/report assertions.")
    }
}
