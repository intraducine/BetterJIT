import Foundation
import BetterJITCore

// This tool emits Wasm as DATA; it never allocates native executable memory.
do {
    let args = Array(CommandLine.arguments.dropFirst())
    if args.count == 3, args[0] == "compile" {
        let wasm = try X86Wasm.compile(X86Wasm.hex(args[1]))
        try wasm.write(to: URL(fileURLWithPath: args[2]))
        print("Wrote \(wasm.count) Wasm bytes")
    } else if args.count == 2, args[0] == "fixtures" {
        let destination = URL(fileURLWithPath: args[1], isDirectory: true)
        try FileManager.default.createDirectory(at: destination, withIntermediateDirectories: true)
        let fixtures: [(String, [UInt8])] = [
            ("arithmetic", try X86Wasm.hex(X86Wasm.arithmeticHex)),
            ("low-memory", X86Wasm.memoryFixture(address: 8192)),
            ("high-memory", X86Wasm.memoryFixture(address: Transport.highOffset)),
            ("negative", try X86Wasm.hex("48 05 ff ff ff ff c3")),
            ("extended", try X86Wasm.hex("49 b8 ff ff ff ff ff ff ff ff 4c 01 c0 c3")),
            ("sign-boundary", try X86Wasm.hex("48 b8 00 00 00 00 00 00 00 80 c3"))
        ]
        var config: [String: Any] = ["schema": 1, "highOffset": String(Transport.highOffset)]
        for (name, x86) in fixtures {
            let bytes = try X86Wasm.compile(x86)
            try bytes.write(to: destination.appendingPathComponent(name + ".wasm"))
            config[name] = bytes.base64EncodedString()
        }
        let json = try JSONSerialization.data(withJSONObject: config, options: [.sortedKeys, .prettyPrinted])
        try json.write(to: destination.appendingPathComponent("fixtures.json"))
        print("Emitted \(fixtures.count) native-translated fixtures")
    } else {
        throw ProbeError.invalid("Usage: betterjit-probe fixtures <directory> | compile '<hex ending in c3>' <output.wasm>")
    }
} catch {
    FileHandle.standardError.write(Data("\(error)\n".utf8))
    exit(1)
}
