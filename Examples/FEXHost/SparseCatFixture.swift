// SPDX-License-Identifier: GPL-3.0-or-later
import Foundation
import CryptoKit

enum SparseCatFixture {
    static let expected=String(repeating:"x",count:4095)+"é🙂\nCopied through compiled stdin.\n"
    static let input=Data(expected.utf8)
    static func digest(_ bytes:Data)->String {SHA256.hash(data:bytes).map{String(format:"%02x",$0)}.joined()}
    static func load() throws -> (Data,SparseROT13Fixture.Payload) {
        guard let url=Bundle.main.url(forResource:"sparse-cat",withExtension:"json") else {throw SparseROT13Fixture.LinuxFixtureError.missing}
        let data=try Data(contentsOf:url);guard data.count<=128*1024 else {throw SparseROT13Fixture.LinuxFixtureError.invalid}
        let p=try JSONDecoder().decode(SparseROT13Fixture.Payload.self,from:data)
        guard p.schema==1,let elf=Data(base64Encoded:p.elf),elf.count<=1024*1024,digest(elf)==p.elfSHA256 else {throw SparseROT13Fixture.LinuxFixtureError.invalid}
        return(elf,p)
    }
    struct RuntimeEvidence:Decodable {
        struct Input:Decodable {let providedBytes:Int;let consumedBytes:Int;let positiveReads:Int}
        let steps:Int;let internalBytes:Int;let stdin:Input
        let retainedUntilSessionTeardown:Bool;let workerRetirementAcknowledged:Bool
        static func parse(_ log:String)throws->Self {
            let prefix="[sparse-command] "
            guard let line=log.split(separator:"\n").last(where:{$0.hasPrefix(prefix)})else {throw SparseROT13Fixture.LinuxFixtureError.invalid}
            return try JSONDecoder().decode(Self.self,from:Data(line.dropFirst(prefix.count).utf8))
        }
    }
}
