// SPDX-License-Identifier: GPL-3.0-or-later
import Foundation

enum SparsePipelineFixture {
    static let expected=SparseCatFixture.expected
    static let input=SparseCatFixture.input
    static func load() throws -> (Data,SparseROT13Fixture.Payload) {
        guard let url=Bundle.main.url(forResource:"sparse-pipeline",withExtension:"json") else {throw SparseROT13Fixture.LinuxFixtureError.missing}
        let bytes=try Data(contentsOf:url);guard bytes.count<=128*1024 else {throw SparseROT13Fixture.LinuxFixtureError.invalid}
        let p=try JSONDecoder().decode(SparseROT13Fixture.Payload.self,from:bytes)
        guard p.schema==1,let elf=Data(base64Encoded:p.elf),SparseCatFixture.digest(elf)==p.elfSHA256 else {throw SparseROT13Fixture.LinuxFixtureError.invalid}
        return(elf,p)
    }
    struct RuntimeEvidence:Decodable {
        struct Backing:Decodable {let ownedPayloadBytes:Int}
        struct Birth:Decodable {let pid:Int}
        struct Exec:Decodable {let pid:Int;let path:String}
        let steps:Int;let internalContextsRetained:Int;let internalBytesRetained:Int
        let stdin:SparseCatFixture.RuntimeEvidence.Input;let guestBacking:Backing
        let births:[Birth];let commits:[Exec]
        let guestAccessQuiescenceAcknowledged:Bool;let workerRetirementAcknowledged:Bool
        let internalContextsRetainedUntilSessionTeardown:Bool
        static func parse(_ log:String)throws->Self {
            let prefix="[sparse-processes] "
            guard let line=log.split(separator:"\n").last(where:{$0.hasPrefix(prefix)})else {throw SparseROT13Fixture.LinuxFixtureError.invalid}
            return try JSONDecoder().decode(Self.self,from:Data(line.dropFirst(prefix.count).utf8))
        }
    }
}
