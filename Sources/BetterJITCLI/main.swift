import Foundation
import Dispatch
import BetterJITCore
#if canImport(Darwin)
import Darwin
#else
import Glibc
#endif

func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data((message + "\n").utf8))
    exit(1)
}
let usage = """
Usage:
  betterjit-probe listen [--address 127.0.0.1|127.0.0.2] [--ike-port 15000] [--nat-port 14500] [--duration 60]
  betterjit-probe profile --output /path/BetterJIT.mobileconfig [--address 127.0.0.1|127.0.0.2]

Only loopback addresses are accepted. Desktop ports default to unprivileged ports.
Use --ike-port 500 --nat-port 4500 for a native-client test (may require privileges on macOS).
A cookie round trip is transport evidence, NOT an established VPN or enabled JIT.
"""
let arguments = Array(CommandLine.arguments.dropFirst())
if arguments.isEmpty || arguments == ["--help"] { print(usage); exit(0) }
let command = arguments[0]
guard ["listen", "profile"].contains(command) else { fail(usage) }
var options: [String: String] = [:]
let allowed: Set<String> = command == "listen"
    ? ["--address", "--ike-port", "--nat-port", "--duration"] : ["--address", "--output"]
var index = 1
while index < arguments.count {
    let key = arguments[index]
    guard allowed.contains(key), index + 1 < arguments.count, options[key] == nil else { fail("Invalid arguments.\n" + usage) }
    options[key] = arguments[index + 1]; index += 2
}
guard let address = LoopbackAddress(rawValue: options["--address"] ?? "127.0.0.1") else { fail("Address must be 127.0.0.1 or 127.0.0.2") }
if command == "profile" {
    guard let path = options["--output"] else { fail("--output is required") }
    do {
        let url = URL(fileURLWithPath: path)
        try ProbeProfile.make(address: address).write(to: url, options: .atomic)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
        print("Wrote removable localhost-only test profile to \(url.path)")
        exit(0)
    } catch { fail(String(describing: error)) }
}
guard let ike = UInt16(options["--ike-port"] ?? "15000"),
      let nat = UInt16(options["--nat-port"] ?? "14500"), (nat != ike || ike == 0),
      let duration = Double(options["--duration"] ?? "60"), (1...3600).contains(duration) else {
    fail("Use distinct ports (or zero for automatic allocation) and a duration from 1 to 3600 seconds")
}
let encoder = JSONEncoder()
encoder.dateEncodingStrategy = .iso8601
let probe = LoopbackProbe { event in
    if let data = try? encoder.encode(event) { FileHandle.standardOutput.write(data + Data([10])) }
}
let bindings = probe.start(address: address, ikePort: ike, natPort: nat)
if bindings.allSatisfy({ $0.boundPort == nil }) { fail("No sockets bound") }
signal(SIGINT, SIG_IGN)
signal(SIGTERM, SIG_IGN)
let interrupt = DispatchSource.makeSignalSource(signal: SIGINT, queue: .main)
let terminate = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
for source in [interrupt, terminate] {
    source.setEventHandler { probe.stop(); exit(0) }
    source.resume()
}
DispatchQueue.main.asyncAfter(deadline: .now() + duration) { probe.stop(); exit(0) }
dispatchMain()
