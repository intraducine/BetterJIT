import Foundation
import Dispatch
import BetterJITCore
#if canImport(Darwin)
import Darwin
#else
import Glibc
#endif

func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data((message + "\n").utf8)); exit(1)
}
let usage = """
Usage:
  betterjit-probe interfaces
  betterjit-probe listen [--address IP] [--interface NAME] [--ike-port 15000] [--nat-port 14500] [--duration 60]
  betterjit-probe profile --output FILE [--address IP] [--interface NAME]

Without --interface, only the original 127.0.0.1 / 127.0.0.2 controls are accepted.
With --interface, --address must match a currently assigned eligible local address.
No remote hosts, wildcard listeners, native interface override, VPN, or JIT.
"""
let args = Array(CommandLine.arguments.dropFirst())
if args.isEmpty || args == ["--help"] { print(usage); exit(0) }
let command = args[0]
if command == "interfaces" {
    guard args.count == 1 else { fail(usage) }
    do {
        let encoder = JSONEncoder(); encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        FileHandle.standardOutput.write(try encoder.encode(LocalInterfaces.snapshot()) + Data([10])); exit(0)
    } catch { fail(error.localizedDescription) }
}
guard ["listen", "profile"].contains(command) else { fail(usage) }
var options: [String: String] = [:]
let allowed: Set<String> = command == "listen"
    ? ["--address", "--interface", "--ike-port", "--nat-port", "--duration"] : ["--address", "--interface", "--output"]
var i = 1
while i < args.count {
    let key = args[i]
    guard allowed.contains(key), i + 1 < args.count, options[key] == nil else { fail(usage) }
    options[key] = args[i + 1]; i += 2
}
let host = options["--address"] ?? "127.0.0.1"
var target: InterfaceTarget?
if let name = options["--interface"] {
    target = (try? LocalInterfaces.snapshot())?.first { $0.name == name && $0.address == host && $0.exclusion == nil }
    guard target != nil else { fail("Address is not currently assigned to that eligible interface") }
}
let loopback = LoopbackAddress(rawValue: host)
guard target != nil || loopback != nil else { fail("Use --interface and an assigned local address, or a supported loopback control") }
if command == "profile" {
    guard let path = options["--output"] else { fail("--output is required") }
    do {
        let data = try target.map { try ProbeProfile.make(target: $0) } ?? ProbeProfile.make(address: loopback!)
        try data.write(to: URL(fileURLWithPath: path), options: .atomic)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: path)
        print("Wrote removable test profile to \(path)"); exit(0)
    } catch { fail(error.localizedDescription) }
}
guard let ike = UInt16(options["--ike-port"] ?? "15000"), let nat = UInt16(options["--nat-port"] ?? "14500"),
      (nat != ike || ike == 0), let duration = Double(options["--duration"] ?? "60"), (1...3600).contains(duration)
else { fail("Use distinct ports (or zero) and a duration between 1 and 3600 seconds") }
let encoder = JSONEncoder(); encoder.dateEncodingStrategy = .iso8601
let probe = LoopbackProbe { event in
    if let data = try? encoder.encode(event) { FileHandle.standardOutput.write(data + Data([10])) }
}
let bindings: [PortBinding]
if let target { bindings = probe.start(target: target, ikePort: ike, natPort: nat, runSelfTests: true) }
else { bindings = probe.start(address: loopback!, ikePort: ike, natPort: nat) }
guard bindings.contains(where: { $0.boundPort != nil }) else { fail("No sockets bound") }
signal(SIGINT, SIG_IGN); signal(SIGTERM, SIG_IGN)
let signals = [SIGINT, SIGTERM].map { DispatchSource.makeSignalSource(signal: $0, queue: .main) }
for source in signals { source.setEventHandler { probe.stop(); exit(0) }; source.resume() }
DispatchQueue.main.asyncAfter(deadline: .now() + duration) { probe.stop(); exit(0) }
dispatchMain()
