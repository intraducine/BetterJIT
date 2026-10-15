// SPDX-License-Identifier: GPL-3.0-or-later
import Foundation
import CryptoKit

enum SparseROT13Fixture {
    static let argument="Hello, BetterJIT 2026!"
    static let expected="Uryyb, OrggreWVG 2026!\n"
    struct Payload: Decodable { let schema:Int; let compiler:String; let sourceSHA256:String; let elfSHA256:String; let elf:String }
    static func load() throws -> (Data,Payload) {
        guard let url=Bundle.main.url(forResource:"sparse-rot13",withExtension:"json") else {
            throw LinuxFixtureError.missing
        }
        let data=try Data(contentsOf:url)
        guard data.count <= 128*1024 else { throw LinuxFixtureError.invalid }
        let p=try JSONDecoder().decode(Payload.self,from:data)
        guard p.schema == 1, let elf=Data(base64Encoded:p.elf), elf.count <= 1024*1024,
              SHA256.hash(data:elf).map({String(format:"%02x",$0)}).joined()==p.elfSHA256 else { throw LinuxFixtureError.invalid }
        return (elf,p)
    }
    enum LinuxFixtureError: Error { case missing, invalid }
}
